/**
 * Names every resource this stack creates, and identifies the deployment in
 * tags.
 *
 * Two separate concerns meet here.
 *
 * **Collision.** SQS, SNS, ECS cluster and IAM role names are unique per AWS
 * account (per region, except IAM which is account-global). Fixed names mean a
 * second MSight deployment cannot be created at all. Names therefore default to
 * a deployment-scoped form.
 *
 * **Continuity.** Renaming any of those on an existing stack *replaces* the
 * resource. For SNS that changes the topic ARN, which silently breaks every
 * field sensor still publishing to the old one. So each name can be pinned
 * explicitly in deploy.config.yaml, and an existing deployment pins the names
 * it already has.
 *
 * Discovery of runtime-created sensor resources is by tag, and the tag value
 * names the *deployment*, never the product — otherwise tearing down one stack
 * would reap another's queues.
 */

/** Tag key carrying the deployment name. Read by the reconciler and the reaper. */
export const DEPLOYMENT_TAG_KEY = 'msight:deployment';

/** Tag key naming which sensor a runtime-created resource belongs to. */
export const SENSOR_TAG_KEY = 'msight:sensor';

/**
 * Constraints are the intersection of every service a name feeds: IAM role
 * names cap at 64 characters and SQS FIFO queue names at 80 including the
 * `.fifo` suffix, so the deployment name is held well below both to leave room
 * for a sensor name appended after it.
 */
const PATTERN = /^[a-z][a-z0-9-]{2,23}$/;

export function assertDeploymentName(name: string): void {
  if (!PATTERN.test(name)) {
    throw new Error(
      `deploy.config.yaml: deploymentName "${name}" is not usable as a resource name prefix. ` +
        'It must be 3-24 characters, start with a lowercase letter, and contain only ' +
        'lowercase letters, digits and hyphens. It is embedded in SQS, SNS, ECS and IAM ' +
        'names, which are unique per account and have their own length limits.'
    );
  }
}

/**
 * Explicit name pins from deploy.config.yaml. Anything omitted falls back to a
 * deployment-scoped default, so a brand-new deployment needs none of these.
 */
export interface ResourceNameOverrides {
  sensorTopic?: string;
  spatTopic?: string;
  controlTopic?: string;
  cluster?: string;
  sensorConsumerTaskRole?: string;
  /** Per-sensor queues and services are named `<prefix>-<sensor>`. */
  sensorResourcePrefix?: string;
  /** CloudWatch log groups are named `/<prefix>/...`. */
  logPrefix?: string;
  httpApi?: string;
  sensorHttpApi?: string;
  wsApi?: string;
  adminApi?: string;
  adminUserPool?: string;
}

export interface ResourceNames {
  sensorTopic: string;
  spatTopic: string;
  controlTopic: string;
  cluster: string;
  sensorConsumerTaskRole: string;
  sensorResourcePrefix: string;
  logPrefix: string;
  httpApi: string;
  sensorHttpApi: string;
  wsApi: string;
  adminApi: string;
  adminUserPool: string;
  apiAccessLogGroup: (id: string) => string;
  sensorLogGroup: (sensorName: string) => string;
}

export function names(
  deployment: string,
  overrides: ResourceNameOverrides = {}
): ResourceNames {
  const logPrefix = overrides.logPrefix ?? deployment;

  return {
    sensorTopic: overrides.sensorTopic ?? `${deployment}-sensor-topic.fifo`,
    spatTopic: overrides.spatTopic ?? `${deployment}-spat-topic`,
    controlTopic: overrides.controlTopic ?? `${deployment}-control-topic`,
    cluster: overrides.cluster ?? `${deployment}-cluster`,
    sensorConsumerTaskRole:
      overrides.sensorConsumerTaskRole ?? `${deployment}-sensor-consumer-task-role`,
    sensorResourcePrefix: overrides.sensorResourcePrefix ?? `${deployment}-sensor`,
    logPrefix,
    httpApi: overrides.httpApi ?? `${deployment}-http-api`,
    sensorHttpApi: overrides.sensorHttpApi ?? `${deployment}-sensor-http-api`,
    wsApi: overrides.wsApi ?? `${deployment}-ws-api`,
    adminApi: overrides.adminApi ?? `${deployment}-admin-api`,
    adminUserPool: overrides.adminUserPool ?? `${deployment}-admin-pool`,
    apiAccessLogGroup: (id: string) => `/${logPrefix}/apigw/${id}`,
    sensorLogGroup: (sensorName: string) => `/${logPrefix}/sensor-consumer/${sensorName}`,
  };
}

/**
 * Queue name for a sensor.
 *
 * Shared by the CDK stack, the reconciler that creates queues at runtime, and
 * the admin API that looks them up. Deriving it in more than one place would
 * let them drift, and the failure is silent: the console reports a
 * correctly-wired sensor as missing.
 */
export function sensorQueueName(prefix: string, sensorName: string): string {
  return `${prefix}-${sensorName.replace(/_/g, '-').toLowerCase()}.fifo`;
}

/** ECS service name for a sensor, matching the queue's convention. */
export function sensorServiceName(prefix: string, sensorName: string): string {
  return `${prefix}-${sensorName.replace(/_/g, '-').toLowerCase()}`;
}
