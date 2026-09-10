import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  addSensor,
  inventory,
  removeSensor,
  setSensorEnabled,
  setSensorIngest,
} from '../services/sensor-registry';
import { reconcileAll } from '../services/reconcile';
import { z } from 'zod';

const AddSensorSchema = z.object({
  name: z.string().min(2).max(64),
  display_name: z.string().max(200).nullable().optional(),
  /** Omitted defaults to a streaming sensor, which is what every sensor was. */
  stream_enabled: z.boolean().optional(),
  archive_enabled: z.boolean().optional(),
  storage_bucket: z.string().max(63).nullable().optional(),
  storage_prefix: z.string().max(900).nullable().optional(),
});

const SetEnabledSchema = z.object({ enabled: z.boolean() });

/**
 * Every field optional: absent means "leave as it is", so the console sends
 * only what the operator changed rather than restating the whole row and
 * risking a stale form overwriting a change made somewhere else.
 */
const SetIngestSchema = z.object({
  stream_enabled: z.boolean().optional(),
  archive_enabled: z.boolean().optional(),
  storage_bucket: z.string().max(63).nullable().optional(),
  storage_prefix: z.string().max(900).nullable().optional(),
});

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
        ...(input.stream_enabled === undefined ? {} : { streamEnabled: input.stream_enabled }),
        ...(input.archive_enabled === undefined ? {} : { archiveEnabled: input.archive_enabled }),
        ...(input.storage_bucket === undefined ? {} : { storageBucket: input.storage_bucket }),
        ...(input.storage_prefix === undefined ? {} : { storagePrefix: input.storage_prefix }),
        actor: ctx.caller.username,
      });
      // Create the infrastructure immediately; the row alone does nothing.
      // An archive-only sensor has none to create, and reconcile correctly
      // does nothing for it — the S3 side is wired at the bucket, not here.
      const result = await reconcileAll();
      return ok({ sensor: row, reconcile: result.sensors, storage: result.storage });
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
      const result = await reconcileAll();
      return ok({ sensor: ctx.params.name, reconcile: result.sensors, storage: result.storage });
    },
    admin
  );

  /**
   * Which ingest paths this sensor uses.
   *
   * Reconciles afterwards because turning streaming off is a teardown: the
   * queue, subscription and Fargate consumer all have to go, and leaving them
   * running would mean the operator saw the setting change while continuing to
   * pay for exactly what they turned off.
   */
  router.post(
    `${base}/sensors/:name/ingest`,
    async (ctx) => {
      const input = parseWith(SetIngestSchema, readJsonBody(ctx));
      const sensor = await setSensorIngest({
        name: ctx.params.name,
        ...(input.stream_enabled === undefined ? {} : { streamEnabled: input.stream_enabled }),
        ...(input.archive_enabled === undefined ? {} : { archiveEnabled: input.archive_enabled }),
        ...(input.storage_bucket === undefined ? {} : { storageBucket: input.storage_bucket }),
        ...(input.storage_prefix === undefined ? {} : { storagePrefix: input.storage_prefix }),
        actor: ctx.caller.username,
      });
      const result = await reconcileAll();
      return ok({ sensor, reconcile: result.sensors, storage: result.storage });
    },
    admin
  );

  router.delete(
    `${base}/sensors/:name`,
    async (ctx) => {
      await removeSensor({ name: ctx.params.name, actor: ctx.caller.username });
      const result = await reconcileAll();
      return ok({ sensor: ctx.params.name, reconcile: result.sensors, storage: result.storage });
    },
    admin
  );

  /** Manual convergence, for drift or to retry a partially-failed change. */
  router.post(
    `${base}/sensors/reconcile`,
    async () => {
      const result = await reconcileAll();
      return ok({ reconcile: result.sensors, storage: result.storage });
    },
    admin
  );

  return router;
}
