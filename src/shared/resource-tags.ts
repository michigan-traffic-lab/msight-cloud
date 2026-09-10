/**
 * The tags every runtime-created MSight resource carries, and the shapes the
 * AWS SDKs want them in.
 *
 * Sensor queues, ECS services and storage buckets are all created at runtime
 * rather than by CloudFormation, so `cdk.Tags.of(stack)` never reaches any of
 * them and each has to be tagged by hand at the point of creation. Before this
 * module the tag list was written out once per resource kind, in whichever
 * shape that service's SDK happened to want — and the cost allocation tag was
 * duly added to one copy and missed on the other, which is exactly the failure
 * that made every sensor's Fargate spend invisible to the Cost page.
 *
 * One definition, three adapters. A fourth runtime-created resource type adds a
 * caller here, not a fourth copy.
 */

import { DEPLOYMENT_TAG_KEY } from './deployment-naming';

/**
 * Service-neutral tag representation.
 *
 * Pairs rather than a Record because order is preserved and every SDK shape
 * below is one `map` or `Object.fromEntries` away.
 */
export type TagPairs = Array<[string, string]>;

/** Marks a resource as this console's rather than a hand-made one. */
export const MANAGED_BY = 'msight-console';

export interface ResourceTagInput {
  /**
   * Names the deployment, never the product. Ownership discovery and teardown
   * both enumerate by this tag, so a constant here would let one stack's
   * destroy reap another's resources.
   */
  deployment: string;
  /**
   * Tags meaningful only to the resource kind — which sensor a queue serves,
   * how a bucket came to be registered. Placed between the deployment tag and
   * `ManagedBy` so the resulting order matches what each caller produced before
   * this module existed.
   */
  specific?: TagPairs;
  /**
   * The cost allocation tag the console's Cost page filters on. The only tag in
   * the set that AWS itself gives meaning to, and then only once it has been
   * activated as a cost allocation tag in the billing account.
   *
   * Optional for two unrelated reasons, both real: the teardown reaper never
   * tags anything and has no cost tag configured, and storage buckets decide
   * per bucket — Cost Explorer attributes ALL of a bucket's spend to its tags,
   * so an adopted bucket holding someone else's data must be able to opt out.
   */
  costTag?: { key: string; value: string } | undefined;
}

/** The canonical tag set for one runtime-created resource. */
export function resourceTags(input: ResourceTagInput): TagPairs {
  const pairs: TagPairs = [[DEPLOYMENT_TAG_KEY, input.deployment]];
  for (const pair of input.specific ?? []) pairs.push(pair);
  pairs.push(['ManagedBy', MANAGED_BY]);
  if (input.costTag) pairs.push([input.costTag.key, input.costTag.value]);
  return pairs;
}

/** SQS takes a plain map, on both CreateQueue and TagQueue. */
export function toSqsTags(pairs: TagPairs): Record<string, string> {
  return Object.fromEntries(pairs);
}

/** ECS spells the fields in lowercase, alone among the services used here. */
export function toEcsTags(pairs: TagPairs): Array<{ key: string; value: string }> {
  return pairs.map(([key, value]) => ({ key, value }));
}

/** S3 and SNS spell them capitalised. */
export function toTagSet(pairs: TagPairs): Array<{ Key: string; Value: string }> {
  return pairs.map(([Key, Value]) => ({ Key, Value }));
}
