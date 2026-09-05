import { ok } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { getServiceDetail, getSummary, resolvePeriod } from '../services/cost';

/**
 * Cost reporting, filtered to this stack's cost allocation tag.
 *
 * Admin-only: spend figures for a shared research account are not something
 * every console user needs, and the underlying Cost Explorer calls are billed
 * per request.
 */
export function costRoutes(base: string): Router {
  const router = new Router();
  const adminOnly = { middleware: [requireRole('admin')] };

  // No period → current month to date.
  router.get(
    `${base}/cost/summary`,
    async (ctx) => {
      const period = resolvePeriod(ctx.query.start, ctx.query.end);
      return ok(await getSummary(period, ctx.query.refresh === 'true'));
    },
    adminOnly
  );

  router.get(
    `${base}/cost/service`,
    async (ctx) => {
      const period = resolvePeriod(ctx.query.start, ctx.query.end);
      return ok(
        await getServiceDetail(
          ctx.query.service ?? '',
          period,
          ctx.query.refresh === 'true'
        )
      );
    },
    adminOnly
  );

  return router;
}
