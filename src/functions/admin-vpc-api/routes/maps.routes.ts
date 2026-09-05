import { ok } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { getMap, listMaps } from '../services/maps';

/**
 * Intersection MAP data.
 *
 * Read-only. Editing a MAP means replacing decoded J2735 geometry, which is not
 * something a console form should do — a malformed lane set breaks SPaT
 * broadcasts silently. Validation findings are surfaced instead, so a bad map
 * is visible even though it cannot be fixed here.
 */
export function mapRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };

  router.get(`${base}/maps`, async () => ok(await listMaps()), operator);

  router.get(`${base}/maps/:name`, async (ctx) => ok(await getMap(ctx.params.name)), operator);

  return router;
}
