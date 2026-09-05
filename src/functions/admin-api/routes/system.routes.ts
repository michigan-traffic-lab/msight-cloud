import { ok } from '../../../shared/admin-api/http';
import { Router } from '../../../shared/admin-api/router';
import { buildInfo } from '../services/system';

/**
 * Read-only view of the stack. No role gate beyond the global one: any
 * signed-in console user may read it.
 *
 * Health probing deliberately lives in the browser rather than here: a Lambda
 * calling an API Gateway in the same region measures an in-datacentre hop, not
 * the round trip a client actually experiences.
 */
export function systemRoutes(base: string): Router {
  const router = new Router();

  router.get(`${base}/system/info`, async () => ok(buildInfo()));

  return router;
}
