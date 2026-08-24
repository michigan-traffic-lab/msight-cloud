import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError, ok, type Middleware, type MutableContext } from '../src/functions/admin-api/http';
import { Router, runMiddleware } from '../src/functions/admin-api/router';
import { authenticate, parseGroups, resolveRole } from '../src/functions/admin-api/middleware/auth';
import { requireRole } from '../src/functions/admin-api/middleware/require-role';
import { buildRouter } from '../src/functions/admin-api/routes';

function makeEvent(groups: unknown, username = 'alice'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      http: { method: 'GET' },
      authorizer: {
        jwt: {
          claims: {
            'cognito:username': username,
            'cognito:groups': groups,
            email: `${username}@example.com`,
          },
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function makeContext(
  method: string,
  path: string,
  options: { groups?: unknown; body?: unknown } = {}
): MutableContext {
  return {
    method,
    path,
    params: {},
    query: {},
    rawBody: options.body === undefined ? null : JSON.stringify(options.body),
    event: makeEvent(options.groups ?? 'admin'),
    caller: null,
  };
}

describe('parseGroups', () => {
  it('reads a real array', () => {
    expect(parseGroups(['admin', 'viewer'])).toEqual(['admin', 'viewer']);
  });

  it('reads the bracketed string the JWT authorizer produces', () => {
    expect(parseGroups('[admin operator]')).toEqual(['admin', 'operator']);
  });

  it('reads a single unbracketed group', () => {
    expect(parseGroups('viewer')).toEqual(['viewer']);
  });

  it('treats absent or empty membership as no groups', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
    expect(parseGroups('[]')).toEqual([]);
  });
});

describe('resolveRole', () => {
  it('picks the most privileged role when several are present', () => {
    expect(resolveRole(['viewer', 'admin', 'operator'])).toBe('admin');
    expect(resolveRole(['viewer', 'operator'])).toBe('operator');
  });

  it('ignores groups that are not console roles', () => {
    expect(resolveRole(['some-other-group', 'viewer'])).toBe('viewer');
    expect(resolveRole(['some-other-group'])).toBeNull();
  });
});

describe('authenticate middleware', () => {
  it('populates the caller from JWT claims', async () => {
    const ctx = makeContext('GET', '/v1/admin/me', { groups: '[operator]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    expect(ctx.caller).toEqual({
      username: 'alice',
      email: 'alice@example.com',
      groups: ['operator'],
      role: 'operator',
    });
  });

  it('refuses a user who holds no console role group', async () => {
    const ctx = makeContext('GET', '/v1/admin/me', { groups: '[]' });

    await expect(
      runMiddleware([authenticate], ctx, async () => ok({}))
    ).rejects.toMatchObject({ status: 403, code: 'no_role_assigned' });
  });
});

describe('requireRole middleware', () => {
  async function attempt(callerGroups: string, required: 'admin' | 'operator' | 'viewer') {
    const ctx = makeContext('GET', '/v1/admin/users', { groups: callerGroups });
    return runMiddleware([authenticate, requireRole(required)], ctx, async () => ok({ reached: true }));
  }

  it('admits a caller holding exactly the required role', async () => {
    await expect(attempt('[admin]', 'admin')).resolves.toMatchObject({ statusCode: 200 });
  });

  it('admits a more privileged caller', async () => {
    await expect(attempt('[admin]', 'viewer')).resolves.toMatchObject({ statusCode: 200 });
  });

  it('blocks a less privileged caller', async () => {
    await expect(attempt('[viewer]', 'admin')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

describe('Router', () => {
  function testRouter() {
    return new Router()
      .get('/v1/admin/users', async () => ok({ route: 'list' }))
      .post('/v1/admin/users/:username/role', async (ctx) =>
        ok({ route: 'role', username: ctx.params.username })
      );
  }

  async function dispatch(router: Router, ctx: MutableContext) {
    await runMiddleware([authenticate], ctx, async () => ok({}));
    return router.dispatch(ctx);
  }

  it('matches a static route', async () => {
    const ctx = makeContext('GET', '/v1/admin/users');
    const result = await dispatch(testRouter(), ctx);
    expect(JSON.parse(result.body as string)).toEqual({ route: 'list' });
  });

  it('captures path parameters and decodes them', async () => {
    const ctx = makeContext('POST', '/v1/admin/users/jane%40example.com/role');
    const result = await dispatch(testRouter(), ctx);
    expect(JSON.parse(result.body as string)).toEqual({
      route: 'role',
      username: 'jane@example.com',
    });
  });

  it('404s an unknown path', async () => {
    const ctx = makeContext('GET', '/v1/admin/nothing-here');
    await expect(dispatch(testRouter(), ctx)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('405s a known path used with the wrong method', async () => {
    const ctx = makeContext('DELETE', '/v1/admin/users');
    await expect(dispatch(testRouter(), ctx)).rejects.toMatchObject({
      status: 405,
      code: 'method_not_allowed',
    });
  });

  it('fails loudly if a route is reached without the auth middleware', async () => {
    const ctx = makeContext('GET', '/v1/admin/users');
    await expect(testRouter().dispatch(ctx)).rejects.toMatchObject({
      status: 500,
      code: 'auth_middleware_missing',
    });
  });

  it('runs route middleware in registration order, outermost first', async () => {
    const order: string[] = [];
    const trace = (label: string): Middleware => async (_ctx, next) => {
      order.push(`${label}:before`);
      const result = await next();
      order.push(`${label}:after`);
      return result;
    };

    const router = new Router().get('/v1/admin/probe', async () => {
      order.push('handler');
      return ok({});
    }, { middleware: [trace('outer'), trace('inner')] });

    const ctx = makeContext('GET', '/v1/admin/probe');
    await dispatch(router, ctx);

    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'handler',
      'inner:after',
      'outer:after',
    ]);
  });
});

describe('buildRouter', () => {
  it('registers the full admin surface', () => {
    expect(buildRouter('v1').list().sort()).toEqual(
      [
        'GET /v1/admin/me',
        'GET /v1/admin/system/overview',
        'GET /v1/admin/users',
        'POST /v1/admin/users',
        'DELETE /v1/admin/users/:username',
        'POST /v1/admin/users/:username/role',
        'POST /v1/admin/users/:username/enabled',
        'POST /v1/admin/users/:username/password',
      ].sort()
    );
  });

  it('gates every user-management route behind the admin role', async () => {
    const router = buildRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/users', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    await expect(router.dispatch(ctx)).rejects.toBeInstanceOf(HttpError);
    await expect(router.dispatch(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('lets a viewer read the system overview', async () => {
    const router = buildRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/me', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    const result = await router.dispatch(ctx);
    expect(JSON.parse(result.body as string)).toMatchObject({
      username: 'alice',
      role: 'viewer',
    });
  });
});
