import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { addApp, listApps, removeApp, updateApp } from '../services/apps';
import { z } from 'zod';

const AddAppSchema = z.object({
  app_id: z.string().min(2).max(128),
  display_name: z.string().max(200).nullable().optional(),
  receive_sdsm: z.boolean().optional(),
  receive_spat: z.boolean().optional(),
  receive_critical_spat: z.boolean().optional(),
});

/** Absent means unchanged, so the console sends only what was touched. */
const UpdateAppSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  receive_sdsm: z.boolean().optional(),
  receive_spat: z.boolean().optional(),
  receive_critical_spat: z.boolean().optional(),
});

/**
 * The app registry.
 *
 * Reads are open to any signed-in user — which fleets exist and what they
 * subscribe to is onboarding information. Every mutation is admin-only, and
 * more strictly so than it looks: these flags are read on the SDSM and SPaT
 * hot paths, so flipping one changes what real vehicles are told, and the
 * failure mode is silence rather than an error. That matches how the Aurora
 * grid already gates writes to this same table.
 */
export function appRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };

  router.get(`${base}/apps`, async () => ok(await listApps()));

  router.post(
    `${base}/apps`,
    async (ctx) => {
      const input = parseWith(AddAppSchema, readJsonBody(ctx));
      const app = await addApp({
        appId: input.app_id,
        displayName: input.display_name ?? null,
        ...(input.receive_sdsm === undefined ? {} : { receiveSdsm: input.receive_sdsm }),
        ...(input.receive_spat === undefined ? {} : { receiveSpat: input.receive_spat }),
        ...(input.receive_critical_spat === undefined
          ? {}
          : { receiveCriticalSpat: input.receive_critical_spat }),
        actor: ctx.caller.username,
      });
      return ok({ app });
    },
    admin
  );

  router.patch(
    `${base}/apps/:appId`,
    async (ctx) => {
      const input = parseWith(UpdateAppSchema, readJsonBody(ctx));
      const app = await updateApp({
        appId: ctx.params.appId,
        ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
        ...(input.receive_sdsm === undefined ? {} : { receiveSdsm: input.receive_sdsm }),
        ...(input.receive_spat === undefined ? {} : { receiveSpat: input.receive_spat }),
        ...(input.receive_critical_spat === undefined
          ? {}
          : { receiveCriticalSpat: input.receive_critical_spat }),
        actor: ctx.caller.username,
      });
      return ok({ app });
    },
    admin
  );

  router.delete(
    `${base}/apps/:appId`,
    async (ctx) => {
      await removeApp({ appId: ctx.params.appId, actor: ctx.caller.username });
      return ok({ app_id: ctx.params.appId, removed: true });
    },
    admin
  );

  return router;
}
