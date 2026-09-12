/**
 * Deep links into the AWS console.
 *
 * This console deliberately shows a curated view: the six numbers that matter
 * for a microservice, not the forty ECS reports on one. That is the right
 * default and the wrong dead end — the moment something is actually wrong, the
 * next question is invariably one this console does not answer, and the answer
 * is two clicks away in a tab nobody can find without knowing the resource's
 * generated name.
 *
 * So every page that names an AWS resource offers a way through to it. Three
 * rules hold throughout:
 *
 *   * Built from ARNs and stored names, never assembled from a naming
 *     convention. A link derived from a guessed name breaks silently when the
 *     convention changes, and points at the wrong account's resource at worst.
 *
 *   * Every builder returns `null` when it lacks what it needs, so a caller
 *     renders nothing rather than a link to a 404. A resource that has not been
 *     provisioned has no ARN, which is the ordinary state of half the fields on
 *     a new service.
 *
 *   * The region is a parameter rather than an import. That keeps this file
 *     free of dependencies — it is plain data manipulation and is tested as
 *     such, without a browser, a Vite alias, or a config file. `aws-links.ts`
 *     is the one-line binding that supplies the deployment's own region.
 */

export interface AwsConsoleUrls {
  ecsService(serviceArn: string | null | undefined): string | null;
  ecsCluster(clusterArnOrName: string | null | undefined): string | null;
  ecsTask(
    serviceArn: string | null | undefined,
    taskArn: string | null | undefined
  ): string | null;
  logGroup(name: string | null | undefined): string | null;
  logStream(
    group: string | null | undefined,
    stream: string | null | undefined
  ): string | null;
  codeBuildProject(name: string | null | undefined): string | null;
  codeBuildBuild(buildId: string | null | undefined): string | null;
  ecrRepository(repositoryUri: string | null | undefined): string | null;
  s3Bucket(name: string | null | undefined): string | null;
  rdsCluster(identifier: string | null | undefined): string | null;
  rdsDatabases(): string;
  elastiCache(): string;
  lambdaFunction(name: string | null | undefined): string | null;
  cloudWatchAlarm(name: string | null | undefined): string | null;
  costExplorer(): string;
}

/**
 * CloudWatch's fragment encoding, which is its own thing.
 *
 * Log group names contain slashes, and the console expects them URI-encoded
 * twice with the percent signs then rewritten as dollars: `/msight/lambda/x`
 * becomes `$252Fmsight$252Flambda$252Fx`. Encode it once, or not at all, and
 * the console opens on an empty log-group list with no error at all.
 */
function cloudwatchFragment(value: string): string {
  return encodeURIComponent(encodeURIComponent(value)).replace(/%/g, '$');
}

/** Pulls the last segment of an ARN, or returns the value if it is not one. */
function lastSegment(value: string): string {
  const afterColon = value.slice(value.lastIndexOf(':') + 1);
  return afterColon.includes('/') ? afterColon.slice(afterColon.lastIndexOf('/') + 1) : afterColon;
}

/**
 * Splits an ECS service ARN into the two names its console URL needs.
 *
 * `arn:aws:ecs:<region>:<account>:service/<cluster>/<service>`. The older
 * two-part form without a cluster segment is refused rather than guessed at:
 * it belongs to an ECS account setting this deployment does not use, and a
 * cluster name invented here would link somewhere wrong.
 */
function ecsServiceParts(serviceArn: string): { cluster: string; service: string } | null {
  const marker = ':service/';
  if (!serviceArn.includes(marker)) {
    return null;
  }
  const parts = serviceArn.slice(serviceArn.indexOf(marker) + marker.length).split('/');
  if (parts.length !== 2) {
    return null;
  }
  return { cluster: parts[0]!, service: parts[1]! };
}

export function awsConsoleUrls(region: string): AwsConsoleUrls {
  const base = `https://${region}.console.aws.amazon.com`;
  const suffix = `?region=${region}`;

  return {
    ecsService(serviceArn) {
      if (!serviceArn) return null;
      const parts = ecsServiceParts(serviceArn);
      if (!parts) return null;
      return `${base}/ecs/v2/clusters/${encodeURIComponent(parts.cluster)}/services/${encodeURIComponent(parts.service)}/health${suffix}`;
    },

    ecsCluster(clusterArnOrName) {
      if (!clusterArnOrName) return null;
      const name = lastSegment(clusterArnOrName);
      if (!name) return null;
      return `${base}/ecs/v2/clusters/${encodeURIComponent(name)}/services${suffix}`;
    },

    /**
     * One task needs the cluster as well, and a task ARN does not reliably
     * name it — so it comes from the service ARN, which is where this console
     * actually has it.
     */
    ecsTask(serviceArn, taskArn) {
      if (!serviceArn || !taskArn) return null;
      const parts = ecsServiceParts(serviceArn);
      const taskId = lastSegment(taskArn);
      if (!parts || !taskId) return null;
      return `${base}/ecs/v2/clusters/${encodeURIComponent(parts.cluster)}/tasks/${encodeURIComponent(taskId)}/configuration${suffix}`;
    },

    logGroup(name) {
      if (!name) return null;
      return `${base}/cloudwatch/home${suffix}#logsV2:log-groups/log-group/${cloudwatchFragment(name)}`;
    },

    logStream(group, stream) {
      if (!group || !stream) return null;
      return `${base}/cloudwatch/home${suffix}#logsV2:log-groups/log-group/${cloudwatchFragment(group)}/log-events/${cloudwatchFragment(stream)}`;
    },

    codeBuildProject(name) {
      if (!name) return null;
      return `${base}/codesuite/codebuild/projects/${encodeURIComponent(name)}/history${suffix}`;
    },

    /**
     * CodeBuild ids are `<project>:<uuid>`, and the console wants the project
     * separately — so the id is split rather than the project passed twice.
     */
    codeBuildBuild(buildId) {
      if (!buildId) return null;
      const separator = buildId.indexOf(':');
      if (separator <= 0) return null;
      const project = buildId.slice(0, separator);
      return `${base}/codesuite/codebuild/projects/${encodeURIComponent(project)}/build/${encodeURIComponent(buildId)}${suffix}`;
    },

    /**
     * `<account>.dkr.ecr.<region>.amazonaws.com/<namespace>/<name>`. The
     * account is taken from the URI rather than configured, because it is
     * already there and the console has no other source for it.
     */
    ecrRepository(repositoryUri) {
      if (!repositoryUri) return null;
      const slash = repositoryUri.indexOf('/');
      const dot = repositoryUri.indexOf('.');
      if (slash <= 0 || dot <= 0 || dot > slash) return null;
      const account = repositoryUri.slice(0, dot);
      const name = repositoryUri.slice(slash + 1);
      if (!account || !name) return null;
      return `${base}/ecr/repositories/private/${encodeURIComponent(account)}/${name}${suffix}`;
    },

    s3Bucket(name) {
      if (!name) return null;
      return `${base}/s3/buckets/${encodeURIComponent(name)}${suffix}&tab=objects`;
    },

    rdsCluster(identifier) {
      if (!identifier) return null;
      return `${base}/rds/home${suffix}#database:id=${encodeURIComponent(identifier)};is-cluster=true`;
    },

    /**
     * Used where the console holds an endpoint but not a cluster identifier.
     * One cannot be turned into the other without asking RDS, and a link to
     * the list is honest where a guessed identifier would not be.
     */
    rdsDatabases() {
      return `${base}/rds/home${suffix}#databases:`;
    },

    /**
     * ElastiCache, at the list rather than the cache. Deliberately not a deep
     * link: that path has been reorganised more than once as the console was
     * rebuilt around Valkey, and a link that lands on an error page is worse
     * than one that lands a click away from the answer.
     */
    elastiCache() {
      return `${base}/elasticache/home${suffix}`;
    },

    lambdaFunction(name) {
      if (!name) return null;
      return `${base}/lambda/home${suffix}#/functions/${encodeURIComponent(name)}`;
    },

    cloudWatchAlarm(name) {
      if (!name) return null;
      return `${base}/cloudwatch/home${suffix}#alarmsV2:alarm/${encodeURIComponent(name)}`;
    },

    /** Cost Explorer is global, so it is the one link with no region in it. */
    costExplorer() {
      return 'https://us-east-1.console.aws.amazon.com/cost-management/home#/cost-explorer';
    },
  };
}
