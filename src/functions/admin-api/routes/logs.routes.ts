import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { getResults, listGroups, startQuery, stopQuery } from '../services/logs';
import { z } from 'zod';

const StartQuerySchema = z.object({
  groups: z.array(z.string()).min(1),
  query: z.string().max(4096).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

/**
 * Log search.
 *
 * Operator-gated: log bodies routinely contain client identifiers and request
 * payloads, which is a wider disclosure than the rest of the read-only console.
 *
 * Queries are asynchronous by necessity — CloudWatch Insights can take longer
 * than an API Gateway timeout, so starting and reading results are separate
 * calls and the console polls.
 */
export function logRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };

  router.get(`${base}/logs/groups`, async () => ok(await listGroups()), operator);

  router.post(
    `${base}/logs/query`,
    async (ctx) => ok(await startQuery(parseWith(StartQuerySchema, readJsonBody(ctx)))),
    operator
  );

  router.get(
    `${base}/logs/query/:queryId`,
    async (ctx) => ok(await getResults(ctx.params.queryId)),
    operator
  );

  router.delete(
    `${base}/logs/query/:queryId`,
    async (ctx) => ok(await stopQuery(ctx.params.queryId)),
    operator
  );

  return router;
}
