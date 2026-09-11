import { HttpError } from '../../../shared/admin-api/http';
import { ensureMicroserviceSchema } from '../../../shared/microservice-schema';
import type { GithubRepoInfo, InspectBuildResult } from '../../../shared/github/rpc';
import { getPool, withTransaction } from './db';
import { inspectBuild, listInstallationRepos } from './github-client';
import {
  assertVramFits,
  clusterOccupant,
  insertCluster,
  requireCluster,
  type ClusterRow,
  type ClusterSettings,
} from './clusters';

/**
 * The microservice registry: which repository builds each service, and how.
 *
 * One row per microservice. A row records a source (installation, repo, branch,
 * Dockerfile path, build context), the runtime shape its ECS service takes, and
 * whether somebody has asked for it to be running. Nothing here touches AWS —
 * that is `provisioning.ts` — so what this module enforces is that a registered
 * microservice is *buildable*: the branch exists, and there is a Dockerfile
 * where the row says there is.
 *
 * That check is the reason a row cannot be saved unvalidated. Storing a source
 * nobody has verified only moves the failure to the first build, by which point
 * the person who mistyped the path has moved on.
 */

/**
 * Microservice names become ECS service, task family and ECR repository names
 * later, all of which are far stricter than a display label. Enforced now,
 * while there is nothing to migrate.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * `github` would collide with the sibling route prefix, and the rest are
 * reserved so a name can never read as a sub-resource of the collection.
 */
const RESERVED_NAMES = new Set(['github', 'new', 'validate', 'reconcile', 'all']);

export function nameProblem(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return (
      'A microservice name must be 2-32 characters, start with a lowercase letter, and ' +
      'contain only lowercase letters, digits and hyphens. It is used for the ECR ' +
      'repository and the ECS service, which do not accept anything else.'
    );
  }
  if (RESERVED_NAMES.has(name)) {
    return `"${name}" is reserved. Pick another name.`;
  }
  return null;
}

/**
 * Normalises a repo-relative path.
 *
 * GitHub's contents API rejects a leading slash and treats "./x" as a literal
 * directory named ".", so a path pasted from a shell prompt fails in a way that
 * reads as "the file is missing". Normalising here means the stored value and
 * the value looked up are the same string, which is what makes the drift check
 * meaningful later.
 *
 * `..` is refused rather than resolved: nothing legitimate needs it, and
 * allowing it would let a path escape the repository it is scoped to.
 */
export function normalizeRepoPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  const collapsed = trimmed
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  if (collapsed.split('/').some((segment) => segment === '..')) {
    throw new HttpError(
      400,
      'invalid_path',
      'Paths are relative to the repository root and may not contain "..".'
    );
  }

  return collapsed;
}

/** The build context, with the repo root spelled '.' rather than empty. */
export function normalizeBuildContext(raw: string): string {
  const normalized = normalizeRepoPath(raw);
  return normalized === '' || normalized === '.' ? '.' : normalized;
}

export function normalizeDockerfilePath(raw: string): string {
  const normalized = normalizeRepoPath(raw);
  if (normalized === '' || normalized === '.') {
    throw new HttpError(
      400,
      'invalid_path',
      'The Dockerfile path cannot be empty. Use "Dockerfile" for one at the repository root.'
    );
  }
  return normalized;
}

/**
 * How the task count is decided.
 *
 * 'fixed' runs exactly `desired_count`. 'auto' hands the count to Application
 * Auto Scaling, which holds `scaling_metric` at `scaling_target` percent by
 * moving between `min_tasks` and `max_tasks`.
 *
 * Recorded but not yet acted on — the ECS side is the next step — so these
 * values are validated as a coherent policy here rather than being discovered
 * to be nonsense at provisioning time.
 */
export type ScalingMode = 'fixed' | 'auto';

/** The signal target tracking follows. Both are ECS service-level averages. */
export type ScalingMetric = 'cpu' | 'memory';

export interface ScalingInput {
  mode?: ScalingMode | undefined;
  minTasks?: number | undefined;
  maxTasks?: number | undefined;
  metric?: ScalingMetric | undefined;
  target?: number | undefined;
  scaleOutCooldown?: number | undefined;
  scaleInCooldown?: number | undefined;
}

export interface ScalingSettings {
  scaling_mode: ScalingMode;
  min_tasks: number;
  max_tasks: number;
  scaling_metric: ScalingMetric;
  scaling_target: number;
  scale_out_cooldown: number;
  scale_in_cooldown: number;
}

/** ECS refuses a service below this, and a policy that can reach zero. */
const MIN_TASKS_FLOOR = 1;
/** Not an AWS limit — a guard against a typo provisioning a fleet. */
const MAX_TASKS_CEILING = 100;

/**
 * Validates a scaling policy as a whole and fills in the rest.
 *
 * Checked as a set rather than field by field because the constraints are
 * between fields: a maximum below the minimum is a policy that can never
 * settle, and a target of 0 or 100 percent is one that never stops scaling in
 * one direction. None of this is enforced by ECS until a policy is created, and
 * by then the person who typed it has moved on — so it is refused here, while
 * the form that produced it is still open.
 */
export function normalizeScaling(input: ScalingInput | undefined): ScalingSettings {
  const mode: ScalingMode = input?.mode === 'auto' ? 'auto' : 'fixed';
  const metric: ScalingMetric = input?.metric === 'memory' ? 'memory' : 'cpu';

  const minTasks = input?.minTasks ?? 1;
  const maxTasks = input?.maxTasks ?? Math.max(minTasks, 4);
  const target = input?.target ?? 60;
  const scaleOut = input?.scaleOutCooldown ?? 60;
  const scaleIn = input?.scaleInCooldown ?? 300;

  const whole = (value: number, field: string) => {
    if (!Number.isInteger(value)) {
      throw new HttpError(400, 'invalid_scaling', `${field} must be a whole number.`);
    }
  };

  // Only meaningful in 'auto'; in 'fixed' the columns keep their defaults and
  // are ignored, so a half-filled form does not block saving a fixed service.
  if (mode === 'auto') {
    whole(minTasks, 'Minimum tasks');
    whole(maxTasks, 'Maximum tasks');
    whole(target, 'Target utilisation');
    whole(scaleOut, 'Scale-out cooldown');
    whole(scaleIn, 'Scale-in cooldown');

    if (minTasks < MIN_TASKS_FLOOR) {
      throw new HttpError(
        400,
        'invalid_scaling',
        `Minimum tasks must be at least ${MIN_TASKS_FLOOR}. A policy allowed to reach zero ` +
          'has nothing left running to produce the metric it would scale back up on.'
      );
    }
    if (maxTasks > MAX_TASKS_CEILING) {
      throw new HttpError(
        400,
        'invalid_scaling',
        `Maximum tasks is capped at ${MAX_TASKS_CEILING} here, as a guard against a typo ` +
          'provisioning a fleet.'
      );
    }
    if (maxTasks < minTasks) {
      throw new HttpError(
        400,
        'invalid_scaling',
        `Maximum tasks (${maxTasks}) is below minimum tasks (${minTasks}), which is a policy ` +
          'that can never settle.'
      );
    }
    if (target < 10 || target > 90) {
      throw new HttpError(
        400,
        'invalid_scaling',
        'Target utilisation must be between 10% and 90%. Outside that the policy never ' +
          'stops scaling in one direction.'
      );
    }
    if (scaleOut < 0 || scaleIn < 0) {
      throw new HttpError(400, 'invalid_scaling', 'Cooldowns cannot be negative.');
    }
  }

  return {
    scaling_mode: mode,
    min_tasks: minTasks,
    max_tasks: maxTasks,
    scaling_metric: metric,
    scaling_target: target,
    scale_out_cooldown: scaleOut,
    scale_in_cooldown: scaleIn,
  };
}

export type CheckState =
  | 'unchecked'
  | 'ok'
  | 'dockerfile_missing'
  | 'branch_missing'
  | 'context_missing'
  | 'error';

export interface MicroserviceRow {
  name: string;
  display_name: string | null;
  installation_id: number;
  repo_id: number;
  repo_full_name: string;
  branch: string;
  dockerfile_path: string;
  build_context: string;
  check_state: CheckState;
  check_detail: string | null;
  checked_at: string | null;
  checked_commit_sha: string | null;
  dockerfile_sha: string | null;
  dockerfile_size: number | null;
  provision_state: string;
  desired_count: number;
  cpu: number;
  memory: number;
  container_port: number | null;
  /** 'fixed' runs exactly desired_count tasks; 'auto' scales between the bounds. */
  scaling_mode: ScalingMode;
  min_tasks: number;
  max_tasks: number;
  scaling_metric: ScalingMetric;
  scaling_target: number;
  scale_out_cooldown: number;
  scale_in_cooldown: number;
  /** Null until assigned. A service with no cluster has nowhere to run. */
  cluster_name: string | null;
  /**
   * Video memory this service expects to need. ECS never checks it, so it is
   * the console's only way to refuse an overcommit on a shared GPU cluster.
   */
  gpu_vram_mb: number;
  // ── What provisioning created. Null until it has run. ──────────────────
  ecr_repository_name: string | null;
  ecr_repository_uri: string | null;
  build_project_name: string | null;
  log_group_name: string | null;
  /** Null means never expire, which is a choice rather than an oversight. */
  log_retention_days: number | null;
  service_arn: string | null;
  task_definition_arn: string | null;
  image_tag: string | null;
  image_digest: string | null;
  provision_detail: string | null;
  provisioned_at: string | null;
  // ── The last image build. ──────────────────────────────────────────────
  build_id: string | null;
  build_state: BuildState;
  build_detail: string | null;
  /**
   * The commit the running image was built from. Compared against
   * `checked_commit_sha` — the branch head as of the last look at GitHub — this
   * is what distinguishes "deployed" from "up to date".
   */
  build_commit_sha: string | null;
  build_started_at: string | null;
  build_finished_at: string | null;
  build_log_group: string | null;
  build_log_stream: string | null;
  // ── The standing instruction to get this running. ──────────────────────
  /**
   * How far an automatic bring-up has got. 'none' for a service nobody asked
   * to launch; 'requested' for one whose scaffolding has not started yet,
   * which is the state the reconcile looks for.
   */
  launch_state: LaunchState;
  launch_detail: string | null;
  launch_requested_by: string | null;
  launch_requested_at: string | null;
  launch_finished_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Mirrors the CodeBuild states the provisioner records. */
export type BuildState =
  | 'never'
  | 'queued'
  | 'building'
  | 'succeeded'
  | 'failed'
  | 'stopped';

/**
 * How far an automatic bring-up has got.
 *
 * Deliberately a different axis from `provision_state`, which says what exists
 * on AWS. This says whether anyone is still waiting for the service to come up.
 * A row can be 'scaffolded' and 'building' at the same time; what separates a
 * build someone started by hand from one a launch is waiting on is whether the
 * deploy happens on its own when it finishes.
 */
export type LaunchState =
  | 'none'
  | 'requested'
  | 'provisioning'
  | 'building'
  | 'deploying'
  | 'running'
  | 'failed';

/** The states a launch is still in flight in, and the reconcile picks up. */
export const LAUNCH_IN_FLIGHT: readonly LaunchState[] = [
  'requested',
  'provisioning',
  'building',
  'deploying',
];

export const COLUMNS = `name, display_name, installation_id, repo_id, repo_full_name, branch,
                 dockerfile_path, build_context, check_state, check_detail, checked_at,
                 checked_commit_sha, dockerfile_sha, dockerfile_size, provision_state,
                 desired_count, cpu, memory, container_port, scaling_mode, min_tasks,
                 max_tasks, scaling_metric, scaling_target, scale_out_cooldown,
                 scale_in_cooldown, cluster_name, gpu_vram_mb, ecr_repository_name,
                 ecr_repository_uri, build_project_name, log_group_name,
                 log_retention_days, service_arn, task_definition_arn, image_tag,
                 image_digest, provision_detail, provisioned_at, build_id, build_state,
                 build_detail, build_commit_sha, build_started_at, build_finished_at,
                 build_log_group, build_log_stream, launch_state, launch_detail,
                 launch_requested_by, launch_requested_at, launch_finished_at,
                 created_by, created_at, updated_at`;

function optionalIso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function toRow(row: Record<string, unknown>): MicroserviceRow {
  return {
    name: String(row.name),
    display_name: row.display_name === null ? null : String(row.display_name),
    installation_id: Number(row.installation_id),
    repo_id: Number(row.repo_id),
    repo_full_name: String(row.repo_full_name),
    branch: String(row.branch),
    dockerfile_path: String(row.dockerfile_path),
    build_context: String(row.build_context),
    check_state: String(row.check_state) as CheckState,
    check_detail: row.check_detail === null ? null : String(row.check_detail),
    checked_at: optionalIso(row.checked_at),
    checked_commit_sha: row.checked_commit_sha === null ? null : String(row.checked_commit_sha),
    dockerfile_sha: row.dockerfile_sha === null ? null : String(row.dockerfile_sha),
    dockerfile_size: row.dockerfile_size === null ? null : Number(row.dockerfile_size),
    provision_state: String(row.provision_state),
    desired_count: Number(row.desired_count),
    cpu: Number(row.cpu),
    memory: Number(row.memory),
    container_port: row.container_port === null ? null : Number(row.container_port),
    scaling_mode: (String(row.scaling_mode) === 'auto' ? 'auto' : 'fixed') as ScalingMode,
    min_tasks: Number(row.min_tasks),
    max_tasks: Number(row.max_tasks),
    scaling_metric: (String(row.scaling_metric) === 'memory' ? 'memory' : 'cpu') as ScalingMetric,
    scaling_target: Number(row.scaling_target),
    scale_out_cooldown: Number(row.scale_out_cooldown),
    scale_in_cooldown: Number(row.scale_in_cooldown),
    cluster_name: row.cluster_name == null ? null : String(row.cluster_name),
    gpu_vram_mb: Number(row.gpu_vram_mb ?? 0),
    ecr_repository_name: text(row.ecr_repository_name),
    ecr_repository_uri: text(row.ecr_repository_uri),
    build_project_name: text(row.build_project_name),
    log_group_name: text(row.log_group_name),
    log_retention_days: row.log_retention_days == null ? null : Number(row.log_retention_days),
    service_arn: text(row.service_arn),
    task_definition_arn: text(row.task_definition_arn),
    image_tag: text(row.image_tag),
    image_digest: text(row.image_digest),
    provision_detail: text(row.provision_detail),
    provisioned_at: optionalIso(row.provisioned_at),
    build_id: text(row.build_id),
    build_state: (text(row.build_state) ?? 'never') as BuildState,
    build_detail: text(row.build_detail),
    build_commit_sha: text(row.build_commit_sha),
    build_started_at: optionalIso(row.build_started_at),
    build_finished_at: optionalIso(row.build_finished_at),
    build_log_group: text(row.build_log_group),
    build_log_stream: text(row.build_log_stream),
    launch_state: (text(row.launch_state) ?? 'none') as LaunchState,
    launch_detail: text(row.launch_detail),
    launch_requested_by: text(row.launch_requested_by),
    launch_requested_at: optionalIso(row.launch_requested_at),
    launch_finished_at: optionalIso(row.launch_finished_at),
    created_by: String(row.created_by),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

/** Null-preserving string coercion, for the many nullable columns above. */
function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

async function ensureSchema(): Promise<void> {
  await ensureMicroserviceSchema(await getPool());
}

export async function listMicroservices(): Promise<MicroserviceRow[]> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM microservice_clusters ORDER BY name`);
  return rows.map(toRow);
}

export async function requireMicroservice(name: string): Promise<MicroserviceRow> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM microservice_clusters WHERE name = $1`,
    [name]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'microservice_not_found', `No microservice named "${name}".`);
  }
  return toRow(rows[0]);
}

/**
 * Resolves a repo the console named against what the installation actually
 * grants.
 *
 * Deliberately not a direct `GET /repos/{owner}/{repo}`: that would succeed for
 * any public repository on GitHub, including ones this installation was never
 * given. Matching against the installation's own list is what makes the grant —
 * rather than the repo's visibility — the thing that decides.
 */
async function resolveRepo(
  installationId: number,
  identifier: { repoId?: number | undefined; repoFullName?: string | undefined }
): Promise<GithubRepoInfo> {
  const { repositories, truncated } = await listInstallationRepos(installationId);

  const match = repositories.find((repo) =>
    identifier.repoId !== undefined
      ? repo.repo_id === identifier.repoId
      : repo.full_name.toLowerCase() === (identifier.repoFullName ?? '').toLowerCase()
  );

  if (!match) {
    const named = identifier.repoFullName ?? `id ${identifier.repoId}`;
    throw new HttpError(
      404,
      'repo_not_granted',
      `The installation does not grant access to ${named}.` +
        (truncated
          ? ' Its repository list was too long to read in full, so the repo may exist but ' +
            'not be visible here.'
          : ' Add it to the App installation on GitHub, then try again.')
    );
  }

  if (match.archived) {
    throw new HttpError(
      400,
      'repo_archived',
      `${match.full_name} is archived on GitHub, so nothing can be built from it.`
    );
  }

  return match;
}

export interface CheckOutcome {
  state: CheckState;
  detail: string | null;
  commitSha: string | null;
  dockerfileSha: string | null;
  dockerfileSize: number | null;
}

/**
 * Turns an inspection into the outcome stored on the row.
 *
 * Pure, and separate from the call that produced it, because this is the part
 * worth testing: which absence maps to which state, and what the operator is
 * told to do about it.
 */
export function interpretInspection(
  inspection: InspectBuildResult,
  source: { repoFullName: string; branch: string; dockerfilePath: string; buildContext: string }
): CheckOutcome {
  if (!inspection.branch) {
    return {
      state: 'branch_missing',
      detail:
        `${source.repoFullName} has no branch "${source.branch}". Check the spelling, or ` +
        `pick the branch the service is actually built from.`,
      commitSha: null,
      dockerfileSha: null,
      dockerfileSize: null,
    };
  }

  const commitSha = inspection.branch.head_sha || null;

  if (!inspection.dockerfile) {
    return {
      state: 'dockerfile_missing',
      detail:
        `No Dockerfile at "${source.dockerfilePath}" on ${source.repoFullName}@` +
        `${source.branch}. If the repository keeps it somewhere else — a service ` +
        `subdirectory, or a name like "docker/Dockerfile.prod" — set the Dockerfile path ` +
        `to that. If the repository has no Dockerfile at all, one has to be added before ` +
        `this can be built: a container image is the only thing Fargate can run.`,
      commitSha,
      dockerfileSha: null,
      dockerfileSize: null,
    };
  }

  if (inspection.build_context === 'missing') {
    return {
      state: 'context_missing',
      detail:
        `The Dockerfile exists, but there is no directory "${source.buildContext}" on ` +
        `${source.branch} to build it in.`,
      commitSha,
      dockerfileSha: inspection.dockerfile.sha,
      dockerfileSize: inspection.dockerfile.size,
    };
  }

  if (inspection.build_context === 'not_a_directory') {
    return {
      state: 'context_missing',
      detail:
        `"${source.buildContext}" is a file, not a directory. The build context is the ` +
        `directory docker build runs in — usually the repository root, or the service's ` +
        `own subdirectory in a monorepo.`,
      commitSha,
      dockerfileSha: inspection.dockerfile.sha,
      dockerfileSize: inspection.dockerfile.size,
    };
  }

  // An empty Dockerfile passes every existence check and fails every build, so
  // it is called out here rather than left for CodeBuild to discover.
  if (inspection.dockerfile.size === 0) {
    return {
      state: 'error',
      detail: `${inspection.dockerfile.path} exists but is empty.`,
      commitSha,
      dockerfileSha: inspection.dockerfile.sha,
      dockerfileSize: 0,
    };
  }

  return {
    state: 'ok',
    detail: null,
    commitSha,
    dockerfileSha: inspection.dockerfile.sha,
    dockerfileSize: inspection.dockerfile.size,
  };
}

/** The HTTP error a failed check becomes when it blocks a save. */
function checkFailure(outcome: CheckOutcome): HttpError {
  const code =
    outcome.state === 'branch_missing'
      ? 'branch_not_found'
      : outcome.state === 'dockerfile_missing'
        ? 'dockerfile_not_found'
        : outcome.state === 'context_missing'
          ? 'build_context_not_found'
          : 'source_unusable';
  return new HttpError(400, code, outcome.detail ?? 'The source could not be verified.');
}

interface SourceFields {
  installationId: number;
  owner: string;
  repo: string;
  repoFullName: string;
  branch: string;
  dockerfilePath: string;
  buildContext: string;
}

async function runCheck(source: SourceFields): Promise<CheckOutcome> {
  const inspection = await inspectBuild({
    installationId: source.installationId,
    owner: source.owner,
    repo: source.repo,
    branch: source.branch,
    dockerfilePath: source.dockerfilePath,
    buildContext: source.buildContext,
  });

  return interpretInspection(inspection, {
    repoFullName: source.repoFullName,
    branch: source.branch,
    dockerfilePath: source.dockerfilePath,
    buildContext: source.buildContext,
  });
}

export interface CreateMicroserviceInput {
  name: string;
  displayName?: string | null;
  installationId: number;
  repoId?: number | undefined;
  repoFullName?: string | undefined;
  /** Defaults to the repository's own default branch. */
  branch?: string | undefined;
  dockerfilePath?: string | undefined;
  buildContext?: string | undefined;
  desiredCount?: number | undefined;
  cpu?: number | undefined;
  memory?: number | undefined;
  containerPort?: number | null | undefined;
  scaling?: ScalingInput | undefined;
  /**
   * The hardware this service runs on.
   *
   * A cluster is created for it, always, named after the service. There is no
   * option to attach to an existing one and no way to create a service without
   * one, because a cluster carries exactly one service — which makes it a
   * property of the service, not a thing to choose. Asking an operator to
   * create one first, or to pick from a list that will only ever have one
   * relevant entry, is ceremony around a decision they have already made by
   * filling in this form.
   *
   * Defaults to Fargate, which is the right default: nothing to manage and no
   * cost when idle.
   *
   * The cluster and the service are inserted in one transaction, so a service
   * that fails to save leaves no cluster behind.
   */
  compute?: ClusterSettings | undefined;
  gpuVramMb?: number | undefined;
  /**
   * Whether to bring the service up as well as register it.
   *
   * Recorded here, in the same transaction as the row, rather than being left
   * to whatever the caller does next. The bring-up itself takes minutes — a
   * docker build sits in the middle of it — so the intent has to outlive this
   * request, and the reconcile picks up anything whose follow-up never arrived.
   * That is what makes "create it and run it" survive a closed tab.
   *
   * Off by default. An omitted field must never be the reason instances start
   * billing; the console sends it explicitly, from a checkbox that says so.
   */
  launch?: boolean | undefined;
  actor: string;
}

export async function createMicroservice(
  input: CreateMicroserviceInput
): Promise<{
  microservice: MicroserviceRow;
  repo: GithubRepoInfo;
  /** The dedicated cluster created for it. */
  cluster: ClusterRow;
}> {
  await ensureSchema();

  const problem = nameProblem(input.name);
  if (problem) {
    throw new HttpError(400, 'invalid_name', problem);
  }

  const pool = await getPool();
  const existing = await pool.query(`SELECT 1 FROM microservice_clusters WHERE name = $1`, [
    input.name,
  ]);
  if (existing.rows.length > 0) {
    throw new HttpError(
      409,
      'microservice_exists',
      `A microservice named "${input.name}" already exists.`
    );
  }

  const repo = await resolveRepo(input.installationId, {
    repoId: input.repoId,
    repoFullName: input.repoFullName,
  });

  const branch = (input.branch ?? '').trim() || repo.default_branch;
  const dockerfilePath = normalizeDockerfilePath(input.dockerfilePath ?? 'Dockerfile');
  const buildContext = normalizeBuildContext(input.buildContext ?? '.');

  // Checked before the insert, so a source nobody verified is never stored.
  const outcome = await runCheck({
    installationId: input.installationId,
    owner: repo.owner,
    repo: repo.name,
    repoFullName: repo.full_name,
    branch,
    dockerfilePath,
    buildContext,
  });

  if (outcome.state !== 'ok') {
    throw checkFailure(outcome);
  }

  const scaling = normalizeScaling(input.scaling);
  const gpuVramMb = input.gpuVramMb ?? 0;

  /**
   * The cluster takes the service's name.
   *
   * Not configurable, because a second name for a thing that maps one-to-one
   * onto the service is only a way for the two to disagree. It is also the name
   * an operator will look for in ECS and on the Cost page, so matching the
   * service is the only helpful choice.
   */
  const clusterName = input.name;

  // Fargate unless told otherwise: nothing to manage, no cost when idle.
  const compute: ClusterSettings = input.compute ?? { capacityType: 'fargate' };

  /**
   * Both rows, or neither.
   *
   * The cluster has to exist before the microservice row can reference it, and
   * the microservice insert can still fail — on the source uniqueness index,
   * for instance. Outside a transaction that failure leaves an empty cluster
   * nobody asked for and the console has no way to describe.
   */
  const created = await withTransaction(async (client) => {
    const cluster = await insertCluster(client, {
      name: clusterName,
      displayName: input.displayName ?? null,
      settings: compute,
      actor: input.actor,
    });

    const { rows } = await client.query(
      `INSERT INTO microservice_clusters
            (name, display_name, installation_id, repo_id, repo_full_name, branch,
             dockerfile_path, build_context, check_state, check_detail, checked_at,
             checked_commit_sha, dockerfile_sha, dockerfile_size, desired_count, cpu,
             memory, container_port, scaling_mode, min_tasks, max_tasks, scaling_metric,
             scaling_target, scale_out_cooldown, scale_in_cooldown, cluster_name,
             gpu_vram_mb, launch_state, launch_requested_by, launch_requested_at,
             launch_detail, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13,
                  COALESCE($14, 1), COALESCE($15, 256), COALESCE($16, 512), $17,
                  $18, $19, $20, $21, $22, $23, $24, $25, $26,
                  CASE WHEN $27::boolean THEN 'requested' ELSE 'none' END,
                  CASE WHEN $27::boolean THEN $28::text ELSE NULL END,
                  CASE WHEN $27::boolean THEN NOW() ELSE NULL END,
                  CASE WHEN $27::boolean
                       THEN 'Waiting to create its cluster and build its image.'
                       ELSE NULL END,
                  $28)
       RETURNING ${COLUMNS}`,
      [
        input.name,
        input.displayName ?? null,
        input.installationId,
        repo.repo_id,
        repo.full_name,
        branch,
        dockerfilePath,
        buildContext,
        outcome.state,
        outcome.detail,
        outcome.commitSha,
        outcome.dockerfileSha,
        outcome.dockerfileSize,
        input.desiredCount ?? null,
        input.cpu ?? null,
        input.memory ?? null,
        input.containerPort ?? null,
        scaling.scaling_mode,
        scaling.min_tasks,
        scaling.max_tasks,
        scaling.scaling_metric,
        scaling.scaling_target,
        scaling.scale_out_cooldown,
        scaling.scale_in_cooldown,
        clusterName,
        gpuVramMb,
        Boolean(input.launch),
        input.actor,
      ]
    );

    return { microservice: toRow(rows[0]), cluster };
  });

  console.log('microservice registered', {
    name: input.name,
    repo: repo.full_name,
    branch,
    dockerfile: dockerfilePath,
    cluster: clusterName,
    capacity_type: created.cluster.capacity_type,
    instance_type: created.cluster.instance_type,
    launch: Boolean(input.launch),
    actor: input.actor,
  });

  return { microservice: created.microservice, repo, cluster: created.cluster };
}

export interface UpdateMicroserviceInput {
  name: string;
  displayName?: string | null;
  repoId?: number | undefined;
  repoFullName?: string | undefined;
  branch?: string | undefined;
  dockerfilePath?: string | undefined;
  buildContext?: string | undefined;
  desiredCount?: number | undefined;
  cpu?: number | undefined;
  memory?: number | undefined;
  containerPort?: number | null | undefined;
  scaling?: ScalingInput | undefined;
  clusterName?: string | null | undefined;
  gpuVramMb?: number | undefined;
  actor: string;
}

/**
 * Edits a microservice.
 *
 * Anything absent is left alone, so the console sends only what was touched.
 * If any of the four source fields changed, the new source is checked before it
 * is written and a failure leaves the row exactly as it was — an operator
 * mistyping a path does not break a microservice that was working.
 */
export async function updateMicroservice(
  input: UpdateMicroserviceInput
): Promise<{ microservice: MicroserviceRow; rechecked: boolean }> {
  await ensureSchema();
  const current = await requireMicroservice(input.name);
  const pool = await getPool();

  const repoChanged = input.repoId !== undefined || input.repoFullName !== undefined;
  const repo = repoChanged
    ? await resolveRepo(current.installation_id, {
        repoId: input.repoId,
        repoFullName: input.repoFullName,
      })
    : null;

  const branch = input.branch === undefined ? current.branch : input.branch.trim();
  if (branch.length === 0) {
    throw new HttpError(400, 'invalid_branch', 'The branch cannot be empty.');
  }

  const dockerfilePath =
    input.dockerfilePath === undefined
      ? current.dockerfile_path
      : normalizeDockerfilePath(input.dockerfilePath);
  const buildContext =
    input.buildContext === undefined
      ? current.build_context
      : normalizeBuildContext(input.buildContext);

  const sourceChanged =
    (repo !== null && repo.repo_id !== current.repo_id) ||
    branch !== current.branch ||
    dockerfilePath !== current.dockerfile_path ||
    buildContext !== current.build_context;

  const repoFullName = repo?.full_name ?? current.repo_full_name;
  const [owner = '', repoName = ''] = repoFullName.split('/');

  let outcome: CheckOutcome | null = null;
  if (sourceChanged) {
    outcome = await runCheck({
      installationId: current.installation_id,
      owner,
      repo: repoName,
      repoFullName,
      branch,
      dockerfilePath,
      buildContext,
    });

    if (outcome.state !== 'ok') {
      throw checkFailure(outcome);
    }
  }

  // Carried forward from the stored row when the caller sends nothing, so an
  // edit that only changes the branch does not silently reset the policy.
  const scaling = normalizeScaling(
    input.scaling ?? {
      mode: current.scaling_mode,
      minTasks: current.min_tasks,
      maxTasks: current.max_tasks,
      metric: current.scaling_metric,
      target: current.scaling_target,
      scaleOutCooldown: current.scale_out_cooldown,
      scaleInCooldown: current.scale_in_cooldown,
    }
  );

  // Absent means unchanged, so an edit that only moves a branch does not clear
  // the cluster assignment or reset the VRAM figure.
  const clusterName =
    input.clusterName === undefined ? current.cluster_name : (input.clusterName ?? null);
  const gpuVramMb = input.gpuVramMb ?? current.gpu_vram_mb;

  if (clusterName && clusterName !== current.cluster_name) {
    // Only on a move. Named here so the refusal identifies the service already
    // there instead of surfacing the unique index as a constraint violation.
    const occupant = await clusterOccupant(pool, clusterName);
    if (occupant && occupant !== input.name) {
      throw new HttpError(
        409,
        'cluster_occupied',
        `Cluster "${clusterName}" already carries "${occupant}". A cluster runs exactly one ` +
          'service, so this one needs an empty cluster or a new one of its own.'
      );
    }
  }

  if (clusterName) {
    // Excluding itself: raising this service's own requirement is measured
    // against its siblings, not against the figure being replaced.
    await assertVramFits({ clusterName, gpuVramMb, excludeService: input.name });
  }

  const { rows } = await pool.query(
    `UPDATE microservice_clusters
        SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
            repo_id = $4,
            repo_full_name = $5,
            branch = $6,
            dockerfile_path = $7,
            build_context = $8,
            check_state = COALESCE($9, check_state),
            check_detail = CASE WHEN $9::text IS NULL THEN check_detail ELSE $10 END,
            checked_at = CASE WHEN $9::text IS NULL THEN checked_at ELSE NOW() END,
            checked_commit_sha = CASE WHEN $9::text IS NULL THEN checked_commit_sha ELSE $11 END,
            dockerfile_sha = CASE WHEN $9::text IS NULL THEN dockerfile_sha ELSE $12 END,
            dockerfile_size = CASE WHEN $9::text IS NULL THEN dockerfile_size ELSE $13 END,
            desired_count = COALESCE($14, desired_count),
            cpu = COALESCE($15, cpu),
            memory = COALESCE($16, memory),
            container_port = CASE WHEN $17::boolean THEN $18 ELSE container_port END,
            scaling_mode = $19,
            min_tasks = $20,
            max_tasks = $21,
            scaling_metric = $22,
            scaling_target = $23,
            scale_out_cooldown = $24,
            scale_in_cooldown = $25,
            cluster_name = $26,
            gpu_vram_mb = $27,
            updated_at = NOW()
      WHERE name = $1
      RETURNING ${COLUMNS}`,
    [
      input.name,
      input.displayName !== undefined,
      input.displayName ?? null,
      repo?.repo_id ?? current.repo_id,
      repoFullName,
      branch,
      dockerfilePath,
      buildContext,
      outcome?.state ?? null,
      outcome?.detail ?? null,
      outcome?.commitSha ?? null,
      outcome?.dockerfileSha ?? null,
      outcome?.dockerfileSize ?? null,
      input.desiredCount ?? null,
      input.cpu ?? null,
      input.memory ?? null,
      input.containerPort !== undefined,
      input.containerPort ?? null,
      scaling.scaling_mode,
      scaling.min_tasks,
      scaling.max_tasks,
      scaling.scaling_metric,
      scaling.scaling_target,
      scaling.scale_out_cooldown,
      scaling.scale_in_cooldown,
      clusterName,
      gpuVramMb,
    ]
  );

  console.log('microservice updated', {
    name: input.name,
    actor: input.actor,
    sourceChanged,
  });

  return { microservice: toRow(rows[0]), rechecked: sourceChanged };
}

/**
 * Re-runs the check against GitHub and records the result.
 *
 * Unlike a save, this never fails on a bad outcome — reporting that the
 * Dockerfile has since been deleted IS the answer. That is the whole point of
 * storing `check_state`: the source was verified once, and this is how drift
 * becomes visible instead of surfacing as a failed build much later.
 */
export async function checkMicroservice(
  name: string
): Promise<{ microservice: MicroserviceRow }> {
  await ensureSchema();
  const current = await requireMicroservice(name);
  const [owner = '', repoName = ''] = current.repo_full_name.split('/');

  let outcome: CheckOutcome;
  try {
    outcome = await runCheck({
      installationId: current.installation_id,
      owner,
      repo: repoName,
      repoFullName: current.repo_full_name,
      branch: current.branch,
      dockerfilePath: current.dockerfile_path,
      buildContext: current.build_context,
    });
  } catch (error) {
    // A transport or permission failure is recorded as 'error' rather than
    // thrown away, so the page shows why the last look did not work instead of
    // going on displaying a stale 'ok'.
    if (!(error instanceof HttpError)) {
      throw error;
    }
    outcome = {
      state: 'error',
      detail: error.message,
      commitSha: null,
      dockerfileSha: null,
      dockerfileSize: null,
    };
  }

  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE microservice_clusters
        SET check_state = $2, check_detail = $3, checked_at = NOW(),
            checked_commit_sha = $4, dockerfile_sha = $5, dockerfile_size = $6,
            updated_at = NOW()
      WHERE name = $1
      RETURNING ${COLUMNS}`,
    [
      name,
      outcome.state,
      outcome.detail,
      outcome.commitSha,
      outcome.dockerfileSha,
      outcome.dockerfileSize,
    ]
  );

  return { microservice: toRow(rows[0]) };
}

/**
 * Removes a microservice from the registry.
 *
 * Refused while anything is provisioned. Deleting the row first would strand
 * the ECR repository, the build project, the log groups and the ECS service —
 * every one of them billing, and none of them findable from a console that has
 * just forgotten they exist. Deprovisioning is a separate, deliberate action
 * precisely because it destroys things.
 */
export async function removeMicroservice(input: {
  name: string;
  actor: string;
}): Promise<{ name: string; removed: boolean; infrastructure_removed: boolean }> {
  await ensureSchema();
  const current = await requireMicroservice(input.name);
  const pool = await getPool();

  if (current.provision_state !== 'not_provisioned') {
    throw new HttpError(
      409,
      'microservice_provisioned',
      `"${input.name}" still has AWS resources: ` +
        [
          current.ecr_repository_name && 'an image repository',
          current.build_project_name && 'a build project',
          current.log_group_name && 'log groups',
          current.service_arn && 'a running ECS service',
        ]
          .filter(Boolean)
          .join(', ') +
        '. Deleting the service takes those down first; this route only drops the row, ' +
        'which would leave them running with nothing tracking them.'
    );
  }

  /**
   * The dedicated cluster goes with it.
   *
   * It exists for this service alone, so leaving the row behind would leave an
   * empty cluster on the Clusters page that nothing explains and nobody will
   * ever assign a service to. Refused while that cluster still has AWS
   * resources — deprovisioning the service takes them down, so the ordinary
   * path arrives here with nothing left to strand.
   *
   * One transaction, and the service first: the foreign key is RESTRICT, so the
   * cluster cannot be deleted while the row referencing it exists.
   */
  if (current.cluster_name) {
    const cluster = await requireCluster(current.cluster_name);
    if (cluster.provision_state !== 'not_provisioned') {
      throw new HttpError(
        409,
        'cluster_provisioned',
        `The cluster behind "${input.name}" still has AWS resources. Deleting the service ` +
          'takes them down first; this route only drops the rows.'
      );
    }
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM microservice_clusters WHERE name = $1`, [input.name]);
    if (current.cluster_name) {
      await client.query(`DELETE FROM compute_clusters WHERE name = $1`, [current.cluster_name]);
    }
  });

  console.log('microservice removed', {
    name: input.name,
    repo: current.repo_full_name,
    actor: input.actor,
  });

  return {
    name: input.name,
    removed: true,
    infrastructure_removed: current.provision_state !== 'not_provisioned',
  };
}
