import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError, ok, type Middleware, type MutableContext } from '../src/shared/admin-api/http';
import { Router, runMiddleware } from '../src/shared/admin-api/router';
import { authenticate, parseGroups, resolveRole } from '../src/shared/admin-api/middleware/auth';
import { requireRole } from '../src/shared/admin-api/middleware/require-role';
import { buildRouter } from '../src/functions/admin-api/routes';
import { sensorQueueName } from '../src/shared/deployment-naming';
import { buildVpcRouter } from '../src/functions/admin-vpc-api/routes';
import {
  routePrefixOf,
  VPC_ROUTE_PREFIXES,
} from '../src/shared/admin-api/vpc-route-prefixes';

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
        'GET /v1/admin/system/info',
        'GET /v1/admin/cost/summary',
        'GET /v1/admin/cost/service',
        'GET /v1/admin/network/topology',
        'GET /v1/admin/logs/groups',
        'POST /v1/admin/logs/query',
        'GET /v1/admin/logs/query/:queryId',
        'DELETE /v1/admin/logs/query/:queryId',
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

describe('cost routes', () => {
  it('are gated behind the admin role', async () => {
    for (const path of ['/v1/admin/cost/summary', '/v1/admin/cost/service']) {
      const ctx = makeContext('GET', path, { groups: '[operator]' });
      await runMiddleware([authenticate], ctx, async () => ok({}));
      await expect(buildRouter('v1').dispatch(ctx)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    }
  });
});

describe('network route', () => {
  it('is gated behind the operator role', async () => {
    const ctx = makeContext('GET', '/v1/admin/network/topology', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildRouter('v1').dispatch(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

});

describe('sensor queue naming', () => {
  // The CDK stack and the admin API both derive queue names from this helper.
  // If it changes, the console starts reporting correctly-wired sensors as
  // missing, so the mapping is pinned here.
  it('matches the names the stack creates', () => {
    // The pinned prefix this deployment already uses.
    expect(sensorQueueName('msight-sensor', 'derq_huronPkwy_plymouth')).toBe(
      'msight-sensor-derq-huronpkwy-plymouth.fifo'
    );
    // A second deployment gets a different prefix, which is what makes two
    // stacks in one account possible at all.
    expect(sensorQueueName('msight-dev-sensor', 'simple')).toBe(
      'msight-dev-sensor-simple.fifo'
    );
  });
});

describe('in-VPC admin router', () => {
  // The in-VPC function serves only what genuinely needs Valkey or Aurora.
  // Nothing here may enumerate the keyspace, so there is deliberately no
  // "list all clients" route — this pins that.
  it('registers the in-VPC surface', () => {
    expect(buildVpcRouter('v1').list().sort()).toEqual(
      [
        'GET /v1/admin/clusters',
        'POST /v1/admin/clusters',
        'PATCH /v1/admin/clusters/:name',
        'DELETE /v1/admin/clusters/:name',
        'GET /v1/admin/clusters/instance-types',
        'GET /v1/admin/clusters/:name/health',
        'POST /v1/admin/clusters/:name/provision',
        'POST /v1/admin/clusters/:name/deprovision',
        'GET /v1/admin/clients/summary',
        'GET /v1/admin/clients/search',
        'GET /v1/admin/clients/sample',
        'GET /v1/admin/clients/lookup',
        'GET /v1/admin/db/aurora/tables',
        'GET /v1/admin/db/aurora/tables/:table/rows',
        'POST /v1/admin/db/aurora/query',
        'PATCH /v1/admin/db/aurora/tables/:table/rows/:pk',
        'DELETE /v1/admin/db/aurora/tables/:table/rows/:pk',
        'GET /v1/admin/db/valkey/overview',
        'GET /v1/admin/db/valkey/key',
        'POST /v1/admin/db/valkey/key/value',
        'POST /v1/admin/db/valkey/key/field',
        'POST /v1/admin/db/valkey/key/ttl',
        'DELETE /v1/admin/db/valkey/key',
        'GET /v1/admin/maps',
        'GET /v1/admin/maps/:name',
        'GET /v1/admin/sensors',
        'POST /v1/admin/sensors',
        'POST /v1/admin/sensors/reconcile',
        'POST /v1/admin/sensors/:name/enabled',
        'POST /v1/admin/sensors/:name/ingest',
        'DELETE /v1/admin/sensors/:name',
        'GET /v1/admin/storages',
        'GET /v1/admin/storages/available',
        'POST /v1/admin/storages',
        'POST /v1/admin/storages/reconcile',
        'PATCH /v1/admin/storages/:bucket',
        'DELETE /v1/admin/storages/:bucket',
        'GET /v1/admin/storages/:bucket/objects',
        'GET /v1/admin/apps',
        'POST /v1/admin/apps',
        'PATCH /v1/admin/apps/:appId',
        'DELETE /v1/admin/apps/:appId',
        'GET /v1/admin/github/app',
        'POST /v1/admin/github/app',
        'POST /v1/admin/github/app/manifest-intent',
        'POST /v1/admin/github/app/from-manifest',
        'DELETE /v1/admin/github/app',
        'POST /v1/admin/github/install-intent',
        'GET /v1/admin/github/installations',
        'POST /v1/admin/github/installations',
        'GET /v1/admin/github/installations/:installationId/repositories',
        'DELETE /v1/admin/github/installations/:installationId',
        'GET /v1/admin/microservices',
        'POST /v1/admin/microservices',
        'POST /v1/admin/microservices/:name/check',
        'PATCH /v1/admin/microservices/:name',
        'DELETE /v1/admin/microservices/:name',
        'GET /v1/admin/microservices/:name/status',
        'GET /v1/admin/microservices/:name/logs',
        'POST /v1/admin/microservices/:name/launch',
        'POST /v1/admin/microservices/:name/launch/dismiss',
        'POST /v1/admin/microservices/:name/provision',
        'POST /v1/admin/microservices/:name/build',
        'POST /v1/admin/microservices/:name/build/stop',
        'POST /v1/admin/microservices/:name/deploy',
        'POST /v1/admin/microservices/:name/restart',
        'POST /v1/admin/microservices/:name/deprovision',
        'PUT /v1/admin/microservices/:name/logs/retention',
        'POST /v1/admin/microservices/:name/logs/clear',
      ].sort()
    );
  });

  /**
   * The API Gateway sends only these prefixes to the in-VPC function; anything
   * else matches a greedy catch-all pointing at the out-of-VPC one. A prefix
   * missing from the list therefore does not fail loudly — the request reaches
   * the wrong Lambda, finds no such route, and 404s, which the console renders
   * as "Unavailable" while the function that owns the page is never invoked.
   * Both `apps` and `storages` shipped that way.
   */
  it('routes every in-VPC path through a declared gateway prefix', () => {
    const undeclared = buildVpcRouter('v1')
      .list()
      .map((route) => routePrefixOf(route.split(' ')[1]))
      .filter((prefix): prefix is string => prefix !== null)
      .filter((prefix) => !VPC_ROUTE_PREFIXES.includes(prefix as never));

    expect([...new Set(undeclared)]).toEqual([]);
  });

  it('declares no gateway prefix the in-VPC router does not serve', () => {
    // The other direction: a stale prefix steals its whole subtree from the
    // out-of-VPC function, which is the same failure with the Lambdas swapped.
    const served = new Set(
      buildVpcRouter('v1')
        .list()
        .map((route) => routePrefixOf(route.split(' ')[1]))
    );

    expect(VPC_ROUTE_PREFIXES.filter((prefix) => !served.has(prefix))).toEqual([]);
  });

  it('has no route that would list every client', () => {
    const routes = buildVpcRouter('v1').list();
    expect(routes).not.toContain('GET /v1/admin/clients');
    expect(routes.some((route) => route.endsWith('/clients'))).toBe(false);
  });
});

describe('log routes', () => {
  it('are gated behind the operator role', async () => {
    const ctx = makeContext('GET', '/v1/admin/logs/groups', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildRouter('v1').dispatch(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

describe('aurora routes', () => {
  // Reads are operator-gated; writes touch tables that drive live SPaT fanout,
  // so they are admin-only. This pins that gradient.
  it('gates reads behind operator', async () => {
    const ctx = makeContext('GET', '/v1/admin/db/aurora/tables', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildVpcRouter('v1').dispatch(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('gates row edits behind admin, not operator', async () => {
    const ctx = makeContext('PATCH', '/v1/admin/db/aurora/tables/apps/rows/app_demo', {
      groups: '[operator]',
      body: { changes: { receive_spat: true } },
    });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildVpcRouter('v1').dispatch(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

describe('aurora row deletion', () => {
  it('is admin-only, not operator', async () => {
    const ctx = makeContext('DELETE', '/v1/admin/db/aurora/tables/apps/rows/app_demo', {
      groups: '[operator]',
    });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildVpcRouter('v1').dispatch(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('routes a single row, never a whole table', () => {
    const routes = buildVpcRouter('v1').list();
    // A route without the :pk segment would delete by table alone.
    expect(routes).not.toContain('DELETE /v1/admin/db/aurora/tables/:table/rows');
    expect(routes).not.toContain('DELETE /v1/admin/db/aurora/tables/:table');
    expect(routes).toContain('DELETE /v1/admin/db/aurora/tables/:table/rows/:pk');
  });
});

describe('valkey debug operations', () => {
  // The console must expose no way to express a bulk or pattern operation.
  // Every route takes one fully-qualified key, so FLUSHALL/KEYS/pattern-delete
  // are unrepresentable rather than merely discouraged.
  it('offers no bulk or pattern route', () => {
    const routes = buildVpcRouter('v1').list();
    for (const forbidden of [
      'DELETE /v1/admin/db/valkey/keys',
      'POST /v1/admin/db/valkey/flush',
      'GET /v1/admin/db/valkey/keys',
      'DELETE /v1/admin/db/valkey',
    ]) {
      expect(routes).not.toContain(forbidden);
    }
  });

  it('gates every write behind admin', async () => {
    const writes: Array<[string, string]> = [
      ['POST', '/v1/admin/db/valkey/key/value'],
      ['POST', '/v1/admin/db/valkey/key/field'],
      ['POST', '/v1/admin/db/valkey/key/ttl'],
      ['DELETE', '/v1/admin/db/valkey/key'],
    ];

    for (const [method, path] of writes) {
      const ctx = makeContext(method, path, { groups: '[operator]', body: {} });
      await runMiddleware([authenticate], ctx, async () => ok({}));
      await expect(buildVpcRouter('v1').dispatch(ctx)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    }
  });
});

describe('map routes', () => {
  it('are read-only — no route can modify MAP geometry', () => {
    const routes = buildVpcRouter('v1').list();
    const mapRoutes = routes.filter((route) => route.includes('/maps'));
    expect(mapRoutes.every((route) => route.startsWith('GET '))).toBe(true);
    expect(mapRoutes).toHaveLength(2);
  });

  it('is operator-gated', async () => {
    const ctx = makeContext('GET', '/v1/admin/maps', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(buildVpcRouter('v1').dispatch(ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe('sensor routes', () => {
  // Reading the registry is onboarding information and open to any signed-in
  // user. Everything that changes it creates or destroys real infrastructure
  // and discards queued messages, so it is admin-only. This pins that split.
  it('leaves reads open to a viewer', async () => {
    const router = buildVpcRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/sensors', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    // The handler itself needs AWS, so reaching it at all is the assertion:
    // a role rejection would surface as a 403 before any call is attempted.
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 403 });
  });

  it('gates every mutation behind the admin role', async () => {
    const router = buildVpcRouter('v1');
    const mutations: Array<[string, string]> = [
      ['POST', '/v1/admin/sensors'],
      ['POST', '/v1/admin/sensors/cam_1/enabled'],
      ['DELETE', '/v1/admin/sensors/cam_1'],
      ['POST', '/v1/admin/sensors/reconcile'],
    ];

    for (const [method, path] of mutations) {
      const ctx = makeContext(method, path, { groups: '[operator]' });
      await runMiddleware([authenticate], ctx, async () => ok({}));
      await expect(router.dispatch(ctx)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    }
  });

  it('prefers the literal reconcile route over the :name parameter', async () => {
    // `POST /sensors/reconcile` and `POST /sensors/:name/enabled` do not
    // collide, but `POST /sensors/reconcile` would be shadowed by a
    // hypothetical `POST /sensors/:name`. Matching order is what keeps
    // Reconcile from being read as a sensor named "reconcile".
    const router = buildVpcRouter('v1');
    const ctx = makeContext('POST', '/v1/admin/sensors/reconcile', { groups: '[admin]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    // Admin passes the role gate, so failure now comes from the AWS call the
    // reconcile handler makes — not from a 404 or a 405.
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 404 });
  });
});
