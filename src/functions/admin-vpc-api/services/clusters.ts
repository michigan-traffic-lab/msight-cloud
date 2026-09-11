import { HttpError } from '../../../shared/admin-api/http';
import { ensureMicroserviceSchema } from '../../../shared/microservice-schema';
import { instanceSpec } from '../../../shared/instance-catalog';
import { getPool } from './db';

/**
 * Compute clusters: where microservice containers actually run.
 *
 * An ECS cluster is only a name. What decides the machines is the capacity
 * attached to it, and there are two kinds with one difference that drives this
 * whole module: **Fargate cannot run GPUs**. Everything else — task
 * definitions, services, scaling policies — is identical between them.
 *
 * One instance type per cluster. That keeps capacity a single number, stops a
 * CPU-only task landing on a GPU box and eating the memory a GPU task needed,
 * and gives cost an honest unit: instance-hours cannot be split between the
 * services sharing a box, but a cluster's can be reported whole.
 *
 * Nothing here provisions anything yet. What it does enforce is that a cluster
 * and the services assigned to it are a coherent plan — above all that the GPU
 * memory promised to those services actually fits on the cards, which is the
 * one limit ECS will not check.
 */

/** Same rules as microservice names: these become ECS cluster names. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type CapacityType = 'fargate' | 'ec2';
export type ClusterScalingMode = 'fixed' | 'auto';

/**
 * How tasks reach the GPU.
 *
 * 'exclusive' sets `resourceRequirements: [{ type: 'GPU', value: '1' }]`, so
 * ECS pins one whole card per task and enforces it.
 *
 * 'shared' sets no GPU requirement and exposes the device with
 * `NVIDIA_VISIBLE_DEVICES` instead, so tasks pack by CPU and memory like any
 * other cluster and all of them see the card. This is the only way to get finer
 * granularity than a whole GPU — `resourceRequirements` takes an integer, and
 * nothing below the driver can enforce a fraction.
 */
export type GpuMode = 'shared' | 'exclusive';

export function clusterNameProblem(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return (
      'A cluster name must be 2-32 characters, start with a lowercase letter, and contain ' +
      'only lowercase letters, digits and hyphens. It becomes the ECS cluster name, which ' +
      'accepts nothing else.'
    );
  }
  return null;
}

export interface ClusterRow {
  name: string;
  display_name: string | null;
  capacity_type: CapacityType;
  instance_type: string | null;
  scaling_mode: ClusterScalingMode;
  min_instances: number;
  max_instances: number;
  target_capacity: number;
  gpus_per_instance: number;
  gpu_vram_mb: number;
  gpu_mode: GpuMode;
  provision_state: string;
  // ── What provisioning created. All null on Fargate, which has no instances. ──
  cluster_arn: string | null;
  launch_template_id: string | null;
  asg_name: string | null;
  capacity_provider_name: string | null;
  /** The AMI the launch template was built with, and when it was resolved. */
  image_id: string | null;
  image_resolved_at: string | null;
  provision_detail: string | null;
  provisioned_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const COLUMNS = `name, display_name, capacity_type, instance_type, scaling_mode,
                 min_instances, max_instances, target_capacity, gpus_per_instance,
                 gpu_vram_mb, gpu_mode, provision_state, cluster_arn, launch_template_id,
                 asg_name, capacity_provider_name, image_id, image_resolved_at,
                 provision_detail, provisioned_at, created_by, created_at, updated_at`;

function toRow(row: Record<string, unknown>): ClusterRow {
  return {
    name: String(row.name),
    display_name: row.display_name === null ? null : String(row.display_name),
    capacity_type: String(row.capacity_type) === 'ec2' ? 'ec2' : 'fargate',
    instance_type: row.instance_type === null ? null : String(row.instance_type),
    scaling_mode: String(row.scaling_mode) === 'fixed' ? 'fixed' : 'auto',
    min_instances: Number(row.min_instances),
    max_instances: Number(row.max_instances),
    target_capacity: Number(row.target_capacity),
    gpus_per_instance: Number(row.gpus_per_instance),
    gpu_vram_mb: Number(row.gpu_vram_mb),
    gpu_mode: String(row.gpu_mode) === 'exclusive' ? 'exclusive' : 'shared',
    provision_state: String(row.provision_state),
    cluster_arn: text(row.cluster_arn),
    launch_template_id: text(row.launch_template_id),
    asg_name: text(row.asg_name),
    capacity_provider_name: text(row.capacity_provider_name),
    image_id: text(row.image_id),
    image_resolved_at: iso(row.image_resolved_at),
    provision_detail: text(row.provision_detail),
    provisioned_at: iso(row.provisioned_at),
    created_by: String(row.created_by),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

async function ensureSchema(): Promise<void> {
  await ensureMicroserviceSchema(await getPool());
}

export interface ClusterSettings {
  capacityType: CapacityType;
  instanceType?: string | null | undefined;
  scalingMode?: ClusterScalingMode | undefined;
  minInstances?: number | undefined;
  maxInstances?: number | undefined;
  targetCapacity?: number | undefined;
  gpusPerInstance?: number | undefined;
  gpuVramMb?: number | undefined;
  gpuMode?: GpuMode | undefined;
}

interface NormalizedCluster {
  capacity_type: CapacityType;
  instance_type: string | null;
  scaling_mode: ClusterScalingMode;
  min_instances: number;
  max_instances: number;
  target_capacity: number;
  gpus_per_instance: number;
  gpu_vram_mb: number;
  gpu_mode: GpuMode;
}

/**
 * Validates a cluster as a whole and fills in the rest.
 *
 * Checked as a set because the fields constrain each other, and because half of
 * them are meaningless on Fargate — there are no instances there to count, so a
 * Fargate cluster with `min_instances: 3` is not a stricter configuration, it
 * is a misunderstanding. Those fields are normalised away rather than stored
 * and silently ignored.
 */
export function normalizeCluster(input: ClusterSettings): NormalizedCluster {
  const capacityType: CapacityType = input.capacityType === 'ec2' ? 'ec2' : 'fargate';

  if (capacityType === 'fargate') {
    if (input.gpusPerInstance && input.gpusPerInstance > 0) {
      throw new HttpError(
        400,
        'fargate_no_gpu',
        'Fargate cannot run GPUs — AWS does not offer it, and it is the reason the EC2 ' +
          'option exists. Use an EC2 cluster with a GPU instance type instead.'
      );
    }
    // Fargate has no instances, so nothing about instance count applies. Task
    // count is a property of each service, not of the cluster.
    return {
      capacity_type: 'fargate',
      instance_type: null,
      scaling_mode: 'auto',
      min_instances: 0,
      max_instances: 0,
      target_capacity: 100,
      gpus_per_instance: 0,
      gpu_vram_mb: 0,
      gpu_mode: 'shared',
    };
  }

  const instanceType = (input.instanceType ?? '').trim();
  if (!instanceType) {
    throw new HttpError(
      400,
      'instance_type_required',
      'An EC2 cluster runs one instance type, and it has to be named — it decides how much ' +
        'CPU, memory and GPU every task on this cluster can be given.'
    );
  }

  const scalingMode: ClusterScalingMode = input.scalingMode === 'fixed' ? 'fixed' : 'auto';
  const minInstances = input.minInstances ?? (scalingMode === 'fixed' ? 1 : 0);
  const maxInstances = input.maxInstances ?? Math.max(minInstances, 4);
  const targetCapacity = input.targetCapacity ?? 100;
  const gpusPerInstance = input.gpusPerInstance ?? 0;
  const gpuVramMb = input.gpuVramMb ?? 0;
  const gpuMode: GpuMode = input.gpuMode === 'exclusive' ? 'exclusive' : 'shared';

  const whole = (value: number, field: string) => {
    if (!Number.isInteger(value) || value < 0) {
      throw new HttpError(400, 'invalid_cluster', `${field} must be a whole number, not negative.`);
    }
  };
  whole(minInstances, 'Minimum instances');
  whole(maxInstances, 'Maximum instances');
  whole(gpusPerInstance, 'GPUs per instance');
  whole(gpuVramMb, 'GPU memory');

  if (maxInstances < minInstances) {
    throw new HttpError(
      400,
      'invalid_cluster',
      `Maximum instances (${maxInstances}) is below the minimum (${minInstances}).`
    );
  }
  if (maxInstances < 1) {
    throw new HttpError(
      400,
      'invalid_cluster',
      'Maximum instances must be at least 1, or nothing can ever run here.'
    );
  }
  if (targetCapacity < 1 || targetCapacity > 100) {
    throw new HttpError(
      400,
      'invalid_cluster',
      'Target capacity is a percentage between 1 and 100. At 100 the cluster keeps only ' +
        'enough instances for the tasks it has, which is cheapest but makes every scale-up ' +
        'wait for an instance to boot.'
    );
  }

  /**
   * Cross-check against the catalog, when the type is one we know.
   *
   * The failure this prevents is quiet and expensive: `g4dn.xlarge` saved with
   * `gpusPerInstance: 0` provisions from the standard AMI with no driver, comes
   * up perfectly healthy, registers zero GPUs, and every GPU task then sits
   * PENDING with a placement message nobody reads. The instance bills the whole
   * time. An uncatalogued type is left alone — that is the documented escape
   * hatch — but a known one is held to what the hardware actually is.
   */
  const catalogued = instanceSpec(instanceType);
  if (catalogued) {
    if (gpusPerInstance > catalogued.gpus) {
      throw new HttpError(
        400,
        'gpu_count_mismatch',
        `${catalogued.name} has ${catalogued.gpus} GPU(s), not ${gpusPerInstance}. ` +
          (catalogued.gpus === 0
            ? 'It is a CPU-only instance type — pick a G or P family type for GPU work.'
            : 'Correct the count, or pick a larger type in the same family.')
      );
    }
    if (gpusPerInstance > 0 && gpuVramMb > catalogued.gpuVramMb) {
      throw new HttpError(
        400,
        'gpu_vram_mismatch',
        `Each ${catalogued.name} card has ${catalogued.gpuVramMb} MiB of video memory, ` +
          `not ${gpuVramMb} MiB. Overstating it defeats the overcommit check that this ` +
          'figure exists for.'
      );
    }
  }

  // A fixed cluster of one instance has no headroom: replacing that instance —
  // a deploy, a patch, a spot reclaim — stops its tasks before new ones can
  // start. Allowed, because it is right for batch work, but not silently.
  if (gpusPerInstance > 0 && gpuVramMb <= 0) {
    throw new HttpError(
      400,
      'gpu_vram_required',
      'A GPU cluster needs the card\'s memory recorded. Nothing in ECS checks video memory, ' +
        'so this figure is what lets the console refuse an overcommit that would otherwise ' +
        'schedule fine and then fail with a CUDA out-of-memory at runtime.'
    );
  }

  return {
    capacity_type: 'ec2',
    instance_type: instanceType,
    scaling_mode: scalingMode,
    min_instances: minInstances,
    max_instances: maxInstances,
    target_capacity: targetCapacity,
    gpus_per_instance: gpusPerInstance,
    gpu_vram_mb: gpuVramMb,
    gpu_mode: gpuMode,
  };
}

export interface ClusterUsage {
  /** Microservices assigned here. At most one — a cluster carries one service. */
  services: number;
  /**
   * The service that occupies it, or null if it is free.
   *
   * Named rather than merely counted so the console can say "carries detector"
   * in the assignment picker instead of silently omitting the cluster and
   * leaving the operator to wonder where it went.
   */
  service_name: string | null;
  /** Their task counts added up — the ceiling under autoscaling. */
  max_tasks: number;
  /** Video memory those services expect to need, per instance. */
  committed_vram_mb: number;
  /** What one instance actually has. */
  available_vram_mb: number;
  /**
   * True when the services promised more video memory than the cards hold.
   * ECS would schedule them all and let them fail at runtime instead.
   */
  vram_overcommitted: boolean;
}

/**
 * What each cluster is being asked to carry.
 *
 * The GPU total is the interesting one, and it is deliberately compared against
 * a *single instance* rather than the fleet: tasks are not spread evenly, and a
 * card either fits what lands on it or does not. Under 'exclusive' the question
 * does not arise, because one task owns the card.
 */
export async function clusterUsage(): Promise<Map<string, ClusterUsage>> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT c.name,
            count(m.name)::int                            AS services,
            min(m.name)                                   AS service_name,
            COALESCE(sum(GREATEST(m.desired_count, m.max_tasks)), 0)::int AS max_tasks,
            COALESCE(sum(m.gpu_vram_mb), 0)::int          AS committed_vram_mb,
            c.gpu_vram_mb                                 AS available_vram_mb,
            c.gpu_mode
       FROM compute_clusters c
       LEFT JOIN microservice_clusters m ON m.cluster_name = c.name
      GROUP BY c.name, c.gpu_vram_mb, c.gpu_mode`
  );

  return new Map(
    rows.map((row) => {
      const committed = Number(row.committed_vram_mb ?? 0);
      const available = Number(row.available_vram_mb ?? 0);
      return [
        String(row.name),
        {
          services: Number(row.services ?? 0),
          service_name: row.service_name == null ? null : String(row.service_name),
          max_tasks: Number(row.max_tasks ?? 0),
          committed_vram_mb: committed,
          available_vram_mb: available,
          vram_overcommitted:
            String(row.gpu_mode) === 'shared' && available > 0 && committed > available,
        },
      ];
    })
  );
}

export async function listClusters() {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM compute_clusters ORDER BY name`
  );
  const usage = await clusterUsage();

  const clusters = rows.map((row) => {
    const cluster = toRow(row);
    return {
      ...cluster,
      usage: usage.get(cluster.name) ?? {
        services: 0,
        service_name: null,
        max_tasks: 0,
        committed_vram_mb: 0,
        available_vram_mb: cluster.gpu_vram_mb,
        vram_overcommitted: false,
      },
    };
  });

  return { clusters, fetched_at: new Date().toISOString() };
}

export async function requireCluster(name: string): Promise<ClusterRow> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM compute_clusters WHERE name = $1`,
    [name]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'cluster_not_found', `No cluster named "${name}".`);
  }
  return toRow(rows[0]);
}

/** The subset of a pg Pool or PoolClient these inserts need. */
interface Executor {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * Inserts a cluster row on a given executor.
 *
 * Split out from {@link createCluster} so it can run inside a caller's
 * transaction. The one caller that needs that is creating a microservice
 * together with the cluster it runs on: two inserts that must both land, since
 * a cluster created for a service that then failed to save is litter the
 * console has no way to describe.
 */
export async function insertCluster(
  db: Executor,
  input: {
    name: string;
    displayName?: string | null;
    settings: ClusterSettings;
    actor: string;
  }
): Promise<ClusterRow> {
  const problem = clusterNameProblem(input.name);
  if (problem) throw new HttpError(400, 'invalid_cluster_name', problem);

  const settings = normalizeCluster(input.settings);

  const existing = await db.query('SELECT 1 FROM compute_clusters WHERE name = $1', [input.name]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HttpError(409, 'cluster_exists', `A cluster named "${input.name}" already exists.`);
  }

  const { rows } = await db.query(
    `INSERT INTO compute_clusters
       (name, display_name, capacity_type, instance_type, scaling_mode, min_instances,
        max_instances, target_capacity, gpus_per_instance, gpu_vram_mb, gpu_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      input.name,
      input.displayName ?? null,
      settings.capacity_type,
      settings.instance_type,
      settings.scaling_mode,
      settings.min_instances,
      settings.max_instances,
      settings.target_capacity,
      settings.gpus_per_instance,
      settings.gpu_vram_mb,
      settings.gpu_mode,
      input.actor,
    ]
  );

  console.log(
    JSON.stringify({
      event: 'cluster_created',
      actor: input.actor,
      cluster: input.name,
      capacity_type: settings.capacity_type,
      instance_type: settings.instance_type,
      gpus_per_instance: settings.gpus_per_instance,
    })
  );

  return toRow(rows[0]);
}

export async function createCluster(input: {
  name: string;
  displayName?: string | null;
  settings: ClusterSettings;
  actor: string;
}): Promise<ClusterRow> {
  await ensureSchema();
  return insertCluster(await getPool(), input);
}

/**
 * Whether a cluster already carries a service, and which one.
 *
 * A cluster holds exactly one service, so this is what the assignment picker
 * and every save have to consult. Without it the unique index refuses the
 * insert and the operator gets a constraint violation instead of the name of
 * the service already sitting there.
 */
export async function clusterOccupant(
  db: Executor,
  clusterName: string
): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT name FROM microservice_clusters WHERE cluster_name = $1 LIMIT 1',
    [clusterName]
  );
  return rows.length > 0 ? String(rows[0].name) : null;
}

export async function updateCluster(input: {
  name: string;
  displayName?: string | null;
  settings: ClusterSettings;
  actor: string;
}): Promise<ClusterRow> {
  const current = await requireCluster(input.name);
  const settings = normalizeCluster(input.settings);

  // Changing capacity type would move every service on it between Fargate and
  // EC2 — a different task definition shape, and on the GPU side a different
  // set of things that can even run. Refused rather than silently rebuilt.
  if (settings.capacity_type !== current.capacity_type) {
    throw new HttpError(
      409,
      'capacity_type_immutable',
      `This cluster runs on ${current.capacity_type}. Switching to ${settings.capacity_type} ` +
        'changes the task definition shape for every service on it, so it is not an edit. ' +
        'Create a second cluster and move the services across.'
    );
  }

  /**
   * An edit to a provisioned cluster marks it drifted rather than applying
   * itself.
   *
   * Changing an instance type or a scaling bound means a new launch template
   * version and a scaling group update, and on a GPU change possibly a
   * different AMI — none of which should happen as a side effect of saving a
   * form. 'drifted' is what the console turns into an explicit "Apply changes",
   * so the operator chooses the moment their instances get replaced.
   */
  const drifted =
    current.provision_state === 'provisioned' || current.provision_state === 'drifted';

  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE compute_clusters
        SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
            instance_type = $4,
            scaling_mode = $5,
            min_instances = $6,
            max_instances = $7,
            target_capacity = $8,
            gpus_per_instance = $9,
            gpu_vram_mb = $10,
            gpu_mode = $11,
            provision_state = CASE WHEN $12::boolean THEN 'drifted' ELSE provision_state END,
            updated_at = NOW()
      WHERE name = $1
      RETURNING ${COLUMNS}`,
    [
      input.name,
      input.displayName !== undefined,
      input.displayName ?? null,
      settings.instance_type,
      settings.scaling_mode,
      settings.min_instances,
      settings.max_instances,
      settings.target_capacity,
      settings.gpus_per_instance,
      settings.gpu_vram_mb,
      settings.gpu_mode,
      drifted,
    ]
  );

  console.log(JSON.stringify({ event: 'cluster_updated', actor: input.actor, cluster: input.name }));
  return toRow(rows[0]);
}

/**
 * Removes a cluster, refusing while anything still runs on it.
 *
 * The foreign key would refuse anyway; this catches it first so the message can
 * name the services rather than surfacing a constraint violation.
 */
export async function removeCluster(input: { name: string; actor: string }) {
  const current = await requireCluster(input.name);
  const pool = await getPool();

  // Deleting the row while AWS resources exist would strand a scaling group
  // launching instances for a cluster nothing remembers — billing forever, and
  // invisible to the console that created it. Deprovision is the way out, and
  // it is a separate deliberate action.
  if (current.provision_state !== 'not_provisioned') {
    throw new HttpError(
      409,
      'cluster_provisioned',
      `"${input.name}" still has AWS resources — an ECS cluster` +
        (current.asg_name ? ', an Auto Scaling group and a capacity provider' : '') +
        '. Deprovision it first, or deleting this row would leave them running with ' +
        'nothing tracking them.'
    );
  }

  const { rows: dependents } = await pool.query(
    `SELECT name FROM microservice_clusters WHERE cluster_name = $1 ORDER BY name`,
    [input.name]
  );

  if (dependents.length > 0) {
    const names = dependents.map((row) => String(row.name));
    throw new HttpError(
      409,
      'cluster_in_use',
      `${names.length} microservice(s) run on "${input.name}": ${names.join(', ')}. Move them ` +
        'to another cluster first — deleting this would leave them configured with nowhere ' +
        'to run.'
    );
  }

  await pool.query('DELETE FROM compute_clusters WHERE name = $1', [input.name]);
  console.log(JSON.stringify({ event: 'cluster_removed', actor: input.actor, cluster: input.name }));

  return { cluster: input.name, removed: true };
}

/**
 * Whether a service's GPU memory fits on the cluster it is being assigned to.
 *
 * Called before a microservice is saved, because this is the check ECS does not
 * do: it schedules on CPU and memory, sees a card with free capacity by those
 * measures, places the task, and the container fails on its first allocation.
 *
 * `excludeService` lets an edit re-count itself out of the total, so raising a
 * service's own requirement is measured against its siblings rather than
 * against itself.
 */
export async function assertVramFits(input: {
  clusterName: string;
  gpuVramMb: number;
  excludeService?: string | undefined;
}): Promise<void> {
  const cluster = await requireCluster(input.clusterName);

  // Only a shared GPU cluster can overcommit. Exclusive gives a task the whole
  // card, and a Fargate or CPU cluster has none to divide.
  if (cluster.gpus_per_instance === 0 || cluster.gpu_mode !== 'shared') return;
  if (input.gpuVramMb <= 0) return;

  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(gpu_vram_mb), 0)::int AS committed
       FROM microservice_clusters
      WHERE cluster_name = $1 AND name <> COALESCE($2, '')`,
    [input.clusterName, input.excludeService ?? null]
  );

  const committed = Number(rows[0]?.committed ?? 0);
  const total = committed + input.gpuVramMb;

  if (total > cluster.gpu_vram_mb) {
    throw new HttpError(
      409,
      'gpu_vram_overcommitted',
      `The services on this cluster would need ${total} MiB of video memory, and ` +
        `each ${cluster.instance_type ?? 'instance'} card has ${cluster.gpu_vram_mb} MiB. ` +
        'ECS schedules on CPU and memory only, so it would place them all and then one would ' +
        'fail with a CUDA out-of-memory. Lower the requirement, move a service off this ' +
        'cluster, or use a card with more memory.'
    );
  }
}
