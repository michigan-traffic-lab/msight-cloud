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
  /** Which compute cluster this runs on. Null means unassigned. */
  cluster_name: z.string().max(32).nullable().optional(),
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

const CreateSchema = z
  .object({
    name: z.string().min(2).max(32),
    display_name: z.string().max(200).nullable().optional(),
    installation_id: z.coerce.number().int().positive(),
    repo_id: z.coerce.number().int().positive().optional(),
    repo_full_name: z.string().max(256).optional(),
    ...SourceFields,
    ...RuntimeFields,
  })
  // Either identifier works: the console sends both, but a hand-made request
  // with just the full name is legitimate and the id is what survives a rename.
  .refine((value) => value.repo_id !== undefined || value.repo_full_name !== undefined, {
    message: 'Either repo_id or repo_full_name is required.',
  });

const UpdateSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  repo_id: z.coerce.number().int().positive().optional(),
  repo_full_name: z.string().max(256).optional(),
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
        clusterName: input.cluster_name,
        gpuVramMb: input.gpu_vram_mb,
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

  router.delete(
    `${base}/microservices/:name`,
    async (ctx) =>
      ok(await removeMicroservice({ name: ctx.params.name, actor: ctx.caller.username })),
    admin
  );

  return router;
}
