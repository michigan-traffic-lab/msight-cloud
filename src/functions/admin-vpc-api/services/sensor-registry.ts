import {
  converge,
  listClusterServices,
  queueDepths,
  ROUTING_ATTRIBUTE,
  type ConvergeResult,
  type SensorInfraConfig,
} from '../../../shared/sensor-infrastructure';
import { sensorQueueName, sensorServiceName } from '../../../shared/deployment-naming';
import { ensureStorageSchema } from '../../../shared/storage-schema';
import { findPrefixConflict, normalizePrefix } from '../../../shared/storage-infrastructure';
import { HttpError } from '../../../shared/admin-api/http';
import { getPool } from './db';

/** Sensor names double as SQS name components, so keep them conservative. */
const SENSOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/**
 * Resolved once per invocation rather than at module load, so a missing
 * variable surfaces as a 500 on the sensor routes instead of killing every
 * other route in this function at cold start.
 */
function infraConfig(): SensorInfraConfig {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new HttpError(500, 'not_configured', `${key} is not set on the in-VPC admin function.`);
    }
    return value;
  };

  return {
    deployment: required('DEPLOYMENT_NAME'),
    prefix: required('SENSOR_RESOURCE_PREFIX'),
    topicArn: required('SENSOR_TOPIC_ARN'),
    cluster: required('SENSOR_CLUSTER_NAME'),
    templateTaskDefinition: required('SENSOR_TASK_DEFINITION'),
    subnetIds: required('SENSOR_SUBNET_IDS').split(',').filter(Boolean),
    securityGroupIds: required('SENSOR_SECURITY_GROUP_IDS').split(',').filter(Boolean),
    // `required` rather than optional: a missing cost tag here is silent — the
    // sensor works perfectly and simply never appears in the cost breakdown,
    // which is the kind of thing nobody notices until a bill is queried.
    costTag: { key: required('COST_TAG_KEY'), value: required('COST_TAG_VALUE') },
  };
}

/**
 * The registry table is the desired state, and it is the only source of it.
 *
 * Created on demand so a fresh deployment needs no separate migration step, and
 * created EMPTY: sensors are added from the console, never from deploy config.
 * A deploy therefore cannot resurrect a sensor an operator deleted, and cannot
 * quietly disagree with what the console shows.
 *
 * The DDL itself lives in shared/storage-schema, because the storage tables and
 * the sensor columns that reference them have to be created together — a
 * sensor's foreign key to `storages` cannot exist before that table does.
 */
async function ensureTable(): Promise<void> {
  await ensureStorageSchema(await getPool());
}

/**
 * A sensor has two independent ingest paths and may use either or both.
 *
 *   stream_enabled  — real-time: the SNS topic fans out to a per-sensor SQS
 *                     FIFO queue drained by a Fargate consumer. Low latency,
 *                     and billed continuously for the queue and the task
 *                     whether data flows or not.
 *   archive_enabled — aggregated: the edge device writes files straight to a
 *                     registered S3 bucket under its own prefix. Nothing runs
 *                     in between, so it costs storage and nothing else.
 *
 * Archive-only is a normal configuration, not a degraded one: a sensor whose
 * data is only ever analysed later has no reason to pay for the streaming path.
 * Two booleans rather than a mode enum, because "both" is a real combination
 * and an enum would make it a third value every consumer has to remember to
 * handle — forgetting reads as a sensor silently not streaming.
 */
export interface SensorRow {
  name: string;
  display_name: string | null;
  enabled: boolean;
  stream_enabled: boolean;
  archive_enabled: boolean;
  storage_bucket: string | null;
  storage_prefix: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `name, display_name, enabled, stream_enabled, archive_enabled,
                        storage_bucket, storage_prefix, created_at, updated_at`;

function toRow(row: Record<string, unknown>): SensorRow {
  return {
    name: String(row.name),
    display_name: row.display_name === null ? null : String(row.display_name),
    enabled: Boolean(row.enabled),
    stream_enabled: Boolean(row.stream_enabled),
    archive_enabled: Boolean(row.archive_enabled),
    storage_bucket: row.storage_bucket === null ? null : String(row.storage_bucket),
    storage_prefix: String(row.storage_prefix ?? ''),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listSensors(): Promise<SensorRow[]> {
  await ensureTable();
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT ${SELECT_COLUMNS} FROM sensors ORDER BY name`);
  return rows.map(toRow);
}

/**
 * Whether a sensor's streaming infrastructure should exist.
 *
 * `enabled` is the master switch and `stream_enabled` selects the path, so both
 * have to hold. Named once because the reconciler, the drift report and the
 * console all have to agree on it — three separate `&&`s is how they end up
 * disagreeing, and the symptom is a sensor the console calls healthy while its
 * queue is deleted and rebuilt every five minutes.
 */
export function streamingDesired(row: SensorRow): boolean {
  return row.enabled && row.stream_enabled;
}

async function assertStorageRegistered(bucket: string): Promise<void> {
  const pool = await getPool();
  const { rowCount } = await pool.query('SELECT 1 FROM storages WHERE bucket = $1', [bucket]);
  if (!rowCount) {
    throw new HttpError(
      400,
      'storage_not_registered',
      `Bucket "${bucket}" is not registered. Add it on the Storage page first, so its ` +
        'uploads are cataloged and it is wired to the control topic.'
    );
  }
}

/**
 * Refuses a prefix that S3 could not filter alongside its neighbours.
 *
 * Each archiving sensor gets its own prefix-filtered notification rule on the
 * bucket, and S3 rejects overlapping prefix filters for one event type — it
 * rejects the entire `PutBucketNotificationConfiguration` call, not the
 * offending rule. Without this check the rejection would surface on a later
 * reconcile, blamed on whichever sensor was edited last, with an error naming
 * neither prefix.
 *
 * Sensors sharing an identical prefix are fine: they collapse into one rule.
 * Only nesting — `plymouth/` beside `plymouth/overflow/` — is unresolvable.
 */
async function assertPrefixAvailable(next: {
  name: string;
  storage_bucket: string;
  storage_prefix: string;
}): Promise<void> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT name, storage_prefix
       FROM sensors
      WHERE archive_enabled AND storage_bucket = $1 AND name <> $2`,
    [next.storage_bucket, next.name]
  );

  const entries = [
    ...rows.map((row) => ({ sensor: String(row.name), prefix: String(row.storage_prefix ?? '') })),
    { sensor: next.name, prefix: next.storage_prefix },
  ];

  const conflict = findPrefixConflict(entries);
  if (!conflict) return;

  const other = conflict.a.sensor === next.name ? conflict.b : conflict.a;
  throw new HttpError(
    409,
    'prefix_conflict',
    `Sensor "${other.sensor}" already archives to ${next.storage_bucket} under ` +
      `"${other.prefix || '(the whole bucket)'}", which overlaps "` +
      `${next.storage_prefix || '(the whole bucket)'}". S3 filters uploads per prefix and ` +
      'cannot have one prefix nested inside another on the same bucket. Pick a prefix ' +
      'outside it, or point this sensor at a different bucket.'
  );
}

/**
 * Validates the ingest configuration a change would produce.
 *
 * Checked as a whole rather than field by field: turning archiving on and
 * choosing the bucket arrive in the same request, and validating them
 * independently would reject a request that is perfectly consistent.
 */
async function assertIngestValid(next: {
  stream_enabled: boolean;
  archive_enabled: boolean;
  storage_bucket: string | null;
}): Promise<void> {
  if (next.archive_enabled && !next.storage_bucket) {
    throw new HttpError(
      400,
      'storage_required',
      'A sensor set to archive needs a registered bucket to archive to.'
    );
  }
  if (next.storage_bucket) await assertStorageRegistered(next.storage_bucket);

  if (!next.stream_enabled && !next.archive_enabled) {
    throw new HttpError(
      400,
      'no_ingest_path',
      'A sensor needs at least one ingest path: real-time streaming, S3 archive, or both. ' +
        'With neither, nothing it publishes reaches the cloud. To take a sensor out of ' +
        'service entirely, disable it instead — that keeps its configuration.'
    );
  }
}

export async function addSensor(input: {
  name: string;
  displayName?: string | null;
  streamEnabled?: boolean;
  archiveEnabled?: boolean;
  storageBucket?: string | null;
  storagePrefix?: string | null;
  actor: string;
}): Promise<SensorRow> {
  if (!SENSOR_NAME_PATTERN.test(input.name)) {
    throw new HttpError(
      400,
      'invalid_sensor_name',
      'Sensor names must be 2-64 characters of letters, digits, underscore or hyphen, ' +
        'starting with a letter or digit. The name becomes part of an SQS queue name.'
    );
  }

  await ensureTable();
  const pool = await getPool();

  const existing = await pool.query('SELECT 1 FROM sensors WHERE name = $1', [input.name]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HttpError(409, 'sensor_exists', `A sensor named "${input.name}" already exists.`);
  }

  const streamEnabled = input.streamEnabled ?? true;
  const archiveEnabled = input.archiveEnabled ?? false;
  const storageBucket = input.storageBucket ?? null;
  const storagePrefix = normalizePrefix(input.storagePrefix);

  if (archiveEnabled && storageBucket) {
    await assertPrefixAvailable({
      name: input.name,
      storage_bucket: storageBucket,
      storage_prefix: storagePrefix,
    });
  }

  await assertIngestValid({
    stream_enabled: streamEnabled,
    archive_enabled: archiveEnabled,
    storage_bucket: storageBucket,
  });

  await pool.query(
    `INSERT INTO sensors
       (name, display_name, stream_enabled, archive_enabled, storage_bucket, storage_prefix)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.name,
      input.displayName ?? null,
      streamEnabled,
      archiveEnabled,
      storageBucket,
      storagePrefix,
    ]
  );

  console.log(
    JSON.stringify({
      event: 'sensor_added',
      actor: input.actor,
      sensor: input.name,
      stream_enabled: streamEnabled,
      archive_enabled: archiveEnabled,
      storage_bucket: storageBucket,
    })
  );

  const rows = await listSensors();
  return rows.find((row) => row.name === input.name)!;
}

export async function setSensorEnabled(input: {
  name: string;
  enabled: boolean;
  actor: string;
}): Promise<void> {
  await ensureTable();
  const pool = await getPool();
  const result = await pool.query(
    'UPDATE sensors SET enabled = $1, updated_at = NOW() WHERE name = $2',
    [input.enabled, input.name]
  );
  if (result.rowCount === 0) {
    throw new HttpError(404, 'sensor_not_found', `No sensor named "${input.name}".`);
  }
  console.log(
    JSON.stringify({
      event: 'sensor_enabled_changed',
      actor: input.actor,
      sensor: input.name,
      enabled: input.enabled,
    })
  );
}

/**
 * Changes which ingest paths a sensor uses.
 *
 * Every field is optional and absent means "leave alone", so the console can
 * send only the control the operator touched without having to restate the
 * rest — restating is how a stale form overwrites a change made elsewhere.
 */
export async function setSensorIngest(input: {
  name: string;
  streamEnabled?: boolean;
  archiveEnabled?: boolean;
  storageBucket?: string | null;
  storagePrefix?: string | null;
  actor: string;
}): Promise<SensorRow> {
  await ensureTable();
  const pool = await getPool();

  const current = (await listSensors()).find((row) => row.name === input.name);
  if (!current) {
    throw new HttpError(404, 'sensor_not_found', `No sensor named "${input.name}".`);
  }

  const next: SensorRow = {
    ...current,
    stream_enabled: input.streamEnabled ?? current.stream_enabled,
    archive_enabled: input.archiveEnabled ?? current.archive_enabled,
    storage_bucket:
      input.storageBucket === undefined ? current.storage_bucket : input.storageBucket,
    storage_prefix:
      input.storagePrefix === undefined
        ? current.storage_prefix
        : normalizePrefix(input.storagePrefix),
  };

  // Detaching the bucket also turns archiving off, rather than leaving a sensor
  // that claims to archive with nowhere to archive to — which is the state the
  // check constraint refuses anyway, and a constraint violation is a worse
  // error message than doing the obvious thing.
  if (next.storage_bucket === null) {
    next.archive_enabled = false;
    next.storage_prefix = '';
  }

  await assertIngestValid(next);

  if (next.archive_enabled && next.storage_bucket) {
    await assertPrefixAvailable({
      name: next.name,
      storage_bucket: next.storage_bucket,
      storage_prefix: next.storage_prefix,
    });
  }

  await pool.query(
    `UPDATE sensors
        SET stream_enabled  = $2,
            archive_enabled = $3,
            storage_bucket  = $4,
            storage_prefix  = $5,
            updated_at      = NOW()
      WHERE name = $1`,
    [
      input.name,
      next.stream_enabled,
      next.archive_enabled,
      next.storage_bucket,
      next.storage_prefix,
    ]
  );

  console.log(
    JSON.stringify({
      event: 'sensor_ingest_changed',
      actor: input.actor,
      sensor: input.name,
      stream_enabled: next.stream_enabled,
      archive_enabled: next.archive_enabled,
      storage_bucket: next.storage_bucket,
      storage_prefix: next.storage_prefix,
    })
  );

  return next;
}

export async function removeSensor(input: { name: string; actor: string }): Promise<void> {
  await ensureTable();
  const pool = await getPool();
  const result = await pool.query('DELETE FROM sensors WHERE name = $1', [input.name]);
  if (result.rowCount === 0) {
    throw new HttpError(404, 'sensor_not_found', `No sensor named "${input.name}".`);
  }
  console.log(
    JSON.stringify({ event: 'sensor_removed', actor: input.actor, sensor: input.name })
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Converges AWS to the streaming sensors in the registry.
 *
 * Archive-only sensors are deliberately absent from the desired list: they need
 * no queue, no subscription and no consumer, and including them would build —
 * and bill for — exactly the infrastructure that choosing S3 was meant to
 * avoid. Turning streaming off on a sensor therefore tears its queue down on
 * the next reconcile, which is the point.
 */
export async function reconcile(): Promise<ConvergeResult> {
  const config = infraConfig();
  const desired = (await listSensors()).filter(streamingDesired).map((row) => row.name);
  return converge(config, desired);
}

/** Actual infrastructure state per sensor, for the console to show drift. */
export async function inventory() {
  const config = infraConfig();
  const rows = await listSensors();
  const depths = await queueDepths(config);
  const services = await listClusterServices(config);

  return {
    sensors: rows.map((row) => {
      const queueName = sensorQueueName(config.prefix, row.name);
      const depth = depths.get(queueName);
      return {
        ...row,
        /** What the streaming half of the registry asks AWS for. */
        streaming_desired: streamingDesired(row),
        queue_name: queueName,
        queue_exists: depth !== undefined,
        service_exists: services.has(sensorServiceName(config.prefix, row.name)),
        messages_available: depth?.available ?? null,
        messages_in_flight: depth?.in_flight ?? null,
      };
    }),
    // Queues with no registry row: a row removed while a delete failed, or a
    // reconcile that stopped halfway. Surfaced rather than silently ignored.
    orphaned_queues: [...depths.keys()].filter(
      (queueName) => !rows.some((row) => sensorQueueName(config.prefix, row.name) === queueName)
    ),
    topic_arn: config.topicArn,
    routing_attribute: ROUTING_ATTRIBUTE,
    cluster: config.cluster,
    fetched_at: new Date().toISOString(),
  };
}
