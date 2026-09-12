/**
 * Deep links into the AWS console.
 *
 * Worth testing because every failure here is silent. A CloudWatch link with
 * the wrong encoding opens an empty log-group list; an ECS link with the
 * cluster missing opens a "cluster not found" page. Neither throws, neither
 * shows up in a build, and both are only noticed by the person who needed the
 * link at the moment they needed it.
 */

import { awsConsoleUrls } from '../admin-console/src/aws-console-urls';

/** Bound once, the way the console binds it, so the region is visible in every expectation. */
const {
  cloudWatchAlarm,
  codeBuildBuild,
  codeBuildProject,
  ecrRepository,
  ecsCluster,
  ecsService,
  ecsTask,
  logGroup,
  logStream,
  rdsCluster,
  s3Bucket,
} = awsConsoleUrls('us-east-2');

const SERVICE_ARN =
  'arn:aws:ecs:us-east-2:162092913718:service/msight-cloud-ms-cluster-testing/msight-cloud-ms-testing';

describe('ECS', () => {
  /**
   * The cluster is not optional in an ECS console URL, and it is not in the
   * task ARN either — it only exists in the service ARN. Getting this wrong
   * produces a plausible-looking link to nothing.
   */
  it('links a service using both names from its ARN', () => {
    expect(ecsService(SERVICE_ARN)).toBe(
      'https://us-east-2.console.aws.amazon.com/ecs/v2/clusters/msight-cloud-ms-cluster-testing/services/msight-cloud-ms-testing/health?region=us-east-2'
    );
  });

  it('links a cluster from an ARN or a bare name', () => {
    const expected =
      'https://us-east-2.console.aws.amazon.com/ecs/v2/clusters/msight-cloud-ms-cluster-testing/services?region=us-east-2';
    expect(ecsCluster('arn:aws:ecs:us-east-2:162092913718:cluster/msight-cloud-ms-cluster-testing')).toBe(
      expected
    );
    expect(ecsCluster('msight-cloud-ms-cluster-testing')).toBe(expected);
  });

  it('links a task by combining the service ARN with the task ARN', () => {
    const task = 'arn:aws:ecs:us-east-2:162092913718:task/msight-cloud-ms-cluster-testing/abc123def456';
    expect(ecsTask(SERVICE_ARN, task)).toBe(
      'https://us-east-2.console.aws.amazon.com/ecs/v2/clusters/msight-cloud-ms-cluster-testing/tasks/abc123def456/configuration?region=us-east-2'
    );
  });

  /**
   * The pre-2018 ARN format omits the cluster. Inventing one would link to
   * another cluster's page, so it is refused instead.
   */
  it('refuses a service ARN with no cluster in it', () => {
    expect(ecsService('arn:aws:ecs:us-east-2:162092913718:service/msight-cloud-ms-testing')).toBeNull();
  });
});

describe('CloudWatch Logs', () => {
  /**
   * The encoding this gets wrong by default: twice URI-encoded, with percent
   * signs rewritten as dollars. Encoded once, the console silently opens an
   * empty list.
   */
  it('double-encodes the log group name and rewrites % as $', () => {
    expect(logGroup('/msight/microservice/testing')).toBe(
      'https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#logsV2:log-groups/log-group/$252Fmsight$252Fmicroservice$252Ftesting'
    );
  });

  it('encodes a stream name the same way, slashes included', () => {
    const url = logStream('/msight/microservice/testing', 'testing/app/abc123');
    expect(url).toContain('/log-events/testing$252Fapp$252Fabc123');
  });

  it('leaves no raw percent signs, which the console reads as its own escapes', () => {
    expect(logGroup('/msight/lambda/admin-vpc-api')).not.toContain('%');
  });
});

describe('the other services', () => {
  it('links a CodeBuild project', () => {
    expect(codeBuildProject('msight-cloud-ms-build-testing')).toBe(
      'https://us-east-2.console.aws.amazon.com/codesuite/codebuild/projects/msight-cloud-ms-build-testing/history?region=us-east-2'
    );
  });

  /** A build id is `<project>:<uuid>`, and the URL needs both halves. */
  it('splits a build id into project and build', () => {
    const url = codeBuildBuild('msight-cloud-ms-build-testing:6f1e-42');
    expect(url).toContain('/projects/msight-cloud-ms-build-testing/build/');
    expect(url).toContain('msight-cloud-ms-build-testing%3A6f1e-42');
  });

  it('refuses a build id with no project half', () => {
    expect(codeBuildBuild('6f1e-42')).toBeNull();
  });

  /** The account id exists only inside the repository URI. */
  it('takes the account out of an ECR URI', () => {
    expect(
      ecrRepository('162092913718.dkr.ecr.us-east-2.amazonaws.com/msight-cloud-ms/testing')
    ).toBe(
      'https://us-east-2.console.aws.amazon.com/ecr/repositories/private/162092913718/msight-cloud-ms/testing?region=us-east-2'
    );
  });

  it('links a bucket, an Aurora cluster and an alarm', () => {
    expect(s3Bucket('msight-sensor-data')).toContain('/s3/buckets/msight-sensor-data');
    expect(rdsCluster('msight-db')).toContain('#database:id=msight-db;is-cluster=true');
    expect(cloudWatchAlarm('msight-queue-depth')).toContain('#alarmsV2:alarm/msight-queue-depth');
  });
});

/**
 * A resource that has not been provisioned has no ARN, which is the ordinary
 * state of half the fields on a new service. Every builder has to answer null
 * so the component renders nothing rather than a link to a 404.
 */
describe('resources that do not exist yet', () => {
  it.each([
    ['ecsService', ecsService],
    ['ecsCluster', ecsCluster],
    ['logGroup', logGroup],
    ['codeBuildProject', codeBuildProject],
    ['codeBuildBuild', codeBuildBuild],
    ['ecrRepository', ecrRepository],
    ['s3Bucket', s3Bucket],
    ['rdsCluster', rdsCluster],
  ])('%s returns null for null, undefined and empty', (_name, build) => {
    expect(build(null)).toBeNull();
    expect(build(undefined)).toBeNull();
    expect(build('')).toBeNull();
  });

  it('ecsTask needs both ARNs', () => {
    expect(ecsTask(SERVICE_ARN, null)).toBeNull();
    expect(ecsTask(null, 'arn:aws:ecs:us-east-2:1:task/c/abc')).toBeNull();
  });

  it('logStream needs both names', () => {
    expect(logStream('/msight/x', null)).toBeNull();
    expect(logStream(null, 'stream')).toBeNull();
  });
});
