import { ok } from '../src/shared/admin-api/http';
import { runMiddleware } from '../src/shared/admin-api/router';
import { authenticate } from '../src/shared/admin-api/middleware/auth';
import { buildVpcRouter } from '../src/functions/admin-vpc-api/routes';
import {
  bucketNameProblem,
  costTagConflict,
  normalizePrefix,
  findPrefixConflict,
  notificationRuleId,
  prefixesOverlap,
  type StorageInfraConfig,
} from '../src/shared/storage-infrastructure';
import { tagPairs, type SensorInfraConfig } from '../src/shared/sensor-infrastructure';
import {
  resourceTags,
  toEcsTags,
  toSqsTags,
  toTagSet,
} from '../src/shared/resource-tags';
import { DEPLOYMENT_TAG_KEY, STORAGE_ORIGIN_TAG_KEY } from '../src/shared/deployment-naming';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { MutableContext } from '../src/shared/admin-api/http';

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

describe('storage routes', () => {
  it('leaves reads open to a viewer', async () => {
    const router = buildVpcRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/storages', { groups: '[viewer]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));

    // The handler needs AWS and Aurora, so reaching it at all is the assertion:
    // a role rejection would surface as a 403 before any call is attempted.
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 403 });
  });

  it('gates every mutation behind the admin role', async () => {
    const router = buildVpcRouter('v1');
    const mutations: Array<[string, string]> = [
      ['POST', '/v1/admin/storages'],
      ['PATCH', '/v1/admin/storages/some-bucket'],
      ['DELETE', '/v1/admin/storages/some-bucket'],
      // The bucket picker calls ListAllMyBuckets across the whole account, which
      // is more than a viewer should be able to enumerate.
      ['GET', '/v1/admin/storages/available'],
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

  it('prefers the literal sub-route over the :bucket parameter', async () => {
    // `/storages/available` is the same shape as `/storages/:bucket`.
    // Registration order is the only thing stopping it being read as a bucket
    // named "available".
    const router = buildVpcRouter('v1');
    const ctx = makeContext('GET', '/v1/admin/storages/available', { groups: '[admin]' });
    await runMiddleware([authenticate], ctx, async () => ok({}));
    await expect(router.dispatch(ctx)).rejects.not.toMatchObject({ status: 404 });
  });

  it('exposes the sensor ingest route', () => {
    expect(buildVpcRouter('v1').list()).toContain('POST /v1/admin/sensors/:name/ingest');
  });
});

describe('bucket name validation', () => {
  it('accepts ordinary names', () => {
    expect(bucketNameProblem('msight-sensor-archive')).toBeNull();
    expect(bucketNameProblem('a1b')).toBeNull();
  });

  it('rejects what S3 rejects, with a reason', () => {
    // Each of these fails at CreateBucket with an error that does not say
    // which rule was broken, which is the whole point of checking here.
    for (const name of [
      'ab',
      'Uppercase-Not-Allowed',
      '-leading-hyphen',
      'trailing-hyphen-',
      'two..dots',
      '192.168.0.1',
      'xn--punycode',
      'sthree-reserved',
      'something-s3alias',
    ]) {
      expect(bucketNameProblem(name)).not.toBeNull();
    }
  });
});

describe('prefix normalisation', () => {
  // The prefix is what anything reading the bucket later uses to map a key back
  // to the sensor that wrote it, so a stored prefix that cannot match a real key
  // breaks that lookup silently — there is no error, just no match.
  it('strips the leading slash operators reflexively add', () => {
    // S3 keys have no leading slash, so "/plymouth/" matches nothing at all.
    expect(normalizePrefix('/plymouth/')).toBe('plymouth/');
  });

  it('adds the trailing slash so a prefix cannot match a sibling', () => {
    // Without it, "plymouth" also matches "plymouth-annex/file", which would
    // map one sensor's keys to another.
    expect(normalizePrefix('plymouth')).toBe('plymouth/');
  });

  it('keeps an empty prefix empty, meaning the whole bucket', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix(null)).toBe('');
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('   ')).toBe('');
  });

  it('names the notification rule per deployment', () => {
    // Two deployments sharing a bucket must not overwrite each other's rule.
    expect(notificationRuleId('alpha')).not.toBe(notificationRuleId('beta'));
  });
});

describe('cost allocation tagging', () => {
  const storageConfig: StorageInfraConfig = {
    deployment: 'msight-prod',
    region: 'us-east-2',
    controlTopicArn: 'arn:aws:sns:us-east-2:1:topic',
    costTag: { key: 'Project', value: 'msight-cloud' },
  };

  const sensorConfig: SensorInfraConfig = {
    deployment: 'msight-prod',
    prefix: 'msight-prod-sensor',
    topicArn: 'arn:aws:sns:us-east-2:1:sensor.fifo',
    cluster: 'msight-prod-cluster',
    templateTaskDefinition: 'msight-prod-sensor-template',
    subnetIds: ['subnet-1'],
    securityGroupIds: ['sg-1'],
    costTag: { key: 'Project', value: 'msight-cloud' },
  };

  // Queues, ECS services and buckets are all created outside CloudFormation, so
  // cdk.Tags.of(stack) never reaches them. Without the cost tag applied here
  // they work perfectly and are simply absent from the Cost page — a silent
  // failure, which is why it is pinned.
  it('puts the cost tag on runtime-created sensor resources', () => {
    expect(tagPairs(sensorConfig, 'plymouth')).toContainEqual(['Project', 'msight-cloud']);
  });

  it('omits it when no cost tag is configured, as on the teardown reaper', () => {
    const { costTag, ...withoutCostTag } = sensorConfig;
    expect(tagPairs(withoutCostTag, 'plymouth').map(([key]) => key)).not.toContain('Project');
  });

  it('keeps the deployment tag, which teardown enumerates by', () => {
    // The reaper finds what to delete by this tag. Losing it would strand every
    // runtime-created resource at stack destroy.
    expect(tagPairs(sensorConfig, 'plymouth')).toContainEqual([
      'msight:deployment',
      'msight-prod',
    ]);
  });

  it('reports a bucket whose cost tag belongs to someone else', () => {
    // Cost Explorer attributes all of a bucket's spend to its tags, so taking
    // the key over moves another report's spend without saying so.
    expect(costTagConflict(storageConfig, { Project: 'someone-elses-thing' })).toContain(
      'Project=someone-elses-thing'
    );
  });

  it('reports no conflict when the tag is absent or already ours', () => {
    expect(costTagConflict(storageConfig, {})).toBeNull();
    expect(costTagConflict(storageConfig, { Project: 'msight-cloud' })).toBeNull();
  });
});

describe('shared resource tags', () => {
  const costTag = { key: 'Project', value: 'msight-cloud' };

  it('puts the deployment tag first and ManagedBy after the specific tags', () => {
    expect(
      resourceTags({
        deployment: 'msight-prod',
        specific: [[STORAGE_ORIGIN_TAG_KEY, 'adopted']],
        costTag,
      })
    ).toEqual([
      [DEPLOYMENT_TAG_KEY, 'msight-prod'],
      [STORAGE_ORIGIN_TAG_KEY, 'adopted'],
      ['ManagedBy', 'msight-console'],
      ['Project', 'msight-cloud'],
    ]);
  });

  it('omits the cost tag when none is configured', () => {
    expect(resourceTags({ deployment: 'msight-prod' }).map(([key]) => key)).not.toContain(
      'Project'
    );
  });

  /**
   * The reason this module exists. SQS, ECS and S3 each want the same tags in a
   * different shape, and writing the list once per shape is how the cost
   * allocation tag ended up on the sensor path and missing from storage.
   */
  it('renders one tag set into all three SDK shapes', () => {
    const pairs = resourceTags({ deployment: 'd', costTag });

    expect(toSqsTags(pairs)).toMatchObject({ Project: 'msight-cloud' });
    expect(toEcsTags(pairs)).toContainEqual({ key: 'Project', value: 'msight-cloud' });
    expect(toTagSet(pairs)).toContainEqual({ Key: 'Project', Value: 'msight-cloud' });
  });

  it('gives the sensor path the same base tags as any other resource', () => {
    // Both callers now derive from resourceTags, so a tag added there cannot
    // reach one resource kind and miss the other.
    const sensorConfig: SensorInfraConfig = {
      deployment: 'msight-prod',
      prefix: 'msight-prod-sensor',
      topicArn: 'arn:aws:sns:us-east-2:1:sensor.fifo',
      cluster: 'msight-prod-cluster',
      templateTaskDefinition: 'tpl',
      subnetIds: [],
      securityGroupIds: [],
      costTag,
    };

    const fromSensor = new Map(tagPairs(sensorConfig, 'plymouth'));
    const fromShared = new Map(
      resourceTags({ deployment: 'msight-prod', specific: [['msight:sensor', 'plymouth']], costTag })
    );
    expect(fromSensor).toEqual(fromShared);
  });
});

describe('prefix filter rules', () => {
  // S3 rejects overlapping prefix filters for one event type, and rejects the
  // whole PutBucketNotificationConfiguration call rather than the offending
  // rule — with an error naming neither prefix. Every one of these is checked
  // before the call so the operator gets a sentence instead.
  it('treats nesting as overlap in either direction', () => {
    expect(prefixesOverlap('plymouth/', 'plymouth/overflow/')).toBe(true);
    expect(prefixesOverlap('plymouth/overflow/', 'plymouth/')).toBe(true);
  });

  it('treats the empty prefix as overlapping everything', () => {
    // An empty prefix means the whole bucket, which S3 writes as a rule with no
    // filter — so it cannot coexist with any filtered rule.
    expect(prefixesOverlap('', 'plymouth/')).toBe(true);
    expect(prefixesOverlap('plymouth/', '')).toBe(true);
  });

  it('allows disjoint prefixes, which is the whole point', () => {
    expect(prefixesOverlap('plymouth/', 'barton/')).toBe(false);
  });

  it('names both sensors in a conflict', () => {
    const conflict = findPrefixConflict([
      { sensor: 'barton', prefix: 'barton/' },
      { sensor: 'plymouth', prefix: 'plymouth/' },
      { sensor: 'overflow', prefix: 'plymouth/overflow/' },
    ]);
    expect(conflict).not.toBeNull();
    expect([conflict!.a.sensor, conflict!.b.sensor].sort()).toEqual(['overflow', 'plymouth']);
  });

  it('does not call an identical prefix a conflict', () => {
    // Two sensors on the same prefix collapse into one rule, which is correct.
    // Rejecting them would block a legitimate configuration.
    expect(
      findPrefixConflict([
        { sensor: 'a', prefix: 'shared/' },
        { sensor: 'b', prefix: 'shared/' },
      ])
    ).toBeNull();
  });

  it('accepts a bucket whose single sensor owns the whole thing', () => {
    expect(findPrefixConflict([{ sensor: 'solo', prefix: '' }])).toBeNull();
  });

  it('accepts a set of disjoint prefixes', () => {
    expect(
      findPrefixConflict([
        { sensor: 'a', prefix: 'plymouth/' },
        { sensor: 'b', prefix: 'barton/' },
        { sensor: 'c', prefix: 'huron/' },
      ])
    ).toBeNull();
  });

  it('normalises prefixes into a form that cannot half-match a sibling', () => {
    // "plymouth" without the trailing slash would both match "plymouth-annex/"
    // in S3 and read as non-overlapping here — two bugs from one missing char.
    expect(prefixesOverlap(normalizePrefix('plymouth'), normalizePrefix('plymouth-annex'))).toBe(
      false
    );
    expect(prefixesOverlap('plymouth', 'plymouth-annex/')).toBe(true);
  });

  it('reconciles listeners through their own route', () => {
    expect(buildVpcRouter('v1').list()).toContain('POST /v1/admin/storages/reconcile');
  });
});
