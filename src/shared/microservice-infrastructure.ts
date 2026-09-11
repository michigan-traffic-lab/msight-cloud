/**
 * Creates and destroys the AWS resources behind a compute cluster and the one
 * microservice that runs on it.
 *
 * Same contract as `sensor-infrastructure`, and for the same reason: two
 * callers with nothing else in common share these mutations — the admin API,
 * which converges to whatever the registry says, and the teardown reaper, which
 * converges to nothing and runs during `cdk destroy` when Aurora may already be
 * gone. The delete path is destructive and must not exist twice.
 *
 * No database, no HTTP. Every function returns what it did and what went wrong
 * rather than throwing, because a half-finished provision has to be reportable:
 * the caller records the steps that succeeded so the next attempt can resume
 * instead of starting over.
 *
 * ## What a provisioned microservice is
 *
 * Seven resources, created in dependency order:
 *
 *   1. an ECR repository holding the built image
 *   2. a CloudWatch log group for the container
 *   3. a CloudWatch log group for its builds
 *   4. a CodeBuild project that clones the repo and pushes the image
 *   5. an ECS cluster — and on EC2, a launch template, an Auto Scaling group
 *      and a capacity provider attached to it
 *   6. a task definition revision naming the built image
 *   7. an ECS service running it, with an Application Auto Scaling policy when
 *      the service scales on load rather than a fixed count
 *
 * Every one of them is tagged with the deployment, the cluster, the service and
 * the cost allocation tag. `cdk.Tags.of(stack)` reaches none of this, so an
 * untagged resource is invisible to the Cost page and to teardown — which is
 * precisely how the sensors' Fargate spend went missing once already.
 */

import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  PutLifecyclePolicyCommand,
} from '@aws-sdk/client-ecr';
import {
  BatchGetBuildsCommand,
  BatchGetProjectsCommand,
  CodeBuildClient,
  CreateProjectCommand,
  DeleteProjectCommand,
  StartBuildCommand,
  StopBuildCommand,
  UpdateProjectCommand,
} from '@aws-sdk/client-codebuild';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DeleteLogStreamCommand,
  DeleteRetentionPolicyCommand,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateCommand,
  DescribeLaunchTemplatesCommand,
  EC2Client,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  CreateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  ApplicationAutoScalingClient,
  DeregisterScalableTargetCommand,
  PutScalingPolicyCommand,
  RegisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';
import {
  CreateCapacityProviderCommand,
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteCapacityProviderCommand,
  DeleteClusterCommand,
  DeleteServiceCommand,
  DescribeClustersCommand,
  DescribeContainerInstancesCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListContainerInstancesCommand,
  ListTasksCommand,
  PutClusterCapacityProvidersCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
  COMPUTE_CLUSTER_TAG_KEY,
  MICROSERVICE_TAG_KEY,
  computeClusterNames,
  microserviceNames,
} from './deployment-naming';
import { resourceTags, toEcsTags, toSqsTags, toTagSet, type TagPairs } from './resource-tags';
import { instanceSpec } from './instance-catalog';

export const ecr = new ECRClient({});
export const codebuild = new CodeBuildClient({});
export const cwlogs = new CloudWatchLogsClient({});
export const ec2 = new EC2Client({});
export const autoscaling = new AutoScalingClient({});
export const appAutoScaling = new ApplicationAutoScalingClient({});
export const ecs = new ECSClient({});
export const ssm = new SSMClient({});

/**
 * The ECS-optimized AMI parameters. Public SSM parameters AWS keeps current, so
 * a cluster provisioned today gets today's agent and driver stack.
 *
 * The GPU variant is a different AMI, not a flag: it carries the NVIDIA driver,
 * Fabric Manager and the container toolkit. An EC2 GPU cluster launched from
 * the standard AMI comes up healthy, registers with the cluster, and then every
 * GPU task fails to place — the agent reports zero GPUs because there is no
 * driver to report.
 */
const AMI_PARAMETER_STANDARD =
  '/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id';
const AMI_PARAMETER_GPU =
  '/aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended/image_id';

/**
 * How many images ECR keeps per microservice.
 *
 * Untagged and superseded layers are pure cost — an ML image is routinely
 * several gigabytes, and a service rebuilt on every push accumulates them
 * forever. Ten is enough to roll back through recent builds and small enough
 * that storage stays a rounding error.
 */
const ECR_IMAGE_RETENTION_COUNT = 10;

/** CodeBuild compute. Docker builds of ML images OOM on SMALL often enough to matter. */
const BUILD_COMPUTE_TYPE = 'BUILD_GENERAL1_MEDIUM' as const;
const BUILD_IMAGE = 'aws/codebuild/standard:7.0';
const BUILD_TIMEOUT_MINUTES = 60;

export interface CostTag {
  key: string;
  value: string;
}

/** Everything the mutations need, resolved from environment by each caller. */
export interface MicroserviceInfraConfig {
  deployment: string;
  /** `names().microserviceResourcePrefix`. */
  prefix: string;
  /**
   * `names().logPrefix` — which is not always the deployment name.
   *
   * Separate from `deployment` because a deployment may log under a shorter
   * prefix, and the stack's IAM policy is scoped to that form. Deriving log
   * group names from the deployment name instead produces names this function
   * is not allowed to create.
   */
  logPrefix: string;
  region: string;
  accountId: string;
  /** Where tasks and container instances are placed. */
  subnetIds: string[];
  securityGroupIds: string[];
  /** CDK-owned roles. Passed to ECS, so the API's PassRole is scoped to these. */
  taskRoleArn: string;
  executionRoleArn: string;
  /** CDK-owned CodeBuild service role. */
  buildRoleArn: string;
  /** Instance profile the container instances assume. EC2 clusters only. */
  instanceProfileArn: string;
  /**
   * Environment every microservice container receives: the database proxy, the
   * cache, the topics. Assembled by the stack so a microservice sees the same
   * deployment the sensor consumers do.
   */
  taskEnvironment: Record<string, string>;
  /**
   * Optional only because the reaper never tags anything. Every creating caller
   * must supply it, or the resource's spend is invisible to the Cost page.
   */
  costTag?: CostTag | undefined;
}

/** One resource mutation, reported rather than thrown. */
export interface InfraResult {
  steps: string[];
  error: string | null;
}

function ok(steps: string[]): InfraResult {
  return { steps, error: null };
}

function failed(steps: string[], error: unknown): InfraResult {
  return {
    steps,
    error: error instanceof Error ? error.message : String(error ?? 'Unknown failure.'),
  };
}

/** Whether an AWS error means the thing is simply not there. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return (
    name === 'RepositoryNotFoundException' ||
    name === 'ResourceNotFoundException' ||
    name === 'ResourceNotFoundFault' ||
    name === 'ClusterNotFoundException' ||
    name === 'ServiceNotFoundException' ||
    name === 'ServiceNotActiveException' ||
    name === 'ObjectNotFoundException' ||
    name === 'InvalidLaunchTemplateId.NotFound' ||
    name === 'InvalidLaunchTemplateName.NotFoundException' ||
    name === 'ValidationError'
  );
}

/** Whether an AWS error means the thing is already there, which is success. */
function isAlreadyExists(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return (
    name === 'RepositoryAlreadyExistsException' ||
    name === 'ResourceAlreadyExistsException' ||
    name === 'ResourceInUseException' ||
    name === 'AlreadyExistsFault' ||
    name === 'InvalidLaunchTemplateName.AlreadyExistsException'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tags
// ───────────────────────────────────────────────────────────────────────────

/**
 * The tag set for a resource belonging to one microservice on one cluster.
 *
 * Both keys are present even though the relationship is one-to-one, because
 * they answer different questions: the Cost page groups instance-hours by
 * cluster and image storage by service, and the reaper matches on whichever it
 * has. A resource carrying only one of them is findable by half the callers.
 */
export function serviceTags(
  config: MicroserviceInfraConfig,
  service: string,
  cluster: string | null
): TagPairs {
  const specific: TagPairs = [[MICROSERVICE_TAG_KEY, service]];
  if (cluster) specific.push([COMPUTE_CLUSTER_TAG_KEY, cluster]);
  return resourceTags({ deployment: config.deployment, specific, costTag: config.costTag });
}

export function clusterTags(config: MicroserviceInfraConfig, cluster: string): TagPairs {
  return resourceTags({
    deployment: config.deployment,
    specific: [[COMPUTE_CLUSTER_TAG_KEY, cluster]],
    costTag: config.costTag,
  });
}

/** CodeBuild spells tags lowercase, like ECS. */
function toCodeBuildTags(pairs: TagPairs): Array<{ key: string; value: string }> {
  return pairs.map(([key, value]) => ({ key, value }));
}

/** Auto Scaling wants Key/Value plus a propagation flag per tag. */
function toAsgTags(
  pairs: TagPairs,
  asgName: string
): Array<{ Key: string; Value: string; PropagateAtLaunch: boolean; ResourceId: string; ResourceType: string }> {
  return pairs.map(([Key, Value]) => ({
    Key,
    Value,
    // The entire point. Without propagation the tags stop at the scaling group,
    // and the EC2 instances — the expensive part — carry nothing for Cost
    // Explorer to group by.
    PropagateAtLaunch: true,
    ResourceId: asgName,
    ResourceType: 'auto-scaling-group',
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// CloudWatch log groups
// ───────────────────────────────────────────────────────────────────────────

/**
 * Creates a log group if absent and applies its retention.
 *
 * Retention is set on every call rather than only at creation, because it is
 * the one property an operator changes after the fact — "rotate the logs" in a
 * console with no log server means exactly this. `null` removes the policy,
 * which is CloudWatch's way of spelling "never expire".
 */
export async function ensureLogGroup(
  config: MicroserviceInfraConfig,
  logGroupName: string,
  retentionDays: number | null,
  tags: TagPairs
): Promise<InfraResult> {
  const steps: string[] = [];
  try {
    try {
      await cwlogs.send(
        new CreateLogGroupCommand({ logGroupName, tags: toSqsTags(tags) })
      );
      steps.push(`log group ${logGroupName}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    if (retentionDays === null) {
      try {
        await cwlogs.send(new DeleteRetentionPolicyCommand({ logGroupName }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      steps.push('retention: never expire');
    } else {
      await cwlogs.send(
        new PutRetentionPolicyCommand({ logGroupName, retentionInDays: retentionDays })
      );
      steps.push(`retention: ${retentionDays}d`);
    }

    return ok(steps);
  } catch (error) {
    return failed(steps, error);
  }
}

export async function deleteLogGroup(logGroupName: string): Promise<InfraResult> {
  try {
    await cwlogs.send(new DeleteLogGroupCommand({ logGroupName }));
    return ok([`log group ${logGroupName} deleted`]);
  } catch (error) {
    if (isNotFound(error)) return ok([]);
    return failed([], error);
  }
}

/**
 * Empties a log group without deleting it.
 *
 * The manual counterpart to retention: an operator who has just fixed a service
 * that was logging a stack trace per frame wants the noise gone now, not in
 * thirty days, and wants the group to keep existing so the running task's log
 * driver does not start failing. Deleting the streams is the only way —
 * CloudWatch has no truncate.
 */
export async function clearLogGroup(logGroupName: string): Promise<InfraResult> {
  const steps: string[] = [];
  let deleted = 0;
  try {
    let token: string | undefined;
    do {
      const page = await cwlogs.send(
        new DescribeLogStreamsCommand({
          logGroupName,
          ...(token ? { nextToken: token } : {}),
        })
      );
      for (const stream of page.logStreams ?? []) {
        if (!stream.logStreamName) continue;
        try {
          await cwlogs.send(
            new DeleteLogStreamCommand({ logGroupName, logStreamName: stream.logStreamName })
          );
          deleted += 1;
        } catch (error) {
          // A stream the running task is actively writing can vanish between
          // the list and the delete. Not a failure.
          if (!isNotFound(error)) throw error;
        }
      }
      token = page.nextToken;
    } while (token);

    steps.push(`${deleted} log stream(s) deleted`);
    return ok(steps);
  } catch (error) {
    if (isNotFound(error)) return ok([`log group ${logGroupName} does not exist`]);
    return failed(steps, error);
  }
}

/** What the console shows about a log group: size, age, retention. */
export async function logGroupSummary(logGroupName: string) {
  try {
    const described = await cwlogs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName, limit: 5 })
    );
    const group = (described.logGroups ?? []).find((g) => g.logGroupName === logGroupName);
    if (!group) return null;
    return {
      name: logGroupName,
      stored_bytes: group.storedBytes ?? 0,
      retention_days: group.retentionInDays ?? null,
      created_at: group.creationTime ? new Date(group.creationTime).toISOString() : null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The last lines of a log, which is the part anyone is ever looking at.
 *
 * Deliberately not the Insights query the Logs page uses. That one searches
 * across groups and takes seconds to return because CloudWatch has to schedule
 * it; this answers "what did it just print" in one call, which is what you want
 * with a build that has failed or a task that will not start. The two are
 * different questions and reading the wrong one at the wrong moment is most of
 * why log pages feel slow.
 *
 * stdout and stderr are not separated, because CloudWatch does not separate
 * them: both the awslogs driver and CodeBuild write one interleaved stream, in
 * the order the process produced it. That interleaving is the useful artifact —
 * it is what shows which line of output the failure followed.
 */
export interface LogEvent {
  timestamp: string;
  message: string;
  /** The stream it came from — one per task for a container log. */
  stream: string | null;
}

/** One stream in a group, for choosing between them without reading them. */
export interface LogStreamInfo {
  name: string;
  last_event_at: string | null;
}

export interface LogTail {
  log_group: string | null;
  /** The streams actually read, newest first. */
  streams: string[];
  /**
   * Every stream in the group, newest first — which is not the same as the
   * ones read.
   *
   * A service running twenty tasks has twenty streams, and reading them all on
   * every poll would be twenty calls for a page of text. So the merged view
   * reads the newest few and this says what it passed over, which is what lets
   * the console offer the rest by name instead of pretending they are not
   * there.
   */
  available: LogStreamInfo[];
  /** Oldest first, so it reads like a terminal. */
  events: LogEvent[];
  /** Older events exist before the first one returned. */
  truncated: boolean;
}

const EMPTY_TAIL: LogTail = {
  log_group: null,
  streams: [],
  available: [],
  events: [],
  truncated: false,
};

/**
 * The streams in a group, newest first.
 *
 * Separate from reading them, because choosing which task to look at should not
 * cost a read of every task: this is one call and returns enough to fill a
 * picker.
 */
export async function listLogStreams(logGroup: string, limit = 50): Promise<LogStreamInfo[]> {
  try {
    const described = await cwlogs.send(
      new DescribeLogStreamsCommand({
        logGroupName: logGroup,
        orderBy: 'LastEventTime',
        descending: true,
        limit,
      })
    );
    return (described.logStreams ?? [])
      .filter((stream) => Boolean(stream.logStreamName))
      .map((stream) => ({
        name: stream.logStreamName as string,
        last_event_at: stream.lastEventTimestamp
          ? new Date(stream.lastEventTimestamp).toISOString()
          : null,
      }));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function eventsOf(
  raw: Array<{ timestamp?: number; message?: string }> | undefined,
  stream: string | null
): LogEvent[] {
  return (raw ?? []).map((event) => ({
    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : '',
    message: (event.message ?? '').replace(/\s+$/, ''),
    stream,
  }));
}

/**
 * The tail of one known stream — a build, whose output is a single stream.
 *
 * `startFromHead: false` is the whole point: it returns the *last* page rather
 * than the first. A failed build's reason is its last twenty lines, and reading
 * from the head means paging through a successful docker build to reach them.
 */
export async function tailLogStream(
  logGroup: string,
  logStream: string,
  limit: number,
  available: LogStreamInfo[] = []
): Promise<LogTail> {
  try {
    const result = await cwlogs.send(
      new GetLogEventsCommand({
        logGroupName: logGroup,
        logStreamName: logStream,
        limit,
        startFromHead: false,
      })
    );

    const events = eventsOf(result.events, logStream);
    return {
      log_group: logGroup,
      streams: [logStream],
      available,
      events,
      truncated: events.length >= limit,
    };
  } catch (error) {
    if (isNotFound(error)) return { ...EMPTY_TAIL, log_group: logGroup, available };
    throw error;
  }
}

/**
 * The tail of a group whose streams are not known ahead of time.
 *
 * A service's container logs are one stream per task, named after the task id,
 * and a task that has been replaced takes its stream out of use without
 * deleting it. So the newest streams are found first and read individually,
 * rather than filtering the group: `FilterLogEvents` returns a window from its
 * *start*, which for "what did it just print" is the wrong end of the log and
 * cannot be turned round without paging the whole window.
 *
 * Several streams because a service runs several tasks and the interesting line
 * is as likely to be in one as another. Merged and sorted, so the result reads
 * as one timeline with each line attributed to the task that wrote it.
 */
export async function tailLogGroup(
  logGroup: string,
  limit: number,
  maxStreams = 3,
  available?: LogStreamInfo[]
): Promise<LogTail> {
  const all = available ?? (await listLogStreams(logGroup));
  const streams = all.slice(0, maxStreams).map((stream) => stream.name);

  if (streams.length === 0) return { ...EMPTY_TAIL, log_group: logGroup, available: all };

  // Per stream rather than summed, so one chatty task cannot crowd out every
  // line another wrote.
  const perStream = Math.max(10, Math.ceil(limit / streams.length));
  const collected: LogEvent[] = [];
  let truncated = false;

  for (const stream of streams) {
    try {
      const result = await cwlogs.send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: stream,
          limit: perStream,
          startFromHead: false,
        })
      );
      const events = eventsOf(result.events, stream);
      if (events.length >= perStream) truncated = true;
      collected.push(...events);
    } catch (error) {
      // A stream deleted between listing and reading is not an error worth
      // failing the whole tail for.
      if (!isNotFound(error)) throw error;
    }
  }

  collected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const events = collected.slice(-limit);

  return {
    log_group: logGroup,
    streams,
    available: all,
    events,
    truncated: truncated || collected.length > events.length,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ECR
// ───────────────────────────────────────────────────────────────────────────

export function repositoryUri(config: MicroserviceInfraConfig, repositoryName: string): string {
  return `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/${repositoryName}`;
}

/**
 * Creates the image repository for a microservice.
 *
 * `imageScanningConfiguration` is on because it costs nothing on push and the
 * finding an operator most needs — a base image with a known CVE — is otherwise
 * invisible. `imageTagMutability: MUTABLE` because the deploy flow retags
 * `latest`, which an immutable repository refuses.
 */
export async function ensureRepository(
  config: MicroserviceInfraConfig,
  service: string,
  cluster: string | null
): Promise<InfraResult & { repositoryName: string; repositoryUri: string }> {
  const { ecrRepository } = microserviceNames(config.prefix, service);
  const steps: string[] = [];

  try {
    try {
      await ecr.send(
        new CreateRepositoryCommand({
          repositoryName: ecrRepository,
          imageTagMutability: 'MUTABLE',
          imageScanningConfiguration: { scanOnPush: true },
          tags: toTagSet(serviceTags(config, service, cluster)),
        })
      );
      steps.push(`ecr repository ${ecrRepository}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    // Applied every time: it is cheap, and a repository created before this
      // policy existed would otherwise keep every image forever.
    await ecr.send(
      new PutLifecyclePolicyCommand({
        repositoryName: ecrRepository,
        lifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              description: `Keep the last ${ECR_IMAGE_RETENTION_COUNT} images`,
              selection: {
                tagStatus: 'any',
                countType: 'imageCountMoreThan',
                countNumber: ECR_IMAGE_RETENTION_COUNT,
              },
              action: { type: 'expire' },
            },
          ],
        }),
      })
    );
    steps.push(`keep last ${ECR_IMAGE_RETENTION_COUNT} images`);

    return {
      ...ok(steps),
      repositoryName: ecrRepository,
      repositoryUri: repositoryUri(config, ecrRepository),
    };
  } catch (error) {
    return {
      ...failed(steps, error),
      repositoryName: ecrRepository,
      repositoryUri: repositoryUri(config, ecrRepository),
    };
  }
}

/**
 * Deletes the repository and every image in it.
 *
 * `force` is required and deliberate: a repository holding images cannot be
 * deleted without it, and leaving one behind on teardown means paying storage
 * for images nothing can ever run.
 */
export async function deleteRepository(
  config: MicroserviceInfraConfig,
  service: string
): Promise<InfraResult> {
  const { ecrRepository } = microserviceNames(config.prefix, service);
  try {
    await ecr.send(new DeleteRepositoryCommand({ repositoryName: ecrRepository, force: true }));
    return ok([`ecr repository ${ecrRepository} deleted`]);
  } catch (error) {
    if (isNotFound(error)) return ok([]);
    return failed([], error);
  }
}

/** The digest and size of an image tag, or null if it was never pushed. */
export async function imageSummary(repositoryName: string, imageTag: string) {
  try {
    const described = await ecr.send(
      new DescribeImagesCommand({ repositoryName, imageIds: [{ imageTag }] })
    );
    const image = described.imageDetails?.[0];
    if (!image) return null;
    return {
      digest: image.imageDigest ?? null,
      size_bytes: image.imageSizeInBytes ?? null,
      pushed_at: image.imagePushedAt ? new Date(image.imagePushedAt).toISOString() : null,
    };
  } catch (error) {
    if (isNotFound(error) || (error as { name?: string }).name === 'ImageNotFoundException') {
      return null;
    }
    throw error;
  }
}

/** Whether a repository exists at all — the cheap "is this provisioned" probe. */
export async function repositoryExists(repositoryName: string): Promise<boolean> {
  try {
    await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CodeBuild — turning a Dockerfile into an image
// ───────────────────────────────────────────────────────────────────────────

/**
 * The buildspec, identical for every microservice.
 *
 * `NO_SOURCE` with an explicit clone, rather than a CodeBuild GitHub source,
 * for one decisive reason: a GitHub source needs credentials stored on the
 * CodeBuild *account*, which is a single OAuth token shared by every project
 * and exactly the "a GitHub account is attached to this deployment" that the
 * whole App design exists to avoid. Cloning by hand lets each build carry a
 * fresh installation token, scoped to the repositories that installation
 * grants and dead in an hour.
 *
 * The token never appears in a command line. It is handed to git through a
 * credential helper reading the environment, so no clone URL, no error message
 * and no `set -x` can put it in the build log. Putting it in the URL — the
 * obvious way — leaks it into CloudWatch the first time a clone fails.
 *
 * Exported for the test that pins the shell against the commands below.
 */
export function buildSpec(): string {
  return JSON.stringify({
    version: '0.2',
    /**
     * bash, named explicitly, because `pipefail` is a bashism.
     *
     * CodeBuild's default shell on Linux is `/bin/sh`, which on these
     * Ubuntu-based images is dash — and dash answers `set -o pipefail` with
     * "Illegal option" and exit status 2. That is the first command of the
     * first phase, so every build failed before it had cloned anything, with an
     * error naming the `set` line and nothing about why.
     *
     * Worth keeping rather than dropping the option: the login below pipes a
     * password into `docker login`, and without `pipefail` a failure to mint
     * that password is hidden behind the exit status of the command consuming
     * it.
     */
    env: { shell: 'bash' },
    phases: {
      pre_build: {
        commands: [
          'set -euo pipefail',
          'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"',
          "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
          'git clone --depth 1 --single-branch --branch "$SOURCE_BRANCH" "https://github.com/$SOURCE_REPO.git" /tmp/src',
          'cd /tmp/src && git rev-parse HEAD > /tmp/commit_sha',
          'echo "Building $SOURCE_REPO@$(cat /tmp/commit_sha)"',
        ],
      },
      build: {
        commands: [
          'cd /tmp/src',
          // --pull so a stale cached base image cannot silently produce an
          // image different from what the Dockerfile now asks for.
          'docker build --pull -f "$DOCKERFILE_PATH" -t "$IMAGE_URI:$IMAGE_TAG" -t "$IMAGE_URI:latest" "$BUILD_CONTEXT"',
        ],
      },
      post_build: {
        commands: [
          // Both tags: the immutable one is what the task definition pins, and
          // `latest` is what a human pulls to reproduce a failure locally.
          'docker push "$IMAGE_URI:$IMAGE_TAG"',
          'docker push "$IMAGE_URI:latest"',
          'echo "Pushed $IMAGE_URI:$IMAGE_TAG"',
        ],
      },
    },
  });
}

/**
 * Creates or updates the build project for a microservice.
 *
 * One project per service rather than one shared project, because a shared one
 * cannot answer either question that matters: its CloudWatch logs interleave
 * every service's builds, and its CodeBuild minutes land on a single tag so
 * per-service build cost is unrecoverable. A project is free until it runs.
 */
export async function ensureBuildProject(
  config: MicroserviceInfraConfig,
  input: {
    service: string;
    cluster: string | null;
    buildLogGroup: string;
  }
): Promise<InfraResult & { projectName: string }> {
  const { buildProject } = microserviceNames(config.prefix, input.service);
  const steps: string[] = [];

  const definition = {
    name: buildProject,
    description: `Builds the ${input.service} microservice image for ${config.deployment}.`,
    source: { type: 'NO_SOURCE' as const, buildspec: buildSpec() },
    artifacts: { type: 'NO_ARTIFACTS' as const },
    environment: {
      type: 'LINUX_CONTAINER' as const,
      image: BUILD_IMAGE,
      computeType: BUILD_COMPUTE_TYPE,
      // Required to run a Docker daemon inside the build container. Without it
      // `docker build` fails with "Cannot connect to the Docker daemon".
      privilegedMode: true,
      environmentVariables: [
        { name: 'ECR_REGISTRY', value: `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com` },
        // Placeholders. Every one is overridden per build, because the branch
        // and paths can change between builds without the project changing.
        { name: 'SOURCE_REPO', value: 'unset' },
        { name: 'SOURCE_BRANCH', value: 'unset' },
        { name: 'DOCKERFILE_PATH', value: 'Dockerfile' },
        { name: 'BUILD_CONTEXT', value: '.' },
        { name: 'IMAGE_URI', value: 'unset' },
        { name: 'IMAGE_TAG', value: 'unset' },
        { name: 'GITHUB_TOKEN', value: 'unset' },
      ],
    },
    serviceRole: config.buildRoleArn,
    timeoutInMinutes: BUILD_TIMEOUT_MINUTES,
    logsConfig: {
      cloudWatchLogs: {
        status: 'ENABLED' as const,
        groupName: input.buildLogGroup,
        streamName: input.service,
      },
    },
  };

  try {
    try {
      await codebuild.send(
        new CreateProjectCommand({
          ...definition,
          tags: toCodeBuildTags(serviceTags(config, input.service, input.cluster)),
        })
      );
      steps.push(`build project ${buildProject}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // Updated rather than left alone: the buildspec above is versioned with
      // this file, and an existing project would keep running the old one.
      await codebuild.send(new UpdateProjectCommand(definition));
      steps.push(`build project ${buildProject} updated`);
    }

    return { ...ok(steps), projectName: buildProject };
  } catch (error) {
    return { ...failed(steps, error), projectName: buildProject };
  }
}

export async function deleteBuildProject(
  config: MicroserviceInfraConfig,
  service: string
): Promise<InfraResult> {
  const { buildProject } = microserviceNames(config.prefix, service);
  try {
    await codebuild.send(new DeleteProjectCommand({ name: buildProject }));
    return ok([`build project ${buildProject} deleted`]);
  } catch (error) {
    if (isNotFound(error)) return ok([]);
    return failed([], error);
  }
}

export async function buildProjectExists(projectName: string): Promise<boolean> {
  const described = await codebuild.send(new BatchGetProjectsCommand({ names: [projectName] }));
  return (described.projects ?? []).length > 0;
}

export interface StartBuildInput {
  projectName: string;
  repoFullName: string;
  branch: string;
  dockerfilePath: string;
  buildContext: string;
  imageUri: string;
  imageTag: string;
  /** Short-lived installation token, minted per build by the github-api function. */
  githubToken: string;
}

/**
 * Starts one image build and returns its id.
 *
 * The token is passed as a build-time override rather than stored on the
 * project, which is what keeps it short-lived: it exists only for this build's
 * environment and is never written to the project definition where a later
 * reader could recover it.
 */
export async function startImageBuild(
  input: StartBuildInput
): Promise<{ buildId: string; startedAt: string }> {
  const started = await codebuild.send(
    new StartBuildCommand({
      projectName: input.projectName,
      environmentVariablesOverride: [
        { name: 'SOURCE_REPO', value: input.repoFullName },
        { name: 'SOURCE_BRANCH', value: input.branch },
        { name: 'DOCKERFILE_PATH', value: input.dockerfilePath },
        { name: 'BUILD_CONTEXT', value: input.buildContext },
        { name: 'IMAGE_URI', value: input.imageUri },
        { name: 'IMAGE_TAG', value: input.imageTag },
        { name: 'GITHUB_TOKEN', value: input.githubToken },
      ],
    })
  );

  const buildId = started.build?.id;
  if (!buildId) throw new Error('StartBuild returned no build id.');
  return {
    buildId,
    startedAt: (started.build?.startTime ?? new Date()).toString(),
  };
}

export type BuildState = 'queued' | 'building' | 'succeeded' | 'failed' | 'stopped';

export interface BuildStatus {
  state: BuildState;
  detail: string | null;
  /** Head commit the build actually cloned, once it has got that far. */
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logGroup: string | null;
  logStream: string | null;
}

/**
 * Reads a build's current state.
 *
 * CodeBuild reports phase-level failure detail that is far more useful than the
 * status alone — "DOWNLOAD_SOURCE failed" and "BUILD failed" send an operator
 * to completely different places — so the first failing phase's context is
 * surfaced rather than a bare "FAILED".
 */
export async function buildStatus(buildId: string): Promise<BuildStatus | null> {
  const described = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const build = described.builds?.[0];
  if (!build) return null;

  const phase = (build.phases ?? []).find(
    (entry) => entry.phaseStatus && entry.phaseStatus !== 'SUCCEEDED'
  );
  const context = phase?.contexts?.[0];

  const state: BuildState =
    build.buildStatus === 'SUCCEEDED'
      ? 'succeeded'
      : build.buildStatus === 'IN_PROGRESS'
        ? build.currentPhase === 'QUEUED' || build.currentPhase === 'SUBMITTED'
          ? 'queued'
          : 'building'
        : build.buildStatus === 'STOPPED'
          ? 'stopped'
          : 'failed';

  const detail =
    state === 'succeeded'
      ? null
      : [phase?.phaseType, context?.statusCode, context?.message].filter(Boolean).join(': ') ||
        build.buildStatus ||
        null;

  return {
    state,
    detail,
    commitSha: build.resolvedSourceVersion ?? null,
    startedAt: build.startTime ? new Date(build.startTime).toISOString() : null,
    finishedAt: build.endTime ? new Date(build.endTime).toISOString() : null,
    logGroup: build.logs?.groupName ?? null,
    logStream: build.logs?.streamName ?? null,
  };
}

export async function stopBuild(buildId: string): Promise<InfraResult> {
  try {
    await codebuild.send(new StopBuildCommand({ id: buildId }));
    return ok(['build stopped']);
  } catch (error) {
    if (isNotFound(error)) return ok([]);
    return failed([], error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Compute clusters
// ───────────────────────────────────────────────────────────────────────────

export interface ClusterSpec {
  name: string;
  capacityType: 'fargate' | 'ec2';
  instanceType: string | null;
  scalingMode: 'fixed' | 'auto';
  minInstances: number;
  maxInstances: number;
  targetCapacity: number;
  gpusPerInstance: number;
  /** Root volume size, GiB. GPU images are large enough that the 30 GiB default is tight. */
  volumeSizeGib?: number | undefined;
}

/** Resolves the AMI for a cluster, and says which parameter it came from. */
export async function resolveClusterImage(
  spec: ClusterSpec
): Promise<{ imageId: string; parameter: string }> {
  const parameter = spec.gpusPerInstance > 0 ? AMI_PARAMETER_GPU : AMI_PARAMETER_STANDARD;
  const fetched = await ssm.send(new GetParameterCommand({ Name: parameter }));
  const imageId = fetched.Parameter?.Value;
  if (!imageId) throw new Error(`SSM parameter ${parameter} returned no AMI id.`);
  return { imageId, parameter };
}

/**
 * The instance boot script.
 *
 * Registering with the right cluster is the whole job — an instance that boots
 * without `ECS_CLUSTER` joins `default` instead, sits there healthy, and the
 * service it was launched for never places a task. `ECS_ENABLE_GPU_SUPPORT` is
 * what makes the agent enumerate the cards and advertise them as a resource;
 * without it a GPU task on a correctly-driven GPU instance still cannot place.
 */
function instanceUserData(ecsClusterName: string, gpu: boolean): string {
  const lines = [
    '#!/bin/bash',
    `echo "ECS_CLUSTER=${ecsClusterName}" >> /etc/ecs/ecs.config`,
    // Long enough for a model to flush and exit cleanly, short enough that a
    // hung container does not block a deployment for the 30-minute default.
    'echo "ECS_CONTAINER_STOP_TIMEOUT=2m" >> /etc/ecs/ecs.config',
    // So a container instance that has drained is not left registered.
    'echo "ECS_ENABLE_SPOT_INSTANCE_DRAINING=true" >> /etc/ecs/ecs.config',
  ];
  if (gpu) lines.push('echo "ECS_ENABLE_GPU_SUPPORT=true" >> /etc/ecs/ecs.config');
  return Buffer.from(`${lines.join('\n')}\n`).toString('base64');
}

/** Creates the ECS cluster. Free and instant — it is only a name and a container for capacity. */
export async function ensureEcsCluster(
  config: MicroserviceInfraConfig,
  spec: ClusterSpec
): Promise<InfraResult & { clusterName: string; clusterArn: string | null }> {
  const { cluster } = computeClusterNames(config.prefix, spec.name);
  const steps: string[] = [];

  try {
    const created = await ecs.send(
      new CreateClusterCommand({
        clusterName: cluster,
        // Container Insights is what makes the cluster health page possible:
        // without it there are no CPU/memory/GPU reservation metrics to show.
        settings: [{ name: 'containerInsights', value: 'enhanced' }],
        tags: toEcsTags(clusterTags(config, spec.name)),
        // Fargate clusters need the providers declared to place tasks on them;
        // an EC2 cluster gets its own provider attached below.
        ...(spec.capacityType === 'fargate'
          ? { capacityProviders: ['FARGATE', 'FARGATE_SPOT'] }
          : {}),
      })
    );
    steps.push(`ecs cluster ${cluster}`);
    return {
      ...ok(steps),
      clusterName: cluster,
      clusterArn: created.cluster?.clusterArn ?? null,
    };
  } catch (error) {
    return { ...failed(steps, error), clusterName: cluster, clusterArn: null };
  }
}

/**
 * Creates the EC2 capacity behind a cluster: launch template, scaling group,
 * capacity provider.
 *
 * The three are one unit — a capacity provider without a scaling group has
 * nothing to scale, and a scaling group not attached to a provider launches
 * instances ECS will never manage. Split across three AWS services, so this is
 * where a partial failure is most likely and each step is separately
 * idempotent.
 */
export async function ensureEc2Capacity(
  config: MicroserviceInfraConfig,
  spec: ClusterSpec,
  ecsClusterName: string
): Promise<
  InfraResult & {
    launchTemplateId: string | null;
    asgName: string | null;
    capacityProviderName: string | null;
    imageId: string | null;
  }
> {
  const names = computeClusterNames(config.prefix, spec.name);
  const steps: string[] = [];
  let launchTemplateId: string | null = null;
  let imageId: string | null = null;

  try {
    if (!spec.instanceType) {
      throw new Error('An EC2 cluster needs an instance type.');
    }

    const resolved = await resolveClusterImage(spec);
    imageId = resolved.imageId;
    steps.push(`ami ${resolved.imageId}`);

    const catalogued = instanceSpec(spec.instanceType);
    const gpu = spec.gpusPerInstance > 0;
    // GPU images and ML layers are large; the 30 GiB AMI default fills fast and
    // the failure reads as a mysterious task launch error, not a disk problem.
    const volumeSize = spec.volumeSizeGib ?? (gpu ? 200 : 50);

    const launchTemplateData = {
      ImageId: resolved.imageId,
      // Cast because the SDK types this as an enum of every instance type that
      // existed when the SDK was published, and free text is a documented
      // escape hatch here — a family AWS adds next quarter must still be usable
      // without waiting for a dependency bump. EC2 validates it anyway.
      InstanceType: spec.instanceType as _InstanceType,
      IamInstanceProfile: { Arn: config.instanceProfileArn },
      SecurityGroupIds: config.securityGroupIds,
      UserData: instanceUserData(ecsClusterName, gpu),
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: volumeSize,
            VolumeType: 'gp3' as const,
            DeleteOnTermination: true,
            Encrypted: true,
          },
        },
      ],
      MetadataOptions: {
        // IMDSv2 only. The task's own credentials come from the task role, so
        // nothing legitimately needs the v1 endpoint.
        HttpTokens: 'required' as const,
        HttpPutResponseHopLimit: 2,
      },
      TagSpecifications: [
        { ResourceType: 'instance' as const, Tags: toTagSet(clusterTags(config, spec.name)) },
        { ResourceType: 'volume' as const, Tags: toTagSet(clusterTags(config, spec.name)) },
      ],
    };

    try {
      const created = await ec2.send(
        new CreateLaunchTemplateCommand({
          LaunchTemplateName: names.launchTemplate,
          LaunchTemplateData: launchTemplateData,
          TagSpecifications: [
            {
              ResourceType: 'launch-template',
              Tags: toTagSet(clusterTags(config, spec.name)),
            },
          ],
        })
      );
      launchTemplateId = created.LaunchTemplate?.LaunchTemplateId ?? null;
      steps.push(`launch template ${names.launchTemplate}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // A new version rather than an edit: launch template versions are
      // immutable, and this is how an AMI refresh or an instance type change
      // reaches new instances. Existing instances keep running until replaced.
      const version = await ec2.send(
        new CreateLaunchTemplateVersionCommand({
          LaunchTemplateName: names.launchTemplate,
          LaunchTemplateData: launchTemplateData,
        })
      );
      launchTemplateId = version.LaunchTemplateVersion?.LaunchTemplateId ?? null;
      steps.push(`launch template version ${version.LaunchTemplateVersion?.VersionNumber ?? '?'}`);
    }

    const managedScaling = spec.scalingMode === 'auto';
    const desired = spec.minInstances;

    const asgShape = {
      MinSize: spec.minInstances,
      MaxSize: spec.maxInstances,
      DesiredCapacity: desired,
      VPCZoneIdentifier: config.subnetIds.join(','),
      LaunchTemplate: {
        LaunchTemplateName: names.launchTemplate,
        Version: '$Latest',
      },
      // Required by ECS managed termination protection: without it ECS refuses
      // to enable the protection, and a scale-in can kill an instance mid-task.
      NewInstancesProtectedFromScaleIn: managedScaling,
    };

    try {
      await autoscaling.send(
        new CreateAutoScalingGroupCommand({
          AutoScalingGroupName: names.autoScalingGroup,
          ...asgShape,
          Tags: toAsgTags(clusterTags(config, spec.name), names.autoScalingGroup),
        })
      );
      steps.push(`auto scaling group ${names.autoScalingGroup}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await autoscaling.send(
        new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: names.autoScalingGroup,
          ...asgShape,
        })
      );
      steps.push(`auto scaling group ${names.autoScalingGroup} updated`);
    }

    const asgArn = await autoScalingGroupArn(names.autoScalingGroup);
    if (!asgArn) throw new Error(`Auto Scaling group ${names.autoScalingGroup} has no ARN.`);

    try {
      await ecs.send(
        new CreateCapacityProviderCommand({
          name: names.capacityProvider,
          autoScalingGroupProvider: {
            autoScalingGroupArn: asgArn,
            managedScaling: {
              status: managedScaling ? 'ENABLED' : 'DISABLED',
              targetCapacity: spec.targetCapacity,
              minimumScalingStepSize: 1,
              maximumScalingStepSize: Math.max(1, Math.min(10, spec.maxInstances)),
              instanceWarmupPeriod: 300,
            },
            // Only valid with managed scaling on. Enabled there because it is
            // what stops a scale-in from terminating an instance still running
            // tasks — the difference between graceful and abrupt.
            managedTerminationProtection: managedScaling ? 'ENABLED' : 'DISABLED',
          },
          tags: toEcsTags(clusterTags(config, spec.name)),
        })
      );
      steps.push(`capacity provider ${names.capacityProvider}`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      steps.push(`capacity provider ${names.capacityProvider} exists`);
    }

    await ecs.send(
      new PutClusterCapacityProvidersCommand({
        cluster: ecsClusterName,
        capacityProviders: [names.capacityProvider],
        defaultCapacityProviderStrategy: [{ capacityProvider: names.capacityProvider, weight: 1 }],
      })
    );
    steps.push('capacity provider attached');

    return {
      ...ok(steps),
      launchTemplateId,
      asgName: names.autoScalingGroup,
      capacityProviderName: names.capacityProvider,
      imageId,
    };
  } catch (error) {
    return {
      ...failed(steps, error),
      launchTemplateId,
      asgName: names.autoScalingGroup,
      capacityProviderName: names.capacityProvider,
      imageId,
    };
  }
}

async function autoScalingGroupArn(asgName: string): Promise<string | null> {
  const described = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] })
  );
  return described.AutoScalingGroups?.[0]?.AutoScalingGroupARN ?? null;
}

/**
 * Tears a cluster's capacity down, in the order AWS actually permits.
 *
 * The order is not a preference. A capacity provider cannot be deleted while it
 * is attached to a cluster, a scaling group with managed termination protection
 * cannot be deleted until the provider is gone, and a launch template in use by
 * a scaling group cannot be deleted at all. Reversing any two of these produces
 * a resource that survives teardown and keeps billing.
 */
export async function deleteEc2Capacity(
  config: MicroserviceInfraConfig,
  clusterName: string,
  ecsClusterName: string
): Promise<InfraResult> {
  const names = computeClusterNames(config.prefix, clusterName);
  const steps: string[] = [];

  try {
    // 1. Detach the provider from the cluster by putting an empty list.
    try {
      await ecs.send(
        new PutClusterCapacityProvidersCommand({
          cluster: ecsClusterName,
          capacityProviders: [],
          defaultCapacityProviderStrategy: [],
        })
      );
      steps.push('capacity provider detached');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    // 2. Scale to zero and drop protection, or the delete below is refused
    //    while instances are still protected from scale-in.
    try {
      await autoscaling.send(
        new UpdateAutoScalingGroupCommand({
          AutoScalingGroupName: names.autoScalingGroup,
          MinSize: 0,
          DesiredCapacity: 0,
          NewInstancesProtectedFromScaleIn: false,
        })
      );
      steps.push('scaling group drained');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await ecs.send(new DeleteCapacityProviderCommand({ capacityProvider: names.capacityProvider }));
      steps.push('capacity provider deleted');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    // 3. ForceDelete because instances are still terminating and waiting for
    //    them would hold the request open for minutes.
    try {
      await autoscaling.send(
        new DeleteAutoScalingGroupCommand({
          AutoScalingGroupName: names.autoScalingGroup,
          ForceDelete: true,
        })
      );
      steps.push('scaling group deleted');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await ec2.send(
        new DeleteLaunchTemplateCommand({ LaunchTemplateName: names.launchTemplate })
      );
      steps.push('launch template deleted');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    return ok(steps);
  } catch (error) {
    return failed(steps, error);
  }
}

export async function deleteEcsCluster(
  config: MicroserviceInfraConfig,
  clusterName: string
): Promise<InfraResult> {
  const { cluster } = computeClusterNames(config.prefix, clusterName);
  try {
    await ecs.send(new DeleteClusterCommand({ cluster }));
    return ok([`ecs cluster ${cluster} deleted`]);
  } catch (error) {
    if (isNotFound(error)) return ok([]);
    return failed([], error);
  }
}

/** Whether a launch template still exists — used to detect drift. */
export async function launchTemplateExists(launchTemplateName: string): Promise<boolean> {
  try {
    await ec2.send(
      new DescribeLaunchTemplatesCommand({ LaunchTemplateNames: [launchTemplateName] })
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Task definitions and services
// ───────────────────────────────────────────────────────────────────────────

export interface ServiceSpec {
  /** Registry name, used for the ECS service and task family. */
  name: string;
  cluster: ClusterSpec;
  imageUri: string;
  imageTag: string;
  cpu: number;
  memory: number;
  containerPort: number | null;
  desiredCount: number;
  scalingMode: 'fixed' | 'auto';
  minTasks: number;
  maxTasks: number;
  scalingMetric: 'cpu' | 'memory';
  scalingTarget: number;
  scaleOutCooldown: number;
  scaleInCooldown: number;
  /** 'shared' | 'exclusive', from the cluster. Decides how the GPU is claimed. */
  gpuMode: 'shared' | 'exclusive';
  logGroup: string;
}

/**
 * Registers a task definition revision for a microservice.
 *
 * ## The GPU decision
 *
 * This is where `gpu_mode` stops being a database column and becomes two
 * genuinely different scheduling behaviours.
 *
 * `exclusive` declares `resourceRequirements: [{ type: 'GPU', value: '1' }]`.
 * ECS then treats GPUs as a countable resource: it places one task per card and
 * refuses to place more, and the agent sets `NVIDIA_VISIBLE_DEVICES` to that
 * card alone. Enforced, predictable, and a whole card even for a task using a
 * tenth of it.
 *
 * `shared` declares no GPU requirement at all and sets
 * `NVIDIA_VISIBLE_DEVICES=all` by hand. ECS packs tasks by CPU and memory like
 * any other cluster, and every task sees every card. This is the only way to
 * get finer granularity than one whole GPU — `resourceRequirements` takes an
 * integer and nothing below the driver enforces a fraction — and the price is
 * that video memory is unguarded, which is why `gpu_vram_mb` is summed and
 * refused by the console before it ever gets here.
 *
 * Both need the GPU-optimized AMI. Neither works on Fargate, which has no GPUs
 * at all; the cluster form refuses that combination long before this runs.
 */
export async function registerServiceTaskDefinition(
  config: MicroserviceInfraConfig,
  spec: ServiceSpec
): Promise<{ taskDefinitionArn: string }> {
  const names = microserviceNames(config.prefix, spec.name);
  const isFargate = spec.cluster.capacityType === 'fargate';
  const gpu = spec.cluster.gpusPerInstance > 0;

  const environment = Object.entries({
    ...config.taskEnvironment,
    MSIGHT_MICROSERVICE: spec.name,
    MSIGHT_CLUSTER: spec.cluster.name,
    MSIGHT_IMAGE_TAG: spec.imageTag,
    ...(gpu && spec.gpuMode === 'shared' ? { NVIDIA_VISIBLE_DEVICES: 'all' } : {}),
  }).map(([name, value]) => ({ name, value }));

  const registered = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: names.taskFamily,
      // awsvpc on both launch types, deliberately. It gives an EC2 task its own
      // ENI and therefore the same security group the Lambdas use, which is
      // what lets it reach the RDS proxy and Valkey — a bridge-mode task would
      // inherit the instance's groups and need a separate ingress rule.
      networkMode: 'awsvpc',
      requiresCompatibilities: [isFargate ? 'FARGATE' : 'EC2'],
      cpu: String(spec.cpu),
      memory: String(spec.memory),
      executionRoleArn: config.executionRoleArn,
      taskRoleArn: config.taskRoleArn,
      containerDefinitions: [
        {
          name: spec.name,
          image: `${spec.imageUri}:${spec.imageTag}`,
          essential: true,
          environment,
          ...(spec.containerPort
            ? { portMappings: [{ containerPort: spec.containerPort, protocol: 'tcp' as const }] }
            : {}),
          ...(gpu && spec.gpuMode === 'exclusive'
            ? { resourceRequirements: [{ type: 'GPU' as const, value: '1' }] }
            : {}),
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': spec.logGroup,
              'awslogs-region': config.region,
              'awslogs-stream-prefix': spec.name,
            },
          },
        },
      ],
      tags: toEcsTags(serviceTags(config, spec.name, spec.cluster.name)),
    })
  );

  const arn = registered.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error(`RegisterTaskDefinition returned no ARN for ${spec.name}.`);
  return { taskDefinitionArn: arn };
}

/**
 * Creates or updates the ECS service.
 *
 * `desiredCount` is only sent when the service runs a fixed count. Under
 * autoscaling, sending it on every update fights the scaling policy: the
 * console would reset the count to its stored figure on each save and Auto
 * Scaling would immediately move it back, producing a service that visibly
 * flaps for reasons nothing in either console explains.
 */
export async function ensureService(
  config: MicroserviceInfraConfig,
  spec: ServiceSpec,
  ecsClusterName: string,
  taskDefinitionArn: string
): Promise<InfraResult & { serviceArn: string | null }> {
  const names = microserviceNames(config.prefix, spec.name);
  const steps: string[] = [];

  try {
    const networkConfiguration = {
      awsvpcConfiguration: {
        subnets: config.subnetIds,
        securityGroups: config.securityGroupIds,
        assignPublicIp: 'DISABLED' as const,
      },
    };

    const described = await ecs.send(
      new DescribeServicesCommand({ cluster: ecsClusterName, services: [names.service] })
    );
    const existing = described.services?.find((entry) => entry.status !== 'INACTIVE');

    if (existing) {
      await ecs.send(
        new UpdateServiceCommand({
          cluster: ecsClusterName,
          service: names.service,
          taskDefinition: taskDefinitionArn,
          networkConfiguration,
          ...(spec.scalingMode === 'fixed' ? { desiredCount: spec.desiredCount } : {}),
        })
      );
      steps.push('ecs service updated');
      return { ...ok(steps), serviceArn: existing.serviceArn ?? null };
    }

    const created = await ecs.send(
      new CreateServiceCommand({
        cluster: ecsClusterName,
        serviceName: names.service,
        taskDefinition: taskDefinitionArn,
        desiredCount: spec.scalingMode === 'fixed' ? spec.desiredCount : spec.minTasks,
        networkConfiguration,
        ...(spec.cluster.capacityType === 'fargate'
          ? { launchType: 'FARGATE' as const }
          : {
              // The capacity provider, not `launchType: EC2` — that is what
              // lets ECS scale the instances to fit pending tasks. With a bare
              // launch type the tasks simply stay PENDING when capacity runs
              // out and nothing grows the group.
              capacityProviderStrategy: [
                {
                  capacityProvider: computeClusterNames(config.prefix, spec.cluster.name)
                    .capacityProvider,
                  weight: 1,
                },
              ],
            }),
        // Billed against the task on Fargate, and tasks inherit nothing unless
        // this is set — without it the service's spend is invisible to the cost
        // allocation tag.
        propagateTags: 'SERVICE',
        tags: toEcsTags(serviceTags(config, spec.name, spec.cluster.name)),
        // So an operator can get a shell in a running container from the
        // console's instructions rather than needing an SSH path to the host.
        enableExecuteCommand: true,
      })
    );
    steps.push(`ecs service ${names.service}`);
    return { ...ok(steps), serviceArn: created.service?.serviceArn ?? null };
  } catch (error) {
    return { ...failed(steps, error), serviceArn: null };
  }
}

/**
 * Registers or removes the target-tracking scaling policy.
 *
 * Deregistering on 'fixed' is as important as registering on 'auto': a scalable
 * target left behind keeps its policy, and the policy keeps moving a count the
 * operator has just declared fixed.
 */
export async function ensureServiceScaling(
  config: MicroserviceInfraConfig,
  spec: ServiceSpec,
  ecsClusterName: string
): Promise<InfraResult> {
  const names = microserviceNames(config.prefix, spec.name);
  const resourceId = `service/${ecsClusterName}/${names.service}`;
  const steps: string[] = [];

  try {
    if (spec.scalingMode === 'fixed') {
      try {
        await appAutoScaling.send(
          new DeregisterScalableTargetCommand({
            ServiceNamespace: 'ecs',
            ResourceId: resourceId,
            ScalableDimension: 'ecs:service:DesiredCount',
          })
        );
        steps.push('autoscaling removed');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return ok(steps);
    }

    await appAutoScaling.send(
      new RegisterScalableTargetCommand({
        ServiceNamespace: 'ecs',
        ResourceId: resourceId,
        ScalableDimension: 'ecs:service:DesiredCount',
        MinCapacity: spec.minTasks,
        MaxCapacity: spec.maxTasks,
        Tags: Object.fromEntries(serviceTags(config, spec.name, spec.cluster.name)),
      })
    );
    steps.push(`scalable target ${spec.minTasks}-${spec.maxTasks}`);

    await appAutoScaling.send(
      new PutScalingPolicyCommand({
        PolicyName: `${names.service}-target-tracking`,
        ServiceNamespace: 'ecs',
        ResourceId: resourceId,
        ScalableDimension: 'ecs:service:DesiredCount',
        PolicyType: 'TargetTrackingScaling',
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: spec.scalingTarget,
          PredefinedMetricSpecification: {
            PredefinedMetricType:
              spec.scalingMetric === 'memory'
                ? 'ECSServiceAverageMemoryUtilization'
                : 'ECSServiceAverageCPUUtilization',
          },
          ScaleOutCooldown: spec.scaleOutCooldown,
          ScaleInCooldown: spec.scaleInCooldown,
        },
      })
    );
    steps.push(`target ${spec.scalingTarget}% ${spec.scalingMetric}`);

    return ok(steps);
  } catch (error) {
    return failed(steps, error);
  }
}

/**
 * Removes a service.
 *
 * Scaled to zero first, then force-deleted. `force` alone would do it, but
 * scaling down first is what makes the tasks stop before the service record
 * disappears — otherwise the capacity provider can be left holding instances
 * for tasks whose service no longer exists.
 */
export async function deleteService(
  config: MicroserviceInfraConfig,
  service: string,
  ecsClusterName: string
): Promise<InfraResult> {
  const names = microserviceNames(config.prefix, service);
  const steps: string[] = [];

  try {
    try {
      await appAutoScaling.send(
        new DeregisterScalableTargetCommand({
          ServiceNamespace: 'ecs',
          ResourceId: `service/${ecsClusterName}/${names.service}`,
          ScalableDimension: 'ecs:service:DesiredCount',
        })
      );
      steps.push('autoscaling removed');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await ecs.send(
        new UpdateServiceCommand({
          cluster: ecsClusterName,
          service: names.service,
          desiredCount: 0,
        })
      );
      steps.push('scaled to zero');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await ecs.send(
        new DeleteServiceCommand({ cluster: ecsClusterName, service: names.service, force: true })
      );
      steps.push('ecs service deleted');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    return ok(steps);
  } catch (error) {
    return failed(steps, error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Status and health
// ───────────────────────────────────────────────────────────────────────────

export interface ServiceRuntimeStatus {
  exists: boolean;
  status: string | null;
  desired_count: number;
  running_count: number;
  pending_count: number;
  task_definition: string | null;
  /** Most recent deployment's rollout state — the answer to "did my deploy land". */
  rollout_state: string | null;
  rollout_detail: string | null;
  /** ECS service events, newest first. The only place a placement failure is explained. */
  events: Array<{ at: string; message: string }>;
  tasks: Array<{
    arn: string;
    last_status: string | null;
    health_status: string | null;
    started_at: string | null;
    stopped_reason: string | null;
    /**
     * Where it ran.
     *
     * `container_instance` is null on Fargate, which has no instances — the
     * zone is the only placement fact there, and it is worth keeping for both:
     * on EC2 it explains why a task landed on one node rather than another.
     *
     * This is also what attributes a log stream to a machine. A stream is named
     * after the task and never after the host, so "which node wrote this" is a
     * join through here and cannot be read off the log at all.
     */
    container_instance: string | null;
    availability_zone: string | null;
  }>;
}

/**
 * What a service is actually doing right now.
 *
 * The events list is the point. A service stuck at 0/1 running says nothing on
 * its own; the event "unable to place a task because no container instance met
 * all of its requirements" is the entire diagnosis, and it exists nowhere else.
 */
export async function serviceRuntimeStatus(
  config: MicroserviceInfraConfig,
  service: string,
  ecsClusterName: string
): Promise<ServiceRuntimeStatus> {
  const names = microserviceNames(config.prefix, service);
  const empty: ServiceRuntimeStatus = {
    exists: false,
    status: null,
    desired_count: 0,
    running_count: 0,
    pending_count: 0,
    task_definition: null,
    rollout_state: null,
    rollout_detail: null,
    events: [],
    tasks: [],
  };

  let described;
  try {
    described = await ecs.send(
      new DescribeServicesCommand({
        cluster: ecsClusterName,
        services: [names.service],
      })
    );
  } catch (error) {
    if (isNotFound(error)) return empty;
    throw error;
  }

  const found = described.services?.find((entry) => entry.status !== 'INACTIVE');
  if (!found) return empty;

  const primary = (found.deployments ?? []).find((entry) => entry.status === 'PRIMARY');

  let tasks: ServiceRuntimeStatus['tasks'] = [];
  try {
    const listed = await ecs.send(
      new ListTasksCommand({ cluster: ecsClusterName, serviceName: names.service })
    );
    if (listed.taskArns?.length) {
      const detailed = await ecs.send(
        new DescribeTasksCommand({ cluster: ecsClusterName, tasks: listed.taskArns })
      );
      tasks = (detailed.tasks ?? []).map((task) => ({
        arn: task.taskArn ?? '',
        last_status: task.lastStatus ?? null,
        health_status: task.healthStatus ?? null,
        started_at: task.startedAt ? new Date(task.startedAt).toISOString() : null,
        stopped_reason: task.stoppedReason ?? null,
        // The id alone: the ARN's last segment is what `clusterHealth` reports
        // as a container instance id, so this is the join key between a task
        // and the node underneath it.
        container_instance: task.containerInstanceArn
          ? (task.containerInstanceArn.split('/').pop() ?? null)
          : null,
        availability_zone: task.availabilityZone ?? null,
      }));
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return {
    exists: true,
    status: found.status ?? null,
    desired_count: found.desiredCount ?? 0,
    running_count: found.runningCount ?? 0,
    pending_count: found.pendingCount ?? 0,
    task_definition: found.taskDefinition ?? null,
    rollout_state: primary?.rolloutState ?? null,
    rollout_detail: primary?.rolloutStateReason ?? null,
    events: (found.events ?? []).slice(0, 12).map((event) => ({
      at: event.createdAt ? new Date(event.createdAt).toISOString() : '',
      message: event.message ?? '',
    })),
    tasks,
  };
}

export interface ClusterHealth {
  exists: boolean;
  status: string | null;
  registered_instances: number;
  /** Instances the agent has lost contact with. A nonzero value here is the fault. */
  disconnected_instances: number;
  running_tasks: number;
  pending_tasks: number;
  /** Summed across registered instances, so capacity arithmetic needs no guessing. */
  registered_cpu: number;
  remaining_cpu: number;
  registered_memory_mib: number;
  remaining_memory_mib: number;
  registered_gpus: number;
  remaining_gpus: number;
  instances: Array<{
    id: string;
    ec2_instance_id: string | null;
    status: string | null;
    agent_connected: boolean;
    agent_version: string | null;
    running_tasks: number;
    pending_tasks: number;
    /**
     * Registered as well as remaining, per instance.
     *
     * "4096 CPU units left" is not a fact anyone can act on without knowing
     * what the box has. The pair is, and it is the only way the console can
     * draw how full a node is — ECS reports both and reporting only one made
     * the totals at the top the sole usable number on the page.
     */
    registered_cpu: number;
    remaining_cpu: number;
    registered_memory_mib: number;
    remaining_memory_mib: number;
    registered_gpus: number;
    remaining_gpus: number;
  }>;
}

/**
 * Cluster health, from ECS rather than CloudWatch.
 *
 * Registered resources come from the container instances themselves, which is
 * the only source that reflects what ECS believes it can schedule. The GPU
 * numbers are the reason this exists: a GPU cluster whose instances booted from
 * the wrong AMI reports zero registered GPUs while looking perfectly healthy by
 * every other measure, and that single figure is the difference between "my
 * task will not start" and knowing why.
 */
export async function clusterHealth(ecsClusterName: string): Promise<ClusterHealth> {
  const empty: ClusterHealth = {
    exists: false,
    status: null,
    registered_instances: 0,
    disconnected_instances: 0,
    running_tasks: 0,
    pending_tasks: 0,
    registered_cpu: 0,
    remaining_cpu: 0,
    registered_memory_mib: 0,
    remaining_memory_mib: 0,
    registered_gpus: 0,
    remaining_gpus: 0,
    instances: [],
  };

  let described;
  try {
    described = await ecs.send(new DescribeClustersCommand({ clusters: [ecsClusterName] }));
  } catch (error) {
    if (isNotFound(error)) return empty;
    throw error;
  }

  const cluster = described.clusters?.[0];
  if (!cluster || cluster.status === 'INACTIVE') return empty;

  const health: ClusterHealth = {
    ...empty,
    exists: true,
    status: cluster.status ?? null,
    running_tasks: cluster.runningTasksCount ?? 0,
    pending_tasks: cluster.pendingTasksCount ?? 0,
    registered_instances: cluster.registeredContainerInstancesCount ?? 0,
  };

  const listed = await ecs.send(new ListContainerInstancesCommand({ cluster: ecsClusterName }));
  if (!listed.containerInstanceArns?.length) return health;

  const detailed = await ecs.send(
    new DescribeContainerInstancesCommand({
      cluster: ecsClusterName,
      containerInstances: listed.containerInstanceArns,
    })
  );

  const numberOf = (
    resources: Array<{ name?: string; integerValue?: number; stringSetValue?: string[] }> | undefined,
    name: string
  ): number => {
    const entry = (resources ?? []).find((item) => item.name === name);
    if (!entry) return 0;
    // GPUs are reported as a set of device ids, not a count — the integer field
    // is zero for them, which reads as "no GPUs" if you only check that.
    if (entry.stringSetValue?.length) return entry.stringSetValue.length;
    return entry.integerValue ?? 0;
  };

  for (const instance of detailed.containerInstances ?? []) {
    const registered = instance.registeredResources;
    const remaining = instance.remainingResources;
    const connected = instance.agentConnected ?? false;
    if (!connected) health.disconnected_instances += 1;

    health.registered_cpu += numberOf(registered, 'CPU');
    health.remaining_cpu += numberOf(remaining, 'CPU');
    health.registered_memory_mib += numberOf(registered, 'MEMORY');
    health.remaining_memory_mib += numberOf(remaining, 'MEMORY');
    health.registered_gpus += numberOf(registered, 'GPU');
    health.remaining_gpus += numberOf(remaining, 'GPU');

    health.instances.push({
      id: (instance.containerInstanceArn ?? '').split('/').pop() ?? '',
      ec2_instance_id: instance.ec2InstanceId ?? null,
      status: instance.status ?? null,
      agent_connected: connected,
      agent_version: instance.versionInfo?.agentVersion ?? null,
      running_tasks: instance.runningTasksCount ?? 0,
      pending_tasks: instance.pendingTasksCount ?? 0,
      registered_cpu: numberOf(registered, 'CPU'),
      remaining_cpu: numberOf(remaining, 'CPU'),
      registered_memory_mib: numberOf(registered, 'MEMORY'),
      remaining_memory_mib: numberOf(remaining, 'MEMORY'),
      registered_gpus: numberOf(registered, 'GPU'),
      remaining_gpus: numberOf(remaining, 'GPU'),
    });
  }

  return health;
}

/**
 * Restarts a service's tasks without changing anything about it.
 *
 * `forceNewDeployment` is the whole mechanism: it starts a fresh deployment on
 * the same task definition, so tasks are replaced one rollout at a time rather
 * than all stopped at once. The ordinary reason to want it is an image rebuilt
 * under the same tag — the definition is unchanged, so nothing else would make
 * ECS pull it again.
 */
export async function restartService(
  config: MicroserviceInfraConfig,
  service: string,
  ecsClusterName: string
): Promise<InfraResult> {
  const names = microserviceNames(config.prefix, service);
  try {
    await ecs.send(
      new UpdateServiceCommand({
        cluster: ecsClusterName,
        service: names.service,
        forceNewDeployment: true,
      })
    );
    return ok(['new deployment started']);
  } catch (error) {
    if (isNotFound(error)) return failed([], new Error('The service does not exist.'));
    return failed([], error);
  }
}
