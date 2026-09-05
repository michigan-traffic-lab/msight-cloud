import { MeResponseSchema } from '../../../shared/schemas/admin';
import { ok } from '../../../shared/admin-api/http';
import { Router } from '../../../shared/admin-api/router';

/**
 * Who am I. Available to every signed-in caller regardless of role — the
 * console calls this immediately after sign-in to decide which tabs to render.
 */
export function identityRoutes(base: string): Router {
  const router = new Router();

  router.get(`${base}/me`, async (ctx) =>
    ok(
      MeResponseSchema.parse({
        username: ctx.caller.username,
        email: ctx.caller.email,
        role: ctx.caller.role,
        groups: ctx.caller.groups,
      })
    )
  );

  return router;
}
