/**
 * Creates, inspects and wires the S3 buckets that hold aggregated sensor data.
 *
 * A storage bucket is the cheap half of the ingest story. Real-time streaming
 * runs a queue, a subscription and a Fargate task per sensor and bills for all
 * three continuously; a sensor that only needs its data eventually can write
 * aggregated files straight to S3 from the edge and cost nothing until it does.
 *
 * Like {@link ./sensor-infrastructure}, none of this is owned by
 * CloudFormation. Buckets are created and registered at runtime from the
 * console, so adding one is an operator action rather than a deploy. This
 * module is deliberately free of any database or HTTP dependency so the same
 * mutations can be shared by the admin API and by anything else that needs
 * them later.
 *
 * What it deliberately does NOT do is grant anyone write access. Edge devices
 * upload with credentials an operator configures out of band — an edge role
 * carries far more than S3 rights, so it does not belong to this module.
 */

import {
  CreateBucketCommand,
  GetBucketLocationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type NotificationConfiguration,
  type TopicConfiguration,
} from '@aws-sdk/client-s3';
import { STORAGE_ORIGIN_TAG_KEY } from './deployment-naming';
import { resourceTags, toTagSet, type TagPairs } from './resource-tags';

export const s3 = new S3Client({});

// Re-exported so callers that think in terms of buckets do not have to know the
// tag vocabulary lives with the naming rules.
export { STORAGE_ORIGIN_TAG_KEY };

/**
 * Everything the mutations need, resolved from environment by each caller.
 * `region` matters more than it looks: S3 will only publish notifications to an
 * SNS topic in the bucket's own region, so a bucket somewhere else cannot be
 * wired to the control topic at all.
 */
export interface StorageInfraConfig {
  deployment: string;
  region: string;
  controlTopicArn: string;
  /**
   * The cost allocation tag the console's Cost page filters on.
   *
   * Buckets are created at runtime, so `cdk.Tags.of(stack)` never reaches them
   * and their storage and request charges would be absent from the cost
   * breakdown entirely. Whether to apply it is decided per bucket rather than
   * always — see `tagBucket`.
   */
  costTag: { key: string; value: string };
}

/**
 * Id prefix for every notification rule this deployment owns on a bucket.
 *
 * A bucket carries one rule per archiving sensor prefix, so ownership is a
 * *family* of ids rather than a single one: `<base>-0`, `<base>-1`, and so on.
 * Scoped to the deployment because `PutBucketNotificationConfiguration`
 * replaces the *entire* configuration on a bucket — there is no per-rule API.
 * Every write therefore reads the current config and swaps out only the entries
 * in this family, so adopting a bucket that already notifies something else
 * does not silently break it.
 */
export function notificationRuleId(deployment: string): string {
  return `msight-${deployment}-object-created`;
}

/** Deterministic id for one rule, given its position in the sorted prefix set. */
export function notificationRuleIdAt(deployment: string, index: number): string {
  return `${notificationRuleId(deployment)}-${index}`;
}

function isOurRule(deployment: string, id: string | undefined): boolean {
  if (!id) return false;
  const base = notificationRuleId(deployment);
  // The bare base is matched too: it is what earlier deployments wrote before
  // rules were split per prefix, and leaving it behind would mean a bucket-wide
  // rule quietly overlapping the prefixed ones S3 is about to be given.
  return id === base || id.startsWith(`${base}-`);
}

/**
 * Whether two prefix filters may coexist on one bucket for the same event type.
 *
 * S3 refuses overlapping ones — "Configurations overlap. Configurations on the
 * same bucket cannot share a common event type" — and refuses the whole
 * `PutBucketNotificationConfiguration` call, not just the offending rule. The
 * empty prefix means the whole bucket and therefore overlaps everything.
 */
export function prefixesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * The first pair of sensors whose prefixes S3 would reject, or null.
 *
 * Checked before writing rather than after, because S3's own error names
 * neither prefix nor rule and arrives at the moment an unrelated sensor is
 * added — which reads like a bug in the console rather than a conflict between
 * two settings.
 *
 * Sensors sharing an identical prefix are NOT a conflict: they collapse to one
 * rule, which is exactly what should happen. Only a strict nesting — one prefix
 * containing another — is unresolvable.
 */
export function findPrefixConflict(
  entries: Array<{ sensor: string; prefix: string }>
): { a: { sensor: string; prefix: string }; b: { sensor: string; prefix: string } } | null {
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a.prefix === b.prefix) continue;
      if (prefixesOverlap(a.prefix, b.prefix)) return { a, b };
    }
  }
  return null;
}

/**
 * S3 bucket naming rules, which are stricter than almost everything else in
 * AWS and are enforced at creation time with an unhelpful error. Checked here
 * so the console can say what is actually wrong.
 */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function bucketNameProblem(name: string): string | null {
  if (!BUCKET_NAME_PATTERN.test(name)) {
    return (
      'Bucket names must be 3-63 characters of lowercase letters, digits, hyphens ' +
      'or dots, and must start and end with a letter or digit.'
    );
  }
  if (name.includes('..')) return 'Bucket names may not contain two adjacent periods.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'Bucket names may not look like an IP address.';
  if (name.startsWith('xn--')) return 'Bucket names may not start with "xn--".';
  if (name.startsWith('sthree-')) return 'Bucket names may not start with "sthree-".';
  if (name.endsWith('-s3alias') || name.endsWith('--ol-s3')) {
    return 'Bucket names may not end with "-s3alias" or "--ol-s3".';
  }
  return null;
}

/**
 * Object key prefixes are stored per sensor and used to attribute uploads.
 *
 * A leading slash is the common mistake: S3 keys have no leading slash, so
 * "/plymouth/" matches nothing and the sensor's uploads are silently
 * unattributed. Normalising is kinder than rejecting, but an empty prefix stays
 * empty — that legitimately means "the whole bucket".
 */
export function normalizePrefix(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+/, '');
  if (trimmed === '') return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * What a registered bucket carries, minus the cost allocation tag.
 *
 * The base set and the per-service shapes are shared with the sensor path via
 * `./resource-tags`. The cost tag is deliberately NOT passed here: unlike a
 * sensor's queue it is decided per bucket and can be turned off later, so
 * `tagBucket` adds or removes it against the bucket's existing tags rather than
 * having it baked into the set.
 */
function tagPairsFor(config: StorageInfraConfig, origin: 'created' | 'adopted'): TagPairs {
  return resourceTags({
    deployment: config.deployment,
    specific: [[STORAGE_ORIGIN_TAG_KEY, origin]],
  });
}

/** Whether an S3 error means the bucket simply is not there (or is not ours). */
function isNoSuchBucket(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NoSuchBucket' || name === 'NotFound' || status === 404;
}

/** Whether an S3 error means the bucket has no configuration of that kind yet. */
function isNoSuchConfiguration(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'NoSuchTagSet' || name === 'NoSuchConfiguration';
}

export interface BucketFacts {
  name: string;
  exists: boolean;
  /** Null when the bucket does not exist or its region cannot be read. */
  region: string | null;
  /** Tags, empty when the bucket carries none or they cannot be read. */
  tags: Record<string, string>;
  versioning: string | null;
  /** True when any of this deployment's notification rules are on the bucket. */
  notifies_control_topic: boolean;
  /**
   * The key prefixes this deployment's rules currently filter on, sorted. An
   * empty string means one rule covers the whole bucket. This is what the
   * reconciler compares against the archiving sensors' prefixes — presence
   * alone would miss a sensor whose prefix changed.
   */
  notification_prefixes: string[];
  /** Notification rules on the bucket that belong to something else. */
  foreign_notification_ids: string[];
  /** Set when the bucket exists but this role cannot inspect it. */
  access_error: string | null;
}

/**
 * Everything the console needs to show about one bucket, gathered tolerantly.
 *
 * A registered bucket may have been deleted, moved to another account, or had
 * its permissions changed underneath us. None of those should fail the whole
 * storage listing, so each fact is collected independently and its absence is
 * reported rather than thrown.
 */
export async function describeBucket(
  config: StorageInfraConfig,
  bucketName: string
): Promise<BucketFacts> {
  const facts: BucketFacts = {
    name: bucketName,
    exists: false,
    region: null,
    tags: {},
    versioning: null,
    notifies_control_topic: false,
    notification_prefixes: [],
    foreign_notification_ids: [],
    access_error: null,
  };

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    facts.exists = true;
  } catch (error) {
    if (isNoSuchBucket(error)) return facts;
    // A 403 means the bucket exists but is someone else's, or our policy is
    // too narrow. Reporting that is far more useful than reporting "missing",
    // which would invite an operator to try to recreate a name they cannot have.
    facts.exists = true;
    facts.access_error = error instanceof Error ? error.message : 'Bucket is not accessible.';
    return facts;
  }

  try {
    const location = await s3.send(new GetBucketLocationCommand({ Bucket: bucketName }));
    // us-east-1 is reported as null for historical reasons.
    facts.region = location.LocationConstraint ?? 'us-east-1';
  } catch {
    facts.region = null;
  }

  try {
    const tagging = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    for (const tag of tagging.TagSet ?? []) {
      if (tag.Key) facts.tags[tag.Key] = tag.Value ?? '';
    }
  } catch (error) {
    if (!isNoSuchConfiguration(error)) facts.tags = {};
  }

  try {
    const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucketName }));
    facts.versioning = versioning.Status ?? 'Disabled';
  } catch {
    facts.versioning = null;
  }

  try {
    const current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucketName })
    );
    const prefixes: string[] = [];
    for (const topic of current.TopicConfigurations ?? []) {
      if (!isOurRule(config.deployment, topic.Id)) {
        if (topic.Id) facts.foreign_notification_ids.push(topic.Id);
        continue;
      }
      facts.notifies_control_topic = true;
      // A rule with no prefix filter covers the whole bucket, which is exactly
      // what an empty prefix means on a sensor — so they compare directly.
      const rule = (topic.Filter?.Key?.FilterRules ?? []).find(
        (filterRule) => filterRule.Name?.toLowerCase() === 'prefix'
      );
      prefixes.push(rule?.Value ?? '');
    }
    facts.notification_prefixes = [...new Set(prefixes)].sort();
    for (const queue of current.QueueConfigurations ?? []) {
      if (queue.Id) facts.foreign_notification_ids.push(queue.Id);
    }
    for (const fn of current.LambdaFunctionConfigurations ?? []) {
      if (fn.Id) facts.foreign_notification_ids.push(fn.Id);
    }
  } catch {
    // Leave the flag false: the console renders that as "not wired", which is
    // the state an operator should act on either way.
  }

  return facts;
}

/**
 * Creates a bucket private, encrypted and tagged.
 *
 * Idempotent in the way that matters: an existing bucket this account already
 * owns is accepted rather than failed, so retrying after a partial failure
 * finishes the job instead of stranding a half-configured bucket. A name owned
 * by somebody else still fails, and must — bucket names are global.
 */
export async function createStorageBucket(
  config: StorageInfraConfig,
  bucketName: string,
  costTracked: boolean
): Promise<string[]> {
  const steps: string[] = [];

  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        // us-east-1 must NOT carry a location constraint; every other region
        // must. Sending the wrong one is an InvalidLocationConstraint error.
        ...(config.region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: config.region as never } }),
      })
    );
    steps.push(`bucket ${bucketName}`);
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    if (name !== 'BucketAlreadyOwnedByYou') throw error;
    steps.push(`bucket ${bucketName} (already owned)`);
  }

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
  );
  steps.push('public access blocked');

  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            BucketKeyEnabled: true,
          },
        ],
      },
    })
  );
  steps.push('encryption enabled');

  await tagBucket(config, bucketName, 'created', costTracked);
  steps.push(costTracked ? 'tagged, cost tracked' : 'tagged');

  return steps;
}

/**
 * Tags a bucket as belonging to this deployment.
 *
 * Merges rather than replaces: `PutBucketTagging` overwrites the whole tag set,
 * and an adopted bucket may already carry cost-allocation tags that something
 * else depends on. Losing those would be invisible until a bill arrived.
 *
 * `costTracked` decides whether the cost allocation tag goes on, and it is a
 * choice rather than a default because Cost Explorer attributes ALL of a
 * bucket's spend to its tags. For a bucket this deployment created that is
 * exactly right. For an adopted bucket that also holds something else, it would
 * quietly book another team's storage bill against MSight.
 *
 * Turning it off removes the tag only when the value is ours. A bucket whose
 * `Project` tag says something else belongs to someone else's cost report, and
 * this has no business clearing it.
 */
export async function tagBucket(
  config: StorageInfraConfig,
  bucketName: string,
  origin: 'created' | 'adopted',
  costTracked: boolean
): Promise<void> {
  const existing: Record<string, string> = {};
  try {
    const tagging = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    for (const tag of tagging.TagSet ?? []) {
      if (tag.Key) existing[tag.Key] = tag.Value ?? '';
    }
  } catch (error) {
    if (!isNoSuchConfiguration(error)) throw error;
  }

  // An adopted bucket keeps whatever origin it was first given: re-tagging a
  // bucket this deployment created as "adopted" would lose the only record
  // that we made it, which is what decides whether removal may offer a delete.
  const merged = { ...existing };
  for (const [key, value] of tagPairsFor(config, origin)) {
    if (key === STORAGE_ORIGIN_TAG_KEY && existing[STORAGE_ORIGIN_TAG_KEY] === 'created') {
      continue;
    }
    merged[key] = value;
  }

  if (costTracked) {
    merged[config.costTag.key] = config.costTag.value;
  } else if (merged[config.costTag.key] === config.costTag.value) {
    delete merged[config.costTag.key];
  }

  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: { TagSet: toTagSet(Object.entries(merged)) },
    })
  );
}

/**
 * Whether applying the cost tag would overwrite someone else's value.
 *
 * Only meaningful when adopting: a bucket that already carries the cost
 * allocation key with a different value is in another cost report, and taking
 * it over silently would move spend between owners with nothing to show for it.
 * Reported rather than refused — the operator asked for it — but reported.
 */
export function costTagConflict(
  config: StorageInfraConfig,
  tags: Record<string, string>
): string | null {
  const current = tags[config.costTag.key];
  if (current === undefined || current === config.costTag.value) return null;
  return (
    `The bucket already has ${config.costTag.key}=${current}. Tracking it here overwrites ` +
    `that with ${config.costTag.value}, moving its spend out of whatever report used it.`
  );
}

function withoutOurRules(
  current: NotificationConfiguration,
  deployment: string
): NotificationConfiguration {
  return {
    TopicConfigurations: (current.TopicConfigurations ?? []).filter(
      (topic) => !isOurRule(deployment, topic.Id)
    ),
    QueueConfigurations: current.QueueConfigurations ?? [],
    LambdaFunctionConfigurations: current.LambdaFunctionConfigurations ?? [],
    ...(current.EventBridgeConfiguration
      ? { EventBridgeConfiguration: current.EventBridgeConfiguration }
      : {}),
  };
}

/**
 * Points the bucket's ObjectCreated events at the control topic.
 *
 * Bucket-wide rather than per-prefix, deliberately. One bucket can hold several
 * sensors' prefixes, and S3 rejects overlapping prefix rules for the same event
 * type — so per-sensor rules would make adding a second sensor to a bucket fail
 * in a way that reads like an S3 bug. The catalog consumer attributes each
 * object to a sensor by matching its key against the registered prefixes, which
 * also means changing a sensor's prefix needs no S3 call at all.
 */
export async function enableObjectNotifications(
  config: StorageInfraConfig,
  bucketName: string,
  prefixes: string[]
): Promise<void> {
  const wanted = [...new Set(prefixes)].sort();
  if (wanted.length === 0) {
    throw new Error(
      `Refusing to configure notifications on ${bucketName} with no prefixes — ` +
        'remove the rules instead.'
    );
  }

  // Checked again here, not only by the caller: the write is all-or-nothing, so
  // a bad set does not partially apply, but S3's own rejection names neither
  // prefix and would surface as an opaque failure on an unrelated edit.
  const conflict = findPrefixConflict(wanted.map((prefix) => ({ sensor: prefix, prefix })));
  if (conflict) {
    throw new Error(
      'S3 will not accept overlapping prefix filters for one event type on a bucket: ' +
        `"${conflict.a.prefix || '(whole bucket)'}" contains ` +
        `"${conflict.b.prefix || '(whole bucket)'}".`
    );
  }

  const current = await s3.send(
    new GetBucketNotificationConfigurationCommand({ Bucket: bucketName })
  );

  // One rule per prefix. An empty prefix means the whole bucket, which S3
  // spells as a rule with no Filter at all.
  const rules: TopicConfiguration[] = wanted.map((prefix, index) => ({
    Id: notificationRuleIdAt(config.deployment, index),
    TopicArn: config.controlTopicArn,
    Events: ['s3:ObjectCreated:*'],
    ...(prefix
      ? { Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: prefix }] } } }
      : {}),
  }));

  const next = withoutOurRules(current, config.deployment);
  next.TopicConfigurations = [...(next.TopicConfigurations ?? []), ...rules];

  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucketName,
      NotificationConfiguration: next,
      // S3 sends a test event to the destination to prove it is reachable
      // before accepting the configuration. Skipping validation would let a
      // misconfigured topic policy be stored and then silently drop every
      // upload, so the check stays on and its failure is surfaced.
      SkipDestinationValidation: false,
    })
  );
}

/** Removes this deployment's rules, leaving anything else on the bucket. */
export async function disableObjectNotifications(
  config: StorageInfraConfig,
  bucketName: string
): Promise<void> {
  let current: NotificationConfiguration;
  try {
    current = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucketName })
    );
  } catch (error) {
    // The bucket being gone is the desired end state for this call.
    if (isNoSuchBucket(error)) return;
    throw error;
  }

  const hadOurs = (current.TopicConfigurations ?? []).some((topic) =>
    isOurRule(config.deployment, topic.Id)
  );
  if (!hadOurs) return;

  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: bucketName,
      NotificationConfiguration: withoutOurRules(current, config.deployment),
      SkipDestinationValidation: true,
    })
  );
}

export interface BucketObject {
  key: string;
  size: number;
  last_modified: string | null;
  storage_class: string | null;
}

/**
 * A page of what is actually in the bucket right now.
 *
 * The catalog table records what arrived since a bucket was registered; this
 * shows what is there regardless — which is the only way to see data that
 * predates registration, and the fastest way for an operator to confirm that
 * an edge device's credentials really work.
 */
export async function listBucketObjects(input: {
  bucket: string;
  prefix?: string;
  cursor?: string;
  limit: number;
}): Promise<{ objects: BucketObject[]; next_cursor: string | null }> {
  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: input.bucket,
      ...(input.prefix ? { Prefix: input.prefix } : {}),
      ...(input.cursor ? { ContinuationToken: input.cursor } : {}),
      MaxKeys: input.limit,
    })
  );

  return {
    objects: (result.Contents ?? []).map((object) => ({
      key: object.Key ?? '',
      size: Number(object.Size ?? 0),
      last_modified: object.LastModified ? object.LastModified.toISOString() : null,
      storage_class: object.StorageClass ?? null,
    })),
    next_cursor: result.IsTruncated ? (result.NextContinuationToken ?? null) : null,
  };
}

/** Every bucket in the account, for the "adopt an existing bucket" picker. */
export async function listAccountBuckets(): Promise<Array<{ name: string; created_at: string | null }>> {
  const result = await s3.send(new ListBucketsCommand({}));
  return (result.Buckets ?? [])
    .map((bucket) => ({
      name: bucket.Name ?? '',
      created_at: bucket.CreationDate ? bucket.CreationDate.toISOString() : null,
    }))
    .filter((bucket) => bucket.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}
