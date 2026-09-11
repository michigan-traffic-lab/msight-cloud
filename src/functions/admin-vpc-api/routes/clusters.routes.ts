import { z } from 'zod';
import { created, ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  createCluster,
  listClusters,
  removeCluster,
  updateCluster,
} from '../services/clusters';
import { clusterHealthFor, deprovisionCluster, provisionCluster } from '../services/provisioning';
import {
  INSTANCE_CATALOG,
  INSTANCE_MEMORY_OVERHEAD_MIB,
  taskMemoryCeiling,
} from '../../../shared/instance-catalog';

/**
 * Capacity settings, as one object.
 *
 * Grouped rather than spread across the request because they constrain each
 * other and half of them are meaningless on Fargate — `normalizeCluster`
 * validates the combination and drops what does not apply, so a Fargate cluster
 * cannot end up storing an instance count nothing will ever read.
 */
const CapacityFields = z.object({
  capacity_type: z.enum(['fargate', 'ec2']),
  instance_type: z.string().max(64).nullable().optional(),
  scaling_mode: z.enum(['fixed', 'auto']).optional(),
  min_instances: z.number().int().min(0).max(100).optional(),
  max_instances: z.number().int().min(0).max(100).optional(),
  target_capacity: z.number().int().min(1).max(100).optional(),
  gpus_per_instance: z.number().int().min(0).max(16).optional(),
  gpu_vram_mb: z.number().int().min(0).max(1024 * 1024).optional(),
  gpu_mode: z.enum(['shared', 'exclusive']).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(2).max(32),
  display_name: z.string().max(200).nullable().optional(),
  capacity: CapacityFields,
});

const UpdateSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  capacity: CapacityFields,
});

function settingsOf(capacity: z.infer<typeof CapacityFields>) {
  return {
    capacityType: capacity.capacity_type,
    instanceType: capacity.instance_type,
    scalingMode: capacity.scaling_mode,
    minInstances: capacity.min_instances,
    maxInstances: capacity.max_instances,
    targetCapacity: capacity.target_capacity,
    gpusPerInstance: capacity.gpus_per_instance,
    gpuVramMb: capacity.gpu_vram_mb,
    gpuMode: capacity.gpu_mode,
  };
}

/**
 * Compute clusters.
 *
 * Reads are operator-gated, matching the microservice routes they sit beside —
 * the two are one workflow, and a floor that differed would show half of it.
 * Every mutation is admin-only: a cluster decides what hardware this deployment
 * runs on and what it costs per hour, which is a larger commitment than any
 * single service on it.
 */
export function clusterRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };
  const operator = { middleware: [requireRole('operator')] };

  router.get(`${base}/clusters`, async () => ok(await listClusters()), operator);

  /**
   * The instance catalog, served rather than duplicated in the console.
   *
   * The console needs vCPU, memory, GPU count and VRAM to auto-fill its form
   * and to warn about a task that cannot place. Shipping a second copy of those
   * numbers in the frontend would mean the check the API enforces and the hint
   * the form shows could disagree — and the number in question is the one that
   * decides whether a GPU overcommit is refused.
   *
   * Registered before `:name` so the literal segment wins.
   */
  router.get(
    `${base}/clusters/instance-types`,
    async () =>
      ok({
        instance_types: INSTANCE_CATALOG.map((spec) => ({
          ...spec,
          task_memory_ceiling: taskMemoryCeiling(spec),
        })),
        memory_overhead_mib: INSTANCE_MEMORY_OVERHEAD_MIB,
      }),
    operator
  );

  /**
   * Live health: what ECS actually has, beside what the row asked for.
   *
   * Operator-level, like every other read on this page. The figure worth the
   * round trip is `gpu_visible` — a provisioned GPU cluster that registered
   * zero GPUs looks healthy by every other measure and will never place a GPU
   * task, and nothing else in either console surfaces that.
   */
  router.get(
    `${base}/clusters/:name/health`,
    async (ctx) => ok(await clusterHealthFor(ctx.params.name)),
    operator
  );

  /**
   * Creating and destroying the AWS resources behind a cluster.
   *
   * Admin-only, and separate from saving the row. Provisioning an EC2 cluster
   * starts instances that bill by the second; deprovisioning terminates them
   * and takes the capacity out from under anything still running. Neither
   * should be a side effect of editing a form, which is why an edit marks the
   * cluster 'drifted' and leaves the decision here.
   */
  router.post(
    `${base}/clusters/:name/provision`,
    async (ctx) => ok(await provisionCluster({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  router.post(
    `${base}/clusters/:name/deprovision`,
    async (ctx) =>
      ok(await deprovisionCluster({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  router.post(
    `${base}/clusters`,
    async (ctx) => {
      const input = parseWith(CreateSchema, readJsonBody(ctx));
      return created({
        cluster: await createCluster({
          name: input.name,
          displayName: input.display_name ?? null,
          settings: settingsOf(input.capacity),
          actor: ctx.caller.username,
        }),
      });
    },
    admin
  );

  router.patch(
    `${base}/clusters/:name`,
    async (ctx) => {
      const input = parseWith(UpdateSchema, readJsonBody(ctx));
      return ok({
        cluster: await updateCluster({
          name: ctx.params.name,
          ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
          settings: settingsOf(input.capacity),
          actor: ctx.caller.username,
        }),
      });
    },
    admin
  );

  router.delete(
    `${base}/clusters/:name`,
    async (ctx) => ok(await removeCluster({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  return router;
}
