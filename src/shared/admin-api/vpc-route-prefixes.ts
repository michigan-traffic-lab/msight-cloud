/**
 * The first path segment of every admin route served from inside the VPC.
 *
 * The admin API is one API Gateway in front of two Lambdas: an out-of-VPC
 * function that starts fast and reaches AWS APIs directly, and an in-VPC one
 * that can reach Valkey and Aurora. Gateway picks between them by path, and
 * these are the prefixes that go to the in-VPC one; everything else falls to a
 * greedy catch-all pointing at the other.
 *
 * That makes this list load-bearing in a way nothing about it looks. Adding a
 * route to the in-VPC router and forgetting to add its prefix here does not
 * fail: the request matches the catch-all instead, reaches the out-of-VPC
 * function, finds no such route, and returns a 404 the console renders as
 * "Unavailable" — with the new page looking broken and the Lambda that owns it
 * never invoked at all. Both `apps` and `storages` shipped that way.
 *
 * Kept here, dependency-free, so the CDK stack can import it at synth time
 * without pulling in the route modules and their AWS SDK clients. A test
 * asserts it against the router in both directions, which is what actually
 * stops the two from drifting.
 */
export const VPC_ROUTE_PREFIXES = [
  'apps',
  'clients',
  'clusters',
  'db',
  'github',
  'maps',
  'microservices',
  'sensors',
  'storages',
] as const;

/** The prefix a route path belongs to, or null if it is not under /v{n}/admin. */
export function routePrefixOf(path: string): string | null {
  const match = /^\/v\d+\/admin\/([^/]+)/.exec(path);
  return match ? match[1] : null;
}
