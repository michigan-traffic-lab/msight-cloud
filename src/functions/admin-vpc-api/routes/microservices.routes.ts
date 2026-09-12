import { z } from 'zod';
import { created, ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  checkMicroservice,
  createMicroservice,
  listMicroservices,
  removeMicroservice,
  updateMicroservice,
} from '../services/microservices';
import {
  buildMicroservice,
  clearLaunch,
  teardownMicroservice,
  clearMicroserviceLogs,
  deployMicroservice,
  deprovisionMicroservice,
  launchMicroservice,
  listMicroserviceBuilds,
  listMicroserviceImages,
  microserviceLogs,
  microserviceStatus,
  provisionMicroservice,
  restartMicroservice,
  rollbackMicroservice,
  setLogRetention,
  stopMicroserviceBuild,
} from '../services/provisioning';

/**
 * Fargate accepts only a fixed set of CPU values, and each one allows a
 * specific memory range. Validated here so a bad pairing is refused at the form
 * rather than at task-definition registration, which is where it would surface
 * once provisioning is wired up.
 */
const FARGATE_CPU = [256, 512, 1024, 2048, 4096, 8192, 16384] as const;

const SourceFields = {
  branch: z.string().min(1).max(255).optional(),
  dockerfile_path: z.string().min(1).max(512).optional(),
  build_context: z.string().max(512).optional(),
};

const RuntimeFields = {
  desired_count: z.number().int().min(0).max(20).optional(),
  cpu: z
    .number()
    .int()
    .refine((value) => (FARGATE_CPU as readonly number[]).includes(value), {
      message: `cpu must be one of ${FARGATE_CPU.join(', ')} — Fargate accepts no other values.`,
    })
    .optional(),
  memory: z.number().int().min(512).max(122880).optional(),
  container_port: z.number().int().min(1).max(65535).nullable().optional(),
  /**
   * Video memory this service expects to need, in MiB. Only meaningful on a
   * shared GPU cluster, where it is the console's only guard against an
   * overcommit ECS would schedule and then fail at runtime.
   */
  gpu_vram_mb: z.number().int().min(0).max(1024 * 1024).optional(),
  /**
   * The scaling policy, as one object rather than seven loose fields — its
   * constraints are between the fields, so it is validated as a whole by
   * `normalizeScaling`. Bounds here are only the coarse ones; the relationships
   * (max above min, a target that can settle) are checked in the service.
   */
  scaling: z
    .object({
      mode: z.enum(['fixed', 'auto']).optional(),
      min_tasks: z.number().int().min(0).max(100).optional(),
      max_tasks: z.number().int().min(0).max(100).optional(),
      metric: z.enum(['cpu', 'memory']).optional(),
      target: z.number().int().min(0).max(100).optional(),
      scale_out_cooldown: z.number().int().min(0).max(3600).optional(),
      scale_in_cooldown: z.number().int().min(0).max(3600).optional(),
    })
    .optional(),
};

/** Maps the wire shape onto the service's camelCase input. */
function scalingOf(input: {
  scaling?: {
    mode?: 'fixed' | 'auto';
    min_tasks?: number;
    max_tasks?: number;
    metric?: 'cpu' | 'memory';
    target?: number;
    scale_out_cooldown?: number;
    scale_in_cooldown?: number;
  };
}) {
  const scaling = input.scaling;
  if (!scaling) return undefined;
  return {
    mode: scaling.mode,
    minTasks: scaling.min_tasks,
    maxTasks: scaling.max_tasks,
    metric: scaling.metric,
    target: scaling.target,
    scaleOutCooldown: scaling.scale_out_cooldown,
    scaleInCooldown: scaling.scale_in_cooldown,
  };
}

/**
 * The hardware a service runs on.
 *
 * Sent as part of creating the service, not as a separate cluster. A cluster
 * carries exactly one service, so it is a property of the service rather than
 * something to choose — one is always created, named after the service, and
 * there is deliberately no way to attach to an existing one.
 *
 * Omitted means Fargate, which is the right default: nothing to manage and no
 * cost when idle.
 */
const ComputeFields = z.object({
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

/** Maps the wire shape onto the service's camelCase input. */
function computeOf(input: { compute?: z.infer<typeof ComputeFields> }) {
  const compute = input.compute;
  if (!compute) return undefined;
  return {
    capacityType: compute.capacity_type,
    instanceType: compute.instance_type,
    scalingMode: compute.scaling_mode,
    minInstances: compute.min_instances,
    maxInstances: compute.max_instances,
    targetCapacity: compute.target_capacity,
    gpusPerInstance: compute.gpus_per_instance,
    gpuVramMb: compute.gpu_vram_mb,
    gpuMode: compute.gpu_mode,
  };
}

/** Exported for the test that pins the create contract. */
export const CreateSchema = z
  .object({
    name: z.string().min(2).max(32),
    display_name: z.string().max(200).nullable().optional(),
    installation_id: z.coerce.number().int().positive(),
    repo_id: z.coerce.number().int().positive().optional(),
    repo_full_name: z.string().max(256).optional(),
    compute: ComputeFields.optional(),
    /**
     * Bring the service up, not just register it.
     *
     * Recorded with the row rather than left to whatever the caller does next,
     * which is what makes "create it and run it" a single durable decision:
     * the row is created in 'requested', and the scheduled reconcile starts
     * anything left there. A caller that wants it to begin immediately — the
     * console does — follows this with POST .../launch, which is the same
     * work five minutes sooner.
     *
     * Deliberately not carried out inside this request. Creating the row costs
     * two GitHub round trips; provisioning a GPU cluster and starting a build
     * costs a dozen AWS calls, and the two together do not reliably fit in a
     * 30-second function. A create that times out halfway through provisioning
     * is the worst of both: the caller sees a failure and the service exists.
     *
     * Absent means register only. An omitted field must never be why instances
     * start billing — the console sends it explicitly, from a checkbox that
     * spells out what it starts.
     */
    launch: z.boolean().optional(),
    ...SourceFields,
    ...RuntimeFields,
  })
  // Either identifier works: the console sends both, but a hand-made request
  // with just the full name is legitimate and the id is what survives a rename.
  .refine((value) => value.repo_id !== undefined || value.repo_full_name !== undefined, {
    message: 'Either repo_id or repo_full_name is required.',
  });

/**
 * Both destructive extras default to false.
 *
 * Deleting the image repository throws away every built image, and deleting the
 * log groups throws away the only record of why the service was misbehaving —
 * usually the very reason it is being torn down. Neither should happen because
 * a field was omitted.
 */
const DeprovisionSchema = z.object({
  delete_images: z.boolean().optional(),
  delete_logs: z.boolean().optional(),
});

/**
 * CloudWatch accepts only this set of retention values, and silently rejects
 * anything else — so a free-form number here would look saved and do nothing.
 * `null` is the explicit "never expire", which is a choice rather than an
 * oversight and is spelled out for that reason.
 */
const CLOUDWATCH_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922,
  3288, 3653,
] as const;

const RetentionSchema = z.object({
  retention_days: z
    .number()
    .int()
    .refine((value) => (CLOUDWATCH_RETENTION_DAYS as readonly number[]).includes(value), {
      message: `retention_days must be one of ${CLOUDWATCH_RETENTION_DAYS.join(', ')} — CloudWatch accepts no other values.`,
    })
    .nullable(),
});

const ClearLogsSchema = z.object({
  scope: z.enum(['container', 'build', 'both']).optional(),
});

const UpdateSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  repo_id: z.coerce.number().int().positive().optional(),
  repo_full_name: z.string().max(256).optional(),
  /**
   * Moving a service to a different cluster.
   *
   * On update only. There is no such field on create, where a dedicated cluster
   * is always made — this exists for the recovery case of a service whose
   * cluster was deleted out from under it, not as a routine choice. Capacity
   * itself is edited on the cluster.
   */
  cluster_name: z.string().max(32).nullable().optional(),
  ...SourceFields,
  ...RuntimeFields,
});

/**
 * The microservice registry.
 *
 * Reads are operator-gated to match the GitHub routes beside them — the two are
 * one page, and a floor that differed between them would show a viewer half of
 * it. Creating, editing and removing are admin-only: each one decides which
 * repository this deployment will build and run code from, which is the same
 * class of decision as connecting the installation in the first place.
 *
 * Re-checking is the exception at operator level. It changes no configuration,
 * only looks at GitHub and records what it saw, and noticing that a Dockerfile
 * has been deleted is exactly the kind of thing an operator is for.
 */
export function microserviceRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };
  const operator = { middleware: [requireRole('operator')] };

  router.get(
    `${base}/microservices`,
    async () => ok({ microservices: await listMicroservices() }),
    operator
  );

  router.post(
    `${base}/microservices`,
    async (ctx) => {
      const input = parseWith(CreateSchema, readJsonBody(ctx));
      const result = await createMicroservice({
        name: input.name,
        displayName: input.display_name ?? null,
        installationId: input.installation_id,
        repoId: input.repo_id,
        repoFullName: input.repo_full_name,
        branch: input.branch,
        dockerfilePath: input.dockerfile_path,
        buildContext: input.build_context,
        desiredCount: input.desired_count,
        cpu: input.cpu,
        memory: input.memory,
        containerPort: input.container_port,

        scaling: scalingOf(input),
        compute: computeOf(input),
        gpuVramMb: input.gpu_vram_mb,
        launch: input.launch,
        actor: ctx.caller.username,
      });
      return created(result);
    },
    admin
  );

  // Registered before `:name` so the literal segment wins. The router matches
  // in registration order and these do not actually collide, but the ordering
  // is what keeps that true if a `POST /microservices/:name` is ever added.
  router.post(
    `${base}/microservices/:name/check`,
    async (ctx) => ok(await checkMicroservice(ctx.params.name)),
    operator
  );

  /**
   * Everything about one service: registry row, live ECS state, image, logs.
   *
   * Operator rather than admin, and the only provisioning route that is: an
   * operator's job includes finding out why a service is not running, and this
   * changes nothing. It does advance the recorded build state as a side effect,
   * because CodeBuild has no callback wired up and this is the moment someone
   * is looking.
   */
  router.get(
    `${base}/microservices/:name/status`,
    async (ctx) => ok(await microserviceStatus(ctx.params.name)),
    operator
  );

  /**
   * The lifecycle. Four separate admin-gated actions, deliberately not one.
   *
   * Provision creates a repository and log groups and costs nothing. Build
   * spends CodeBuild minutes. Deploy starts instances that bill by the second.
   * Deprovision destroys. Collapsing them into one button would mean a mistyped
   * form could start a GPU fleet, and a single "sync" would give an operator no
   * moment at which to stop.
   */
  router.post(
    `${base}/microservices/:name/provision`,
    async (ctx) => ok(await provisionMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  /**
   * Everything at once: cluster, scaffolding, image, and the running service.
   *
   * The four routes below it are still there, and still separate, because a
   * launch that fails halfway needs a way to resume the step that failed. But
   * taking all four in order is the ordinary case, and asking an operator to
   * click through them — on two different pages — was ceremony around a
   * decision they made when they filled in the form.
   *
   * Returns as soon as the image build is running. The deploy happens when the
   * build lands, driven by the status endpoint the console polls and by the
   * scheduled reconcile, so it completes whether or not anyone is watching.
   */
  router.post(
    `${base}/microservices/:name/launch`,
    async (ctx) => ok(await launchMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  /**
   * Stops waiting, without touching anything AWS has.
   *
   * For the launch that failed and has been read: it clears the banner and
   * leaves the service exactly as the failure left it, to be repaired with the
   * individual steps. Operator-level because it changes no infrastructure —
   * it is an acknowledgement, not an action.
   */
  router.post(
    `${base}/microservices/:name/launch/dismiss`,
    async (ctx) => ok({ microservice: await clearLaunch(ctx.params.name) }),
    operator
  );

  router.post(
    `${base}/microservices/:name/build`,
    async (ctx) => ok(await buildMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  router.post(
    `${base}/microservices/:name/build/stop`,
    async (ctx) =>
      ok(await stopMicroserviceBuild({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  router.post(
    `${base}/microservices/:name/deploy`,
    async (ctx) => ok(await deployMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  /**
   * Replaces the running tasks without changing the service.
   *
   * Operator-level: it starts no new infrastructure and spends nothing, and
   * "restart the thing that has wedged" is the most ordinary operational act
   * there is. A rolling deployment on the same task definition, so it is also
   * how a rebuilt image under an unchanged tag actually gets pulled.
   */
  router.post(
    `${base}/microservices/:name/restart`,
    async (ctx) => ok(await restartMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    operator
  );

  router.post(
    `${base}/microservices/:name/deprovision`,
    async (ctx) => {
      const input = parseWith(DeprovisionSchema, readJsonBody(ctx));
      return ok(
        await deprovisionMicroservice({
          name: ctx.params.name,
          actor: ctx.caller.username,
          deleteImages: input.delete_images ?? false,
          deleteLogs: input.delete_logs ?? false,
        })
      );
    },
    admin
  );

  /**
   * Reading the logs, as opposed to managing them.
   *
   * Operator-level, like the status beside it: it discloses log bodies, which
   * is the same disclosure the Logs page already makes at the same role, and
   * an operator's job is largely reading these.
   *
   * A tail rather than a search. The Logs page owns search — an Insights query
   * across groups, asynchronous because CloudWatch schedules it — and using
   * that machinery to answer "what did the build just print" would take seconds
   * to say something one call already knows.
   */
  router.get(
    `${base}/microservices/:name/logs`,
    async (ctx) =>
      ok(
        await microserviceLogs({
          name: ctx.params.name,
          source: ctx.query.source === 'build' ? 'build' : 'container',
          ...(ctx.query.limit ? { limit: Number(ctx.query.limit) } : {}),
          // One task's stream, by name. Read only within this service's own log
          // group, so it cannot reach another service's.
          ...(ctx.query.stream ? { stream: ctx.query.stream } : {}),
        })
      ),
    operator
  );

  /**
   * Log management: retention, and emptying now.
   *
   * Operator-level for both. Retention is a cost control an operator should be
   * able to tighten without waiting for an admin, and clearing a log group
   * destroys diagnostic history but nothing an operator relies on afterwards.
   */
  router.put(
    `${base}/microservices/:name/logs/retention`,
    async (ctx) => {
      const input = parseWith(RetentionSchema, readJsonBody(ctx));
      return ok(
        await setLogRetention({
          name: ctx.params.name,
          retentionDays: input.retention_days,
          actor: ctx.caller.username,
        })
      );
    },
    operator
  );

  router.post(
    `${base}/microservices/:name/logs/clear`,
    async (ctx) => {
      const input = parseWith(ClearLogsSchema, readJsonBody(ctx));
      return ok(
        await clearMicroserviceLogs({
          name: ctx.params.name,
          actor: ctx.caller.username,
          scope: input.scope ?? 'both',
        })
      );
    },
    operator
  );

  router.get(
    `${base}/microservices/:name/images`,
    async (ctx) => ok(await listMicroserviceImages(ctx.params.name)),
    operator
  );

  router.post(
    `${base}/microservices/:name/rollback`,
    async (ctx) => {
      const input = parseWith(
        z.object({ image_tag: z.string().min(1).max(256) }),
        readJsonBody(ctx)
      );
      return ok(
        await rollbackMicroservice({
          name: ctx.params.name,
          image_tag: input.image_tag,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  router.get(
    `${base}/microservices/:name/builds`,
    async (ctx) => {
      const limit = ctx.query.limit ? Math.min(Math.max(Number(ctx.query.limit) || 20, 1), 100) : 20;
      return ok(await listMicroserviceBuilds(ctx.params.name, limit));
    },
    operator
  );

  router.patch(
    `${base}/microservices/:name`,
    async (ctx) => {
      const input = parseWith(UpdateSchema, readJsonBody(ctx));
      return ok(
        await updateMicroservice({
          name: ctx.params.name,
          displayName: input.display_name,
          repoId: input.repo_id,
          repoFullName: input.repo_full_name,
          branch: input.branch,
          dockerfilePath: input.dockerfile_path,
          buildContext: input.build_context,
          desiredCount: input.desired_count,
          cpu: input.cpu,
          memory: input.memory,
          containerPort: input.container_port,

          scaling: scalingOf(input),
          clusterName: input.cluster_name,
          gpuVramMb: input.gpu_vram_mb,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  /**
   * Deletes the service: its AWS resources, its cluster, and both rows.
   *
   * One action rather than a precondition. The three steps it replaces each
   * refused until the previous had been done, on two different pages, and there
   * was never a decision in between — a service being deleted does not want its
   * cluster kept. What survives as a choice is the two destructive extras, and
   * they are query parameters rather than a body because this is a DELETE.
   *
   * Nothing is removed if the teardown fails. A row deleted over a resource
   * that is still there is a resource nothing can name again.
   */
  router.delete(
    `${base}/microservices/:name`,
    async (ctx) =>
      ok(
        await teardownMicroservice({
          name: ctx.params.name,
          actor: ctx.caller.username,
          deleteImages: ctx.query.delete_images === 'true',
          deleteLogs: ctx.query.delete_logs === 'true',
        })
      ),
    admin
  );

  return router;
}
