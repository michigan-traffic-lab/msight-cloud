import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  addSensor,
  inventory,
  reconcile,
  removeSensor,
  setSensorEnabled,
} from '../services/sensor-registry';
import { z } from 'zod';

const AddSensorSchema = z.object({
  name: z.string().min(2).max(64),
  display_name: z.string().max(200).nullable().optional(),
});

const SetEnabledSchema = z.object({ enabled: z.boolean() });

/**
 * Sensor registry and reconciliation.
 *
 * Reads are open to any signed-in user — knowing which sensors exist is
 * onboarding information. Everything that changes the registry, and the
 * reconcile that acts on it, is admin-only: it creates and destroys real
 * infrastructure and discards queued messages.
 */
export function sensorRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };

  router.get(`${base}/sensors`, async () => ok(await inventory()));

  router.post(
    `${base}/sensors`,
    async (ctx) => {
      const input = parseWith(AddSensorSchema, readJsonBody(ctx));
      const row = await addSensor({
        name: input.name,
        displayName: input.display_name ?? null,
        actor: ctx.caller.username,
      });
      // Create the infrastructure immediately; the row alone does nothing.
      const result = await reconcile();
      return ok({ sensor: row, reconcile: result });
    },
    admin
  );

  router.post(
    `${base}/sensors/:name/enabled`,
    async (ctx) => {
      const input = parseWith(SetEnabledSchema, readJsonBody(ctx));
      await setSensorEnabled({
        name: ctx.params.name,
        enabled: input.enabled,
        actor: ctx.caller.username,
      });
      return ok({ sensor: ctx.params.name, reconcile: await reconcile() });
    },
    admin
  );

  router.delete(
    `${base}/sensors/:name`,
    async (ctx) => {
      await removeSensor({ name: ctx.params.name, actor: ctx.caller.username });
      return ok({ sensor: ctx.params.name, reconcile: await reconcile() });
    },
    admin
  );

  /** Manual convergence, for drift or to retry a partially-failed change. */
  router.post(`${base}/sensors/reconcile`, async () => ok(await reconcile()), admin);

  return router;
}
