import {
  CreateUserRequestSchema,
  ResetPasswordRequestSchema,
  SetEnabledRequestSchema,
  SetRoleRequestSchema,
} from '../../../shared/schemas/admin';
import { created, HttpError, ok, parseWith, readJsonBody, type RequestContext } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import * as users from '../services/cognito';

/**
 * Refuses operations that would lock the caller out of their own session.
 * Another admin can always perform these; you just cannot do them to yourself.
 */
function refuseSelf(ctx: RequestContext, target: string, code: string, message: string): void {
  if (target === ctx.caller.username) {
    throw new HttpError(409, code, message);
  }
}

export function userRoutes(base: string): Router {
  const router = new Router();

  // Every route in this module is admin-only.
  const adminOnly = { middleware: [requireRole('admin')] };

  router.get(`${base}/users`, async () => ok({ users: await users.listUsers() }), adminOnly);

  router.post(
    `${base}/users`,
    async (ctx) => {
      const input = parseWith(CreateUserRequestSchema, readJsonBody(ctx));
      await users.createUser({
        username: input.username,
        email: input.email,
        role: input.role,
        temporaryPassword: input.temporary_password,
      });
      return created({ username: input.username, email: input.email, role: input.role });
    },
    adminOnly
  );

  router.delete(
    `${base}/users/:username`,
    async (ctx) => {
      const target = ctx.params.username;
      refuseSelf(
        ctx,
        target,
        'self_delete_forbidden',
        'You cannot delete the account you are signed in with.'
      );
      await users.deleteUser(target);
      return ok({ username: target, deleted: true });
    },
    adminOnly
  );

  router.post(
    `${base}/users/:username/role`,
    async (ctx) => {
      const target = ctx.params.username;
      const { role } = parseWith(SetRoleRequestSchema, readJsonBody(ctx));

      if (target === ctx.caller.username && role !== 'admin') {
        throw new HttpError(
          409,
          'self_demote_forbidden',
          'You cannot remove your own admin role. Ask another admin to do it.'
        );
      }

      await users.assignRole(target, role);
      return ok({ username: target, role });
    },
    adminOnly
  );

  router.post(
    `${base}/users/:username/enabled`,
    async (ctx) => {
      const target = ctx.params.username;
      const { enabled } = parseWith(SetEnabledRequestSchema, readJsonBody(ctx));

      if (!enabled) {
        refuseSelf(
          ctx,
          target,
          'self_disable_forbidden',
          'You cannot disable the account you are signed in with.'
        );
      }

      await users.setEnabled(target, enabled);
      return ok({ username: target, enabled });
    },
    adminOnly
  );

  router.post(
    `${base}/users/:username/password`,
    async (ctx) => {
      const target = ctx.params.username;
      const input = parseWith(ResetPasswordRequestSchema, readJsonBody(ctx));
      await users.setPassword(target, input.password, !input.temporary);
      return ok({ username: target, password_reset: true });
    },
    adminOnly
  );

  return router;
}
