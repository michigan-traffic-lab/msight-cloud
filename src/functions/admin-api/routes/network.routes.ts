import { ok } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { getTopology } from '../services/network';

/**
 * Read-only view of the VPC.
 *
 * Deliberately read-only: CDK owns this topology, so a change made here would
 * be drift that the next deploy silently reverts. Operator-gated because
 * security group rules describe the stack's attack surface.
 */
export function networkRoutes(base: string): Router {
  const router = new Router();

  router.get(
    `${base}/network/topology`,
    async (ctx) => ok(await getTopology(ctx.query.refresh === 'true')),
    { middleware: [requireRole('operator')] }
  );

  return router;
}
