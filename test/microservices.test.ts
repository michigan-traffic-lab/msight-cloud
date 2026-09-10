import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { HttpError, ok, type MutableContext } from '../src/shared/admin-api/http';
import { runMiddleware } from '../src/shared/admin-api/router';
import { authenticate } from '../src/shared/admin-api/middleware/auth';
import { buildVpcRouter } from '../src/functions/admin-vpc-api/routes';
import {
  interpretInspection,
  nameProblem,
  normalizeBuildContext,
  normalizeDockerfilePath,
  normalizeRepoPath,
  normalizeScaling,
} from '../src/functions/admin-vpc-api/services/microservices';
import { GITHUB_ERROR_STATUS, type InspectBuildResult } from '../src/shared/github/rpc';
import {
  appSettingsUrl,
  buildManifest,
  manifestAppName,
  manifestCreateUrl,
} from '../src/functions/admin-vpc-api/services/github-app';
import { signAppJwt } from '../src/functions/github-api/app-auth';
import { generateKeyPairSync } from 'node:crypto';

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
    event: {
      requestContext: {
        http: { method },
        authorizer: {
          jwt: {
            claims: {
              'cognito:username': 'alice',
              'cognito:groups': options.groups ?? 'admin',
              email: 'alice@example.com',
            },
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    caller: null,
  };
}

async function dispatch(ctx: MutableContext) {
  await runMiddleware([authenticate], ctx, async () => ok({}));
  return buildVpcRouter('v1').dispatch(ctx);
}

describe('microservice names', () => {
  // These become ECR repository and ECS service names, which accept far less
  // than a display label does. Rejecting them here is the only chance to do it
  // before there is something to migrate.
  it('accepts a lowercase hyphenated slug', () => {
    expect(nameProblem('api-gateway')).toBeNull();
    expect(nameProblem('svc1')).toBeNull();
  });

  it('rejects what ECS would reject', () => {
    for (const bad of ['A', 'x', 'Api', 'my_service', 'my service', '1svc', '-svc', 'svc.']) {
      expect(nameProblem(bad)).not.toBeNull();
    }
  });

  it('reserves names that would read as a sub-resource of the collection', () => {
    // `github` is the sibling route prefix; the rest would make
    // /microservices/<name> ambiguous with an action on the collection.
    for (const reserved of ['github', 'new', 'validate', 'reconcile', 'all']) {
      expect(nameProblem(reserved)).toContain('reserved');
    }
  });
});

describe('path normalisation', () => {
  // A path pasted from a shell prompt is the common case, and GitHub's contents
  // API treats "./x" as a directory literally named "." — so without this the
  // failure reads as "the Dockerfile is missing" rather than "your path had a
  // prefix on it".
  it('strips shell-style prefixes and redundant separators', () => {
    expect(normalizeRepoPath('./Dockerfile')).toBe('Dockerfile');
    expect(normalizeRepoPath('/Dockerfile')).toBe('Dockerfile');
    expect(normalizeRepoPath('services//api///Dockerfile')).toBe('services/api/Dockerfile');
    expect(normalizeRepoPath('services/api/')).toBe('services/api');
    expect(normalizeRepoPath('  Dockerfile  ')).toBe('Dockerfile');
  });

  it('accepts a Windows-style separator', () => {
    expect(normalizeRepoPath('services\\api\\Dockerfile')).toBe('services/api/Dockerfile');
  });

  it('refuses to walk out of the repository', () => {
    for (const bad of ['../secrets', 'services/../../etc', '..']) {
      expect(() => normalizeRepoPath(bad)).toThrow(HttpError);
    }
  });

  it('spells the repo root as "." for a build context', () => {
    expect(normalizeBuildContext('')).toBe('.');
    expect(normalizeBuildContext('.')).toBe('.');
    expect(normalizeBuildContext('./')).toBe('.');
    expect(normalizeBuildContext('services/api')).toBe('services/api');
  });

  it('refuses an empty Dockerfile path, where the root is meaningless', () => {
    expect(() => normalizeDockerfilePath('')).toThrow(HttpError);
    expect(() => normalizeDockerfilePath('.')).toThrow(HttpError);
    expect(normalizeDockerfilePath('docker/Dockerfile.prod')).toBe('docker/Dockerfile.prod');
  });
});

describe('interpretInspection', () => {
  const source = {
    repoFullName: 'acme/api',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    buildContext: '.',
  };

  const inspection = (overrides: Partial<InspectBuildResult>): InspectBuildResult => ({
    branch: { name: 'main', head_sha: 'a'.repeat(40) },
    dockerfile: { path: 'Dockerfile', sha: 'b'.repeat(40), size: 512 },
    build_context: 'root',
    ...overrides,
  });

  it('passes a repo with a Dockerfile on the branch', () => {
    const outcome = interpretInspection(inspection({}), source);
    expect(outcome.state).toBe('ok');
    expect(outcome.detail).toBeNull();
    expect(outcome.commitSha).toBe('a'.repeat(40));
    expect(outcome.dockerfileSize).toBe(512);
  });

  // The whole point of the check: the console has to say which of the two
  // things was missing, because the fix is different for each.
  it('separates a missing branch from a missing Dockerfile', () => {
    const noBranch = interpretInspection(inspection({ branch: null, dockerfile: null }), source);
    expect(noBranch.state).toBe('branch_missing');
    expect(noBranch.detail).toContain('no branch "main"');

    const noFile = interpretInspection(inspection({ dockerfile: null }), source);
    expect(noFile.state).toBe('dockerfile_missing');
    expect(noFile.detail).toContain('Dockerfile');
    // Names where to put one, since "not found" alone leaves the user guessing.
    expect(noFile.detail).toContain('subdirectory');
  });

  it('still reports the branch head when the Dockerfile is absent', () => {
    // Recorded so the row shows which commit was actually looked at, which is
    // what makes a later re-check comparable.
    expect(interpretInspection(inspection({ dockerfile: null }), source).commitSha).toBe(
      'a'.repeat(40)
    );
  });

  it('reports a build context that is missing or is a file', () => {
    const missing = interpretInspection(
      inspection({ build_context: 'missing' }),
      { ...source, buildContext: 'services/api' }
    );
    expect(missing.state).toBe('context_missing');
    expect(missing.detail).toContain('services/api');

    const notDir = interpretInspection(
      inspection({ build_context: 'not_a_directory' }),
      { ...source, buildContext: 'README.md' }
    );
    expect(notDir.state).toBe('context_missing');
    expect(notDir.detail).toContain('file, not a directory');
  });

  it('rejects an empty Dockerfile, which passes existence and fails every build', () => {
    const outcome = interpretInspection(
      inspection({ dockerfile: { path: 'Dockerfile', sha: 'c'.repeat(40), size: 0 } }),
      source
    );
    expect(outcome.state).toBe('error');
    expect(outcome.detail).toContain('empty');
  });
});

describe('GitHub App JWT', () => {
  // Generated per run rather than checked in: a real PEM in the repo is a
  // liability even when it authenticates nothing.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const credentials = { appId: 12345, privateKey: privateKey as string, webhookSecret: null };

  function claimsOf(jwt: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  }

  it('issues an RS256 token attributed to the App id', () => {
    const jwt = signAppJwt(credentials);
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claimsOf(jwt).iss).toBe('12345');
  });

  it('backdates iat and stays inside GitHub\'s ten-minute ceiling', () => {
    // GitHub rejects a token issued in the future by its own clock, and rejects
    // one whose lifetime exceeds ten minutes outright. Both bounds are pinned
    // because either violation fails as an opaque 401.
    const now = 1_700_000_000_000;
    const claims = claimsOf(signAppJwt(credentials, now));
    const seconds = Math.floor(now / 1000);

    expect(claims.iat).toBeLessThan(seconds);
    expect(seconds - (claims.iat as number)).toBeLessThanOrEqual(60);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    expect((claims.exp as number) - (claims.iat as number)).toBeGreaterThan(0);
  });

  it('reports a malformed PEM as a key problem, not a GitHub problem', () => {
    expect(() =>
      signAppJwt({ appId: 1, privateKey: 'not a pem', webhookSecret: null })
    ).toThrow(/private key/i);
  });
});

describe('github route gating', () => {
  // Reads are operator-gated: which GitHub account this deployment is attached
  // to is operational information. Every mutation is admin-only, because each
  // changes either the credential or which repositories can be read.
  it('keeps a viewer out of the connection entirely', async () => {
    for (const path of ['/v1/admin/github/app', '/v1/admin/github/installations']) {
      await expect(dispatch(makeContext('GET', path, { groups: '[viewer]' }))).rejects.toMatchObject(
        { status: 403, code: 'forbidden' }
      );
    }
  });

  it('gates every credential and installation mutation behind admin', async () => {
    const mutations: Array<[string, string]> = [
      ['POST', '/v1/admin/github/app'],
      ['DELETE', '/v1/admin/github/app'],
      ['POST', '/v1/admin/github/install-intent'],
      ['POST', '/v1/admin/github/installations'],
      ['DELETE', '/v1/admin/github/installations/42'],
    ];

    for (const [method, path] of mutations) {
      await expect(
        dispatch(makeContext(method, path, { groups: '[operator]', body: {} }))
      ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    }
  });

  /** Just the GitHub subtree — the Valkey debug routes legitimately say "key". */
  function githubRoutes(): string[] {
    return buildVpcRouter('v1')
      .list()
      .filter((route) => route.includes('/admin/github/'));
  }

  it('offers no route that could return the private key', () => {
    expect(githubRoutes().filter((route) => /private|secret|token|key/i.test(route))).toEqual([]);
  });

  it('offers no route that accepts a GitHub user token', () => {
    // The design stores an installation, never a person's credential. A route
    // taking an OAuth code or an access token would be the thing that broke
    // that, so the vocabulary itself is pinned.
    expect(githubRoutes().filter((route) => /oauth|authorize|login/i.test(route))).toEqual([]);
  });
});

describe('microservice route gating', () => {
  it('gates create, edit and remove behind admin', async () => {
    const mutations: Array<[string, string]> = [
      ['POST', '/v1/admin/microservices'],
      ['PATCH', '/v1/admin/microservices/api'],
      ['DELETE', '/v1/admin/microservices/api'],
    ];

    for (const [method, path] of mutations) {
      await expect(
        dispatch(makeContext(method, path, { groups: '[operator]', body: {} }))
      ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    }
  });

  it('lets an operator re-check a source', async () => {
    // Re-checking changes no configuration — it looks at GitHub and records
    // what it saw. Reaching the handler at all is the assertion; it then fails
    // on the database, not on the role.
    const ctx = makeContext('POST', '/v1/admin/microservices/api/check', { groups: '[operator]' });
    await expect(dispatch(ctx)).rejects.not.toMatchObject({ status: 403 });
  });

  it('prefers the literal check route over the :name parameter', async () => {
    // `POST /microservices/:name/check` and `POST /microservices` do not
    // collide, but a microservice named "check" would be indistinguishable if
    // the ordering were reversed — hence the reserved-name list too.
    const ctx = makeContext('POST', '/v1/admin/microservices/api/check', { groups: '[admin]' });
    await expect(dispatch(ctx)).rejects.not.toMatchObject({ status: 404 });
  });
});

describe('github transport error mapping', () => {
  it('gives every transport error code an HTTP status', () => {
    // The in-VPC caller maps these straight onto responses, so a code without a
    // status here would surface as an unexplained 502.
    for (const [code, status] of Object.entries(GITHUB_ERROR_STATUS)) {
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it('does not report a missing Dockerfile as a server fault', () => {
    // The single most likely outcome of a first attempt. A 5xx would make the
    // console show it as a broken backend rather than something to correct.
    expect(GITHUB_ERROR_STATUS.repo_not_found).toBe(404);
    expect(GITHUB_ERROR_STATUS.insufficient_permission).toBe(403);
    expect(GITHUB_ERROR_STATUS.app_not_configured).toBe(409);
  });
});

describe('one-click GitHub App creation', () => {
  /**
   * The manifest is what removes the manual App registration: GitHub creates
   * the App from it, so anything wrong here is something an operator can no
   * longer fix by hand on GitHub's form.
   */
  const manifest = buildManifest({
    deployment: 'msight-prod',
    consoleUrl: 'https://console.example.cloudfront.net',
    webhookUrl: 'https://api.example.com/v1/github/webhook',
  });

  it('asks for read-only repository access, with no scope that can change code', () => {
    // The App is offered to a customer's GitHub account, and every permission
    // is one they have to accept. `checks: write` is the only write scope and
    // it writes no repository content — a check run is the pass/fail mark
    // against a commit. Pinned as an exact set so a fifth permission cannot be
    // added without someone deciding to.
    expect(manifest.default_permissions).toEqual({
      contents: 'read',
      metadata: 'read',
      checks: 'write',
    });
  });

  it('never asks for a scope that could modify a repository', () => {
    // The design writes nothing to anyone's repository: no deploy key, no
    // workflow file, no commit. These are the scopes that would allow it, and
    // any of them appearing means that promise was broken.
    for (const forbidden of ['administration', 'workflows', 'contents_write', 'pull_requests']) {
      expect(manifest.default_permissions).not.toHaveProperty(forbidden);
    }
    expect(manifest.default_permissions.contents).toBe('read');
  });

  it('subscribes to the push event that triggers a build', () => {
    // `push` is entitled by `contents: read` — webhook events are gated on the
    // permission covering their data, so watching a branch needs no extra
    // scope. The installation events are how a revoked grant is noticed
    // without waiting for a build to fail.
    expect(manifest.default_events).toEqual(
      expect.arrayContaining(['push', 'installation', 'installation_repositories'])
    );
  });

  it('points both redirect and setup URLs at the console, not the API', () => {
    // GitHub redirects a browser, which carries no Cognito token — an API URL
    // here 401s before any Lambda runs and loses the code with it.
    const expected = 'https://console.example.cloudfront.net/settings/github/callback';
    expect(manifest.redirect_url).toBe(expected);
    expect(manifest.setup_url).toBe(expected);
  });

  it('creates the App public, so the install account can be chosen on GitHub', () => {
    // Load-bearing, and counter-intuitive enough to pin. GitHub only lets a
    // PRIVATE App be installed on the account that owns it — which would force
    // the operator to name their organisation before the redirect, from memory,
    // because the creation page has no owner picker. Public means GitHub's own
    // installation page lists the accounts and organisations they can install
    // on, and the choice happens there.
    //
    // It does not mean listed or discoverable: that needs a Marketplace
    // submission, which nothing here does. Installing still requires the owner
    // to consent and choose repositories, and the private key stays in this
    // deployment's Secrets Manager.
    expect(manifest.public).toBe(true);
  });

  it('declares the webhook but leaves it inactive', () => {
    // The endpoint is not served yet. An App created with live webhooks would
    // start accruing failed deliveries on the owner's account immediately.
    expect(manifest.hook_attributes).toEqual({
      url: 'https://api.example.com/v1/github/webhook',
      active: false,
    });
  });

  it('exposes both halves of the flow as admin routes', () => {
    const routes = buildVpcRouter('v1').list();
    expect(routes).toEqual(
      expect.arrayContaining([
        'POST /v1/admin/github/app/manifest-intent',
        'POST /v1/admin/github/app/from-manifest',
      ])
    );
  });
});

describe('organisation-owned App creation', () => {
  // The deliberate exception, not the default. Personal and organisation
  // creation are entirely different GitHub URLs — there is no parameter that
  // switches the account and no picker on the page — so naming an organisation
  // means knowing it before the redirect. The default omits it and lets the
  // account be chosen at install time instead; this path exists only for teams
  // who want the App itself to outlive the person who created it.
  it('posts the manifest to the organisation form', () => {
    expect(manifestCreateUrl('abc123', 'msight-tech')).toBe(
      'https://github.com/organizations/msight-tech/settings/apps/new?state=abc123'
    );
  });

  it('falls back to the personal form when no organisation is given', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(manifestCreateUrl('abc123', value)).toBe(
        'https://github.com/settings/apps/new?state=abc123'
      );
    }
  });

  it('always carries the state that binds the code back to this deployment', () => {
    expect(manifestCreateUrl('s-1', 'acme')).toContain('state=s-1');
    expect(manifestCreateUrl('s-1', null)).toContain('state=s-1');
  });

  it('rejects anything that is not a GitHub login', () => {
    // A bad name does not fail here — it produces a GitHub 404 after the
    // redirect, which reads as the console sending the user somewhere broken.
    for (const bad of [
      'not a login',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has/slash',
      'MSight Technologies',
      'a'.repeat(40),
    ]) {
      expect(() => manifestCreateUrl('abc123', bad)).toThrow();
    }
  });

  it('accepts the logins GitHub actually allows', () => {
    for (const good of ['msight-tech', 'a', 'Org123', 'a-b-c', 'a'.repeat(39)]) {
      expect(() => manifestCreateUrl('abc123', good)).not.toThrow();
    }
  });
});

describe('scaling policy', () => {
  // The rules are between fields, so they are checked as a set. None of this is
  // enforced by ECS until a policy is created, and by then whoever typed it has
  // moved on — so an unsatisfiable policy is refused while the form is open.
  it('defaults to a fixed count', () => {
    expect(normalizeScaling(undefined)).toMatchObject({ scaling_mode: 'fixed', min_tasks: 1 });
  });

  it('leaves fixed services alone even with nonsense autoscaling fields', () => {
    // In fixed mode the columns are ignored, so a half-filled form must not
    // block saving a service that never autoscales.
    expect(() =>
      normalizeScaling({ mode: 'fixed', minTasks: 9, maxTasks: 2, target: 0 })
    ).not.toThrow();
  });

  it('refuses a maximum below the minimum', () => {
    expect(() => normalizeScaling({ mode: 'auto', minTasks: 4, maxTasks: 2 })).toThrow(
      /never settle/
    );
  });

  it('refuses a floor of zero', () => {
    // A service scaled to zero produces no CPU or memory metric, so target
    // tracking has nothing to scale back up on.
    expect(() => normalizeScaling({ mode: 'auto', minTasks: 0 })).toThrow(/at least 1/);
  });

  it('refuses a target that never settles', () => {
    expect(() => normalizeScaling({ mode: 'auto', target: 0 })).toThrow(/between 10/);
    expect(() => normalizeScaling({ mode: 'auto', target: 100 })).toThrow(/between 10/);
  });

  it('accepts an ordinary policy and fills in the rest', () => {
    expect(normalizeScaling({ mode: 'auto', minTasks: 2, maxTasks: 8, metric: 'memory' })).toEqual({
      scaling_mode: 'auto',
      min_tasks: 2,
      max_tasks: 8,
      scaling_metric: 'memory',
      scaling_target: 60,
      scale_out_cooldown: 60,
      scale_in_cooldown: 300,
    });
  });
});

describe('GitHub App display name', () => {
  it('does not repeat the product name already in the deployment name', () => {
    // "MSight ${deployment}" produced "MSight msight-cloud", which is what the
    // person approving the install reads.
    expect(manifestAppName('msight-cloud')).toBe('MSight Cloud');
    expect(manifestAppName('msight')).toBe('MSight');
  });

  it('adds it when the deployment name does not carry it', () => {
    expect(manifestAppName('prod')).toBe('MSight Prod');
    expect(manifestAppName('eu-staging')).toBe('MSight Eu Staging');
  });
});

describe('App settings and deletion URL', () => {
  /**
   * GitHub exposes no API to delete a GitHub App, so this URL is the only way
   * to remove one — and removing one is the only way to free its name, which is
   * unique across the whole of GitHub. "Forget App" here clears local
   * credentials and cannot touch GitHub, so pointing at the right page matters.
   */
  const base = {
    app_id: 1,
    slug: 'msight-cloud',
    name: 'MSight Cloud',
    html_url: null,
    configured_by: 'alice',
    configured_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('uses the organisation path for an org-owned App', () => {
    expect(
      appSettingsUrl({ ...base, owner_login: 'msight-tech', owner_type: 'Organization' })
    ).toBe('https://github.com/organizations/msight-tech/settings/apps/msight-cloud');
  });

  it('uses the personal path for a user-owned App', () => {
    expect(appSettingsUrl({ ...base, owner_login: 'rusheng', owner_type: 'User' })).toBe(
      'https://github.com/settings/apps/msight-cloud'
    );
  });

  it('falls back to the personal path when the owner was never recorded', () => {
    // Rows written before the owner columns existed. A slightly wrong link
    // beats no link on the one page that can delete the App.
    expect(appSettingsUrl({ ...base, owner_login: null, owner_type: null })).toBe(
      'https://github.com/settings/apps/msight-cloud'
    );
  });
});

describe('App name override', () => {
  it('uses the supplied name when given', () => {
    // The escape hatch for a taken name — including one held by an App this
    // console has forgotten but GitHub still has.
    const manifest = buildManifest({
      deployment: 'msight-cloud',
      consoleUrl: 'https://console.example',
      webhookUrl: 'https://api.example/v1/github/webhook',
      appName: 'MSight Cloud Staging',
    });
    expect(manifest.name).toBe('MSight Cloud Staging');
  });

  it('falls back to the derived name when blank or absent', () => {
    for (const appName of [undefined, null, '', '   ']) {
      expect(
        buildManifest({
          deployment: 'msight-cloud',
          consoleUrl: 'https://console.example',
          webhookUrl: 'https://api.example/v1/github/webhook',
          appName,
        }).name
      ).toBe('MSight Cloud');
    }
  });
});
