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
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { DEPLOYMENT_TAG_KEY, SENSOR_TAG_KEY, sensorQueueName, sensorServiceName } from './deployment-naming';

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
}

export interface SensorAction {
  sensor: string;
  action: 'create' | 'delete' | 'none';
  steps: string[];
  error: string | null;
}

/**
 * Every runtime-created resource carries these, and teardown enumerates by
 * them. The deployment tag is what stops one stack's reaper from reaping
 * another's queues in a shared account.
 */
function tagPairs(deployment: string, sensor: string): Array<[string, string]> {
  return [
    [DEPLOYMENT_TAG_KEY, deployment],
    [SENSOR_TAG_KEY, sensor],
    ['ManagedBy', 'msight-console'],
  ];
}

/** SQS takes a plain map. */
function sqsTags(deployment: string, sensor: string): Record<string, string> {
  return Object.fromEntries(tagPairs(deployment, sensor));
}

/** ECS spells tag fields in lowercase, unlike SQS and SNS. */
function ecsTags(deployment: string, sensor: string) {
  return tagPairs(deployment, sensor).map(([key, value]) => ({ key, value }));
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

/**
 * Queue name to URL, for every queue this deployment owns.
 *
 * Ownership comes from the tag, not the name prefix. Two deployments can
 * legitimately share a prefix — one pins the other's names in config — and
 * deleting another deployment's queue is unrecoverable.
 */
export async function listOwnedQueueUrls(config: SensorInfraConfig): Promise<Map<string, string>> {
  const found = new Map<string, string>();
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
      found.set(url.split('/').pop() ?? '', url);
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

  for (const [queueName, url] of await listOwnedQueueUrls(config)) {
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
      tags: ecsTags(config.deployment, sensor),
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
        tags: sqsTags(config.deployment, sensor),
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
          tags: ecsTags(config.deployment, sensor),
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
  actions: SensorAction[];
  failed: number;
  reconciled_at: string;
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
  const actual = await listOwnedQueues(config);
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
      failed,
    })
  );

  return {
    desired,
    created: toCreate,
    deleted: toDelete,
    actions,
    failed,
    reconciled_at: new Date().toISOString(),
  };
}
