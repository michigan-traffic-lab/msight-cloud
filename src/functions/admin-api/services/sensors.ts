import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import { sensorQueueName } from '../../../shared/sensor-naming';
import { SensorsResponseSchema } from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

const sqs = new SQSClient({});
const sns = new SNSClient({});

/**
 * The message attribute the sensor topic filters on. Publishers must set it or
 * their messages match no subscription and are silently discarded — SNS reports
 * no error for a message that matches nothing, which is the single most common
 * way a new sensor appears dead.
 */
const ROUTING_ATTRIBUTE = 'sensor_name';

function configuredSensors(): string[] {
  return (process.env.SENSOR_NAMES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function topicArn(): string {
  const arn = process.env.SENSOR_TOPIC_ARN;
  if (!arn) {
    throw new HttpError(
      500,
      'not_configured',
      'SENSOR_TOPIC_ARN is not set on the admin API function.'
    );
  }
  return arn;
}

/** Queue depth and in-flight count, or null when the queue does not exist. */
async function queueState(name: string) {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) return null;

    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'QueueArn',
        ],
      })
    );

    return {
      name,
      url: QueueUrl,
      arn: Attributes?.QueueArn ?? '',
      messages_available: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
      messages_in_flight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'QueueDoesNotExist') {
      return null;
    }
    throw error;
  }
}

/**
 * Filter policy per subscribed queue ARN. This is the authoritative answer to
 * "which attribute value reaches this sensor" — the console shows it rather
 * than assuming it matches the configured name, because a mismatch between the
 * two is exactly the failure worth surfacing.
 */
async function filterPolicies(arn: string) {
  const byQueueArn = new Map<string, { arn: string; values: string[] }>();
  let nextToken: string | undefined;

  do {
    const page = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: nextToken })
    );

    for (const subscription of page.Subscriptions ?? []) {
      if (subscription.Protocol !== 'sqs' || !subscription.SubscriptionArn) continue;
      if (!subscription.SubscriptionArn.startsWith('arn:')) continue;

      const attributes = await sns.send(
        new GetSubscriptionAttributesCommand({
          SubscriptionArn: subscription.SubscriptionArn,
        })
      );

      let values: string[] = [];
      const raw = attributes.Attributes?.FilterPolicy;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const entry = parsed[ROUTING_ATTRIBUTE];
          if (Array.isArray(entry)) {
            values = entry.map(String);
          }
        } catch {
          values = [];
        }
      }

      byQueueArn.set(subscription.Endpoint ?? '', {
        arn: subscription.SubscriptionArn,
        values,
      });
    }

    nextToken = page.NextToken;
  } while (nextToken);

  return byQueueArn;
}

export async function getSensors() {
  const arn = topicArn();
  const names = configuredSensors();

  const [queues, policies] = await Promise.all([
    Promise.all(names.map((name) => queueState(sensorQueueName(name)))),
    filterPolicies(arn),
  ]);

  const sensors = names.map((name, index) => {
    const queue = queues[index];
    const subscription = queue ? (policies.get(queue.arn) ?? null) : null;

    return {
      name,
      queue,
      subscription,
      // Wired means the whole path exists: a queue, a subscription to it, and a
      // filter that actually admits this sensor's own name.
      wired: Boolean(queue && subscription && subscription.values.includes(name)),
    };
  });

  return SensorsResponseSchema.parse({
    topic: {
      arn,
      name: arn.split(':').pop() ?? arn,
      fifo: arn.endsWith('.fifo'),
      routing_attribute: ROUTING_ATTRIBUTE,
      content_based_deduplication: true,
    },
    sensors,
    fetched_at: new Date().toISOString(),
  });
}
