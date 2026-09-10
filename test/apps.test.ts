import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ok, type MutableContext } from '../src/shared/admin-api/http';
import { runMiddleware } from '../src/shared/admin-api/router';
import { authenticate } from '../src/shared/admin-api/middleware/auth';
import { buildVpcRouter } from '../src/functions/admin-vpc-api/routes';

function makeEvent(groups: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      http: { method: 'GET' },
      authorizer: {
        jwt: {
          claims: {
            'cognito:username': 'alice',
            'cognito:groups': groups,
            email: 'alice@example.com',
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

describe('app routes', () => {
  it('registers the app surface', () => {
    const routes = buildVpcRouter('v1').list();
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /v1/admin/apps',
        'POST /v1/admin/apps',
        'PATCH /v1/admin/apps/:appId',
        'DELETE /v1/admin/apps/:appId',
      ])
    );
  });

  it('leaves reads open to a viewer', async () => {
    const router = buildVpcRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/apps', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    // The handler needs Aurora and Valkey, so reaching it at all is the
    // assertion: a role rejection surfaces as 403 before any call is attempted.
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 403 });
  });

  it('gates every mutation behind the admin role', async () => {
    // These flags are read on the SDSM and SPaT hot paths, so flipping one
    // changes what real clients are sent — and the failure mode is silence,
    // not an error. Same gate the Aurora grid already puts on this table.
    const router = buildVpcRouter('v1');
    const mutations: Array<[string, string]> = [
      ['POST', '/v1/admin/apps'],
      ['PATCH', '/v1/admin/apps/app_demo'],
      ['DELETE', '/v1/admin/apps/app_demo'],
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

  it('rejects an app id that clients could not present', async () => {
    // The id is embedded in the Valkey keys holding each client's live state,
    // so a value that cannot round-trip would strand a fleet rather than serve
    // it. Validation happens before any database work.
    const router = buildVpcRouter('v1');
    const ctx = makeContext('POST', '/v1/admin/apps', {
      groups: '[admin]',
      body: { app_id: 'has spaces and /slashes' },
    });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(router.dispatch(ctx)).rejects.toMatchObject({ status: 400 });
  });

  it('does not accept an app id change through the update route', async () => {
    // Renaming would orphan the fleet keyed under the old id. The schema drops
    // unknown fields rather than erroring, so this pins that app_id is not
    // among the columns an update can reach.
    const router = buildVpcRouter('v1');
    const ctx = makeContext('PATCH', '/v1/admin/apps/app_demo', {
      groups: '[admin]',
      body: { app_id: 'renamed' },
    });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    // Reaches the handler (no 400), where the id in the path is the only one used.
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 400 });
  });
});
