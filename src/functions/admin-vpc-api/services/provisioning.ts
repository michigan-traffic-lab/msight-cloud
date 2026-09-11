import { HttpError } from '../../../shared/admin-api/http';
import {
  computeClusterNames,
  microserviceNames,
  names as resourceNames,
} from '../../../shared/deployment-naming';
import {
  buildStatus,
  clearLogGroup,
  clusterHealth,
  deleteBuildProject,
  deleteEc2Capacity,
  deleteEcsCluster,
  deleteLogGroup,
  deleteRepository,
  deleteService,
  ensureBuildProject,
  ensureEc2Capacity,
  ensureEcsCluster,
  ensureLogGroup,
  ensureRepository,
  ensureService,
  ensureServiceScaling,
  imageSummary,
  logGroupSummary,
  registerServiceTaskDefinition,
  restartService,
  serviceRuntimeStatus,
  listLogStreams,
  serviceTags,
  startImageBuild,
  stopBuild,
  tailLogGroup,
  tailLogStream,
  type ClusterSpec,
  type InfraResult,
  type LogTail,
  type MicroserviceInfraConfig,
  type ServiceSpec,
} from '../../../shared/microservice-infrastructure';
import { instanceSpec, taskMemoryCeiling } from '../../../shared/instance-catalog';
import { ensureMicroserviceSchema } from '../../../shared/microservice-schema';
import { getPool } from './db';
import { requireCluster, type ClusterRow } from './clusters';
import {
  LAUNCH_IN_FLIGHT,
  checkMicroservice,
  removeMicroservice,
  requireMicroservice,
  type LaunchState,
  type MicroserviceRow,
} from './microservices';
import { cloneToken } from './github-client';

/**
 * Turns registry rows into AWS resources, and back again.
 *
 * The registry says what should exist; this module makes it so. It is the only
 * place the two meet, which is deliberate: `microservices.ts` and `clusters.ts`
 * stay pure validation over Aurora and know nothing about ECS, and
 * `microservice-infrastructure.ts` stays pure AWS and knows nothing about the
 * database. Everything that has to understand both — which column a created
 * resource is recorded in, what a half-finished provision means, which order to
 * tear down in — is here.
 *
 * ## The lifecycle
 *
 * A microservice moves through four states, and each transition is an explicit
 * operator action rather than something that happens on save:
 *
 *   not_provisioned → provision  → scaffolded
 *   scaffolded      → build      → (image in ECR)
 *   scaffolded      → deploy     → provisioned
 *   provisioned     → deprovision → not_provisioned
 *
 * Split that way because the expensive and destructive steps must be chosen.
 * Provisioning creates a repository and log groups, which cost approximately
 * nothing. Building spends CodeBuild minutes. Deploying starts instances that
 * bill by the second. Each is separately callable, and separately repairable
 * when one of them fails.
 *
 * ## Launching
 *
 * Being separately callable is not the same as having to be called separately.
 * `launchMicroservice` takes all three transitions as one decision — the
 * decision the operator already made by filling in the form and asking for the
 * service to run — and `advanceLaunch` carries it across the gap the build
 * opens in the middle, since no Lambda can stay alive for a docker build. The
 * per-step routes remain, because a failure halfway needs a way to resume the
 * step that failed rather than the whole sequence.
 */

// ───────────────────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────────────────

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new HttpError(
      500,
      'not_configured',
      `${key} is not set on the in-VPC admin function, so microservices cannot be ` +
        'provisioned. This is a deployment problem, not a configuration one.'
    );
  }
  return value;
}

/**
 * The environment every microservice container receives.
 *
 * Assembled by the CDK stack into one JSON blob rather than a dozen separate
 * variables, because the set grows: a microservice sees the same deployment the
 * sensor consumers do — the database proxy, the cache, the topics — and adding
 * one more should not mean editing three files.
 */
function taskEnvironment(): Record<string, string> {
  const raw = process.env.MICROSERVICE_TASK_ENV;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)])
    );
  } catch {
    throw new HttpError(
      500,
      'not_configured',
      'MICROSERVICE_TASK_ENV is not valid JSON, so no task definition can be built.'
    );
  }
}

export function infraConfig(): MicroserviceInfraConfig {
  const costKey = process.env.COST_TAG_KEY;
  const costValue = process.env.COST_TAG_VALUE;

  return {
    deployment: required('DEPLOYMENT_NAME'),
    prefix: required('MICROSERVICE_RESOURCE_PREFIX'),
    // Required rather than defaulted to the deployment name. That default is
    // what silently produced log group names outside this function's own IAM
    // policy; a missing value should say so, not guess wrong.
    logPrefix: required('LOG_PREFIX'),
    region: required('AWS_REGION'),
    accountId: required('AWS_ACCOUNT_ID'),
    subnetIds: required('MICROSERVICE_SUBNET_IDS').split(',').filter(Boolean),
    securityGroupIds: required('MICROSERVICE_SECURITY_GROUP_IDS').split(',').filter(Boolean),
    taskRoleArn: required('MICROSERVICE_TASK_ROLE_ARN'),
    executionRoleArn: required('MICROSERVICE_EXECUTION_ROLE_ARN'),
    buildRoleArn: required('MICROSERVICE_BUILD_ROLE_ARN'),
    instanceProfileArn: required('MICROSERVICE_INSTANCE_PROFILE_ARN'),
    taskEnvironment: taskEnvironment(),
    ...(costKey && costValue ? { costTag: { key: costKey, value: costValue } } : {}),
  };
}

/** The ECS cluster name for a registry cluster row. */
function ecsClusterNameFor(config: MicroserviceInfraConfig, cluster: string): string {
  return computeClusterNames(config.prefix, cluster).cluster;
}

function clusterSpecOf(row: ClusterRow): ClusterSpec {
  return {
    name: row.name,
    capacityType: row.capacity_type,
    instanceType: row.instance_type,
    scalingMode: row.scaling_mode,
    minInstances: row.min_instances,
    maxInstances: row.max_instances,
    targetCapacity: row.target_capacity,
    gpusPerInstance: row.gpus_per_instance,
  };
}

/** Collapses a run of engine results, keeping every step and the first error. */
function combine(results: InfraResult[]): InfraResult {
  const steps = results.flatMap((result) => result.steps);
  const error = results.find((result) => result.error)?.error ?? null;
  return { steps, error };
}

// ───────────────────────────────────────────────────────────────────────────
// Clusters
// ───────────────────────────────────────────────────────────────────────────

export interface ProvisionResult {
  name: string;
  provision_state: string;
  steps: string[];
  error: string | null;
}

/**
 * Creates the AWS resources for a cluster, or re-applies them after an edit.
 *
 * Idempotent throughout, which is what makes 'drifted' recoverable and a failed
 * attempt resumable: every step tolerates already having been done, so running
 * this twice converges rather than erroring.
 *
 * A partial failure is recorded as 'failed' with the steps that did succeed. It
 * is not rolled back — an ECS cluster that exists without its capacity provider
 * is halfway to correct, and deleting it would throw away the half that worked
 * for no benefit.
 */
export async function provisionCluster(input: {
  name: string;
  actor: string;
}): Promise<ProvisionResult> {
  const row = await requireCluster(input.name);
  const config = infraConfig();
  const spec = clusterSpecOf(row);
  const pool = await getPool();

  const results: InfraResult[] = [];

  const cluster = await ensureEcsCluster(config, spec);
  results.push(cluster);

  let launchTemplateId: string | null = row.launch_template_id;
  let asgName: string | null = row.asg_name;
  let capacityProviderName: string | null = row.capacity_provider_name;
  let imageId: string | null = row.image_id;

  if (!cluster.error && spec.capacityType === 'ec2') {
    const capacity = await ensureEc2Capacity(config, spec, cluster.clusterName);
    results.push(capacity);
    launchTemplateId = capacity.launchTemplateId ?? launchTemplateId;
    asgName = capacity.asgName ?? asgName;
    capacityProviderName = capacity.capacityProviderName ?? capacityProviderName;
    imageId = capacity.imageId ?? imageId;
  }

  const combined = combine(results);
  const state = combined.error ? 'failed' : 'provisioned';

  await pool.query(
    /*
     * The cast on $7 is load-bearing, not decoration.
     *
     * Postgres transforms every SET expression before coercing any of them to
     * its target column, so `image_id = $7` has not yet given $7 a type when
     * `$7 IS NULL` is analysed — and IS NULL gives it none either. The statement
     * then fails to prepare with "could not determine data type of parameter
     * $7", every time, taking the whole cluster provision with it. Naming the
     * type at the site that cannot infer it is the fix.
     */
    `UPDATE compute_clusters
        SET provision_state = $2,
            cluster_arn = COALESCE($3, cluster_arn),
            launch_template_id = $4,
            asg_name = $5,
            capacity_provider_name = $6,
            image_id = $7,
            image_resolved_at = CASE WHEN $7::text IS NULL THEN image_resolved_at ELSE NOW() END,
            provision_detail = $8,
            provisioned_at = CASE WHEN $2 = 'provisioned' THEN NOW() ELSE provisioned_at END,
            updated_at = NOW()
      WHERE name = $1`,
    [
      input.name,
      state,
      cluster.clusterArn,
      launchTemplateId,
      asgName,
      capacityProviderName,
      imageId,
      combined.error ?? combined.steps.join('; ').slice(0, 2000),
    ]
  );

  console.log(
    JSON.stringify({
      event: 'cluster_provisioned',
      actor: input.actor,
      cluster: input.name,
      state,
      steps: combined.steps,
      error: combined.error,
    })
  );

  return { name: input.name, provision_state: state, ...combined };
}

/**
 * Destroys a cluster's AWS resources, leaving the registry row.
 *
 * Refused while a service is actually *running* on it. The foreign key already
 * stops the row from being deleted, but that says nothing about the running ECS
 * service — and deleting the capacity out from under one would leave tasks that
 * cannot be replaced and a service whose events nobody is reading.
 *
 * A service that is only scaffolded is not running: it has an image repository
 * and log groups and no ECS service at all, so there is nothing here to strand.
 * That distinction is worth making because the state it excludes is the common
 * one — a launch that failed before it ever deployed — and refusing it with
 * "still deployed" sent people looking for tasks that were never started.
 */
export async function deprovisionCluster(input: {
  name: string;
  actor: string;
}): Promise<ProvisionResult> {
  const row = await requireCluster(input.name);
  const config = infraConfig();
  const pool = await getPool();

  // An ECS service on it, not merely a row pointing at it. `service_arn` is
  // what provisioning records when the service is actually created, so it is
  // the only column that distinguishes "running here" from "will run here".
  const { rows: deployed } = await pool.query(
    `SELECT name FROM microservice_clusters
      WHERE cluster_name = $1
        AND (provision_state = 'provisioned' OR service_arn IS NOT NULL)`,
    [input.name]
  );
  if (deployed.length > 0) {
    throw new HttpError(
      409,
      'cluster_has_deployed_service',
      `"${deployed[0].name}" is still running on this cluster. Deprovision the service ` +
        'first — removing the capacity underneath it would leave tasks that cannot be ' +
        'replaced. Deleting the service does both.'
    );
  }

  const ecsClusterName = ecsClusterNameFor(config, input.name);
  const results: InfraResult[] = [];

  if (row.capacity_type === 'ec2') {
    results.push(await deleteEc2Capacity(config, input.name, ecsClusterName));
  }
  results.push(await deleteEcsCluster(config, input.name));

  const combined = combine(results);
  const state = combined.error ? 'failed' : 'not_provisioned';

  await pool.query(
    `UPDATE compute_clusters
        SET provision_state = $2,
            cluster_arn = CASE WHEN $2 = 'not_provisioned' THEN NULL ELSE cluster_arn END,
            launch_template_id = CASE WHEN $2 = 'not_provisioned' THEN NULL ELSE launch_template_id END,
            asg_name = CASE WHEN $2 = 'not_provisioned' THEN NULL ELSE asg_name END,
            capacity_provider_name = CASE WHEN $2 = 'not_provisioned' THEN NULL ELSE capacity_provider_name END,
            provision_detail = $3,
            provisioned_at = CASE WHEN $2 = 'not_provisioned' THEN NULL ELSE provisioned_at END,
            updated_at = NOW()
      WHERE name = $1`,
    [input.name, state, combined.error ?? combined.steps.join('; ').slice(0, 2000)]
  );

  console.log(
    JSON.stringify({
      event: 'cluster_deprovisioned',
      actor: input.actor,
      cluster: input.name,
      state,
      steps: combined.steps,
      error: combined.error,
    })
  );

  return { name: input.name, provision_state: state, ...combined };
}

/**
 * Live health for one cluster.
 *
 * The registry row alone cannot answer "is it working" — it records what was
 * asked for. This pairs it with what ECS actually has, and the interesting
 * cases are the disagreements: a provisioned GPU cluster reporting zero
 * registered GPUs, or zero instances when the scaling group says two.
 */
export async function clusterHealthFor(name: string) {
  const row = await requireCluster(name);
  const config = infraConfig();
  const ecsClusterName = ecsClusterNameFor(config, name);

  const health =
    row.provision_state === 'not_provisioned'
      ? null
      : await clusterHealth(ecsClusterName);

  const catalogued = instanceSpec(row.instance_type);

  return {
    cluster: row,
    ecs_cluster_name: ecsClusterName,
    health,
    /** What the catalog says the chosen instance type is, when it knows. */
    instance: catalogued,
    /**
     * Whether ECS sees the GPUs the row promises. The single most useful
     * derived fact on the page: false means the instances are up but nothing
     * GPU-bound will ever place on them, which is almost always the wrong AMI.
     */
    gpu_visible:
      row.gpus_per_instance === 0
        ? null
        : health === null
          ? null
          : health.registered_instances > 0 && health.registered_gpus > 0,
    fetched_at: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Microservices — scaffolding
// ───────────────────────────────────────────────────────────────────────────

function logGroupsFor(config: MicroserviceInfraConfig, service: string) {
  const names = resourceNames(config.deployment, {
    microserviceResourcePrefix: config.prefix,
    // Both overrides, or the log groups are named after the deployment instead
    // and land outside the ARNs the stack grants this function.
    logPrefix: config.logPrefix,
  });
  return {
    container: names.microserviceLogGroup(service),
    build: names.microserviceBuildLogGroup(service),
  };
}

/**
 * Creates everything a microservice needs before it can be built: its ECS
 * cluster, its image repository, its log groups, and its build project.
 *
 * The cluster is provisioned here rather than being a separate action on
 * another page. It belongs to this service and nothing else, so "provision the
 * cluster, then provision the service" was two steps expressing one decision —
 * and the second one failed with a message telling you to go and do the first.
 *
 * Separate from *deploying* because that distinction is real: everything here
 * costs approximately nothing to keep, while deploying starts tasks. On EC2 the
 * cluster's scaling group does begin launching instances if its minimum is
 * above zero, which is why the result reports what it created.
 *
 * Idempotent throughout, so running it again after a partial failure repairs
 * what is missing rather than starting over.
 */
export async function provisionMicroservice(input: {
  name: string;
  actor: string;
}): Promise<ProvisionResult & { repository_uri: string | null }> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  const pool = await getPool();

  if (!row.cluster_name) {
    // Only reachable for a row whose cluster was deleted from under it — every
    // service created through the console has one.
    throw new HttpError(
      409,
      'no_cluster',
      `"${input.name}" has no cluster, so there is nowhere for it to run. Its cluster was ` +
        'removed; assign another on the service before provisioning.'
    );
  }

  const logGroups = logGroupsFor(config, input.name);
  const results: InfraResult[] = [];

  // The cluster first: the ECS service created later has to be created *in* it,
  // and on EC2 the capacity provider has to exist before a task can be placed.
  const cluster = await requireCluster(row.cluster_name);
  if (cluster.provision_state !== 'provisioned') {
    const clusterResult = await provisionCluster({
      name: row.cluster_name,
      actor: input.actor,
    });
    results.push({
      steps: clusterResult.steps.map((step) => `cluster: ${step}`),
      error: clusterResult.error,
    });
  }

  const repository = await ensureRepository(config, input.name, row.cluster_name);
  results.push(repository);

  // Tagged with the service so the Logs page and the Cost page can both
  // attribute the group without parsing its name.
  const tags = serviceTags(config, input.name, row.cluster_name);

  results.push(await ensureLogGroup(config, logGroups.container, row.log_retention_days, tags));
  results.push(await ensureLogGroup(config, logGroups.build, row.log_retention_days, tags));

  const project = await ensureBuildProject(config, {
    service: input.name,
    cluster: row.cluster_name,
    buildLogGroup: logGroups.build,
  });
  results.push(project);

  const combined = combine(results);
  // Never downgrades a deployed service: re-running this on something already
  // provisioned repairs its scaffolding without claiming the ECS service is
  // gone.
  const state = combined.error
    ? 'failed'
    : row.provision_state === 'provisioned'
      ? 'provisioned'
      : 'scaffolded';

  await pool.query(
    `UPDATE microservice_clusters
        SET provision_state = $2,
            ecr_repository_name = $3,
            ecr_repository_uri = $4,
            build_project_name = $5,
            log_group_name = $6,
            build_log_group = $7,
            provision_detail = $8,
            updated_at = NOW()
      WHERE name = $1`,
    [
      input.name,
      state,
      repository.repositoryName,
      repository.repositoryUri,
      project.projectName,
      logGroups.container,
      logGroups.build,
      combined.error ?? combined.steps.join('; ').slice(0, 2000),
    ]
  );

  console.log(
    JSON.stringify({
      event: 'microservice_provisioned',
      actor: input.actor,
      microservice: input.name,
      state,
      steps: combined.steps,
      error: combined.error,
    })
  );

  return {
    name: input.name,
    provision_state: state,
    ...combined,
    repository_uri: repository.repositoryUri,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Microservices — building
// ───────────────────────────────────────────────────────────────────────────

/**
 * Starts an image build.
 *
 * The source is re-checked against GitHub first, for two reasons that both save
 * an operator time. It refuses before spending build minutes when the
 * Dockerfile has since been deleted or the branch renamed — the most common
 * cause of a failed build, and one that a build failure explains far worse than
 * this does. And it resolves the branch head, so the image can be tagged with
 * the commit it came from rather than a timestamp nobody can trace.
 */
export async function buildMicroservice(input: {
  name: string;
  actor: string;
}): Promise<{ name: string; build_id: string; image_tag: string; build_state: string }> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  const pool = await getPool();

  if (!row.build_project_name) {
    throw new HttpError(
      409,
      'not_provisioned',
      `"${input.name}" has no build project yet. Provision it first — that creates the ` +
        'image repository and the build project this needs.'
    );
  }

  if (row.build_state === 'queued' || row.build_state === 'building') {
    throw new HttpError(
      409,
      'build_in_progress',
      `A build of "${input.name}" is already running. Wait for it, or stop it first.`
    );
  }

  // Refresh the source check. This both validates and gives us the head sha.
  const checked = await checkMicroservice(input.name);
  if (checked.microservice.check_state !== 'ok') {
    throw new HttpError(
      400,
      'source_unusable',
      checked.microservice.check_detail ??
        'The source could not be verified, so there is nothing to build.'
    );
  }

  const commitSha = checked.microservice.checked_commit_sha;
  // Short sha, or a timestamp when GitHub somehow gave us no head — a tag has
  // to be unique per build or a rollback has nothing to point at.
  const imageTag = commitSha ? commitSha.slice(0, 12) : `b${Date.now()}`;

  const repositoryUri =
    row.ecr_repository_uri ??
    `${config.accountId}.dkr.ecr.${config.region}.amazonaws.com/${microserviceNames(config.prefix, input.name).ecrRepository}`;

  // Minted per build and scoped to this one repository. Never stored, never
  // logged, never returned from this function.
  const token = await cloneToken({
    installationId: row.installation_id,
    repository: row.repo_full_name,
  });

  const started = await startImageBuild({
    projectName: row.build_project_name,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    imageUri: repositoryUri,
    imageTag,
    githubToken: token.token,
  });

  await pool.query(
    `UPDATE microservice_clusters
        SET build_id = $2,
            build_state = 'queued',
            build_detail = NULL,
            build_commit_sha = $3,
            build_started_at = NOW(),
            build_finished_at = NULL,
            image_tag = $4,
            updated_at = NOW()
      WHERE name = $1`,
    [input.name, started.buildId, commitSha, imageTag]
  );

  console.log(
    JSON.stringify({
      event: 'microservice_build_started',
      actor: input.actor,
      microservice: input.name,
      build_id: started.buildId,
      image_tag: imageTag,
      commit: commitSha,
    })
  );

  return {
    name: input.name,
    build_id: started.buildId,
    image_tag: imageTag,
    build_state: 'queued',
  };
}

/**
 * Polls CodeBuild and records what it says.
 *
 * Called by the console while a build runs, and by the status endpoint. There is
 * no build-completion callback wired up — CodeBuild would need an EventBridge
 * rule and a Lambda to receive it — so the stored state advances only when
 * something asks. That is honest rather than ideal: a build whose result nobody
 * has looked at shows as still building, which is exactly what the console
 * knows.
 *
 * On success the image digest is read from ECR. That is the proof the push
 * actually landed: a build can report SUCCEEDED and still have pushed nothing
 * if the final phase was skipped.
 */
export async function refreshBuild(name: string): Promise<MicroserviceRow> {
  const row = await requireMicroservice(name);
  if (!row.build_id) return row;
  if (row.build_state === 'succeeded' || row.build_state === 'failed' || row.build_state === 'stopped') {
    return row;
  }

  const status = await buildStatus(row.build_id);
  if (!status) return row;

  const pool = await getPool();
  let digest: string | null = row.image_digest;

  if (status.state === 'succeeded' && row.ecr_repository_name && row.image_tag) {
    const image = await imageSummary(row.ecr_repository_name, row.image_tag);
    digest = image?.digest ?? null;
  }

  const { rows } = await pool.query(
    `UPDATE microservice_clusters
        SET build_state = $2,
            build_detail = $3,
            build_commit_sha = COALESCE($4, build_commit_sha),
            build_finished_at = $5,
            build_log_group = COALESCE($6, build_log_group),
            build_log_stream = COALESCE($7, build_log_stream),
            image_digest = $8,
            updated_at = NOW()
      WHERE name = $1
      RETURNING name`,
    [
      name,
      status.state,
      status.detail,
      status.commitSha,
      status.finishedAt,
      status.logGroup,
      status.logStream,
      digest,
    ]
  );

  if (rows.length === 0) return row;
  return requireMicroservice(name);
}

export async function stopMicroserviceBuild(input: {
  name: string;
  actor: string;
}): Promise<InfraResult> {
  const row = await requireMicroservice(input.name);
  if (!row.build_id) {
    throw new HttpError(409, 'no_build', `"${input.name}" has never been built.`);
  }
  const result = await stopBuild(row.build_id);
  const pool = await getPool();
  await pool.query(
    `UPDATE microservice_clusters SET build_state = 'stopped', updated_at = NOW()
      WHERE name = $1 AND build_state IN ('queued','building')`,
    [input.name]
  );
  console.log(
    JSON.stringify({
      event: 'microservice_build_stopped',
      actor: input.actor,
      microservice: input.name,
    })
  );
  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Microservices — deploying
// ───────────────────────────────────────────────────────────────────────────

/**
 * Checks the task's CPU and memory against the instance it will land on.
 *
 * ECS will happily accept a task definition asking for more memory than any
 * instance in the cluster has. The task then sits PENDING forever with a
 * placement message, the service reports 0/1 running, and nothing anywhere says
 * "the number you typed is bigger than the box". So it is said here.
 *
 * Only for catalogued instance types — an unlisted one has no specs to check
 * against, which is the documented cost of the escape hatch.
 */
function assertTaskFitsInstance(service: MicroserviceRow, cluster: ClusterRow): void {
  if (cluster.capacity_type !== 'ec2') return;
  const spec = instanceSpec(cluster.instance_type);
  if (!spec) return;

  const memoryCeiling = taskMemoryCeiling(spec);
  if (service.memory > memoryCeiling) {
    throw new HttpError(
      400,
      'task_too_large',
      `The task asks for ${service.memory} MiB but a ${spec.name} can only offer about ` +
        `${memoryCeiling} MiB to tasks — the ECS agent and the OS take the rest. ECS would ` +
        'accept this definition and then never place it. Lower the memory, or use a larger ' +
        'instance type.'
    );
  }

  // ECS counts CPU in units of 1/1024 of a vCPU.
  const cpuCeiling = spec.vcpu * 1024;
  if (service.cpu > cpuCeiling) {
    throw new HttpError(
      400,
      'task_too_large',
      `The task asks for ${service.cpu} CPU units and a ${spec.name} has ${cpuCeiling} ` +
        `(${spec.vcpu} vCPU). It would never place.`
    );
  }
}

/**
 * Registers a task definition and brings the ECS service up.
 *
 * Requires an image. Deploying without one produces a service whose tasks fail
 * to pull and retry forever — a failure that shows up as a mysterious 0/1
 * running rather than as "you have not built this yet", so it is refused here.
 */
export async function deployMicroservice(input: {
  name: string;
  actor: string;
}): Promise<ProvisionResult> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  const pool = await getPool();

  if (!row.cluster_name) {
    throw new HttpError(409, 'no_cluster', `"${input.name}" has no cluster to run on.`);
  }
  const cluster = await requireCluster(row.cluster_name);

  if (cluster.provision_state === 'not_provisioned') {
    throw new HttpError(
      409,
      'cluster_not_provisioned',
      `The capacity for "${input.name}" has not been created on AWS yet. Launch the service, ` +
        'or provision it — there is no ECS cluster for it to be created in.'
    );
  }

  if (!row.ecr_repository_uri || !row.image_tag) {
    throw new HttpError(
      409,
      'no_image',
      `"${input.name}" has no built image. Build it first — a service deployed without one ` +
        'starts tasks that fail to pull and retry forever.'
    );
  }

  if (row.build_state !== 'succeeded') {
    throw new HttpError(
      409,
      'no_successful_build',
      `The last build of "${input.name}" ${
        row.build_state === 'never' ? 'never ran' : `ended as "${row.build_state}"`
      }, so there is no image worth deploying.`
    );
  }

  assertTaskFitsInstance(row, cluster);

  const spec: ServiceSpec = {
    name: row.name,
    cluster: clusterSpecOf(cluster),
    imageUri: row.ecr_repository_uri,
    imageTag: row.image_tag,
    cpu: row.cpu,
    memory: row.memory,
    containerPort: row.container_port,
    desiredCount: row.desired_count,
    scalingMode: row.scaling_mode,
    minTasks: row.min_tasks,
    maxTasks: row.max_tasks,
    scalingMetric: row.scaling_metric,
    scalingTarget: row.scaling_target,
    scaleOutCooldown: row.scale_out_cooldown,
    scaleInCooldown: row.scale_in_cooldown,
    gpuMode: cluster.gpu_mode,
    logGroup: row.log_group_name ?? logGroupsFor(config, row.name).container,
  };

  const ecsClusterName = ecsClusterNameFor(config, cluster.name);
  const results: InfraResult[] = [];
  let taskDefinitionArn: string | null = row.task_definition_arn;
  let serviceArn: string | null = row.service_arn;

  try {
    const registered = await registerServiceTaskDefinition(config, spec);
    taskDefinitionArn = registered.taskDefinitionArn;
    results.push({ steps: ['task definition registered'], error: null });

    const created = await ensureService(config, spec, ecsClusterName, taskDefinitionArn);
    results.push(created);
    serviceArn = created.serviceArn ?? serviceArn;

    if (!created.error) {
      results.push(await ensureServiceScaling(config, spec, ecsClusterName));
    }
  } catch (error) {
    results.push({
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const combined = combine(results);
  const state = combined.error ? 'failed' : 'provisioned';

  await pool.query(
    `UPDATE microservice_clusters
        SET provision_state = $2,
            task_definition_arn = COALESCE($3, task_definition_arn),
            service_arn = COALESCE($4, service_arn),
            provision_detail = $5,
            provisioned_at = CASE WHEN $2 = 'provisioned' THEN NOW() ELSE provisioned_at END,
            updated_at = NOW()
      WHERE name = $1`,
    [
      input.name,
      state,
      taskDefinitionArn,
      serviceArn,
      combined.error ?? combined.steps.join('; ').slice(0, 2000),
    ]
  );

  console.log(
    JSON.stringify({
      event: 'microservice_deployed',
      actor: input.actor,
      microservice: input.name,
      cluster: cluster.name,
      image_tag: row.image_tag,
      state,
      steps: combined.steps,
      error: combined.error,
    })
  );

  return { name: input.name, provision_state: state, ...combined };
}

export async function restartMicroservice(input: {
  name: string;
  actor: string;
}): Promise<InfraResult> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();

  if (!row.cluster_name || row.provision_state !== 'provisioned') {
    throw new HttpError(
      409,
      'not_deployed',
      `"${input.name}" is not deployed, so there is nothing to restart.`
    );
  }

  const result = await restartService(
    config,
    input.name,
    ecsClusterNameFor(config, row.cluster_name)
  );

  console.log(
    JSON.stringify({
      event: 'microservice_restarted',
      actor: input.actor,
      microservice: input.name,
      error: result.error,
    })
  );

  return result;
}

/**
 * Removes a microservice's AWS resources.
 *
 * Order matters and is not negotiable: the service goes before the log group it
 * writes to, and the scaling policy before the service it scales.
 *
 * The two destructive extras are opt-in. Deleting the ECR repository throws
 * away every built image, so a service being taken down temporarily should keep
 * them — a rebuild is minutes of CodeBuild and a fresh pull of every base
 * layer. Deleting the log groups throws away the only record of why the service
 * was misbehaving, which is usually the reason it is being torn down.
 */
export async function deprovisionMicroservice(input: {
  name: string;
  actor: string;
  deleteImages?: boolean;
  deleteLogs?: boolean;
}): Promise<ProvisionResult> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  const pool = await getPool();
  const results: InfraResult[] = [];

  if (row.cluster_name) {
    results.push(
      await deleteService(config, input.name, ecsClusterNameFor(config, row.cluster_name))
    );
  }

  results.push(await deleteBuildProject(config, input.name));

  if (input.deleteImages) {
    results.push(await deleteRepository(config, input.name));
  }

  if (input.deleteLogs) {
    const logGroups = logGroupsFor(config, input.name);
    results.push(await deleteLogGroup(logGroups.container));
    results.push(await deleteLogGroup(logGroups.build));
  }

  let combined = combine(results);
  const state = combined.error ? 'failed' : 'not_provisioned';

  await pool.query(
    `UPDATE microservice_clusters
        SET provision_state = $2,
            -- Whatever a launch was waiting for, it is not coming: the service
            -- it would have deployed has just been taken down.
            launch_state = 'none',
            launch_detail = NULL,
            launch_finished_at = NULL,
            service_arn = NULL,
            task_definition_arn = NULL,
            build_project_name = NULL,
            ecr_repository_name = CASE WHEN $3::boolean THEN NULL ELSE ecr_repository_name END,
            ecr_repository_uri = CASE WHEN $3::boolean THEN NULL ELSE ecr_repository_uri END,
            image_tag = CASE WHEN $3::boolean THEN NULL ELSE image_tag END,
            image_digest = CASE WHEN $3::boolean THEN NULL ELSE image_digest END,
            build_state = CASE WHEN $3::boolean THEN 'never' ELSE build_state END,
            build_id = CASE WHEN $3::boolean THEN NULL ELSE build_id END,
            log_group_name = CASE WHEN $4::boolean THEN NULL ELSE log_group_name END,
            build_log_group = CASE WHEN $4::boolean THEN NULL ELSE build_log_group END,
            provision_detail = $5,
            provisioned_at = NULL,
            updated_at = NOW()
      WHERE name = $1`,
    [
      input.name,
      state,
      Boolean(input.deleteImages),
      Boolean(input.deleteLogs),
      combined.error ?? combined.steps.join('; ').slice(0, 2000),
    ]
  );

  /**
   * The cluster goes too.
   *
   * It exists for this service alone, so leaving it behind would leave an EC2
   * scaling group launching instances for a service that no longer runs —
   * billing, and reachable only from a page the operator has no reason to
   * visit. Done after the row is marked `not_provisioned`, because
   * `deprovisionCluster` refuses while a service on it still claims to be
   * deployed.
   *
   * Only when the service teardown actually succeeded. Pulling the capacity out
   * from under a service whose ECS deletion failed would strand tasks.
   */
  if (!combined.error && row.cluster_name) {
    const cluster = await requireCluster(row.cluster_name);
    if (cluster.provision_state !== 'not_provisioned') {
      const clusterResult = await deprovisionCluster({
        name: row.cluster_name,
        actor: input.actor,
      });
      combined = combine([
        combined,
        {
          steps: clusterResult.steps.map((step) => `cluster: ${step}`),
          error: clusterResult.error,
        },
      ]);
    }
  }

  console.log(
    JSON.stringify({
      event: 'microservice_deprovisioned',
      actor: input.actor,
      microservice: input.name,
      deleted_images: Boolean(input.deleteImages),
      deleted_logs: Boolean(input.deleteLogs),
      state,
      steps: combined.steps,
      error: combined.error,
    })
  );

  return { name: input.name, provision_state: state, ...combined };
}

// ───────────────────────────────────────────────────────────────────────────
// Logs
// ───────────────────────────────────────────────────────────────────────────

/**
 * Changes how long a microservice's logs are kept.
 *
 * Applied to both groups and stored, because the stored value is what a
 * re-provision re-applies — setting it only on AWS would silently revert the
 * next time the scaffolding was repaired.
 */
export async function setLogRetention(input: {
  name: string;
  retentionDays: number | null;
  actor: string;
}): Promise<InfraResult> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  const pool = await getPool();
  const logGroups = logGroupsFor(config, input.name);
  const tags = serviceTags(config, input.name, row.cluster_name);

  const results = [
    await ensureLogGroup(config, logGroups.container, input.retentionDays, tags),
    await ensureLogGroup(config, logGroups.build, input.retentionDays, tags),
  ];

  const combined = combine(results);
  if (!combined.error) {
    await pool.query(
      `UPDATE microservice_clusters SET log_retention_days = $2, updated_at = NOW()
        WHERE name = $1`,
      [input.name, input.retentionDays]
    );
  }

  console.log(
    JSON.stringify({
      event: 'microservice_log_retention_set',
      actor: input.actor,
      microservice: input.name,
      retention_days: input.retentionDays,
      error: combined.error,
    })
  );

  return combined;
}

/**
 * How many task streams the merged view reads.
 *
 * Every one is a separate GetLogEvents, so a service running twenty tasks would
 * otherwise cost twenty calls for a single page — on a six-second poll. Three
 * is enough to see a rollout in progress, and the response lists the rest by
 * name so a specific task can be asked for instead.
 */
const MERGED_STREAMS = 3;

/**
 * The last lines a microservice printed, from one of its two logs.
 *
 * 'container' is what the running tasks wrote; 'build' is what CodeBuild wrote
 * while making the image. They are different groups with different lifetimes
 * and answer different questions — "why is it misbehaving" against "why did it
 * not build" — so which one is being read is the caller's choice rather than a
 * merge nobody could untangle.
 *
 * ## Which task
 *
 * A container log is one stream per container per task, named
 * `<service>/<container>/<task id>` — never after the machine, which is why
 * "the log on one node" is not a thing CloudWatch can be asked for directly.
 * What it can be asked for is one task, and a task is attributable to a node
 * through the ECS API rather than through the log.
 *
 * Naming a stream reads that one alone, to its full depth. Omitting it merges
 * the newest few, which is the right default while tasks are being replaced and
 * the wrong one when a specific task is misbehaving — hence both.
 */
export async function microserviceLogs(input: {
  name: string;
  source: 'container' | 'build';
  limit?: number;
  /**
   * One stream, by name. Scoped by construction: it is only ever read within
   * this service's own log group, so naming another service's stream finds
   * nothing rather than reading it.
   */
  stream?: string | undefined;
}): Promise<LogTail & { source: 'container' | 'build' }> {
  const row = await requireMicroservice(input.name);
  const config = infraConfig();
  /**
   * Clamped through `isFinite`, not just `??`.
   *
   * The limit arrives as a query string, so a caller can send `limit=abc` and
   * `Number()` yields NaN — which is not nullish, so `?? 200` never fires and a
   * Math.min/max chain passes the NaN straight through to the SDK. The result
   * is a 500 from a request that was merely malformed.
   */
  const requested = Number(input.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 1000) : 200;
  const groups = logGroupsFor(config, input.name);

  if (input.source === 'build') {
    // The stream the last build wrote to. Without one there has been no build,
    // which is a different thing from a build that produced no output.
    if (!row.build_log_stream) {
      return {
        source: 'build',
        log_group: row.build_log_group ?? groups.build,
        streams: [],
        available: [],
        events: [],
        truncated: false,
      };
    }
    const tail = await tailLogStream(
      row.build_log_group ?? groups.build,
      row.build_log_stream,
      limit
    );
    return { source: 'build', ...tail };
  }

  /**
   * Listed once and passed down, so choosing a task costs the same as not
   * choosing one: the picker needs the full list either way, and the merged
   * read would otherwise list the streams a second time.
   */
  const group = row.log_group_name ?? groups.container;
  const available = await listLogStreams(group);

  if (input.stream) {
    const tail = await tailLogStream(group, input.stream, limit, available);
    return { source: 'container', ...tail };
  }

  const tail = await tailLogGroup(group, limit, MERGED_STREAMS, available);
  return { source: 'container', ...tail };
}

/** Empties a microservice's log groups now, without deleting them. */
export async function clearMicroserviceLogs(input: {
  name: string;
  actor: string;
  /** Which of the two groups to empty. Both by default. */
  scope?: 'container' | 'build' | 'both';
}): Promise<InfraResult> {
  await requireMicroservice(input.name);
  const config = infraConfig();
  const logGroups = logGroupsFor(config, input.name);
  const scope = input.scope ?? 'both';

  const results: InfraResult[] = [];
  if (scope === 'container' || scope === 'both') {
    results.push(await clearLogGroup(logGroups.container));
  }
  if (scope === 'build' || scope === 'both') {
    results.push(await clearLogGroup(logGroups.build));
  }

  console.log(
    JSON.stringify({
      event: 'microservice_logs_cleared',
      actor: input.actor,
      microservice: input.name,
      scope,
    })
  );

  return combine(results);
}

/**
 * Everything to do with this service, gone: AWS resources, cluster, both rows.
 *
 * The single action behind "Delete" on the service, and the reason there is no
 * order to get right any more. Deleting a service used to be three decisions in
 * two places — deprovision the service, deprovision its cluster, remove the row
 * — each of which refused until the previous one had been made, and the refusals
 * pointed at pages rather than buttons. There was never a real choice in there:
 * a service nobody wants does not want its cluster either.
 *
 * The two destructive extras stay opt-in, because they are the two that cannot
 * be undone by re-creating the service. Images are minutes of CodeBuild and a
 * fresh pull of every base layer; the logs are usually the record of why the
 * thing is being deleted.
 *
 * Teardown first, and the rows only if it worked. The opposite order is how a
 * cluster ends up running with nothing in the console pointing at it: the row
 * that named it is the only thing that knows it exists.
 */
export async function teardownMicroservice(input: {
  name: string;
  actor: string;
  deleteImages?: boolean;
  deleteLogs?: boolean;
}): Promise<{
  name: string;
  removed: boolean;
  steps: string[];
  /** What was torn down on the way, so the caller can say what it cost. */
  deleted_images: boolean;
  deleted_logs: boolean;
}> {
  const row = await requireMicroservice(input.name);
  const steps: string[] = [];

  if (row.provision_state !== 'not_provisioned') {
    const result = await deprovisionMicroservice({
      name: input.name,
      actor: input.actor,
      deleteImages: input.deleteImages ?? false,
      deleteLogs: input.deleteLogs ?? false,
    });
    steps.push(...result.steps);

    if (result.error) {
      /**
       * Refused, with the row intact.
       *
       * A teardown that half-worked and then deleted its own record is the one
       * outcome worth preventing outright: whatever survived is still billing
       * and nothing in the console can name it any more. Leaving the row means
       * the next attempt has somewhere to resume from, which is why every step
       * underneath is idempotent.
       */
      throw new HttpError(
        409,
        'teardown_failed',
        `"${input.name}" could not be taken down, so nothing was deleted: ${result.error}. ` +
          'Its row is intact — try again, or clear the resource by hand and retry.'
      );
    }
  }

  /**
   * The cluster, if the service's own teardown did not already take it.
   *
   * It does in the ordinary case. This covers the row whose service was
   * deprovisioned earlier and separately, leaving a cluster that is still
   * provisioned and now has nothing on it — `removeMicroservice` refuses to
   * delete a row while that is true, and it is right to.
   */
  if (row.cluster_name) {
    const cluster = await requireCluster(row.cluster_name);
    if (cluster.provision_state !== 'not_provisioned') {
      const result = await deprovisionCluster({ name: row.cluster_name, actor: input.actor });
      steps.push(...result.steps.map((step) => `cluster: ${step}`));
      if (result.error) {
        throw new HttpError(
          409,
          'teardown_failed',
          `The cluster behind "${input.name}" could not be taken down, so nothing was ` +
            `deleted: ${result.error}. Its rows are intact — try again.`
        );
      }
    }
  }

  const removed = await removeMicroservice({ name: input.name, actor: input.actor });
  steps.push(`removed ${input.name} and its cluster from the registry`);

  console.log(
    JSON.stringify({
      event: 'microservice_torn_down',
      actor: input.actor,
      microservice: input.name,
      cluster: row.cluster_name,
      deleted_images: Boolean(input.deleteImages),
      deleted_logs: Boolean(input.deleteLogs),
      steps,
    })
  );

  return {
    name: input.name,
    removed: removed.removed,
    steps,
    deleted_images: Boolean(input.deleteImages),
    deleted_logs: Boolean(input.deleteLogs),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Launch — the whole bring-up, as one decision
// ───────────────────────────────────────────────────────────────────────────

/** CodeBuild states that mean the image build has not finished yet. */
const BUILD_IN_FLIGHT = new Set(['queued', 'building']);

/**
 * How long a launch may sit in a step before that step is assumed dead.
 *
 * The two states this guards — 'provisioning' and 'deploying' — exist only
 * while a request is executing them, and that request is a Lambda that cannot
 * live past 30 seconds. So anything still in one of them two minutes later is
 * not slow, it is gone: the function timed out, was throttled, or hit an
 * unhandled error before it could record the outcome. Retrying sooner would
 * mean two provisions of the same service racing each other; never retrying
 * would leave a service that stopped halfway and stays there.
 */
const LAUNCH_STALL_SECONDS = 120;

/** At most this many launches are advanced per reconcile tick. */
const LAUNCH_BATCH = 5;

export interface LaunchStatus {
  name: string;
  launch_state: LaunchState;
  launch_detail: string | null;
  /** Where the underlying lifecycle actually got to. */
  provision_state: string;
  build_state: string;
  steps: string[];
  error: string | null;
}

function launchStatusOf(
  row: MicroserviceRow,
  steps: string[],
  error: string | null
): LaunchStatus {
  return {
    name: row.name,
    launch_state: row.launch_state,
    launch_detail: row.launch_detail,
    provision_state: row.provision_state,
    build_state: row.build_state,
    steps,
    error,
  };
}

/**
 * Records where a launch has got to.
 *
 * Written at every transition rather than only at the end, because the middle
 * of a launch is exactly where someone reloads the page and asks what is
 * happening. `launch_finished_at` is set only by the two terminal states, so
 * "still going" and "went wrong twenty minutes ago" never look alike.
 */
async function recordLaunch(
  name: string,
  state: LaunchState,
  detail: string | null,
  options: { finished?: boolean } = {}
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE microservice_clusters
        SET launch_state = $2,
            launch_detail = $3,
            launch_finished_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE name = $1`,
    [name, state, detail === null ? null : detail.slice(0, 2000), Boolean(options.finished)]
  );
}

/**
 * Takes ownership of a launch, or reports that something else already has.
 *
 * The console calls launch the moment a service is created, and the reconcile
 * calls it for anything left in 'requested' — so the two can arrive on the same
 * row within seconds of each other. Without a claim, both would provision and
 * the second would try to start a duplicate build. The claim is the UPDATE
 * itself: whichever transaction changes the row wins, and the loser sees zero
 * rows come back.
 *
 * The staleness clause is what keeps that from becoming a deadlock. A claim is
 * refused while another provision holds the row, and granted once that hold is
 * older than any live request could possibly be.
 */
async function claimLaunch(name: string, actor: string): Promise<boolean> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE microservice_clusters
        SET launch_state = 'provisioning',
            launch_detail = 'Creating the cluster, image repository, log groups and build project.',
            launch_requested_by = $2,
            launch_requested_at = NOW(),
            launch_finished_at = NULL,
            updated_at = NOW()
      WHERE name = $1
        AND (
          launch_state <> 'provisioning'
          OR updated_at < NOW() - ($3::int * INTERVAL '1 second')
        )
      RETURNING name`,
    [name, actor, LAUNCH_STALL_SECONDS]
  );
  return rows.length > 0;
}

/** The same claim, for the deploy at the far end of the build. */
async function claimDeploy(name: string, from: LaunchState): Promise<boolean> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE microservice_clusters
        SET launch_state = 'deploying',
            launch_detail = 'Registering the task definition and starting the ECS service.',
            launch_finished_at = NULL,
            updated_at = NOW()
      WHERE name = $1
        AND launch_state = $2
        AND (
          $2 <> 'deploying'
          OR updated_at < NOW() - ($3::int * INTERVAL '1 second')
        )
      RETURNING name`,
    [name, from, LAUNCH_STALL_SECONDS]
  );
  return rows.length > 0;
}

/**
 * Gets a microservice running: cluster, scaffolding, image, and the service.
 *
 * This is the ordinary path, and the reason the console no longer sends anyone
 * to another page to finish the job. Creating a service asks the hardware and
 * runtime questions once; this then takes every step those answers were for,
 * in the only order they work in — the cluster and the scaffolding, then the
 * image, then the ECS service.
 *
 * It returns as soon as the build is running, because that is where the
 * synchronous part ends: a docker build of an ML image takes minutes and no
 * Lambda lives that long. The deploy is left to `advanceLaunch`, which both the
 * status endpoint and the five-minute reconcile call — so the launch finishes
 * whether or not the browser that started it is still open.
 *
 * Idempotent, deliberately. Every step underneath tolerates already having been
 * done, and a build that is already running is treated as the build this launch
 * is waiting for rather than a reason to start a second. So the same call means
 * both "launch this" and "carry on from wherever you stopped".
 */
export async function launchMicroservice(input: {
  name: string;
  actor: string;
}): Promise<LaunchStatus> {
  const row = await requireMicroservice(input.name);

  // Refused rather than recorded as a launch failure: there is nothing here to
  // retry. Only reachable for a row whose cluster was deleted from under it —
  // every service created through the console has one.
  if (!row.cluster_name) {
    throw new HttpError(
      409,
      'no_cluster',
      `"${input.name}" has no cluster, so there is nowhere for it to run. Its cluster was ` +
        'removed; assign another on the service before launching it.'
    );
  }

  if (!(await claimLaunch(input.name, input.actor))) {
    // Another request is provisioning this right now. Report where it is
    // instead of starting a second one alongside it.
    return launchStatusOf(await requireMicroservice(input.name), [], null);
  }

  const steps: string[] = [];

  try {
    const scaffold = await provisionMicroservice({ name: input.name, actor: input.actor });
    steps.push(...scaffold.steps);

    if (scaffold.error) {
      await recordLaunch(
        input.name,
        'failed',
        `Could not create the infrastructure: ${scaffold.error}`,
        { finished: true }
      );
      return launchStatusOf(await requireMicroservice(input.name), steps, scaffold.error);
    }

    const scaffolded = await requireMicroservice(input.name);
    let imageTag = scaffolded.image_tag;

    if (BUILD_IN_FLIGHT.has(scaffolded.build_state)) {
      steps.push('image build already running');
    } else {
      const started = await buildMicroservice({ name: input.name, actor: input.actor });
      imageTag = started.image_tag;
      steps.push(`image build ${started.build_id} started`);
    }

    await recordLaunch(
      input.name,
      'building',
      `Building ${imageTag ? `image ${imageTag}` : 'the image'} from ` +
        `${scaffolded.repo_full_name}@${scaffolded.branch}. It deploys on its own when the ` +
        'build succeeds.'
    );

    console.log(
      JSON.stringify({
        event: 'microservice_launch_started',
        actor: input.actor,
        microservice: input.name,
        cluster: row.cluster_name,
        image_tag: imageTag,
        steps,
      })
    );

    return launchStatusOf(await requireMicroservice(input.name), steps, null);
  } catch (error) {
    /**
     * Recorded, not rethrown.
     *
     * A launch is a sequence, and which step it stopped on is the useful part.
     * An exception unwinding to the caller would take the steps that did
     * succeed with it, and leave the row claiming to be provisioning until the
     * claim went stale.
     */
    const message = error instanceof Error ? error.message : String(error);
    await recordLaunch(input.name, 'failed', message, { finished: true });
    console.error('microservice launch failed', { microservice: input.name, error: message });
    return launchStatusOf(await requireMicroservice(input.name), steps, message);
  }
}

/**
 * Finishes a launch whose build has landed.
 *
 * Called from wherever the row is already being looked at with fresh eyes: the
 * status endpoint the console polls every few seconds, and the reconcile that
 * runs whether or not anyone is looking. CodeBuild has no completion callback
 * wired up, so "the build finished" is only ever discovered by asking — and the
 * moment it is discovered is the right moment to deploy.
 *
 * Does nothing to a service nobody asked to launch. A build someone started by
 * hand stays a build someone started by hand; the deploy at the end belongs
 * only to a launch that is waiting for it.
 */
export async function advanceLaunch(row: MicroserviceRow): Promise<MicroserviceRow> {
  if (row.launch_state !== 'building' && row.launch_state !== 'deploying') return row;

  if (row.launch_state === 'building') {
    if (BUILD_IN_FLIGHT.has(row.build_state)) return row;

    if (row.build_state !== 'succeeded') {
      await recordLaunch(
        row.name,
        'failed',
        row.build_state === 'never'
          ? 'The image build never started, so there was nothing to deploy.'
          : `The image build ${row.build_state === 'stopped' ? 'was stopped' : 'failed'}, so ` +
            `there is no image to deploy. ${row.build_detail ?? 'Check the build log.'}`,
        { finished: true }
      );
      return requireMicroservice(row.name);
    }
  }

  if (!(await claimDeploy(row.name, row.launch_state))) {
    // Either another poll got here first, or a deploy is genuinely in flight.
    return requireMicroservice(row.name);
  }

  // Whoever asked for the launch, not whoever happened to poll: the deploy is
  // their action, and the reconcile has no user of its own to attribute it to.
  const actor = row.launch_requested_by ?? 'launch';

  try {
    const result = await deployMicroservice({ name: row.name, actor });
    if (result.error) {
      await recordLaunch(row.name, 'failed', `Could not start the service: ${result.error}`, {
        finished: true,
      });
    } else {
      await recordLaunch(
        row.name,
        'running',
        row.image_tag
          ? `Deployed image ${row.image_tag} and started the ECS service.`
          : 'Deployed and started the ECS service.',
        { finished: true }
      );
      console.log(
        JSON.stringify({
          event: 'microservice_launch_completed',
          actor,
          microservice: row.name,
          image_tag: row.image_tag,
        })
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordLaunch(row.name, 'failed', message, { finished: true });
    console.error('microservice launch deploy failed', { microservice: row.name, error: message });
  }

  return requireMicroservice(row.name);
}

/** Forgets a launch, leaving the lifecycle states it produced alone. */
export async function clearLaunch(name: string): Promise<MicroserviceRow> {
  await recordLaunch(name, 'none', null);
  return requireMicroservice(name);
}

export interface LaunchReconcileResult {
  /** Every row this tick looked at, and where it left it. */
  launches: Array<{ name: string; launch_state: LaunchState; detail: string | null }>;
}

/**
 * Carries every in-flight launch as far as it can go, with nobody watching.
 *
 * The console's polling is the fast path; this is the one that has to be true.
 * An operator who creates a service and closes the tab still gets a running
 * service. It is also the only thing that repairs a launch whose request died
 * mid-step — the claim in `claimLaunch` releases after two minutes precisely so
 * this can pick it up.
 *
 * Batched, because a deploy is several ECS calls and this runs in the same
 * 30-second function as everything else on the schedule. A launch left for one
 * more tick loses five minutes; a tick that times out repairs nothing at all.
 */
export async function reconcileLaunches(): Promise<LaunchReconcileResult> {
  const pool = await getPool();
  // A fresh deploy can reach the schedule before any request has applied the
  // columns this reads.
  await ensureMicroserviceSchema(pool);

  const { rows } = await pool.query(
    `SELECT name, launch_state,
            (updated_at < NOW() - ($1::int * INTERVAL '1 second')) AS stalled
       FROM microservice_clusters
      WHERE launch_state = ANY($2::text[])
      ORDER BY launch_requested_at NULLS FIRST
      LIMIT $3`,
    [LAUNCH_STALL_SECONDS, [...LAUNCH_IN_FLIGHT], LAUNCH_BATCH]
  );

  const launches: LaunchReconcileResult['launches'] = [];

  for (const candidate of rows) {
    const name = String(candidate.name);
    const state = String(candidate.launch_state) as LaunchState;
    const stalled = candidate.stalled === true;

    try {
      // 'provisioning' and 'deploying' are held by a running request until they
      // stall, so only the states nothing owns are picked up immediately.
      if (state === 'requested' || (state === 'provisioning' && stalled)) {
        const row = await requireMicroservice(name);
        const result = await launchMicroservice({
          name,
          actor: row.launch_requested_by ?? 'scheduled reconcile',
        });
        launches.push({
          name,
          launch_state: result.launch_state,
          detail: result.error ?? result.launch_detail,
        });
        continue;
      }

      if (state === 'building' || (state === 'deploying' && stalled)) {
        const advanced = await advanceLaunch(await refreshBuild(name));
        launches.push({
          name,
          launch_state: advanced.launch_state,
          detail: advanced.launch_detail,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('launch reconcile failed', { microservice: name, error: message });
      launches.push({ name, launch_state: state, detail: message });
    }
  }

  return { launches };
}

// ───────────────────────────────────────────────────────────────────────────
// Status
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything the console needs about one microservice, in one call.
 *
 * The build state is refreshed as a side effect, because there is no callback
 * from CodeBuild and this is the moment someone is looking. `image_stale` is
 * the derived fact worth having: the branch has moved past the commit the
 * running image was built from, so a rebuild is available.
 */
export async function microserviceStatus(name: string) {
  /**
   * Two side effects on a read, both for the same reason: nothing else asks.
   *
   * `refreshBuild` advances the recorded build state because CodeBuild has no
   * callback, and `advanceLaunch` deploys because a build finishing is the
   * event a launch was waiting for. The console polls this every few seconds
   * while a launch is in flight, which is what makes a launch complete in
   * seconds rather than on the next five-minute reconcile.
   */
  const refreshed = await advanceLaunch(await refreshBuild(name));
  const config = infraConfig();

  const runtime =
    refreshed.cluster_name && refreshed.provision_state === 'provisioned'
      ? await serviceRuntimeStatus(
          config,
          name,
          ecsClusterNameFor(config, refreshed.cluster_name)
        )
      : null;

  const image =
    refreshed.ecr_repository_name && refreshed.image_tag
      ? await imageSummary(refreshed.ecr_repository_name, refreshed.image_tag)
      : null;

  const logs = refreshed.log_group_name ? await logGroupSummary(refreshed.log_group_name) : null;
  const buildLogs = refreshed.build_log_group
    ? await logGroupSummary(refreshed.build_log_group)
    : null;

  return {
    microservice: refreshed,
    runtime,
    image,
    logs,
    build_logs: buildLogs,
    ecs_service_name: microserviceNames(config.prefix, name).service,
    ecs_cluster_name: refreshed.cluster_name
      ? ecsClusterNameFor(config, refreshed.cluster_name)
      : null,
    /**
     * The branch has commits the running image does not contain. Null when
     * either sha is unknown, because "we cannot tell" and "it is current" are
     * different answers and only one of them justifies a rebuild prompt.
     */
    image_stale:
      refreshed.build_commit_sha && refreshed.checked_commit_sha
        ? refreshed.build_commit_sha !== refreshed.checked_commit_sha
        : null,
    fetched_at: new Date().toISOString(),
  };
}
