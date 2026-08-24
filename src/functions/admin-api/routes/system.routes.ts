import { ok } from '../http';
import { Router } from '../router';
import { buildOverview } from '../services/system';

/**
 * Read-only view of the stack. No role gate beyond the global one: any signed-in
 * console user may read it.
 */
export function systemRoutes(base: string): Router {
  const router = new Router();

  router.get(`${base}/system/overview`, async () => ok(await buildOverview()));

  return router;
}
