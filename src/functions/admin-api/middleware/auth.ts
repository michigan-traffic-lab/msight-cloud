import {
  ADMIN_ROLES,
  ROLE_PRECEDENCE,
  type AdminRole,
} from '../../../shared/schemas/admin';
import { HttpError, type Caller, type Middleware } from '../http';

/**
 * The HTTP API JWT authorizer flattens claim values to strings, so Cognito
 * group membership arrives either as a real array or as a bracketed,
 * space-separated string such as "[admin operator]". Handle both.
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  const trimmed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return trimmed
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The most privileged console role among the caller's groups, or null. */
export function resolveRole(groups: string[]): AdminRole | null {
  const known = groups.filter((group): group is AdminRole =>
    (ADMIN_ROLES as readonly string[]).includes(group)
  );
  if (known.length === 0) {
    return null;
  }
  return known.reduce((best, current) =>
    ROLE_PRECEDENCE[current] < ROLE_PRECEDENCE[best] ? current : best
  );
}

/**
 * Turns the authorizer's JWT claims into a {@link Caller}.
 *
 * Token signature, expiry, and audience are already validated by the API
 * Gateway JWT authorizer — an unsigned or expired token never reaches this
 * function. What is enforced here is authorization: the caller must hold one of
 * the console role groups. Someone who exists in the user pool but sits in no
 * role group is authenticated and still refused.
 */
export const authenticate: Middleware = async (ctx, next) => {
  const claims = (ctx.event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<
    string,
    unknown
  >;

  const groups = parseGroups(claims['cognito:groups']);
  const role = resolveRole(groups);

  if (!role) {
    throw new HttpError(
      403,
      'no_role_assigned',
      'Your account is not a member of any console role group. Ask an administrator to assign one.'
    );
  }

  const username =
    (claims['cognito:username'] as string | undefined) ??
    (claims['username'] as string | undefined) ??
    (claims['sub'] as string | undefined) ??
    'unknown';

  const caller: Caller = {
    username,
    email: (claims['email'] as string | undefined) ?? null,
    groups,
    role,
  };

  ctx.caller = caller;
  return next();
};
