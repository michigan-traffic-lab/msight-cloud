import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  deleteKey,
  getOverview,
  inspectKey,
  setExpiry,
  setHashField,
  setStringValue,
} from '../services/valkey';
import { z } from 'zod';

const SetValueSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  ttl_seconds: z.number().int().positive().nullable().optional(),
});

const SetFieldSchema = z.object({
  key: z.string().min(1),
  field: z.string().min(1),
  value: z.string(),
});

const SetTtlSchema = z.object({
  key: z.string().min(1),
  /** null clears the expiry (PERSIST). */
  seconds: z.number().int().positive().nullable(),
});

/**
 * Valkey inspection and single-key debugging.
 *
 * Operations are exposed one at a time rather than as a command console: there
 * is no way to express FLUSHALL, KEYS, or a pattern delete through this API,
 * because no route accepts anything but one fully-qualified key.
 *
 * Reads are operator-gated; writes are admin-only. This cache is on the SPaT
 * broadcast path, so a hand-edited value changes live behaviour immediately.
 */
export function valkeyRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };
  const admin = { middleware: [requireRole('admin')] };

  router.get(`${base}/db/valkey/overview`, async () => ok(await getOverview()), operator);

  router.get(
    `${base}/db/valkey/key`,
    async (ctx) => ok(await inspectKey(ctx.query.key)),
    operator
  );

  router.post(
    `${base}/db/valkey/key/value`,
    async (ctx) => {
      const input = parseWith(SetValueSchema, readJsonBody(ctx));
      return ok(
        await setStringValue({
          key: input.key,
          value: input.value,
          ttlSeconds: input.ttl_seconds ?? null,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  router.post(
    `${base}/db/valkey/key/field`,
    async (ctx) => {
      const input = parseWith(SetFieldSchema, readJsonBody(ctx));
      return ok(
        await setHashField({
          key: input.key,
          field: input.field,
          value: input.value,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  router.post(
    `${base}/db/valkey/key/ttl`,
    async (ctx) => {
      const input = parseWith(SetTtlSchema, readJsonBody(ctx));
      return ok(
        await setExpiry({ key: input.key, seconds: input.seconds, actor: ctx.caller.username })
      );
    },
    admin
  );

  router.delete(
    `${base}/db/valkey/key`,
    async (ctx) => ok(await deleteKey({ key: ctx.query.key, actor: ctx.caller.username })),
    admin
  );

  return router;
}
