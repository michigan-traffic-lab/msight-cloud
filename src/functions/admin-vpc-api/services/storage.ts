import { HttpError } from '../../../shared/admin-api/http';
import { ensureStorageSchema } from '../../../shared/storage-schema';
import {
  bucketNameProblem,
  costTagConflict,
  createStorageBucket,
  findPrefixConflict,
  describeBucket,
  disableObjectNotifications,
  enableObjectNotifications,
  listAccountBuckets,
  listBucketObjects,
  normalizePrefix,
  tagBucket,
  type StorageInfraConfig,
} from '../../../shared/storage-infrastructure';
import { getPool } from './db';

/**
 * The bucket registry behind the console's Storage page.
 *
 * A storage bucket is the aggregated, non-real-time half of sensor ingest. The
 * streaming path costs money continuously — a queue, a subscription and a
 * Fargate task per sensor, running whether data arrives or not — and for a
 * sensor whose data is only ever looked at later that is spend for nothing.
 * Those sensors write aggregated files to S3 from the edge instead, and this
 * module is what records where.
 *
 * The registry is the source of truth for which buckets this deployment knows
 * about. AWS is the source of truth for whether they exist and how they are
 * wired, and the two are reported side by side rather than assumed to agree.
 */

/** Resolved per invocation so a missing variable fails this route, not the function. */
export function storageConfig(): StorageInfraConfig {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new HttpError(500, 'not_configured', `${key} is not set on the in-VPC admin function.`);
    }
    return value;
  };

  return {
    deployment: required('DEPLOYMENT_NAME'),
    region: required('AWS_REGION'),
    controlTopicArn: required('CONTROL_TOPIC_ARN'),
    costTag: { key: required('COST_TAG_KEY'), value: required('COST_TAG_VALUE') },
  };
}

async function ensureSchema(): Promise<void> {
  await ensureStorageSchema(await getPool());
}

export interface StorageRow {
  bucket: string;
  display_name: string | null;
  region: string | null;
  origin: 'created' | 'adopted';
  notify: boolean;
  created_at: string;
  updated_at: string;
}

function toRow(row: Record<string, unknown>): StorageRow {
  return {
    bucket: String(row.bucket),
    display_name: row.display_name === null ? null : String(row.display_name),
    region: row.region === null ? null : String(row.region),
    origin: row.origin === 'created' ? 'created' : 'adopted',
    notify: Boolean(row.notify),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listStorageRows(): Promise<StorageRow[]> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT bucket, display_name, region, origin, notify, created_at, updated_at
       FROM storages ORDER BY bucket`
  );
  return rows.map(toRow);
}

async function requireStorage(bucket: string): Promise<StorageRow> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT bucket, display_name, region, origin, notify, created_at, updated_at
       FROM storages WHERE bucket = $1`,
    [bucket]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'storage_not_found', `No registered bucket named "${bucket}".`);
  }
  return toRow(rows[0]);
}

/**
 * The registry, each row paired with what AWS actually reports.
 *
 * The two halves are returned separately rather than merged into one "status",
 * for the same reason the sensors view keeps "enabled" and "in sync" apart: a
 * bucket that is registered but unreachable and a bucket that was never wired
 * need different actions, and a single health flag cannot say which is which.
 */
export async function listStorages() {
  const config = storageConfig();
  const rows = await listStorageRows();

  const pool = await getPool();
  const { rows: attachments } = await pool.query(
    `SELECT storage_bucket, name, archive_enabled, storage_prefix
       FROM sensors WHERE storage_bucket IS NOT NULL ORDER BY name`
  );

  const sensorsByBucket = new Map<
    string,
    Array<{ name: string; archive_enabled: boolean; prefix: string }>
  >();
  for (const attachment of attachments) {
    const bucket = String(attachment.storage_bucket);
    const list = sensorsByBucket.get(bucket) ?? [];
    list.push({
      name: String(attachment.name),
      archive_enabled: Boolean(attachment.archive_enabled),
      // Carried so the console can show which prefix each sensor writes under,
      // and compare the set against the rules S3 actually has.
      prefix: String(attachment.storage_prefix ?? ''),
    });
    sensorsByBucket.set(bucket, list);
  }

  const storages = await Promise.all(
    rows.map(async (row) => {
      const facts = await describeBucket(config, row.bucket);
      return {
        ...row,
        facts,
        sensors: sensorsByBucket.get(row.bucket) ?? [],
        // Read from the bucket's own tags rather than kept as a column: S3 is
        // where the tag actually has to be for Cost Explorer to see it, so a
        // stored flag could say "tracked" about a bucket someone untagged by
        // hand and the cost page would still show nothing.
        cost_tracked: facts.tags[config.costTag.key] === config.costTag.value,
      };
    })
  );

  return {
    storages,
    /** What the Cost page filters on, so the console can name it exactly. */
    cost_tag: config.costTag,
    // The console's own hosting bucket, surfaced so the Storage page accounts
    // for every bucket this stack owns rather than looking like it missed one.
    // It is CloudFormation's, holds build output, and must never be offered as
    // a sensor target — hence a separate field instead of a row with a flag.
    console_bucket: process.env.CONSOLE_BUCKET_NAME ?? null,
    control_topic_arn: config.controlTopicArn,
    region: config.region,
    fetched_at: new Date().toISOString(),
  };
}

/** Account buckets not already registered, for the "adopt existing" picker. */
export async function listAdoptableBuckets() {
  const registered = new Set((await listStorageRows()).map((row) => row.bucket));
  const consoleBucket = process.env.CONSOLE_BUCKET_NAME ?? '';
  const buckets = await listAccountBuckets();

  return {
    buckets: buckets.filter(
      (bucket) => !registered.has(bucket.name) && bucket.name !== consoleBucket
    ),
    fetched_at: new Date().toISOString(),
  };
}

export interface AddStorageInput {
  bucket: string;
  displayName?: string | null;
  /** True creates the bucket; false adopts one that already exists. */
  create: boolean;
  /** Apply the cost allocation tag, so the bucket shows on the Cost page. */
  costTracked: boolean;
  actor: string;
}

/**
 * Registers a bucket, creating it first when asked.
 *
 * The order is deliberate: AWS work happens before the row is written, so a
 * failure leaves nothing registered rather than a row pointing at a bucket that
 * was never wired. That is the opposite of the sensor path, where the row is
 * the desired state and a reconciler catches up — here there is no reconciler,
 * because creating a bucket someone else may already own is not something to
 * retry in the background.
 */
export async function addStorage(input: AddStorageInput) {
  const config = storageConfig();
  const bucket = input.bucket.trim().toLowerCase();

  const problem = bucketNameProblem(bucket);
  if (problem) throw new HttpError(400, 'invalid_bucket_name', problem);

  if (bucket === process.env.CONSOLE_BUCKET_NAME) {
    throw new HttpError(
      409,
      'bucket_reserved',
      'That bucket hosts the management console itself and cannot be used for sensor data.'
    );
  }

  await ensureSchema();
  const pool = await getPool();

  const existing = await pool.query('SELECT 1 FROM storages WHERE bucket = $1', [bucket]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HttpError(409, 'storage_exists', `Bucket "${bucket}" is already registered.`);
  }

  const steps: string[] = [];
  const warnings: string[] = [];

  if (input.create) {
    steps.push(...(await createStorageBucket(config, bucket, input.costTracked)));
  } else {
    const facts = await describeBucket(config, bucket);
    if (!facts.exists) {
      throw new HttpError(
        404,
        'bucket_not_found',
        `No bucket named "${bucket}" is visible to this account. Create it here instead, ` +
          'or check the name.'
      );
    }
    if (facts.access_error) {
      throw new HttpError(
        403,
        'bucket_not_accessible',
        `"${bucket}" exists but this deployment cannot read it: ${facts.access_error}`
      );
    }
    // S3 will only deliver notifications to a topic in the bucket's own region,
    // and it reports that as a generic validation failure. Checking first turns
    // it into a sentence an operator can act on.
    if (facts.region && facts.region !== config.region) {
      throw new HttpError(
        400,
        'bucket_wrong_region',
        `"${bucket}" is in ${facts.region}, but this deployment runs in ${config.region}. ` +
          'S3 can only notify a topic in the bucket\'s own region, so uploads there would ' +
          'publish no events. Use a bucket in ' + config.region + '.'
      );
    }
    // Surfaced rather than refused: the operator asked for this, but taking
    // over another report's cost tag is not something to do silently.
    if (input.costTracked) {
      const conflict = costTagConflict(config, facts.tags);
      if (conflict) warnings.push(conflict);
    }

    await tagBucket(config, bucket, 'adopted', input.costTracked);
    steps.push(input.costTracked ? 'tagged, cost tracked' : 'tagged');
  }

  const facts = await describeBucket(config, bucket);

  // Registered with no listener. A freshly registered bucket has no sensors
  // archiving to it yet, and the listener's whole lifecycle is derived from
  // that count — see reconcileNotifications. Wiring it here would install a
  // listener for a bucket nothing writes to, which the next reconcile would
  // then remove.
  await pool.query(
    `INSERT INTO storages (bucket, display_name, region, origin, notify)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [bucket, input.displayName ?? null, facts.region, input.create ? 'created' : 'adopted']
  );

  console.log(
    JSON.stringify({
      event: 'storage_added',
      actor: input.actor,
      bucket,
      origin: input.create ? 'created' : 'adopted',
      cost_tracked: input.costTracked,
      steps,
      warnings,
    })
  );

  return {
    storage: await requireStorage(bucket),
    facts,
    cost_tracked: facts.tags[config.costTag.key] === config.costTag.value,
    steps,
    warnings,
  };
}

export async function updateStorage(input: {
  bucket: string;
  displayName?: string | null;
  costTracked?: boolean;
  actor: string;
}) {
  const config = storageConfig();
  await ensureSchema();
  const current = await requireStorage(input.bucket);
  const pool = await getPool();

  // Cost tracking lives in the bucket's tags, not in the registry row, so it is
  // applied straight to S3. `tagBucket` merges, and removes the cost key only
  // when the value is ours.
  if (input.costTracked !== undefined) {
    await tagBucket(config, input.bucket, current.origin, input.costTracked);
  }

  // Built from the keys actually present rather than COALESCEd: an explicit
  // null is how the console clears a display name, and COALESCE would read that
  // as "unchanged" and silently keep the old one.
  const assignments: string[] = [];
  const params: unknown[] = [input.bucket];

  if (input.displayName !== undefined) {
    params.push(input.displayName);
    assignments.push(`display_name = $${params.length}`);
  }

  if (assignments.length > 0) {
    await pool.query(
      `UPDATE storages SET ${assignments.join(', ')}, updated_at = NOW() WHERE bucket = $1`,
      params
    );
  }

  console.log(
    JSON.stringify({
      event: 'storage_updated',
      actor: input.actor,
      bucket: input.bucket,
      ...(input.costTracked === undefined ? {} : { cost_tracked: input.costTracked }),
    })
  );

  const facts = await describeBucket(config, input.bucket);
  return {
    storage: await requireStorage(input.bucket),
    cost_tracked: facts.tags[config.costTag.key] === config.costTag.value,
  };
}

export interface NotificationAction {
  bucket: string;
  action: 'installed' | 'updated' | 'removed' | 'none';
  /** Sensors currently archiving into this bucket. */
  archiving_sensors: number;
  /** The key prefixes S3 now filters on for this bucket. */
  prefixes: string[];
  error: string | null;
}

export interface StorageNotifyResult {
  buckets: number;
  installed: string[];
  /** Buckets whose rules existed but filtered on a different set of prefixes. */
  updated: string[];
  removed: string[];
  actions: NotificationAction[];
  failed: number;
  reconciled_at: string;
}

/** The sensors archiving into each bucket, with the prefix each one writes under. */
export async function archivingSensorsByBucket(): Promise<
  Map<string, Array<{ sensor: string; prefix: string }>>
> {
  const pool = await getPool();
  // One query for every bucket rather than one per bucket. Backed by the
  // partial index on (storage_bucket) WHERE archive_enabled.
  const { rows } = await pool.query(
    `SELECT storage_bucket, name, storage_prefix
       FROM sensors
      WHERE archive_enabled AND storage_bucket IS NOT NULL
      ORDER BY storage_bucket, name`
  );

  const byBucket = new Map<string, Array<{ sensor: string; prefix: string }>>();
  for (const row of rows) {
    const bucket = String(row.storage_bucket);
    const list = byBucket.get(bucket) ?? [];
    list.push({ sensor: String(row.name), prefix: String(row.storage_prefix ?? '') });
    byBucket.set(bucket, list);
  }
  return byBucket;
}

/** Same order the S3 rules are written in, so the two compare directly. */
function desiredPrefixes(entries: Array<{ prefix: string }>): string[] {
  return [...new Set(entries.map((entry) => entry.prefix))].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Converges each registered bucket's S3 notification rules to the sensors that
 * archive into it.
 *
 * A bucket carries one rule per sensor prefix, so S3 publishes only what a
 * sensor actually wrote — anything landing elsewhere in the bucket is never
 * announced and costs nothing. The rule set is therefore derived twice over:
 * it exists at all only while some sensor archives here, and its contents are
 * exactly those sensors' prefixes.
 *
 * Written as a reconciler rather than as install/remove calls hung off each
 * sensor edit, for the same reason the sensor infrastructure is: an edit that
 * fails halfway leaves rules nothing will ever revisit — publishing for a
 * prefix no sensor writes to, or silently missing one that does. Recomputing
 * the whole set from the table is self-healing, safe to schedule, and produces
 * the same answer whichever order the edits happened in.
 *
 * Errors are collected per bucket rather than thrown: one inaccessible bucket
 * must not stop the others from being fixed.
 */
export async function reconcileNotifications(): Promise<StorageNotifyResult> {
  const config = storageConfig();
  await ensureSchema();
  const pool = await getPool();

  const rows = await listStorageRows();
  const archivingByBucket = await archivingSensorsByBucket();

  const actions: NotificationAction[] = [];
  const installed: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  for (const row of rows) {
    const archiving = archivingByBucket.get(row.bucket) ?? [];
    const wanted = desiredPrefixes(archiving);

    try {
      // AWS is the source of truth for what is actually configured. Trusting
      // the `notify` column instead would let rules someone changed by hand
      // stay "correct" forever, with uploads silently unannounced.
      const facts = await describeBucket(config, row.bucket);
      if (!facts.exists || facts.access_error) {
        throw new Error(facts.access_error ?? 'The bucket no longer exists.');
      }
      const actual = facts.notification_prefixes;

      // Refused here rather than at S3, which rejects the whole call with an
      // error naming neither prefix. The sensor routes check the same thing on
      // the way in, so reaching this means a conflict predating that check.
      const conflict = findPrefixConflict(archiving);
      if (conflict) {
        throw new Error(
          `Sensors "${conflict.a.sensor}" and "${conflict.b.sensor}" archive to nested ` +
            `prefixes ("${conflict.a.prefix || '(whole bucket)'}" contains ` +
            `"${conflict.b.prefix || '(whole bucket)'}"). S3 will not filter on both, so ` +
            'this bucket keeps the rules it had. Give one of them a prefix outside the other.'
        );
      }

      if (wanted.length === 0) {
        if (facts.notifies_control_topic) {
          await disableObjectNotifications(config, row.bucket);
          removed.push(row.bucket);
          actions.push({ bucket: row.bucket, action: 'removed', archiving_sensors: 0, prefixes: [], error: null });
        } else {
          actions.push({ bucket: row.bucket, action: 'none', archiving_sensors: 0, prefixes: [], error: null });
        }
      } else if (!sameSet(wanted, actual)) {
        await enableObjectNotifications(config, row.bucket, wanted);
        const action = facts.notifies_control_topic ? 'updated' : 'installed';
        (action === 'installed' ? installed : updated).push(row.bucket);
        actions.push({
          bucket: row.bucket,
          action,
          archiving_sensors: archiving.length,
          prefixes: wanted,
          error: null,
        });
      } else {
        actions.push({
          bucket: row.bucket,
          action: 'none',
          archiving_sensors: archiving.length,
          prefixes: wanted,
          error: null,
        });
      }

      const shouldNotify = wanted.length > 0;
      if (row.notify !== shouldNotify) {
        await pool.query('UPDATE storages SET notify = $2, updated_at = NOW() WHERE bucket = $1', [
          row.bucket,
          shouldNotify,
        ]);
      }
    } catch (error) {
      actions.push({
        bucket: row.bucket,
        action: 'none',
        archiving_sensors: archiving.length,
        prefixes: [],
        error: error instanceof Error ? error.message : 'Unknown failure.',
      });
    }
  }

  for (const action of actions) {
    if (action.error === null) continue;
    console.error(
      JSON.stringify({
        event: 'storage_notification_failed',
        bucket: action.bucket,
        archiving_sensors: action.archiving_sensors,
        message: action.error,
      })
    );
  }

  const failed = actions.filter((action) => action.error !== null).length;

  if (installed.length || updated.length || removed.length || failed) {
    console.log(
      JSON.stringify({
        event: 'storage_notifications_reconciled',
        buckets: rows.length,
        installed,
        updated,
        removed,
        failed,
      })
    );
  }

  return {
    buckets: rows.length,
    installed,
    updated,
    removed,
    actions,
    failed,
    reconciled_at: new Date().toISOString(),
  };
}

/**
 * Unregisters a bucket. The bucket and everything in it survive.
 *
 * This is the only removal the console offers, and that is a deliberate limit:
 * a bucket here holds the aggregated record of a sensor that, by definition,
 * chose not to stream — so S3 is the only copy that ever existed. Nothing in a
 * web console should be one confirmation dialog away from deleting that.
 */
export async function removeStorage(input: { bucket: string; actor: string }) {
  const config = storageConfig();
  await ensureSchema();
  await requireStorage(input.bucket);
  const pool = await getPool();

  // Sensors are detached first. The FK would null the column on its own, but
  // archive_enabled would survive and violate the check constraint — a sensor
  // set to archive with nowhere to archive to.
  const detached = await pool.query(
    `UPDATE sensors
        SET archive_enabled = FALSE,
            storage_bucket  = NULL,
            storage_prefix  = '',
            updated_at      = NOW()
      WHERE storage_bucket = $1
      RETURNING name`,
    [input.bucket]
  );

  // Best effort: an inaccessible or deleted bucket must not block unregistering
  // it, which is precisely when an operator most wants the row gone.
  let notificationRemoved = true;
  try {
    await disableObjectNotifications(config, input.bucket);
  } catch (error) {
    notificationRemoved = false;
    console.error(
      JSON.stringify({
        event: 'storage_notification_cleanup_failed',
        bucket: input.bucket,
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }

  await pool.query('DELETE FROM storages WHERE bucket = $1', [input.bucket]);

  const detachedSensors = detached.rows.map((row) => String(row.name));
  console.log(
    JSON.stringify({
      event: 'storage_removed',
      actor: input.actor,
      bucket: input.bucket,
      detached_sensors: detachedSensors,
      notification_removed: notificationRemoved,
    })
  );

  return {
    bucket: input.bucket,
    unregistered: true,
    detached_sensors: detachedSensors,
    notification_removed: notificationRemoved,
    /** The bucket itself is untouched — say so, so nobody assumes otherwise. */
    bucket_deleted: false,
  };
}

const MAX_LISTING = 200;
const DEFAULT_LISTING = 50;

function clamp(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LISTING);
}

/** Live S3 listing, straight from S3. Nothing in this stack records uploads. */
export async function browseStorage(input: {
  bucket: string;
  prefix?: string;
  cursor?: string;
  limit?: string;
}) {
  await ensureSchema();
  await requireStorage(input.bucket);

  const limit = clamp(input.limit, DEFAULT_LISTING);
  try {
    const page = await listBucketObjects({
      bucket: input.bucket,
      ...(input.prefix ? { prefix: input.prefix } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
    return { bucket: input.bucket, ...page, limit, fetched_at: new Date().toISOString() };
  } catch (error) {
    throw new HttpError(
      502,
      'listing_failed',
      `S3 would not list ${input.bucket}: ${error instanceof Error ? error.message : 'unknown failure'}`
    );
  }
}


export { normalizePrefix };
