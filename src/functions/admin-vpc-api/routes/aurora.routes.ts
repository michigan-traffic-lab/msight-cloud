import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { deleteRow, listTables, readRows, runQuery, updateRow } from '../services/aurora';
import { z } from 'zod';

const UpdateRowSchema = z.object({
  /** Column → new value. Validated server-side against the editable allowlist. */
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

const QuerySchema = z.object({
  sql: z.string().min(1).max(8000),
  limit: z.number().int().positive().max(200).optional(),
});

/**
 * Aurora browsing and a read-only SQL runner.
 *
 * Reads and queries are operator-gated. Writes are admin-only: both tables feed
 * the live SPaT fanout, and a wrong value there fails silently rather than
 * raising anything.
 */
export function auroraRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };
  const admin = { middleware: [requireRole('admin')] };

  router.get(`${base}/db/aurora/tables`, async () => ok(await listTables()), operator);

  router.get(
    `${base}/db/aurora/tables/:table/rows`,
    async (ctx) => ok(await readRows(ctx.params.table, ctx.query.cursor, ctx.query.limit)),
    operator
  );

  router.post(
    `${base}/db/aurora/query`,
    async (ctx) => {
      const input = parseWith(QuerySchema, readJsonBody(ctx));
      return ok(await runQuery(input.sql, input.limit ? String(input.limit) : undefined));
    },
    operator
  );

  router.delete(
    `${base}/db/aurora/tables/:table/rows/:pk`,
    async (ctx) =>
      ok(
        await deleteRow({
          table: ctx.params.table,
          pkValue: ctx.params.pk,
          actor: ctx.caller.username,
        })
      ),
    admin
  );

  router.patch(
    `${base}/db/aurora/tables/:table/rows/:pk`,
    async (ctx) => {
      const input = parseWith(UpdateRowSchema, readJsonBody(ctx));
      return ok(
        await updateRow({
          table: ctx.params.table,
          pkValue: ctx.params.pk,
          changes: input.changes,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  return router;
}
