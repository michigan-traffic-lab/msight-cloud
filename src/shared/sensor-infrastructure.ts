/**
 * Creates and destroys the AWS resources behind one sensor.
 *
 * A sensor is four things: an SQS FIFO queue, a filtered subscription on the
 * sensor topic, a task definition revision naming that queue, and an ECS
 * service running it. None of them are owned by CloudFormation — they are
 * created at runtime from the `sensors` table in Aurora, so adding a sensor is
 * a console action rather than a deploy.
 *
 * This module is deliberately free of any database or HTTP dependency. It has
 * two callers with nothing else in common: the admin API's reconciler, which
 * converges to whatever the registry says, and the teardown reaper, which
 * converges to nothing and runs during `cdk destroy` when Aurora may already be
 * gone. Sharing the mutations keeps the two from drifting; the delete path in
 * particular is destructive and must not exist twice.
 */

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  ListQueuesCommand,
  TagQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ListSubscriptionsByTopicCommand,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListServicesCommand,
  RegisterTaskDefinitionCommand,
  TagResourceCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { DEPLOYMENT_TAG_KEY, SENSOR_TAG_KEY, sensorQueueName, sensorServiceName } from './deployment-naming';
import { resourceTags, toEcsTags, toSqsTags, type TagPairs } from './resource-tags';

export const sqs = new SQSClient({});
export const sns = new SNSClient({});
export const ecs = new ECSClient({});

/** The message attribute the sensor topic filters on. */
export const ROUTING_ATTRIBUTE = 'sensor_name';

/** Everything the mutations need, resolved from environment by each caller. */
export interface SensorInfraConfig {
  deployment: string;
  prefix: string;
  topicArn: string;
  cluster: string;
  /** CDK-owned definition the per-sensor revisions are derived from. */
  templateTaskDefinition: string;
  subnetIds: string[];
  securityGroupIds: string[];
  /**
   * The cost allocation tag the console's Cost page filters on.
   *
   * `cdk.Tags.of(stack)` only reaches resources CloudFormation owns, and none
   * of these are — so without applying it here a sensor's queue and, far more
   * expensively, its Fargate task are invisible to cost reporting. The tag
   * cannot be hardcoded: it is chosen in deploy.config.yaml.
   *
   * Optional only because the teardown reaper never tags anything; every
   * creating caller must supply it.
   */
  costTag?: { key: string; value: string };
}

export interface SensorAction {
  sensor: string;
  action: 'create' | 'delete' | 'none';
  steps: string[];
  error: string | null;
}

/**
 * What every resource behind one sensor carries.
 *
 * The base set and the per-service shapes live in `./resource-tags`, shared
 * with storage — the two were separate copies once, and the cost allocation tag
 * was added to one of them and missed on the other.
 */
export function tagPairs(config: SensorInfraConfig, sensor: string): TagPairs {
  return resourceTags({
    deployment: config.deployment,
    specific: [[SENSOR_TAG_KEY, sensor]],
    costTag: config.costTag,
  });
}

function sqsTags(config: SensorInfraConfig, sensor: string): Record<string, string> {
  return toSqsTags(tagPairs(config, sensor));
}

function ecsTags(config: SensorInfraConfig, sensor: string) {
  return toEcsTags(tagPairs(config, sensor));
}

/**
 * Whether an SQS error means the queue is simply not there any more.
 *
 * ListQueues is eventually consistent: a deleted queue keeps appearing in its
 * results for up to 60 seconds, so any follow-up call on that URL fails. That
 * is routine during a disable or a remove, and must not fail the request.
 *
 * ONLY the not-found case is tolerated. Swallowing every error here would be
 * worse than the bug it hides: an AccessDenied would make owned queues look
 * absent, which reports healthy sensors as out of sync and invites the
 * reconciler to recreate queues that already exist.
 */
function isQueueGone(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'QueueDoesNotExist' || name === 'AWS.SimpleQueueService.NonExistentQueue';
}

/** Recovers the sensor name from a queue name built by `sensorQueueName`. */
export function sensorFromQueueName(prefix: string, queueName: string): string {
  return queueName.replace(new RegExp(`^${prefix}-`), '').replace(/\.fifo$/, '');
}

export interface OwnedQueue {
  url: string;
  tags: Record<string, string>;
}

/**
 * Queue name to URL and tags, for every queue this deployment owns.
 *
 * Ownership comes from the tag, not the name prefix. Two deployments can
 * legitimately share a prefix — one pins the other's names in config — and
 * deleting another deployment's queue is unrecoverable.
 *
 * The tags are returned rather than discarded because the ownership check has
 * already paid for them, and tag convergence needs to know which queues are
 * missing the cost allocation tag. Fetching them twice would double the
 * ListQueueTags calls on a path that already makes one per queue.
 */
export async function listOwnedQueueUrls(
  config: SensorInfraConfig
): Promise<Map<string, OwnedQueue>> {
  const found = new Map<string, OwnedQueue>();
  let nextToken: string | undefined;

  do {
    const page = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: `${config.prefix}-`, NextToken: nextToken })
    );

    for (const url of page.QueueUrls ?? []) {
      let tags;
      try {
        tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl: url }));
      } catch (error) {
        if (isQueueGone(error)) continue;
        throw error;
      }
      if (tags.Tags?.[DEPLOYMENT_TAG_KEY] !== config.deployment) continue;
      found.set(url.split('/').pop() ?? '', { url, tags: tags.Tags ?? {} });
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return found;
}

export async function listOwnedQueues(config: SensorInfraConfig): Promise<Set<string>> {
  return new Set((await listOwnedQueueUrls(config)).keys());
}

export interface QueueDepth {
  available: number;
  in_flight: number;
}

/** Backlog per owned queue, keyed by queue name. */
export async function queueDepths(
  config: SensorInfraConfig
): Promise<Map<string, QueueDepth>> {
  const depths = new Map<string, QueueDepth>();

  for (const [queueName, { url }] of await listOwnedQueueUrls(config)) {
    try {
      const attributes = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        })
      );
      depths.set(queueName, {
        available: Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0),
        in_flight: Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      });
    } catch (error) {
      // Same eventual-consistency race as above. Anything else is real: a
      // swallowed AccessDenied here would report the queue as absent, which is
      // how a healthy sensor gets shown as out of sync.
      if (!isQueueGone(error)) throw error;
    }
  }

  return depths;
}

/** Service names running in this deployment's cluster. */
export async function listClusterServices(config: SensorInfraConfig): Promise<Set<string>> {
  const running = new Set<string>();
  let nextToken: string | undefined;

  do {
    const page = await ecs.send(
      new ListServicesCommand({ cluster: config.cluster, maxResults: 100, nextToken })
    );
    for (const arn of page.serviceArns ?? []) {
      running.add(arn.split('/').pop() ?? '');
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return running;
}

async function subscriptionForQueue(topicArn: string, queueArn: string): Promise<string | null> {
  let nextToken: string | undefined;
  do {
    const page = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken })
    );
    for (const subscription of page.Subscriptions ?? []) {
      // A subscription awaiting confirmation has the literal string
      // "PendingConfirmation" here instead of an ARN, and cannot be deleted.
      if (subscription.Endpoint === queueArn && subscription.SubscriptionArn?.startsWith('arn:')) {
        return subscription.SubscriptionArn;
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return null;
}

/** Registers a per-sensor revision of the CDK-owned template task definition. */
async function registerTaskDefinition(
  config: SensorInfraConfig,
  sensor: string,
  queueUrl: string
): Promise<string> {
  const template = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: config.templateTaskDefinition })
  );
  const base = template.taskDefinition;
  if (!base?.containerDefinitions?.length) {
    throw new Error(
      `Template task definition ${config.templateTaskDefinition} has no container definitions.`
    );
  }

  const containers = base.containerDefinitions.map((container) => ({
    ...container,
    environment: [
      ...(container.environment ?? []).filter(
        (entry) => entry.name !== 'SENSOR_NAME' && entry.name !== 'QUEUE_URL'
      ),
      { name: 'SENSOR_NAME', value: sensor },
      { name: 'QUEUE_URL', value: queueUrl },
    ],
  }));

  const registered = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: sensorServiceName(config.prefix, sensor),
      containerDefinitions: containers,
      cpu: base.cpu,
      memory: base.memory,
      networkMode: base.networkMode,
      requiresCompatibilities: base.requiresCompatibilities,
      executionRoleArn: base.executionRoleArn,
      taskRoleArn: base.taskRoleArn,
      runtimePlatform: base.runtimePlatform,
      tags: ecsTags(config, sensor),
    })
  );

  const arn = registered.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error(`RegisterTaskDefinition returned no ARN for ${sensor}.`);
  return arn;
}

/**
 * Brings one sensor into existence.
 *
 * Each step tolerates already having been done, because the previous attempt
 * may have failed halfway. Errors are returned rather than thrown so one bad
 * sensor does not abandon the rest of a reconcile.
 */
export async function createSensorInfrastructure(
  config: SensorInfraConfig,
  sensor: string
): Promise<SensorAction> {
  const steps: string[] = [];
  const queueName = sensorQueueName(config.prefix, sensor);

  try {
    // CreateQueue is idempotent when the attributes match, so a retry after a
    // partial failure returns the existing queue rather than erroring.
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: '60',
          DeduplicationScope: 'messageGroup',
          FifoThroughputLimit: 'perMessageGroupId',
        },
        tags: sqsTags(config, sensor),
      })
    );
    const queueUrl = created.QueueUrl;
    if (!queueUrl) throw new Error(`CreateQueue returned no URL for ${queueName}.`);
    steps.push(`queue ${queueName}`);

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })
    );
    const queueArn = attributes.Attributes?.QueueArn;
    if (!queueArn) throw new Error(`Queue ${queueName} has no ARN.`);

    if (!(await subscriptionForQueue(config.topicArn, queueArn))) {
      await sns.send(
        new SubscribeCommand({
          TopicArn: config.topicArn,
          Protocol: 'sqs',
          Endpoint: queueArn,
          Attributes: {
            RawMessageDelivery: 'true',
            // This filter is the whole routing mechanism: one topic fans out to
            // every sensor's queue, and each queue accepts only its own.
            FilterPolicy: JSON.stringify({ [ROUTING_ATTRIBUTE]: [sensor] }),
          },
          ReturnSubscriptionArn: true,
        })
      );
      steps.push('topic subscription');
    }

    const taskDefinitionArn = await registerTaskDefinition(config, sensor, queueUrl);
    steps.push('task definition');

    const serviceName = sensorServiceName(config.prefix, sensor);
    const described = await ecs.send(
      new DescribeServicesCommand({ cluster: config.cluster, services: [serviceName] })
    );
    const existing = described.services?.find((entry) => entry.status !== 'INACTIVE');

    if (existing) {
      await ecs.send(
        new UpdateServiceCommand({
          cluster: config.cluster,
          service: serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
        })
      );
      steps.push('ecs service updated');
    } else {
      await ecs.send(
        new CreateServiceCommand({
          cluster: config.cluster,
          serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: 1,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: config.subnetIds,
              securityGroups: config.securityGroupIds,
              assignPublicIp: 'DISABLED',
            },
          },
          // Fargate is billed against the task, and tasks inherit nothing
          // unless this is set — without it the sensor's spend is invisible to
          // the cost allocation tag.
          propagateTags: 'SERVICE',
          tags: ecsTags(config, sensor),
          enableExecuteCommand: true,
        })
      );
      steps.push('ecs service');
    }

    return { sensor, action: 'create', steps, error: null };
  } catch (error) {
    return {
      sensor,
      action: 'create',
      steps,
      error: error instanceof Error ? error.message : 'Unknown failure.',
    };
  }
}

/**
 * Tears one sensor down, in the order that avoids orphans: stop delivering
 * first, then stop consuming, then remove the queue.
 *
 * Queued messages are discarded rather than drained. Sensor payloads are live
 * SDSM observations that are worthless once stale, so waiting for a drain would
 * trade a real delay for no benefit.
 */
export async function deleteSensorInfrastructure(
  config: SensorInfraConfig,
  sensor: string
): Promise<SensorAction> {
  const steps: string[] = [];
  const queueName = sensorQueueName(config.prefix, sensor);
  const serviceName = sensorServiceName(config.prefix, sensor);

  try {
    let queueUrl: string | null = null;
    let queueArn = '';
    try {
      const found = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      queueUrl = found.QueueUrl ?? null;
      if (queueUrl) {
        const attributes = await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })
        );
        queueArn = attributes.Attributes?.QueueArn ?? '';
      }
    } catch (error) {
      // Already gone is the desired end state. Anything else — a denied
      // GetQueueUrl in particular — would otherwise make this report a
      // successful teardown while leaving the queue in place.
      if (!isQueueGone(error)) throw error;
      queueUrl = null;
    }

    if (queueArn) {
      const subscriptionArn = await subscriptionForQueue(config.topicArn, queueArn);
      if (subscriptionArn) {
        await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
        steps.push('unsubscribed');
      }
    }

    const described = await ecs.send(
      new DescribeServicesCommand({ cluster: config.cluster, services: [serviceName] })
    );
    const service = described.services?.find((entry) => entry.status !== 'INACTIVE');
    if (service) {
      await ecs.send(
        new UpdateServiceCommand({ cluster: config.cluster, service: serviceName, desiredCount: 0 })
      );
      await ecs.send(
        new DeleteServiceCommand({ cluster: config.cluster, service: serviceName, force: true })
      );
      steps.push('ecs service deleted');
    }

    if (queueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      steps.push('queue deleted (messages discarded)');
    }

    return { sensor, action: 'delete', steps, error: null };
  } catch (error) {
    return {
      sensor,
      action: 'delete',
      steps,
      error: error instanceof Error ? error.message : 'Unknown failure.',
    };
  }
}

export interface ConvergeResult {
  desired: string[];
  created: string[];
  deleted: string[];
  /** Sensors whose existing resources were brought up to the current tag set. */
  retagged: string[];
  actions: SensorAction[];
  failed: number;
  reconciled_at: string;
}

/**
 * Brings the tags on already-existing sensor resources up to date.
 *
 * Creation is not enough on its own. `CreateQueue` ignores the tags argument
 * when the queue already exists, and an existing service takes the
 * `UpdateService` branch, which does not tag — so a sensor built before a tag
 * was introduced keeps the old set forever. Adding the cost allocation tag to
 * the creation path alone would therefore have fixed nothing on any deployment
 * that already has sensors, which is every deployment that matters.
 *
 * Convergent rather than one-shot: it reads what is actually on each resource
 * and acts only on a difference, so the steady state is a single
 * DescribeServices per reconcile and no writes at all.
 *
 * The force-new-deployment is the subtle part. `propagateTags: 'SERVICE'` copies
 * the service's tags onto tasks *at launch*, so tagging a service leaves the
 * tasks already running with the old set — and on Fargate the task is where
 * nearly all the money is. Restarting them is what actually moves the spend
 * into the cost report. It happens once, because the next reconcile sees the
 * tag present and does nothing.
 */
async function convergeTags(
  config: SensorInfraConfig,
  sensors: string[],
  queues: Map<string, OwnedQueue>
): Promise<{ retagged: string[]; actions: SensorAction[] }> {
  const retagged: string[] = [];
  const actions: SensorAction[] = [];
  if (!config.costTag || sensors.length === 0) return { retagged, actions };

  const costTag = config.costTag;
  const serviceOf = new Map(sensors.map((s) => [sensorServiceName(config.prefix, s), s]));

  // DescribeServices accepts at most 10 services per call.
  const described = new Map<string, { arn: string; tags: Record<string, string> }>();
  const names = [...serviceOf.keys()];
  for (let index = 0; index < names.length; index += 10) {
    const batch = names.slice(index, index + 10);
    const result = await ecs.send(
      new DescribeServicesCommand({ cluster: config.cluster, services: batch, include: ['TAGS'] })
    );
    for (const service of result.services ?? []) {
      if (!service.serviceName || !service.serviceArn) continue;
      described.set(service.serviceName, {
        arn: service.serviceArn,
        tags: Object.fromEntries(
          (service.tags ?? []).map((tag) => [tag.key ?? '', tag.value ?? ''])
        ),
      });
    }
  }

  for (const sensor of sensors) {
    const steps: string[] = [];
    try {
      const queue = queues.get(sensorQueueName(config.prefix, sensor));
      if (queue && queue.tags[costTag.key] !== costTag.value) {
        await sqs.send(
          new TagQueueCommand({ QueueUrl: queue.url, Tags: sqsTags(config, sensor) })
        );
        steps.push('queue tagged');
      }

      const service = described.get(sensorServiceName(config.prefix, sensor));
      if (service && service.tags[costTag.key] !== costTag.value) {
        await ecs.send(
          new TagResourceCommand({ resourceArn: service.arn, tags: ecsTags(config, sensor) })
        );
        await ecs.send(
          new UpdateServiceCommand({
            cluster: config.cluster,
            service: sensorServiceName(config.prefix, sensor),
            forceNewDeployment: true,
          })
        );
        steps.push('service tagged, tasks restarting to inherit it');
      }

      if (steps.length > 0) retagged.push(sensor);
    } catch (error) {
      // Never fatal. Tags are a reporting concern; a sensor that processes
      // messages but is missing from the cost breakdown is a far better outcome
      // than a reconcile that abandons the rest of its work over one of them.
      actions.push({
        sensor,
        action: 'none',
        steps,
        error: error instanceof Error ? error.message : 'Unknown failure.',
      });
    }
  }

  return { retagged, actions };
}

/**
 * Converges AWS to the given sensor list.
 *
 * Deliberately a reconciler rather than create/delete handlers: a partial
 * failure — queue created, service creation throttled — leaves an orphan that
 * imperative handlers would never revisit. Re-running fixes it, which is also
 * what makes it safe to schedule, and what makes teardown just "converge to an
 * empty list".
 */
export async function converge(
  config: SensorInfraConfig,
  desired: string[]
): Promise<ConvergeResult> {
  const desiredQueues = new Map(
    desired.map((sensor) => [sensorQueueName(config.prefix, sensor), sensor])
  );
  const queues = await listOwnedQueueUrls(config);
  const actual = new Set(queues.keys());
  const services = await listClusterServices(config);

  // A sensor needs work when EITHER half is missing, not just the queue.
  // Creation is four steps and can fail partway — the observed case being a
  // queue and subscription that exist with no consumer behind them. Keying
  // convergence on the queue alone would call that state finished and leave
  // messages piling up unprocessed forever, which is the exact failure this is
  // supposed to repair. `createSensorInfrastructure` is idempotent, so
  // re-running it on a half-built sensor completes it rather than duplicating.
  const toCreate = desired.filter(
    (sensor) =>
      !actual.has(sensorQueueName(config.prefix, sensor)) ||
      !services.has(sensorServiceName(config.prefix, sensor))
  );
  const toDelete = [...actual]
    .filter((queueName) => !desiredQueues.has(queueName))
    .map((queueName) => sensorFromQueueName(config.prefix, queueName));

  const actions: SensorAction[] = [];

  // Deletes first, so a rename frees its queue name before the new one wants it.
  for (const sensor of toDelete) {
    actions.push(await deleteSensorInfrastructure(config, sensor));
  }
  for (const sensor of toCreate) {
    actions.push(await createSensorInfrastructure(config, sensor));
  }

  // Only the sensors left alone above. Anything just created already carries
  // the current tags, and anything just deleted has nothing to tag.
  const untouched = desired.filter((sensor) => !toCreate.includes(sensor));
  const tagging = await convergeTags(config, untouched, queues);
  actions.push(...tagging.actions);

  const failed = actions.filter((action) => action.error !== null).length;

  // Each failure is logged on its own line with the steps that did succeed.
  // A summary count alone says a reconcile failed without saying where, which
  // makes a partial build undiagnosable from CloudWatch.
  for (const action of actions) {
    if (action.error === null) continue;
    console.error(
      JSON.stringify({
        event: 'sensor_action_failed',
        sensor: action.sensor,
        action: action.action,
        completed_steps: action.steps,
        message: action.error,
      })
    );
  }

  console.log(
    JSON.stringify({
      event: 'sensor_converge',
      deployment: config.deployment,
      desired: desired.length,
      created: toCreate.length,
      deleted: toDelete.length,
      retagged: tagging.retagged.length,
      failed,
    })
  );

  return {
    desired,
    created: toCreate,
    deleted: toDelete,
    retagged: tagging.retagged,
    actions,
    failed,
    reconciled_at: new Date().toISOString(),
  };
}
