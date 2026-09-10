import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import { logRetentionFromContext } from './log-retention';
import * as cr from 'aws-cdk-lib/custom-resources';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  assertDeploymentName,
  DEPLOYMENT_TAG_KEY,
  names,
  sensorQueueName,
  type ResourceNameOverrides,
} from '../src/shared/deployment-naming';
import { VPC_ROUTE_PREFIXES } from '../src/shared/admin-api/vpc-route-prefixes';

function collectTypeScriptFiles(rootDir: string): string[] {
  const filePaths: string[] = [];

  if (!fs.existsSync(rootDir)) {
    return filePaths;
  }

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.ts')) {
        filePaths.push(entryPath);
      }
    }
  };

  walk(rootDir);
  return filePaths;
}

function computeBuildId(): string {
  const roots = [
    path.join(__dirname, '../src'),
    path.join(__dirname, '../lib'),
    path.join(__dirname, '../bin'),
  ];

  const hash = crypto.createHash('sha256');

  for (const root of roots) {
    const files = collectTypeScriptFiles(root);
    for (const filePath of files) {
      const relativePath = path.relative(path.join(__dirname, '..'), filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      hash.update(relativePath);
      hash.update('\n');
      hash.update(content);
      hash.update('\n');
    }
  }

  return hash.digest('hex').slice(0, 12);
}

/**
 * Fallback tag applied when deploy.config.yaml specifies none.
 *
 * `Project` is the key already activated as a cost allocation tag in the
 * account this stack deploys into, and the key other teams there use, so an
 * untagged deploy still lands in the right place rather than nowhere.
 */
const DEFAULT_COST_TAG_KEY = 'Project';
const DEFAULT_COST_TAG_VALUE = 'msight-cloud';

/**
 * Password policy for the admin console user pool. Declared once so the
 * synth-time check below cannot drift from what Cognito actually enforces.
 */
const ADMIN_PASSWORD_POLICY = {
  minLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireDigits: true,
  requireSymbols: true,
} as const;

/** The symbol set Cognito accepts in a password, plus space. */
const COGNITO_SYMBOL_PATTERN = /[\^$*.\[\]{}()?"!@#%&\/\\,><':;|_~`+=\s-]/;

/**
 * Validates the configured master password at synth time.
 *
 * Without this the failure surfaces inside the bootstrap custom resource, which
 * means a full deploy, a CloudFormation rollback, and an orphaned user pool
 * before you learn the password was two characters short.
 */
function assertMasterPasswordValid(password: string): void {
  const problems: string[] = [];

  if (password.length < ADMIN_PASSWORD_POLICY.minLength) {
    problems.push(
      `at least ${ADMIN_PASSWORD_POLICY.minLength} characters (it has ${password.length})`
    );
  }
  if (!/[a-z]/.test(password)) {
    problems.push('a lowercase letter');
  }
  if (!/[A-Z]/.test(password)) {
    problems.push('an uppercase letter');
  }
  if (!/[0-9]/.test(password)) {
    problems.push('a digit');
  }
  if (!COGNITO_SYMBOL_PATTERN.test(password)) {
    problems.push('a symbol (for example ! @ # $ % ^ & * _ + = ~)');
  }

  if (problems.length > 0) {
    throw new Error(
      'deploy.config.yaml: adminConsole.masterPassword does not meet the console user ' +
        `pool password policy. It needs ${problems.join(', ')}. ` +
        'Fix it before deploying: Cognito rejects the password inside a custom resource, ' +
        'which fails the deployment and rolls the whole stack back.'
    );
  }
}

export class MsightCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------
    // Resource tags
    //
    // Applied to every taggable resource in the stack. This is what lets Cost
    // Explorer separate this stack's spend from the rest of a shared account —
    // without it, cost queries can only return account-wide totals.
    //
    // Tagging is not retroactive: spend is attributed only from the moment
    // resources actually carry the tag, so the first tagged deploy is the start
    // of any usable cost history.
    // -------------------------
    // Resolved first: every resource name and the tag set derive from it.
    const deployment: string = this.node.tryGetContext('deploymentName') ?? DEFAULT_COST_TAG_VALUE;
    assertDeploymentName(deployment);
    // Explicit pins keep an existing deployment's resources from being replaced;
    // anything omitted falls back to a deployment-scoped default.
    const nameOverrides = (this.node.tryGetContext('resourceNames') ??
      {}) as ResourceNameOverrides;

    /**
     * How long log groups keep events, from deploy.config.yaml.
     *
     * Retention is the only thing that bounds log storage, and it is a cost
     * decision rather than a structural one — different deployments want
     * different windows — so it belongs in config rather than in this file.
     * Validated here so an unsupported value fails at synth with a message
     * naming the key, instead of at deploy with a CloudWatch API error.
     */
    const logRetention = logRetentionFromContext(this.node.tryGetContext('logRetentionDays'));

    /**
     * How long the SPaT consumers cache their configuration lookups.
     *
     * They read which apps want SPaT and where each intersection is. Both are
     * hand-edited configuration, but they sit on a path that runs at roughly
     * 10 Hz per sensor — querying them per message held Aurora at 116
     * connections with capacity pinned to its ceiling, and Aurora Serverless
     * bills per ACU-hour.
     *
     * The cost of caching is staleness: a new app or a moved intersection takes
     * up to this long to take effect. Raising it saves more; lowering it makes
     * edits apply sooner.
     */
    const configCacheTtlSeconds = String(
      this.node.tryGetContext('configCacheTtlSeconds') ?? 60
    );
    const name = names(deployment, nameOverrides);

    const configuredTags = (this.node.tryGetContext('tags') ?? {}) as Record<string, unknown>;
    const stackTags: Record<string, string> = Object.fromEntries(
      Object.entries(configuredTags).map(([key, value]) => [key, String(value)])
    );

    if (Object.keys(stackTags).length === 0) {
      stackTags[DEFAULT_COST_TAG_KEY] = deployment;
    }

    // Identifies the deployment rather than the product. Runtime-created sensor
    // resources carry the same tag, and teardown enumerates by it — a constant
    // here would let one deployment's destroy reap another's queues.
    stackTags[DEPLOYMENT_TAG_KEY] = deployment;

    const costAllocationTagKey: string =
      this.node.tryGetContext('costAllocationTagKey') ?? DEFAULT_COST_TAG_KEY;

    // A cost tag that is never applied to anything would make the console's cost
    // page silently return zero rather than fail, so catch it at synth.
    if (!stackTags[costAllocationTagKey]) {
      throw new Error(
        `deploy.config.yaml: costAllocationTagKey is "${costAllocationTagKey}", but no such key ` +
          `exists under tags. Add it, or point costAllocationTagKey at one of: ` +
          `${Object.keys(stackTags).join(', ')}.`
      );
    }

    for (const [key, value] of Object.entries(stackTags)) {
      cdk.Tags.of(this).add(key, value);
    }

    const buildId = computeBuildId();
    const preferredAz = this.node.tryGetContext('preferredAz');
    const debugModeContext = this.node.tryGetContext('debugMode');
    const isDebugMode =
      debugModeContext === true ||
      debugModeContext === 'true' ||
      debugModeContext === 1 ||
      debugModeContext === '1';
    const appSubnetType = ec2.SubnetType.PRIVATE_ISOLATED;
    const hasPreferredAz = typeof preferredAz === 'string' && preferredAz.length > 0;
    const appSubnetSelection: ec2.SubnetSelection =
      hasPreferredAz
        ? { subnetGroupName: 'app', availabilityZones: [preferredAz] }
        : { subnetGroupName: 'app' };
    const multiAzAppSubnetSelection: ec2.SubnetSelection = {
      subnetType: appSubnetType,
    };

    // -------------------------
    // VPC
    // -------------------------
    const vpc = new ec2.Vpc(this, 'MsightVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'app',
          subnetType: appSubnetType,
        },
        {
          name: 'db',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets;
    const natEip = new ec2.CfnEIP(this, 'MsightNatEip', {
      domain: 'vpc',
    });

    const natGateway = new ec2.CfnNatGateway(this, 'MsightNatGateway', {
      allocationId: natEip.attrAllocationId,
      subnetId: publicSubnets[0].subnetId,
    });

    // -------------------------
    // Security Groups (renamed)
    // -------------------------
    const lambdaSg = new ec2.SecurityGroup(this, 'MsightLambdaSg', {
      vpc,
      allowAllOutbound: true,
      description: 'MSight Lambda Security Group',
      securityGroupName: 'msight-lambda-sg',
    });

    const proxySg = new ec2.SecurityGroup(this, 'MsightProxySg', {
      vpc,
      allowAllOutbound: true,
      description: 'MSight RDS Proxy Security Group',
      securityGroupName: 'msight-proxy-sg',
    });

    const dbSg = new ec2.SecurityGroup(this, 'MsightDbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'MSight Aurora PostgreSQL Security Group',
      securityGroupName: 'msight-db-sg',
    });

    const cacheSg = new ec2.SecurityGroup(this, 'MsightCacheSg', {
      vpc,
      allowAllOutbound: true,
      description: 'MSight ElastiCache Security Group',
      securityGroupName: 'msight-cache-sg',
    });

    const vpcEndpointSg = new ec2.SecurityGroup(this, 'MsightVpcEndpointSg', {
      vpc,
      allowAllOutbound: true,
      description: 'MSight Interface VPC Endpoints Security Group',
      securityGroupName: 'msight-vpce-sg',
    });

    // Lambda -> Proxy
    proxySg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Lambda to Proxy');

    // Lambda -> ElastiCache
    cacheSg.addIngressRule(lambdaSg, ec2.Port.tcp(6379), 'Lambda to ElastiCache');

    // Proxy -> DB
    dbSg.addIngressRule(proxySg, ec2.Port.tcp(5432), 'Proxy to Aurora');

    // Lambda -> Interface VPC Endpoints
    vpcEndpointSg.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(443),
      'Lambda HTTPS to interface endpoints'
    );

    const preferredAppSubnetSelection: ec2.SubnetSelection = hasPreferredAz
      ? { subnetGroupName: 'app', availabilityZones: [preferredAz] }
      : { subnetGroupName: 'app' };
    const appSubnets = vpc.selectSubnets({ subnetGroupName: 'app' });
    const preferredAppSubnets = vpc.selectSubnets(preferredAppSubnetSelection);

    for (const [index, subnet] of appSubnets.subnets.entries()) {
      if (!(subnet instanceof ec2.Subnet)) {
        continue;
      }

      subnet.addRoute(`DefaultInternetViaNat${index + 1}`, {
        routerId: natGateway.ref,
        routerType: ec2.RouterType.NAT_GATEWAY,
        enablesInternetConnectivity: true,
      });
    }

    const cacheSubnetIds = hasPreferredAz
      ? preferredAppSubnets.subnetIds
      : [appSubnets.subnetIds[0]];
    const cachePreferredAz = hasPreferredAz
      ? preferredAz
      : appSubnets.subnets[0].availabilityZone;

    // -------------------------
    // ElastiCache Valkey
    // -------------------------
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, 'MsightCacheSubnetGroup', {
      description: 'MSight ElastiCache subnet group',
      cacheSubnetGroupName: 'msight-cache-subnet-group',
      subnetIds: cacheSubnetIds,
    });

    const cacheReplicationGroup = new elasticache.CfnReplicationGroup(this, 'MsightCacheCluster', {
      atRestEncryptionEnabled: true,
      automaticFailoverEnabled: false,
      autoMinorVersionUpgrade: true,
      cacheNodeType: 'cache.t4g.small',
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      engine: 'valkey',
      engineVersion: '8.2',
      multiAzEnabled: false,
      numCacheClusters: 1,
      port: 6379,
      preferredCacheClusterAZs: [cachePreferredAz],
      replicationGroupDescription: 'MSight temporary location cache',
      replicationGroupId: 'msight-cache',
      securityGroupIds: [cacheSg.securityGroupId],
      transitEncryptionEnabled: true,
    });

    cacheReplicationGroup.addDependency(cacheSubnetGroup);

    // -------------------------
    // Aurora PostgreSQL
    // -------------------------
    const cluster = new rds.DatabaseCluster(this, 'MsightAurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      credentials: rds.Credentials.fromGeneratedSecret('msight_admin'),
      defaultDatabaseName: 'msight',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      enableDataApi: true,
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // -------------------------
    // RDS Proxy
    // -------------------------
    const proxy = new rds.DatabaseProxy(this, 'MsightProxy', {
      proxyTarget: rds.ProxyTarget.fromCluster(cluster),
      secrets: [cluster.secret!],
      vpc,
      securityGroups: [proxySg],
      requireTLS: true,
      dbProxyName: 'msight-proxy',
      vpcSubnets: multiAzAppSubnetSelection,
    });

    // Keep Secrets Manager calls on private AWS network when NAT is disabled.
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: appSubnetSelection,
      open: false,
      securityGroups: [vpcEndpointSg],
    });

    // Keep Lambda invoke traffic on private AWS network for VPC-bound functions.
    new ec2.InterfaceVpcEndpoint(this, 'LambdaVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      subnets: appSubnetSelection,
      open: false,
      securityGroups: [vpcEndpointSg],
    });

    // -------------------------
    // Lambda Common Config
    // -------------------------
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      vpc,
      vpcSubnets: appSubnetSelection,
      securityGroups: [lambdaSg],
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
      },
    };

    const publicLambdaProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
      },
    };

    // -------------------------
    // Location Lambda
    // -------------------------
    /**
     * Every Lambda gets a named, CDK-owned log group.
     *
     * Left undeclared, Lambda creates /aws/lambda/<generated-name> on first
     * write with no retention, so events accumulate forever and CloudWatch bills
     * for the storage — two of these groups had reached 276 GB between them.
     * Those groups are also invisible to `cdk destroy`, since nothing in the
     * stack owns them.
     *
     * Declaring the group instead fixes all three: two-week retention (long
     * enough to investigate an incident, short enough to bound volume), a name
     * that says which deployment and function it belongs to, and removal with
     * the stack.
     *
     * `logGroup` rather than `logRetention`: the latter is deprecated, and
     * Lambda's LoggingConfig accepts any group name, so this needs no explicit
     * `functionName` — setting one would replace the function and recreate its
     * SNS subscriptions and event sources.
     */
    const locationLambda = new NodejsFunction(this, 'LocationLambda', {
      logGroup: new logs.LogGroup(this, 'LocationLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/location`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/location-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'location-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        LOCATION_TTL_SECONDS: '1800',
      },
    });

    const wsConnectLambda = new NodejsFunction(this, 'WsConnectLambda', {
      logGroup: new logs.LogGroup(this, 'WsConnectLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/ws-connect`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-connect/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-connect',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    const wsDisconnectLambda = new NodejsFunction(this, 'WsDisconnectLambda', {
      logGroup: new logs.LogGroup(this, 'WsDisconnectLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/ws-disconnect`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-disconnect/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-disconnect',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    const radiusBroadcastLambda = new NodejsFunction(this, 'RadiusBroadcastLambda', {
      logGroup: new logs.LogGroup(this, 'RadiusBroadcastLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/radius-broadcast`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/radius-broadcast-api/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'radius-broadcast-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        WS_SEND_TIMEOUT_MS: '10000',
      },
    });

    const wsSenderLambda = new NodejsFunction(this, 'WsSenderLambda', {
      logGroup: new logs.LogGroup(this, 'WsSenderLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/ws-sender`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...publicLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-send/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-send',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        WS_SEND_TIMEOUT_MS: '10000',
      },
    });

    const sensorLambda = new NodejsFunction(this, 'SensorLambda', {
      logGroup: new logs.LogGroup(this, 'SensorLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/sensor`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...publicLambdaProps,
      entry: path.join(__dirname, '../src/functions/sensor-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'sensor-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
      },
    });

    // radiusBroadcastLambda handles WS sending directly via shared ws-sender module.
    // wsSenderLambda is kept deployed for standalone use but is no longer invoked by radius-broadcast.

    // -------------------------
    // System Lambda
    // -------------------------
    const systemLambda = new NodejsFunction(this, 'SystemLambda', {
      logGroup: new logs.LogGroup(this, 'SystemLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/system`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/system-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'system-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
      },
    });

    // -------------------------
    // Latency Lambda
    // -------------------------
    const latencyLambda = new NodejsFunction(this, 'LatencyLambda', {
      logGroup: new logs.LogGroup(this, 'LatencyLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/latency`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/latency-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'latency-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
      },
    });

    cluster.secret!.grantRead(latencyLambda);

    // -------------------------
    // Maps Lambda
    // -------------------------
    const mapsLambda = new NodejsFunction(this, 'MapsLambda', {
      logGroup: new logs.LogGroup(this, 'MapsLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/maps`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/maps-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'maps-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
      },
    });

    cluster.secret!.grantRead(mapsLambda);

    let cacheDebugLambda: NodejsFunction | undefined;
    if (isDebugMode) {
      cacheDebugLambda = new NodejsFunction(this, 'CacheDebugLambda', {
      logGroup: new logs.LogGroup(this, 'CacheDebugLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/cache-debug`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
        ...commonLambdaProps,
        entry: path.join(__dirname, '../src/functions/cache-debug/handler.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(20),
        environment: {
          API_VERSION: 'v1',
          SERVICE_NAME: 'cache-debug',
        DEBUG_LOGGING: 'false',
          BUILD_ID: buildId,
          CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
          CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
          CACHE_TLS_ENABLED: 'true',
        },
      });
    }

    // -------------------------
    // API Gateway
    // -------------------------
    const locationIntegration = new HttpLambdaIntegration(
      'LocationLambdaIntegration',
      locationLambda
    );

    const systemIntegration = new HttpLambdaIntegration(
      'SystemLambdaIntegration',
      systemLambda
    );

    const latencyIntegration = new HttpLambdaIntegration(
      'LatencyLambdaIntegration',
      latencyLambda
    );

    const radiusBroadcastIntegration = new HttpLambdaIntegration(
      'RadiusBroadcastIntegration',
      radiusBroadcastLambda
    );

    const sensorIntegration = new HttpLambdaIntegration(
      'SensorIntegration',
      sensorLambda
    );

    const mapsIntegration = new HttpLambdaIntegration(
      'MapsIntegration',
      mapsLambda
    );

    const wsConnectIntegration = new WebSocketLambdaIntegration(
      'WsConnectIntegration',
      wsConnectLambda
    );

    const wsDisconnectIntegration = new WebSocketLambdaIntegration(
      'WsDisconnectIntegration',
      wsDisconnectLambda
    );

    const httpApi = new apigwv2.HttpApi(this, 'MsightHttpApi', {
      apiName: name.httpApi,
      corsPreflight: {
        allowHeaders: ['content-type', 'authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    httpApi.addRoutes({
      path: '/v1/clients/location/update',
      methods: [apigwv2.HttpMethod.POST],
      integration: locationIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/clients/location/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: locationIntegration,
    });

    httpApi.addRoutes({
      path: '/system/openapi.json',
      methods: [apigwv2.HttpMethod.GET],
      integration: systemIntegration,
    });

    httpApi.addRoutes({
      path: '/system/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: systemIntegration,
    });

    httpApi.addRoutes({
      path: '/system/version',
      methods: [apigwv2.HttpMethod.GET],
      integration: systemIntegration,
    });

    httpApi.addRoutes({
      path: '/system/websocket-url',
      methods: [apigwv2.HttpMethod.GET],
      integration: systemIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/client/latency',
      methods: [apigwv2.HttpMethod.GET],
      integration: latencyIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/clients/notify/radius',
      methods: [apigwv2.HttpMethod.POST],
      integration: radiusBroadcastIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/clients/notify/radius/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: radiusBroadcastIntegration,
    });

    // /v1/maps/search must be registered before /v1/maps/{name} so the static
    // path takes precedence in API Gateway route matching.
    httpApi.addRoutes({
      path: '/v1/maps/search',
      methods: [apigwv2.HttpMethod.GET],
      integration: mapsIntegration,
    });

    httpApi.addRoutes({
      path: '/v1/maps/{name}',
      methods: [apigwv2.HttpMethod.GET],
      integration: mapsIntegration,
    });

    // -------------------------
    // Sensor HTTP API (dual-stack IPv4 + IPv6)
    // -------------------------
    const sensorHttpApi = new apigwv2.HttpApi(this, 'MsightSensorHttpApi', {
      apiName: name.sensorHttpApi,
      ipAddressType: apigwv2.IpAddressType.DUAL_STACK,
      corsPreflight: {
        allowHeaders: ['content-type', 'x-partition-key'],
        allowMethods: [
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    sensorHttpApi.addRoutes({
      path: '/v1/sensors/data',
      methods: [apigwv2.HttpMethod.POST],
      integration: sensorIntegration,
    });

    const wsApi = new apigwv2.WebSocketApi(this, 'MsightWsApi', {
      apiName: name.wsApi,
      connectRouteOptions: {
        integration: wsConnectIntegration,
      },
      disconnectRouteOptions: {
        integration: wsDisconnectIntegration,
      },
    });

    const wsStage = new apigwv2.WebSocketStage(this, 'MsightWsStage', {
      webSocketApi: wsApi,
      stageName: 'v1',
      autoDeploy: true,
    });

    const wsApiUrl = cdk.Fn.join('', [
      'wss://',
      wsApi.apiId,
      '.execute-api.',
      cdk.Stack.of(this).region,
      '.',
      cdk.Aws.URL_SUFFIX,
      '/',
      wsStage.stageName,
    ]);

    const wsManageConnectionsArn = cdk.Stack.of(this).formatArn({
      service: 'execute-api',
      resource: wsApi.apiId,
      resourceName: '*',
    });

    wsConnectLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [wsManageConnectionsArn],
      })
    );

    wsSenderLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [wsManageConnectionsArn],
      })
    );

    radiusBroadcastLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [wsManageConnectionsArn],
      })
    );

    // -------------------------
    // Expiration Cleanup Lambda
    // -------------------------
    const expirationCleanupLambda = new NodejsFunction(this, 'ExpirationCleanupLambda', {
      logGroup: new logs.LogGroup(this, 'ExpirationCleanupLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/expiration-cleanup`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/expiration-cleanup/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        SERVICE_NAME: 'expiration-cleanup',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    expirationCleanupLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [wsManageConnectionsArn],
      })
    );

    new events.Rule(this, 'ExpirationCleanupSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(expirationCleanupLambda)],
    });

    systemLambda.addEnvironment('WS_API_URL', wsApiUrl);

    // -------------------------
    // Outputs
    // -------------------------
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
    });

    new cdk.CfnOutput(this, 'SensorHttpApiUrl', {
      value: sensorHttpApi.apiEndpoint,
      description: 'Dual-stack (IPv4 + IPv6) endpoint for sensor data ingestion.',
    });

    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: wsApiUrl,
    });

    new cdk.CfnOutput(this, 'DbProxyEndpoint', {
      value: proxy.endpoint,
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: cluster.secret!.secretArn,
    });
    new cdk.CfnOutput(this, 'DbClusterArn', {
      value: cluster.clusterArn,
    });

    new cdk.CfnOutput(this, 'DbInitCommand', {
      value: `node tools/init-db.js --cluster-arn ${cluster.clusterArn} --secret-arn ${cluster.secret!.secretArn} --db-name msight --region ${cdk.Stack.of(this).region}`,
      description: 'Run this command to initialize the database if this is the first deployment.',
    });

    // -------------------------
    // SNS Topic (sensor fanout)
    // -------------------------
    const sensorTopic = new sns.Topic(this, 'MsightSensorTopic', {
      topicName: name.sensorTopic,
      displayName: 'MSight Sensor Data Fanout',
      fifo: true,
      contentBasedDeduplication: true,
      // MessageGroup scope: no regional throughput cap; deduplication scoped per group.
      // WARNING: cannot be reverted to Topic scope once deployed.
      fifoThroughputScope: sns.FifoThroughputScope.MESSAGE_GROUP,
    });

    new cdk.CfnOutput(this, 'SensorTopicArn', {
      value: sensorTopic.topicArn,
      description: 'SNS topic ARN for sensor data fanout. Subscribe Firehose, SQS, or Lambda here.',
    });

    // -------------------------
    // SNS Topic (SPaT fanout)
    // -------------------------
    const spatTopic = new sns.Topic(this, 'MsightSpatTopic', {
      topicName: name.spatTopic,
      displayName: 'MSight SPaT Data Fanout',
    });

    new cdk.CfnOutput(this, 'SpatTopicArn', {
      value: spatTopic.topicArn,
      description: 'SNS topic ARN for SPaT data fanout.',
    });

    // -------------------------
    // SNS Topic (control channel)
    // Low-frequency control-plane events (e.g. an object landed in S3, a config
    // changed, a sensor registered) — not a data path. Standard topic, not FIFO:
    // ordering is not required here, and FIFO topics only accept SQS FIFO
    // subscriptions, whereas control consumers subscribe Lambdas directly.
    //
    // CONVENTION: publishers MUST set an `event_type` String MessageAttribute,
    // and every subscription MUST carry a filter policy on it — a subscription
    // without one receives every control event. Payloads stay small JSON.
    //
    // S3 is the one publisher that cannot follow the convention: bucket event
    // notifications carry no message attributes, and S3 offers no way to add
    // any. A subscriber that wants only S3 events must therefore discriminate
    // on the payload — an S3 notification is a JSON object with a `Records`
    // array whose entries have `eventSource: "aws:s3"`.
    //
    // Nothing in this stack subscribes to those events today. That is
    // deliberate: storage management owns the PUBLISHING side only. Note the
    // consequence — SNS does not buffer, so an event published with no matching
    // subscription is discarded, not queued. A subscriber added later sees only
    // what arrives after it exists; earlier uploads have to be recovered by
    // listing the bucket. Which sensor a key belongs to is recoverable at any
    // time from `sensors.storage_bucket` / `storage_prefix`.
    // -------------------------
    const controlTopic = new sns.Topic(this, 'MsightControlTopic', {
      topicName: name.controlTopic,
      displayName: 'MSight Control Channel',
    });

    /**
     * Lets S3 publish upload notifications here.
     *
     * Conditioned on the source *account* rather than a source bucket ARN
     * because storage buckets are registered at runtime from the console, so no
     * list of them exists at synth time. The account condition is what stops a
     * bucket in someone else's account from being pointed at this topic.
     *
     * This statement is also load-bearing for registration itself:
     * PutBucketNotificationConfiguration sends a test event to prove the
     * destination is reachable and refuses the configuration outright if it is
     * not, so without this every attempt to register a bucket fails.
     */
    controlTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3UploadNotifications',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [controlTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } },
      })
    );

    new cdk.CfnOutput(this, 'ControlTopicArn', {
      value: controlTopic.topicArn,
      description:
        'SNS topic ARN for low-frequency control events. Subscribers must filter on the event_type message attribute.',
    });

    // -------------------------
    // Sensor SNS consumer Lambda (Python)
    // -------------------------

    // Lambda Layer: installs pyv2xlib (local) + pycrate (PyPI) inside Docker
    // Build the Lambda layer locally (no Docker needed — pycrate is pure Python).
    // CDK runs this at synth time; the output is cached in .layer-build/pyv2x/.
    // The cache is considered valid only when the python/ dir is non-empty.
    const pyV2XLayerDir = path.join(__dirname, '../src/vendor/PyV2XLib_ASN');
    const pyV2XLayerOutput = path.join(__dirname, '../.layer-build/pyv2x/python');
    const layerCacheValid =
      fs.existsSync(pyV2XLayerOutput) && fs.readdirSync(pyV2XLayerOutput).length > 0;
    if (!layerCacheValid) {
      fs.mkdirSync(pyV2XLayerOutput, { recursive: true });
      // Install pyv2xlib + pycrate (pure Python — works cross-platform).
      execSync(
        `python -m pip install "${pyV2XLayerDir}" pycrate -t "${pyV2XLayerOutput}"`,
        { stdio: 'inherit' },
      );
      // pycrate ships ~15 sub-packages for telecom protocols we don't need.
      // Only pycrate_asn1rt, pycrate_asn1c (one utility import), and pycrate_core are used.
      const keepPycrate = new Set(['pycrate_asn1rt', 'pycrate_asn1c', 'pycrate_core']);
      for (const entry of fs.readdirSync(pyV2XLayerOutput)) {
        if (entry.startsWith('pycrate') && !entry.endsWith('.dist-info') && !keepPycrate.has(entry)) {
          fs.rmSync(path.join(pyV2XLayerOutput, entry), { recursive: true, force: true });
        }
      }
      // Install psycopg2-binary for the Lambda Linux x86_64 target.
      // We pull the manylinux wheel directly so Docker is not required.
      execSync(
        [
          'python -m pip install psycopg2-binary',
          `--platform manylinux2014_x86_64`,
          `--python-version 3.12`,
          `--only-binary=:all:`,
          `-t "${pyV2XLayerOutput}"`,
        ].join(' '),
        { stdio: 'inherit' },
      );
      // Install redis-py (pure Python — no platform wheel needed).
      execSync(
        `python -m pip install redis -t "${pyV2XLayerOutput}"`,
        { stdio: 'inherit' },
      );
    }

    // MSight's own shared Python modules ride in the same layer as the
    // third-party dependencies, which is what lets both SPaT consumers import
    // them without each function bundle carrying its own copy. The Fargate
    // sensor consumer COPYs the same files in its Dockerfile.
    //
    // Copied on EVERY synth, deliberately outside the cache guard above: the
    // pip installs are skipped once .layer-build exists, so a shared module
    // edited after the first synth would otherwise never reach the layer and
    // the deployed Lambdas would silently run the old copy.
    fs.mkdirSync(pyV2XLayerOutput, { recursive: true });
    const sharedPythonDir = path.join(__dirname, '../src/shared/python');
    for (const entry of fs.readdirSync(sharedPythonDir)) {
      if (entry.endsWith('.py')) {
        fs.copyFileSync(
          path.join(sharedPythonDir, entry),
          path.join(pyV2XLayerOutput, entry),
        );
      }
    }

    const pyV2XLayer = new lambda.LayerVersion(this, 'PyV2XLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../.layer-build/pyv2x')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'pyv2xlib + pycrate + psycopg2 + redis + msight shared modules — V2X ASN.1 decoding, PostgreSQL, and Valkey access',
    });

    // -------------------------
    // Sensor list — sourced from deploy.config.yaml via CDK context
    // -------------------------
    let sensorQueueGrantScope: string;
    const spatBroadcastRadiusM: number = this.node.tryGetContext('spatBroadcastRadiusM') ?? 500;

    // -------------------------
    // ECS Cluster + sensor consumer services
    // -------------------------
    const ecsCluster = new ecs.Cluster(this, 'MsightEcsCluster', {
      vpc,
      clusterName: name.cluster,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Task role — permissions for the running container (SQS, Secrets Manager, WS management)
    const sensorConsumerTaskRole = new iam.Role(this, 'SensorConsumerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: name.sensorConsumerTaskRole,
    });
    sensorConsumerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [wsManageConnectionsArn],
    }));
    cluster.secret!.grantRead(sensorConsumerTaskRole);

    // Container image — built from repo root so src/vendor is accessible
    const sensorConsumerImage = ecs.ContainerImage.fromAsset(
      path.join(__dirname, '..'),
      { file: 'src/services/sensor-consumer/Dockerfile' }
    );

    // -------------------------
    // Sensor consumer template
    //
    // Sensors are no longer provisioned here. Their queues, subscriptions and
    // services are created at runtime from the `sensors` table in Aurora, so
    // adding one is a console action rather than a deploy.
    //
    // What CDK still owns is this single task definition: the container image,
    // CPU, memory and the environment every sensor shares. The reconciler
    // derives per-sensor revisions from it, so that shape lives in one place
    // instead of being restated in imperative code.
    // -------------------------
    const sensorTaskTemplate = new ecs.FargateTaskDefinition(this, 'SensorConsumerTaskTemplate', {
      family: `${name.sensorResourcePrefix}-template`,
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: sensorConsumerTaskRole,
    });

    const sensorLogGroup = new logs.LogGroup(this, 'SensorConsumerLogGroup', {
      logGroupName: name.sensorLogGroup('all'),
      retention: logRetention.container,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    sensorTaskTemplate.addContainer('consumer', {
      image: sensorConsumerImage,
      environment: {
        // SENSOR_NAME and QUEUE_URL are absent on purpose: the reconciler fills
        // them in per sensor when it registers a revision of this definition.
        BUILD_ID: buildId,
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        AWS_REGION: cdk.Stack.of(this).region,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'sensor-consumer',
        logGroup: sensorLogGroup,
      }),
    });

    sensorQueueGrantScope = `arn:${cdk.Aws.PARTITION}:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${name.sensorResourcePrefix}-*`;

    // The task role must reach any queue the reconciler may create, so the
    // grant is by name pattern rather than per queue.
    sensorConsumerTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:DeleteMessageBatch',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
        ],
        resources: [sensorQueueGrantScope],
      })
    );

    // -------------------------
    // SPaT SNS consumer Lambda (Python)
    // -------------------------
    const spatSnsConsumerLambda = new lambda.Function(this, 'SpatSnsConsumerLambda', {
      logGroup: new logs.LogGroup(this, 'SpatSnsConsumerLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/spat-sns-consumer`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/functions/spat-sns-consumer')),
      handler: 'handler.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: appSubnetSelection,
      securityGroups: [lambdaSg],
      layers: [pyV2XLayer],
      environment: {
        SERVICE_NAME: 'spat-sns-consumer',
        DEBUG_LOGGING: 'false',
        CONFIG_CACHE_TTL_SECONDS: configCacheTtlSeconds,
        BUILD_ID: buildId,
        RADIUS_BROADCAST_LAMBDA_NAME: radiusBroadcastLambda.functionName,
        SPAT_BROADCAST_RADIUS_M: String(spatBroadcastRadiusM),
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    cluster.secret!.grantRead(spatSnsConsumerLambda);
    radiusBroadcastLambda.grantInvoke(spatSnsConsumerLambda);

    spatTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(spatSnsConsumerLambda)
    );

    // -------------------------
    // Critical SPaT SNS consumer Lambda (Python)
    // Same as spatSnsConsumerLambda but applies an is_critical() filter before
    // broadcasting; emits "critical_spat" WebSocket messages.
    // -------------------------
    const criticalSpatSnsConsumerLambda = new lambda.Function(this, 'CriticalSpatSnsConsumerLambda', {
      logGroup: new logs.LogGroup(this, 'CriticalSpatSnsConsumerLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/critical-spat-sns-consumer`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/functions/critical-spat-sns-consumer')),
      handler: 'handler.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: appSubnetSelection,
      securityGroups: [lambdaSg],
      layers: [pyV2XLayer],
      environment: {
        SERVICE_NAME: 'critical-spat-sns-consumer',
        DEBUG_LOGGING: 'false',
        CONFIG_CACHE_TTL_SECONDS: configCacheTtlSeconds,
        BUILD_ID: buildId,
        RADIUS_BROADCAST_LAMBDA_NAME: radiusBroadcastLambda.functionName,
        SPAT_BROADCAST_RADIUS_M: String(spatBroadcastRadiusM),
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    cluster.secret!.grantRead(criticalSpatSnsConsumerLambda);
    radiusBroadcastLambda.grantInvoke(criticalSpatSnsConsumerLambda);

    spatTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(criticalSpatSnsConsumerLambda)
    );

    // -------------------------
    // Admin console — Cognito user pool
    //
    // Self-registration is disabled: the only way an account comes into
    // existence is the seeded master user below, or an admin creating one from
    // the Users tab. There is deliberately no sign-up route.
    // -------------------------
    const adminConsoleConfig = (this.node.tryGetContext('adminConsole') ?? {}) as {
      masterUsername?: string;
      masterEmail?: string;
      masterPassword?: string;
      allowedOrigins?: string[];
    };

    const masterUsername = adminConsoleConfig.masterUsername;
    const masterEmail = adminConsoleConfig.masterEmail;
    const masterPassword = adminConsoleConfig.masterPassword;

    if (!masterUsername || !masterEmail || !masterPassword) {
      throw new Error(
        'deploy.config.yaml is missing adminConsole.masterUsername / masterEmail / masterPassword. ' +
          'See deploy.config.example.yaml.'
      );
    }

    assertMasterPasswordValid(masterPassword);

    // -------------------------
    // Console hosting
    //
    // The built frontend is uploaded by deploy.js AFTER this stack finishes,
    // because the bundle bakes in the user pool and API URL that only exist
    // once the stack has been created. CDK therefore owns the bucket and the
    // distribution but never the objects inside — which is why a bare
    // `cdk deploy` leaves the console stale. Use `npm run deploy`.
    // -------------------------
    const consoleBucket = new s3.Bucket(this, 'AdminConsoleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The bucket holds only build output, reproducible from source, so it is
      // removed with the stack rather than left behind to be paid for.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /**
     * Vue Router runs in history mode, so `/sensors` is a client-side route
     * with no object behind it. Without this, opening or refreshing any URL
     * other than `/` returns the S3 403 that Origin Access Control produces for
     * a missing key. Both codes are mapped: S3 answers 403 rather than 404 when
     * the caller cannot list the bucket, which is exactly our case.
     */
    const spaFallbacks: cloudfront.ErrorResponse[] = [403, 404].map((httpStatus) => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: '/index.html',
      ttl: cdk.Duration.seconds(0),
    }));

    const consoleDistribution = new cloudfront.Distribution(this, 'AdminConsoleDistribution', {
      comment: `${deployment} admin console`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // withOriginAccessControl keeps the bucket private: CloudFront signs
        // its origin requests and nothing reaches S3 directly.
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(consoleBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // One behaviour for everything, with cache lifetime decided per object
        // by the Cache-Control header deploy.js sets at upload time. A path
        // pattern for /index.html would not do the job: a request for "/" is
        // matched against the DEFAULT behaviour and only then resolved to
        // index.html, so the most-visited URL would miss the pattern entirely.
        // CACHING_OPTIMIZED honours origin Cache-Control, so no-cache on
        // index.html and immutable on the fingerprinted assets both take effect.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      errorResponses: spaFallbacks,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: false,
    });

    const consoleUrl = `https://${consoleDistribution.distributionDomainName}`;

    // The hosted console is always allowed, so its origin never has to be
    // copied into deploy.config.yaml by hand — a step that is easy to forget
    // and whose failure looks like a CORS bug rather than a config omission.
    const adminAllowedOrigins = [
      ...(adminConsoleConfig.allowedOrigins ?? ['http://localhost:5173']),
      consoleUrl,
    ];

    const adminUserPool = new cognito.UserPool(this, 'MsightAdminUserPool', {
      userPoolName: name.adminUserPool,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: ADMIN_PASSWORD_POLICY,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // The pool holds the only credentials for the console; losing it on a
      // stack replacement would lock everyone out.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const adminUserPoolClient = adminUserPool.addClient('AdminConsoleClient', {
      userPoolClientName: 'msight-admin-console',
      // Public SPA client: no secret, SRP only.
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });

    // Access levels. Precedence is Cognito's own tie-breaker (lower wins) and
    // mirrors ROLE_PRECEDENCE in src/shared/schemas/admin.ts.
    const adminRoleGroups: Array<{ name: string; description: string; precedence: number }> = [
      { name: 'admin', description: 'Full control, including user management.', precedence: 1 },
      { name: 'operator', description: 'Operational actions; cannot manage users.', precedence: 2 },
      { name: 'viewer', description: 'Read-only access.', precedence: 3 },
    ];

    const roleGroupResources = adminRoleGroups.map(
      (group) =>
        new cognito.CfnUserPoolGroup(this, `AdminRoleGroup-${group.name}`, {
          userPoolId: adminUserPool.userPoolId,
          groupName: group.name,
          description: group.description,
          precedence: group.precedence,
        })
    );

    // -------------------------
    // Master account seeding
    //
    // NOTE: masterPassword reaches CloudFormation as a custom resource property,
    // so it is readable by anyone with stack read access. Rotate it from the
    // console after first sign-in, or move it to Secrets Manager.
    // -------------------------
    const adminBootstrapLambda = new NodejsFunction(this, 'AdminBootstrapLambda', {
      logGroup: new logs.LogGroup(this, 'AdminBootstrapLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/admin-bootstrap`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../src/functions/admin-bootstrap/handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });

    adminBootstrapLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminUpdateUserAttributes',
        ],
        resources: [adminUserPool.userPoolArn],
      })
    );

    const adminBootstrapProvider = new cr.Provider(this, 'AdminBootstrapProvider', {
      onEventHandler: adminBootstrapLambda,
      logGroup: new logs.LogGroup(this, 'AdminBootstrapProviderLogGroup', {
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const masterUserResource = new cdk.CustomResource(this, 'AdminMasterUser', {
      serviceToken: adminBootstrapProvider.serviceToken,
      properties: {
        UserPoolId: adminUserPool.userPoolId,
        Username: masterUsername,
        Email: masterEmail,
        Password: masterPassword,
        Role: 'admin',
      },
    });

    // The admin group must exist before the master user can be added to it.
    for (const groupResource of roleGroupResources) {
      masterUserResource.node.addDependency(groupResource);
    }

    // -------------------------
    // Admin API
    //
    // Runs outside the VPC on purpose: it calls Cognito and probes the public
    // endpoints, and the app subnets have no NAT and no Cognito VPC endpoint.
    // When admin operations need Aurora or Valkey, add a second in-VPC function
    // behind the same API rather than moving this one inside.
    // -------------------------
    const adminApiLambda = new NodejsFunction(this, 'AdminApiLambda', {
      logGroup: new logs.LogGroup(this, 'AdminApiLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/admin-api`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../src/functions/admin-api/handler.ts'),
      handler: 'handler',
      memorySize: 512,
      // Listing users fans out one groups lookup per user, and the overview
      // probes public endpoints; 10s is too tight for both.
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'admin-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        USER_POOL_ID: adminUserPool.userPoolId,
        USER_POOL_CLIENT_ID: adminUserPoolClient.userPoolClientId,
        HTTP_API_URL: httpApi.apiEndpoint,
        SENSOR_HTTP_API_URL: sensorHttpApi.apiEndpoint,
        WS_API_URL: wsApiUrl,
        SENSOR_TOPIC_ARN: sensorTopic.topicArn,
        SPAT_TOPIC_ARN: spatTopic.topicArn,
        CONTROL_TOPIC_ARN: controlTopic.topicArn,
        DEPLOYMENT_NAME: deployment,
        SENSOR_RESOURCE_PREFIX: name.sensorResourcePrefix,
        // Identifies this stack's spend in Cost Explorer.
        COST_TAG_KEY: costAllocationTagKey,
        COST_TAG_VALUE: stackTags[costAllocationTagKey],
      },
    });

    adminApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
        ],
        resources: [adminUserPool.userPoolArn],
      })
    );

    // CloudWatch Logs for the console's Logs page. Read plus the Insights query
    // lifecycle; no ability to write or delete log data.
    adminApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:DescribeLogGroups',
          'logs:StartQuery',
          'logs:GetQueryResults',
          'logs:StopQuery',
        ],
        resources: ['*'],
      })
    );

    // Sensor inventory for the console: queue depth per sensor, and the topic
    // subscription filter that routes to it. Read-only.
    adminApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:GetQueueUrl',
          'sqs:GetQueueAttributes',
          'sns:ListSubscriptionsByTopic',
          'sns:GetSubscriptionAttributes',
        ],
        resources: ['*'],
      })
    );

    // Read-only network inspection for the console's Network page. All are
    // Describe/List calls; none can change the topology, which CDK owns.
    adminApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeVpcs',
          'ec2:DescribeSubnets',
          'ec2:DescribeRouteTables',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeNatGateways',
          'ec2:DescribeInternetGateways',
          'ec2:DescribeVpcEndpoints',
          'ec2:DescribeNetworkInterfaces',
          'lambda:ListFunctions',
        ],
        // EC2 Describe actions do not support resource-level permissions.
        resources: ['*'],
      })
    );

    // Cost Explorer for the console's cost page. These are read-only and do not
    // support resource-level permissions, so '*' is the only valid resource.
    // Note that ce:GetCostAndUsage is billed per request — the API caches
    // responses rather than calling it per page view.
    adminApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ce:GetCostAndUsage',
          'ce:GetCostForecast',
          'ce:GetDimensionValues',
          'ce:GetTags',
        ],
        resources: ['*'],
      })
    );

    const adminApi = new apigwv2.HttpApi(this, 'MsightAdminApi', {
      apiName: name.adminApi,
      // Default authorizer, so no route can be added later that is reachable
      // without a valid console token.
      defaultAuthorizer: new HttpUserPoolAuthorizer(
        'AdminConsoleAuthorizer',
        adminUserPool,
        { userPoolClients: [adminUserPoolClient] }
      ),
      corsPreflight: {
        allowHeaders: ['content-type', 'authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: adminAllowedOrigins,
        maxAge: cdk.Duration.hours(1),
      },
    });

    // -------------------------
    // GitHub App credentials
    //
    // The App ID, its PEM private key, and the webhook secret. Written by the
    // console at runtime — an admin pastes them once on the Microservices page —
    // and read only by the github-api function below.
    //
    // CloudFormation deliberately never carries the real value: putting a
    // private key in a template would expose it to anyone with stack read
    // access, which is the same mistake `masterPassword` already documents.
    // What the template creates is a throwaway placeholder, and the first save
    // supersedes it with a new secret version. Later deploys leave that version
    // alone, because `generateSecretString` applies at creation only.
    // -------------------------
    const githubAppSecret = new secretsmanager.Secret(this, 'GithubAppSecret', {
      secretName: `${deployment}/github-app`,
      description:
        'GitHub App credentials for the MSight console: app_id, private_key (PEM) and ' +
        'webhook_secret. Written through the console, never by CloudFormation.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'placeholder',
      },
      // The credentials can be re-pasted from the GitHub App settings page, so
      // holding a deleted stack's secret for the recovery window would block a
      // redeploy from reusing the name for nothing.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------
    // GitHub transport (outside the VPC)
    //
    // This stack runs `natGateways: 0` with its Lambdas in PRIVATE_ISOLATED
    // subnets, so the in-VPC admin function — the only one that can reach
    // Aurora — has no route to api.github.com and will not have one without
    // paying for a NAT gateway. This function is the mirror image: internet
    // access, no database, no VPC.
    //
    // It is invoked only by the in-VPC function, over the Lambda interface
    // endpoint already provisioned above, and is deliberately NOT attached to
    // any API Gateway route. Nothing outside this account can reach it, which
    // is why it carries no authorizer of its own.
    // -------------------------
    const githubApiLambda = new NodejsFunction(this, 'GithubApiLambda', {
      logGroup: new logs.LogGroup(this, 'GithubApiLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/github-api`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      ...publicLambdaProps,
      entry: path.join(__dirname, '../src/functions/github-api/handler.ts'),
      handler: 'handler',
      // Verifying a source is three GitHub calls at up to 8s each, and the
      // in-VPC caller waits on the whole thing.
      timeout: cdk.Duration.seconds(30),
      environment: {
        SERVICE_NAME: 'github-api',
        BUILD_ID: buildId,
        GITHUB_APP_SECRET_ARN: githubAppSecret.secretArn,
      },
    });

    githubAppSecret.grantRead(githubApiLambda);

    // -------------------------
    // Admin API — in-VPC half
    //
    // Valkey and Aurora are reachable only from inside the VPC, so the routes
    // that touch them run here instead of on the function above. Both sit
    // behind the same API and the same authorizer; only placement differs.
    // -------------------------
    const adminVpcApiLambda = new NodejsFunction(this, 'AdminVpcApiLambda', {
      logGroup: new logs.LogGroup(this, 'AdminVpcApiLambdaLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/admin-vpc-api`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../src/functions/admin-vpc-api/handler.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: appSubnetSelection,
      securityGroups: [lambdaSg],
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'admin-vpc-api',
        DEBUG_LOGGING: 'false',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_SECRET_ARN: cluster.secret!.secretArn,
        // Apps whose client fleets the console can inspect. Sourced from config
        // rather than discovered, so the console never scans the keyspace.
        CLIENT_APP_IDS: ((this.node.tryGetContext('clientAppIds') ?? []) as string[]).join(','),
        // Not used for caching here — the console reads Aurora directly. It is
        // how long the SDSM and SPaT consumers hold their cached app list, and
        // therefore how long a subscription change takes to take effect. The
        // Apps page states that delay rather than leaving it to be discovered.
        CONFIG_CACHE_TTL_SECONDS: configCacheTtlSeconds,
        DEPLOYMENT_NAME: deployment,
        SENSOR_RESOURCE_PREFIX: name.sensorResourcePrefix,
        SENSOR_TOPIC_ARN: sensorTopic.topicArn,
        SENSOR_CLUSTER_NAME: ecsCluster.clusterName,
        SENSOR_TASK_DEFINITION: sensorTaskTemplate.family,
        SENSOR_SUBNET_IDS: vpc.selectSubnets(appSubnetSelection).subnetIds.join(','),
        SENSOR_SECURITY_GROUP_IDS: lambdaSg.securityGroupId,
        // Where a registered storage bucket sends its upload notifications.
        CONTROL_TOPIC_ARN: controlTopic.topicArn,
        // Sensor queues, ECS services and storage buckets are all created at
        // runtime, so `cdk.Tags.of(this)` never reaches them. This function is
        // what applies the cost allocation tag to them, and without it their
        // spend — Fargate above all — is missing from the Cost page.
        COST_TAG_KEY: costAllocationTagKey,
        COST_TAG_VALUE: stackTags[costAllocationTagKey],
        // Named so the storage registry can refuse it. It is CloudFormation's,
        // holds console build output, and is emptied on stack deletion — the
        // last place sensor data should be written.
        CONSOLE_BUCKET_NAME: consoleBucket.bucketName,
        // GitHub. This function owns the routes and the tables; it reaches
        // github.com only by invoking the transport function, because its own
        // subnets have no egress.
        GITHUB_API_FUNCTION_NAME: githubApiLambda.functionName,
        GITHUB_APP_SECRET_ARN: githubAppSecret.secretArn,
        // These two go into the App manifest GitHub creates the App from, which
        // is what removes the manual registration: nobody types a setup URL or
        // a webhook URL any more. They are the same values the GithubAppSetupUrl
        // and GithubWebhookUrl outputs print, and must stay in step with them.
        CONSOLE_URL: consoleUrl,
        GITHUB_WEBHOOK_URL: `${httpApi.apiEndpoint}/v1/github/webhook`,
      },
    });

    cluster.secret!.grantRead(adminVpcApiLambda);

    // Write, because saving the App credentials is a console action. Read, so
    // the console can report whether a key is actually present rather than
    // inferring it from the database row — the two disagreeing is diagnostic.
    githubAppSecret.grantRead(adminVpcApiLambda);
    githubAppSecret.grantWrite(adminVpcApiLambda);
    githubApiLambda.grantInvoke(adminVpcApiLambda);

    // Sensor reconciliation: creates and deletes the per-sensor queue,
    // subscription, task definition and service.
    //
    // Scoped by name pattern and cluster rather than granted broadly — this is
    // a web console holding create/delete rights on real infrastructure, and
    // PassRole in particular is a privilege-escalation primitive, so it is
    // conditioned to the one task role these services may assume.
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:CreateQueue',
          'sqs:DeleteQueue',
          'sqs:TagQueue',
          // Ownership of a queue is read from its tags, not inferred from its
          // name, so listing tags is on the read path of every reconcile.
          'sqs:ListQueueTags',
          'sqs:GetQueueUrl',
          'sqs:GetQueueAttributes',
          'sqs:SetQueueAttributes',
        ],
        resources: [sensorQueueGrantScope],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // ListQueues cannot be scoped to a resource.
        actions: ['sqs:ListQueues'],
        resources: ['*'],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Subscribe', 'sns:ListSubscriptionsByTopic'],
        resources: [sensorTopic.topicArn],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // Unsubscribe takes a subscription ARN, and IAM defines no resource
        // type for it — SNS supports resource-level permissions on the topic
        // for Subscribe but not for Unsubscribe, so this cannot be narrowed.
        // Reaching a subscription still requires listing this topic first.
        actions: ['sns:Unsubscribe'],
        resources: ['*'],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // These all take a cluster parameter, which is what populates the
        // ecs:cluster condition key. TagResource does not and is granted
        // separately below.
        actions: [
          'ecs:CreateService',
          'ecs:DeleteService',
          'ecs:UpdateService',
          'ecs:DescribeServices',
          'ecs:ListServices',
        ],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': ecsCluster.clusterArn } },
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // Task definition APIs accept no resource condition.
        actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
        resources: ['*'],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // Tagging on create needs TagResource on the resource being created.
        //
        // It cannot join the cluster-conditioned statement above: TagResource's
        // only parameter is a resource ARN, so the request carries no cluster
        // and the ecs:cluster condition key is never populated — ArnEquals then
        // fails closed for services as well as task definitions. Scoping by ARN
        // is the narrowing that actually works here.
        actions: ['ecs:TagResource'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/${name.sensorResourcePrefix}-*`,
          `arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:service/${name.cluster}/${name.sensorResourcePrefix}-*`,
        ],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [sensorConsumerTaskRole.roleArn, sensorTaskTemplate.executionRole!.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      })
    );

    /**
     * Storage registry: creating buckets, adopting existing ones, and wiring
     * their upload notifications at the control topic.
     *
     * Unscoped by resource, unavoidably. Adoption means an operator names a
     * bucket that already exists — one this stack did not create and whose name
     * follows no convention we control — so there is no ARN pattern to write
     * here that would not break the feature.
     *
     * The narrowing that IS possible is by action, and it is done strictly:
     * these are bucket *configuration* rights only. There is no s3:DeleteBucket
     * (so the console cannot destroy a bucket), no s3:GetObject or
     * s3:DeleteObject (so it cannot read or remove what a sensor uploaded), and
     * no s3:PutObject. The most it can do to data is list the keys.
     */
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:CreateBucket',
          's3:GetBucketLocation',
          's3:GetBucketTagging',
          's3:PutBucketTagging',
          's3:GetBucketNotification',
          's3:PutBucketNotification',
          's3:GetBucketPublicAccessBlock',
          's3:PutBucketPublicAccessBlock',
          's3:GetEncryptionConfiguration',
          's3:PutEncryptionConfiguration',
          's3:GetBucketVersioning',
          // Covers both HeadBucket and the object listing the console shows.
          's3:ListBucket',
        ],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::*`],
      })
    );
    adminVpcApiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        // ListAllMyBuckets is account-wide and takes no resource. It backs the
        // "adopt an existing bucket" picker; without it an operator would have
        // to type bucket names from memory.
        actions: ['s3:ListAllMyBuckets'],
        resources: ['*'],
      })
    );


    // -------------------------
    // Teardown reaper
    //
    // Sensor queues, subscriptions and services are created at runtime, so
    // `cdk destroy` has no record of them. Without this they outlive the stack:
    // queues billing forever, and ECS services still attached to the cluster,
    // which makes the cluster's own deletion fail and strands the destroy.
    //
    // The custom resource below is deleted BEFORE the cluster and the topic —
    // see the DependsOn wiring further down — and its Delete converges this
    // deployment to zero sensors.
    // -------------------------
    const sensorReaperFn = new NodejsFunction(this, 'SensorReaperFunction', {
      logGroup: new logs.LogGroup(this, 'SensorReaperFunctionLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/sensor-reaper`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../src/functions/sensor-reaper/handler.ts'),
      handler: 'onEvent',
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      // Deliberately outside the VPC: during a destroy the NAT gateway and
      // subnets are themselves being deleted, and a VPC-attached function would
      // be racing its own network path to reach SQS.
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        DEPLOYMENT_NAME: deployment,
        SENSOR_RESOURCE_PREFIX: name.sensorResourcePrefix,
        SENSOR_TOPIC_ARN: sensorTopic.topicArn,
        SENSOR_CLUSTER_NAME: ecsCluster.clusterName,
      },
    });

    const sensorReaperPollFn = new NodejsFunction(this, 'SensorReaperPollFunction', {
      logGroup: new logs.LogGroup(this, 'SensorReaperPollFunctionLogGroup', {
        logGroupName: `/${name.logPrefix}/lambda/sensor-reaper-poll`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../src/functions/sensor-reaper/handler.ts'),
      handler: 'isComplete',
      memorySize: 256,
      timeout: cdk.Duration.minutes(1),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
      environment: {
        DEPLOYMENT_NAME: deployment,
        SENSOR_RESOURCE_PREFIX: name.sensorResourcePrefix,
        SENSOR_TOPIC_ARN: sensorTopic.topicArn,
        SENSOR_CLUSTER_NAME: ecsCluster.clusterName,
      },
    });

    for (const fn of [sensorReaperFn, sensorReaperPollFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'sqs:DeleteQueue',
            'sqs:GetQueueUrl',
            'sqs:GetQueueAttributes',
            'sqs:ListQueueTags',
          ],
          resources: [sensorQueueGrantScope],
        })
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          // ListQueues cannot be scoped to a resource.
          actions: ['sqs:ListQueues'],
          resources: ['*'],
        })
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sns:ListSubscriptionsByTopic'],
          resources: [sensorTopic.topicArn],
        })
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DeleteService', 'ecs:UpdateService', 'ecs:DescribeServices', 'ecs:ListServices'],
          resources: ['*'],
          conditions: { ArnEquals: { 'ecs:cluster': ecsCluster.clusterArn } },
        })
      );
    }

    // Unsubscribe takes a subscription ARN, for which IAM defines no resource
    // type — SNS supports resource-level permissions on the topic for Subscribe
    // but not for Unsubscribe, so this cannot be narrowed.
    for (const fn of [sensorReaperFn, sensorReaperPollFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sns:Unsubscribe'],
          resources: ['*'],
        })
      );
    }

    // isCompleteHandler polls until the services actually reach INACTIVE.
    // DeleteService returns immediately but leaves the service DRAINING, and
    // CloudFormation cannot delete a cluster that still holds one — reporting
    // success early would only move the failure downstream.
    const sensorReaperProvider = new cr.Provider(this, 'SensorReaperProvider', {
      onEventHandler: sensorReaperFn,
      isCompleteHandler: sensorReaperPollFn,
      queryInterval: cdk.Duration.seconds(15),
      totalTimeout: cdk.Duration.minutes(30),
      logGroup: new logs.LogGroup(this, 'SensorReaperProviderLogGroup', {
        logGroupName: `/${name.logPrefix}/sensor-reaper`,
        retention: logRetention.lambda,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const sensorReaper = new cdk.CustomResource(this, 'SensorReaper', {
      serviceToken: sensorReaperProvider.serviceToken,
      properties: {
        // Present so an operator can see which deployment a stranded resource
        // belonged to from the CloudFormation console alone.
        DeploymentName: deployment,
        SensorResourcePrefix: name.sensorResourcePrefix,
      },
    });

    // CloudFormation deletes dependents before their dependencies, so making
    // the reaper depend on these guarantees it runs while they still exist.
    sensorReaper.node.addDependency(ecsCluster);
    sensorReaper.node.addDependency(sensorTopic);
    sensorReaper.node.addDependency(sensorTaskTemplate);

    // Converge once at the end of every deploy.
    //
    // Without this a deploy that replaced the sensor queues would leave ingest
    // down until the 30-minute schedule happened to fire, or until someone
    // noticed and pressed Reconcile in the console.
    //
    // Fired asynchronously on purpose. A synchronous invoke would make the
    // deploy fail if reconciliation ran long — and reconciliation touching a
    // throttled ECS API is exactly the moment a deploy should not also break.
    // The console's drift indicator and the schedule cover a failure here.
    const sensorReconcileOnDeploy = new cr.AwsCustomResource(this, 'SensorReconcileOnDeploy', {
      onUpdate: {
        service: 'Lambda',
        action: 'Invoke',
        parameters: {
          FunctionName: adminVpcApiLambda.functionName,
          InvocationType: 'Event',
          Payload: JSON.stringify({ source: 'deploy', action: 'reconcile' }),
        },
        // Changes every deploy, so the reconcile runs every deploy rather than
        // only when some other property happens to differ.
        physicalResourceId: cr.PhysicalResourceId.of(`sensor-reconcile-${buildId}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [adminVpcApiLambda.functionArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // Reconciling before the task template exists would register a revision of
    // nothing.
    sensorReconcileOnDeploy.node.addDependency(sensorTaskTemplate);
    sensorReconcileOnDeploy.node.addDependency(ecsCluster);

    // Drift and partial failures converge on their own rather than waiting for
    // someone to notice: a create that half-succeeded is retried here.
    //
    // Five minutes rather than something longer because this is also the safety
    // net for two cases the deploy-time trigger above cannot cover. CloudFormation
    // deletes replaced resources *after* the update phase, so a deploy that
    // replaces the sensor queues runs the reconcile before they are gone; and SQS
    // refuses to recreate a queue within 60 seconds of its deletion. Both resolve
    // on the next tick, so the tick interval is the worst-case ingest gap.
    new events.Rule(this, 'SensorReconcileSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new eventsTargets.LambdaFunction(adminVpcApiLambda, {
          event: events.RuleTargetInput.fromObject({ source: 'schedule', action: 'reconcile' }),
        }),
      ],
    });


    /**
     * `scopePermissionToRoute: false` is load-bearing, not a tidy-up.
     *
     * By default this integration adds one `AWS::Lambda::Permission` per route,
     * each with that route's exact ARN. The admin API points many routes at two
     * functions — six path prefixes, each in bare and greedy form, across five
     * methods — so the default put roughly sixty statements into one function's
     * resource policy and blew Lambda's hard 20 KB policy limit, failing the
     * deploy on whichever permission happened to cross it. Nothing warns before
     * that; the limit is only enforced at CreatePermission.
     *
     * With this off, each function gets a single permission covering the whole
     * API (`apiId/*` — any stage, method and path). That is broader than
     * per-route, and deliberately acceptable here: both functions sit behind the
     * same API and the same JWT authorizer, the only principal is API Gateway,
     * and a path neither router serves still 404s. The alternative — policy size
     * growing with every page added — fails a deploy for a reason that has
     * nothing to do with the page being added.
     */
    const adminVpcIntegration = new HttpLambdaIntegration(
      'AdminVpcApiIntegration',
      adminVpcApiLambda,
      { scopePermissionToRoute: false }
    );

    // More specific than the catch-all below, so API Gateway prefers these.
    // Both the bare prefix and its children are needed — a greedy path variable
    // does not match the prefix on its own.
    //
    // The list comes from src/shared/admin-api/vpc-route-prefixes rather than
    // being written out here, because a prefix missing from it does not fail:
    // the request quietly matches the catch-all, lands on the out-of-VPC
    // function, and 404s. A test pins the list against the in-VPC router.
    for (const prefix of VPC_ROUTE_PREFIXES) {
      for (const routePath of [`/v1/admin/${prefix}`, `/v1/admin/${prefix}/{proxy+}`]) {
        adminApi.addRoutes({
          path: routePath,
          methods: [
            apigwv2.HttpMethod.GET,
            apigwv2.HttpMethod.POST,
            apigwv2.HttpMethod.PUT,
            apigwv2.HttpMethod.PATCH,
            apigwv2.HttpMethod.DELETE,
          ],
          integration: adminVpcIntegration,
        });
      }
    }

    // One greedy route: new admin operations are added in the handler's router,
    // not here.
    //
    // Methods are listed explicitly rather than using ANY, and OPTIONS is
    // deliberately absent. API Gateway answers CORS preflights itself only when
    // no route matches OPTIONS — an ANY route matches it, sends the preflight
    // through the JWT authorizer, and the browser (which never attaches
    // credentials to a preflight) gets a 401 and blocks every request. Leaving
    // OPTIONS unrouted is what lets the built-in CORS handling do its job.
    adminApi.addRoutes({
      path: '/v1/admin/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      // Same reasoning as the in-VPC integration above: one permission for the
      // whole API rather than one per method on the catch-all.
      integration: new HttpLambdaIntegration('AdminApiIntegration', adminApiLambda, {
        scopePermissionToRoute: false,
      }),
    });

    // -------------------------
    // API Gateway access logs
    //
    // Without these you can see what a Lambda did but not which requests
    // reached the API, their status codes, or their latency — the gap between
    // "the function ran fine" and "the caller got an error".
    //
    // Short retention on purpose: access logs are high-volume and useful mainly
    // while an incident is live. Set through the L1 stage because the L2 HTTP
    // API construct exposes no access-log property.
    // -------------------------
    const accessLogFormat = JSON.stringify({
      requestId: '$context.requestId',
      ip: '$context.identity.sourceIp',
      requestTime: '$context.requestTime',
      httpMethod: '$context.httpMethod',
      routeKey: '$context.routeKey',
      path: '$context.path',
      status: '$context.status',
      responseLatency: '$context.responseLatency',
      integrationStatus: '$context.integrationStatus',
      integrationErrorMessage: '$context.integrationErrorMessage',
    });

    // HTTP API stages only. The WebSocket API is deliberately absent: unlike
    // HTTP APIs, WebSocket stages require an account-level CloudWatch Logs role
    // ARN before logging can be enabled, and that setting is a per-account,
    // per-region singleton shared with every other API Gateway in this account.
    // Claiming it from this stack would change behaviour for unrelated teams,
    // so WebSocket access logs stay off until someone owns that decision.
    const apiStages: Array<{ id: string; stage: apigwv2.IStage }> = [
      { id: 'HttpApi', stage: httpApi.defaultStage! },
      { id: 'SensorHttpApi', stage: sensorHttpApi.defaultStage! },
      { id: 'AdminApi', stage: adminApi.defaultStage! },
    ];

    for (const { id, stage } of apiStages) {
      const accessLogGroup = new logs.LogGroup(this, `${id}AccessLogs`, {
        logGroupName: name.apiAccessLogGroup(id),
        retention: logRetention.api,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
      cfnStage.accessLogSettings = {
        destinationArn: accessLogGroup.logGroupArn,
        format: accessLogFormat,
      };
    }

    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: adminApi.apiEndpoint,
      description: 'Base URL for the management console API.',
    });

    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: adminUserPool.userPoolId,
      description: 'Cognito user pool backing the management console.',
    });

    new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
      value: adminUserPoolClient.userPoolClientId,
      description: 'Cognito app client ID for the management console frontend.',
    });

    new cdk.CfnOutput(this, 'AdminConsoleUrl', {
      value: consoleUrl,
      description: 'Open the management console here (populated by npm run deploy).',
    });

    new cdk.CfnOutput(this, 'AdminConsoleBucketName', {
      value: consoleBucket.bucketName,
      description: 'Bucket the built console is uploaded to. Used by deploy.js.',
    });

    new cdk.CfnOutput(this, 'AdminConsoleDistributionId', {
      value: consoleDistribution.distributionId,
      description: 'CloudFront distribution to invalidate after upload. Used by deploy.js.',
    });

    // The two values needed to register the GitHub App, which is a one-time
    // manual step on github.com. Both are derived from the console URL, and
    // getting either wrong fails at the end of the install flow rather than at
    // the start, so they are printed rather than left to be worked out.
    new cdk.CfnOutput(this, 'GithubAppSetupUrl', {
      value: `${consoleUrl}/settings/github/callback`,
      description:
        'Set this as BOTH the GitHub App\'s Setup URL and its Callback URL, with ' +
        '"Redirect on update" enabled. It points at the static console rather than the ' +
        'admin API because GitHub redirects a browser, which carries no Cognito token.',
    });

    new cdk.CfnOutput(this, 'GithubWebhookUrl', {
      value: `${httpApi.apiEndpoint}/v1/github/webhook`,
      description:
        'Where the GitHub App should send push events. Not served yet — this is the ' +
        'public API, so the receiver will authenticate by HMAC signature, not Cognito.',
    });

    new cdk.CfnOutput(this, 'GithubAppSecretName', {
      value: githubAppSecret.secretName,
      description:
        'Secrets Manager secret holding the GitHub App private key. Written by the ' +
        'console; never populated by CloudFormation.',
    });

    if (cacheDebugLambda) {
      new cdk.CfnOutput(this, 'CacheDebugLambdaName', {
        value: cacheDebugLambda.functionName,
        description: 'Present only when debugMode is enabled.',
      });

      new cdk.CfnOutput(this, 'CacheDebugInvokeExample', {
        value: `aws lambda invoke --function-name ${cacheDebugLambda.functionName} --payload '{"action":"ping"}' --cli-binary-format raw-in-base64-out /tmp/msight-cache-debug.json`,
        description: 'Invoke cache debug Lambda directly (debugMode only).',
      });
    }
  }
}