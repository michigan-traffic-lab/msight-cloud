import { ROLE_PRECEDENCE, type AdminRole } from '../../../shared/schemas/admin';
import { HttpError, type Caller, type Middleware } from '../http';

/** True when the caller holds `required` or anything more privileged. */
export function hasAtLeast(caller: Caller, required: AdminRole): boolean {
  return ROLE_PRECEDENCE[caller.role] <= ROLE_PRECEDENCE[required];
}

/**
 * Route middleware gating on a minimum role.
 *
 * This is the authoritative check. The console hides tabs the caller cannot
 * use, but that is a convenience — every privileged route carries this gate so
 * a hand-crafted request is refused just the same.
 */
export function requireRole(required: AdminRole): Middleware {
  return async (ctx, next) => {
    if (!ctx.caller) {
      throw new HttpError(
        500,
        'auth_middleware_missing',
        'requireRole ran before the authenticate middleware.'
      );
    }

    if (!hasAtLeast(ctx.caller, required)) {
      throw new HttpError(
        403,
        'forbidden',
        `This operation requires the ${required} role.`
      );
    }

    return next();
  };
}
