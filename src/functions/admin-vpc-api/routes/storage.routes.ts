import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  addStorage,
  browseStorage,
  listAdoptableBuckets,
  listStorages,
  reconcileNotifications,
  removeStorage,
  updateStorage,
} from '../services/storage';
import { z } from 'zod';

const AddStorageSchema = z.object({
  bucket: z.string().min(3).max(63),
  display_name: z.string().max(200).nullable().optional(),
  /**
   * Create a new bucket versus adopt one that already exists. Explicit rather
   * than inferred from whether the name resolves: inferring would turn a typo
   * in an existing bucket's name into the silent creation of a new empty one,
   * and the operator would then wonder why no uploads ever appear.
   */
  create: z.boolean(),
  /**
   * Whether to apply the cost allocation tag. Defaults on: a bucket that does
   * not appear in the cost breakdown is the surprise, not the other way round.
   * Declining is for an adopted bucket that also holds unrelated data, whose
   * whole bill would otherwise be booked against this deployment.
   */
  cost_tracked: z.boolean().optional(),
});

const UpdateStorageSchema = z.object({
  display_name: z.string().max(200).nullable().optional(),
  cost_tracked: z.boolean().optional(),
});

/**
 * S3 buckets holding aggregated sensor data.
 *
 * Reads are open to any signed-in user, matching the sensor routes — knowing
 * where data lands is onboarding information. Everything that changes the
 * registry is admin-only: it creates real buckets and rewires S3 event
 * notifications, including on buckets this deployment did not create.
 */
export function storageRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };

  router.get(`${base}/storages`, async () => ok(await listStorages()));

  /** Account buckets not yet registered, for the "adopt existing" picker. */
  router.get(
    `${base}/storages/available`,
    async () => ok(await listAdoptableBuckets()),
    admin
  );

  /**
   * Converges every bucket's upload listener to whether anything archives into
   * it. Runs automatically after every sensor change and on the schedule; this
   * is for drift, or to retry after a bucket was briefly unreachable.
   */
  router.post(
    `${base}/storages/reconcile`,
    async () => ok(await reconcileNotifications()),
    admin
  );

  router.post(
    `${base}/storages`,
    async (ctx) => {
      const input = parseWith(AddStorageSchema, readJsonBody(ctx));
      return ok(
        await addStorage({
          bucket: input.bucket,
          displayName: input.display_name ?? null,
          create: input.create,
          costTracked: input.cost_tracked ?? true,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  router.patch(
    `${base}/storages/:bucket`,
    async (ctx) => {
      const input = parseWith(UpdateStorageSchema, readJsonBody(ctx));
      return ok(
        await updateStorage({
          bucket: ctx.params.bucket,
          ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
          ...(input.cost_tracked === undefined ? {} : { costTracked: input.cost_tracked }),
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  /**
   * Unregisters. The bucket and its contents are untouched — see removeStorage
   * for why the console offers no bucket deletion at all.
   */
  router.delete(
    `${base}/storages/:bucket`,
    async (ctx) => ok(await removeStorage({ bucket: ctx.params.bucket, actor: ctx.caller.username })),
    admin
  );

  /** Live S3 listing. Nothing in this stack records uploads, so S3 is the only source. */
  router.get(`${base}/storages/:bucket/objects`, async (ctx) =>
    ok(
      await browseStorage({
        bucket: ctx.params.bucket,
        ...(ctx.query.prefix ? { prefix: ctx.query.prefix } : {}),
        ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
        ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
      })
    )
  );

  return router;
}
