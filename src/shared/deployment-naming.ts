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
 * Tag key naming which microservice a runtime-created resource belongs to.
 *
 * Carries the same weight as `SENSOR_TAG_KEY`: it is how the teardown reaper
 * finds an ECR repository, a build project or a scaling group that Aurora no
 * longer remembers, and how the Cost page attributes an instance-hour to a
 * service rather than to the account at large.
 */
export const MICROSERVICE_TAG_KEY = 'msight:microservice';

/** Tag key naming which compute cluster a resource belongs to. */
export const COMPUTE_CLUSTER_TAG_KEY = 'msight:cluster';

/**
 * Tag key recording whether this deployment created a storage bucket or adopted
 * one that already existed. Kept beside the other tag keys so the vocabulary is
 * discoverable in one place; the tag set itself is assembled in resource-tags.
 */
export const STORAGE_ORIGIN_TAG_KEY = 'msight:storage-origin';

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
  /**
   * Microservice-owned resources are named `<prefix>-<service>` and compute
   * clusters `<prefix>-cluster-<cluster>`. Separate from the sensor prefix so
   * the reaper's name patterns and the IAM conditions scoped to them cannot
   * match each other's resources.
   */
  microserviceResourcePrefix?: string;
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
  microserviceResourcePrefix: string;
  microserviceTaskRole: string;
  microserviceExecutionRole: string;
  microserviceBuildRole: string;
  microserviceInstanceRole: string;
  logPrefix: string;
  httpApi: string;
  sensorHttpApi: string;
  wsApi: string;
  adminApi: string;
  adminUserPool: string;
  apiAccessLogGroup: (id: string) => string;
  sensorLogGroup: (sensorName: string) => string;
  /** Where a microservice's containers write. One group per service. */
  microserviceLogGroup: (service: string) => string;
  /** Where its image builds write. Separate so retention can differ. */
  microserviceBuildLogGroup: (service: string) => string;
}

export function names(
  deployment: string,
  overrides: ResourceNameOverrides = {}
): ResourceNames {
  const logPrefix = overrides.logPrefix ?? deployment;
  const microservicePrefix = overrides.microserviceResourcePrefix ?? `${deployment}-ms`;

  return {
    sensorTopic: overrides.sensorTopic ?? `${deployment}-sensor-topic.fifo`,
    spatTopic: overrides.spatTopic ?? `${deployment}-spat-topic`,
    controlTopic: overrides.controlTopic ?? `${deployment}-control-topic`,
    cluster: overrides.cluster ?? `${deployment}-cluster`,
    sensorConsumerTaskRole:
      overrides.sensorConsumerTaskRole ?? `${deployment}-sensor-consumer-task-role`,
    sensorResourcePrefix: overrides.sensorResourcePrefix ?? `${deployment}-sensor`,
    microserviceResourcePrefix: microservicePrefix,
    microserviceTaskRole: `${deployment}-microservice-task-role`,
    microserviceExecutionRole: `${deployment}-microservice-execution-role`,
    microserviceBuildRole: `${deployment}-microservice-build-role`,
    microserviceInstanceRole: `${deployment}-microservice-instance-role`,
    logPrefix,
    httpApi: overrides.httpApi ?? `${deployment}-http-api`,
    sensorHttpApi: overrides.sensorHttpApi ?? `${deployment}-sensor-http-api`,
    wsApi: overrides.wsApi ?? `${deployment}-ws-api`,
    adminApi: overrides.adminApi ?? `${deployment}-admin-api`,
    adminUserPool: overrides.adminUserPool ?? `${deployment}-admin-pool`,
    apiAccessLogGroup: (id: string) => `/${logPrefix}/apigw/${id}`,
    sensorLogGroup: (sensorName: string) => `/${logPrefix}/sensor-consumer/${sensorName}`,
    microserviceLogGroup: (service: string) => `/${logPrefix}/microservice/${service}`,
    microserviceBuildLogGroup: (service: string) => `/${logPrefix}/microservice-build/${service}`,
  };
}

/**
 * Names for the resources one microservice owns.
 *
 * Derived in one place because five callers need the same strings — the
 * provisioner that creates them, the console that displays them, the reconciler
 * that compares them, the reaper that deletes them, and the IAM conditions in
 * the stack that scope who may touch them. A second derivation would drift, and
 * the failure mode is a resource nothing recognises as its own: still billing,
 * invisible to the console, immune to teardown.
 *
 * Names are already constrained at registration (`^[a-z][a-z0-9-]{1,31}$`), so
 * nothing needs escaping here.
 */
export function microserviceNames(prefix: string, service: string) {
  return {
    /** ECR allows slashes, and a path segment keeps one deployment's repositories together. */
    ecrRepository: `${prefix}/${service}`,
    buildProject: `${prefix}-build-${service}`,
    /** ECS service name, unique within its cluster. */
    service: `${prefix}-${service}`,
    /** Task definition family. Revisions accumulate under it. */
    taskFamily: `${prefix}-${service}`,
  };
}

/** Names for the resources one compute cluster owns. */
export function computeClusterNames(prefix: string, cluster: string) {
  return {
    /** The ECS cluster itself. */
    cluster: `${prefix}-cluster-${cluster}`,
    launchTemplate: `${prefix}-lt-${cluster}`,
    autoScalingGroup: `${prefix}-asg-${cluster}`,
    /**
     * Capacity provider names are immutable and cannot be reused after
     * deletion for a period, which is why this is derived from the cluster name
     * rather than being made unique per attempt.
     */
    capacityProvider: `${prefix}-cp-${cluster}`,
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
