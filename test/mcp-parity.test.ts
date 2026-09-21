import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVpcRouter } from '../src/functions/admin-vpc-api/routes';
import { buildRouter } from '../src/functions/admin-api/routes';

/**
 * Whether the MCP server can do what the console can do.
 *
 * The honest answer used to require reading two files side by side and holding
 * ninety-odd routes in your head, which is why it drifted: tools were added
 * when someone remembered, and the gap was only discovered by an assistant
 * saying "I can't do that" to a person who knew perfectly well the console
 * could.
 *
 * So the question is asked mechanically. Every admin route is either reachable
 * through a tool or named below as deliberately withheld, and adding a route
 * without doing one of those two things fails here.
 *
 * The mapping is read out of the dispatch's source rather than by calling it,
 * because calling it means invoking Lambdas. That makes this a scanner, with a
 * scanner's weakness — it sees the paths, not whether they work — which is the
 * right trade for the thing it is protecting against, namely a route that no
 * tool mentions at all.
 */

const HANDLER = readFileSync(join(__dirname, '../src/functions/mcp-api/handler.ts'), 'utf8');

/**
 * Routes with no tool, on purpose.
 *
 * Each one is a decision rather than an omission, and the reason is recorded
 * here because "why can't the assistant do this" is asked far more often than
 * it is answered.
 */
const DELIBERATELY_WITHHELD: Record<string, string> = {
  // A token that can mint tokens cannot be meaningfully revoked: whoever holds
  // one can always issue themselves another. Minting stays in the console,
  // behind a Cognito session belonging to a person.
  'GET /v1/admin/mcp-tokens': 'a token must not be able to issue tokens',
  'POST /v1/admin/mcp-tokens': 'a token must not be able to issue tokens',
  'DELETE /v1/admin/mcp-tokens/:name': 'a token must not be able to issue tokens',

  // Browser flows. Creating a GitHub App needs a human on GitHub's consent
  // page, and installing one needs its repository picker; neither can be
  // driven headlessly, so a tool could only ever return a URL.
  'POST /v1/admin/github/app': 'needs a human on GitHub’s consent page',
  'POST /v1/admin/github/app/manifest-intent': 'needs a human on GitHub’s consent page',
  'POST /v1/admin/github/app/from-manifest': 'needs a human on GitHub’s consent page',
  'DELETE /v1/admin/github/app': 'disconnecting the App is a console decision',
  'POST /v1/admin/github/install-intent': 'needs GitHub’s own repository picker',
  'POST /v1/admin/github/installations': 'completes a browser redirect',
  'DELETE /v1/admin/github/installations/:installationId': 'disconnecting is a console decision',
  'GET /v1/admin/github/installations/:installationId/repositories':
    'only meaningful inside the install flow',

  // Setting a person's password from an assistant is not a capability worth
  // having, whatever the role.
  'POST /v1/admin/users/:username/password': 'credential setting stays with a person',

  // Internal plumbing: the webhook receiver's private entry point, which
  // authenticates by HMAC rather than by role.
  'POST /v1/admin/microservices/github-push': 'internal webhook plumbing',

  // Answered by `whoami` from the authorizer context instead, which can also
  // say which token is being used — this route cannot.
  'GET /v1/admin/me': 'answered by the whoami tool',

  // Read through get_microservice_status, which returns the same figures
  // alongside the rest of the service's state.
  'GET /v1/admin/clusters/:name/health': 'folded into get_cluster_health',

  // The instance catalogue is reference data the console renders in a picker.
  // An assistant that needs it can read it from create_cluster's schema.
  'GET /v1/admin/clusters/instance-types': 'reference data, described in the tool schema',

  // Started and polled inside query_logs, which does both and returns results.
  'POST /v1/admin/logs/query': 'driven by query_logs',
  'GET /v1/admin/logs/query/:queryId': 'driven by query_logs',
  'DELETE /v1/admin/logs/query/:queryId': 'query_logs stops its own query',
};

/**
 * Every `/v1/admin/...` path the dispatch builds, normalised back to the
 * router's own pattern so the two can be compared.
 *
 * The dispatch interpolates parameters — `${n()}` for a name, `${enc(...)}`
 * for everything else — and appends query strings. Both are reduced to the
 * shape the router registered.
 */
function pathsReferencedByTools(): Set<string> {
  /**
   * Interpolations are collapsed before the paths are matched, because some of
   * them contain template literals of their own — `${q ? `?${q}` : ''}` is how
   * every optional query string here is written, and its inner backtick ends
   * the outer literal as far as a regex is concerned. Collapsing innermost
   * first, repeatedly, flattens those from the inside out.
   */
  let source = HANDLER.replace(/\$\{n\(\)\}/g, ':name');
  for (let previous = ''; previous !== source; ) {
    previous = source;
    source = source.replace(/\$\{[^{}]*\}/g, ':param');
  }

  const found = new Set<string>();
  const pattern = /['`](\/v1\/admin\/[^'`]*)['`]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    let path = match[1]!;
    // Query strings are not part of a route pattern.
    path = path.split('?')[0]!;
    /**
     * A real path parameter always follows a slash. One that does not is what
     * is left of a collapsed query string — `/alarms:param` from
     * `/alarms${q ? ...}` — and belongs to the query, not the path.
     */
    path = path.replace(/([^/]):param/g, '$1');
    path = path.replace(/\/+$/, '');
    if (path.startsWith('/v1/admin/')) {
      found.add(path);
    }
  }

  return found;
}

/** A route pattern reduced the same way, so the two sets are comparable. */
function normalise(pattern: string): string {
  return pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (param) =>
    param === ':name' ? ':name' : ':param'
  );
}

function allRoutes(): string[] {
  return [
    ...buildVpcRouter('v1').list(),
    ...(buildRouter as (version: string) => { list(): string[] })('v1').list(),
  ];
}

describe('MCP coverage of the admin API', () => {
  const referenced = pathsReferencedByTools();

  /**
   * The test that answers the question. A route that is neither reachable nor
   * deliberately withheld is a console feature an assistant silently cannot
   * use, which is exactly the failure this exists to prevent.
   */
  it('reaches every admin route that is not deliberately withheld', () => {
    const uncovered: string[] = [];

    for (const route of allRoutes()) {
      if (route in DELIBERATELY_WITHHELD) continue;

      const [, pattern = ''] = route.split(' ');
      if (!referenced.has(normalise(pattern))) {
        uncovered.push(route);
      }
    }

    expect(uncovered).toEqual([]);
  });

  /**
   * Keeps the exclusion list honest. A route that is removed or renamed leaves
   * a stale reason behind, and a stale reason is how an exclusion outlives the
   * decision that made it.
   */
  it('withholds only routes that still exist', () => {
    const routes = new Set(allRoutes());
    const stale = Object.keys(DELIBERATELY_WITHHELD).filter((route) => !routes.has(route));
    expect(stale).toEqual([]);
  });

  /**
   * The console tells people what a token's role buys them, in numbers.
   *
   * Those numbers were previously a hand-copied list of thirteen tools that had
   * drifted to a sixth of the truth, which is how someone concludes the server
   * cannot do a thing it has done all along. Counted from the server's own
   * table so the page cannot quietly go stale again.
   */
  it('agrees with the tool counts the console advertises', () => {
    const table = HANDLER.slice(
      HANDLER.indexOf('const TOOLS'),
      HANDLER.indexOf('\nfunction toolsForRole')
    );
    // Entries begin at a two-space-indented brace inside the array literal.
    const entries = table.split(/\n  \{\n/).slice(1);

    const adminOnly = entries.filter((entry) => /minRole: 'admin'/.test(entry)).length;
    const operatorFloor = entries.filter((entry) => /minRole: 'operator'/.test(entry)).length;
    const unrestricted = entries.length - adminOnly - operatorFloor;

    const counts = {
      viewer: unrestricted,
      operator: unrestricted + operatorFloor,
      admin: entries.length,
    };

    const page = readFileSync(
      join(__dirname, '../admin-console/src/pages/McpPage.vue'),
      'utf8'
    );
    const declared = /const TOOL_COUNTS: Record<AdminRole, number> = \{([^}]*)\}/.exec(page);
    expect(declared).not.toBeNull();

    const parsed = Object.fromEntries(
      declared![1]!
        .split(',')
        .map((pair) => pair.split(':').map((part) => part.trim()))
        .filter((pair) => pair.length === 2)
        .map(([key, value]) => [key, Number(value)])
    );

    expect(parsed).toEqual(counts);
  });

  /**
   * The specific gap that prompted all this: an assistant reporting it could
   * not enable a sensor, on a deployment whose console has had that button for
   * months.
   */
  it('can do the things the console’s main buttons do', () => {
    for (const tool of [
      'set_sensor_enabled',
      'launch_microservice',
      'restart_microservice',
      'rollback_microservice',
      'create_cluster',
      'list_log_groups',
    ]) {
      expect(HANDLER).toContain(`name: '${tool}'`);
      expect(HANDLER).toContain(`case '${tool}':`);
    }
  });
});
