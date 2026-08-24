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
import * as cr from 'aws-cdk-lib/custom-resources';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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
    const locationLambda = new NodejsFunction(this, 'LocationLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/location-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'location-api',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        LOCATION_TTL_SECONDS: '1800',
      },
    });

    const wsConnectLambda = new NodejsFunction(this, 'WsConnectLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-connect/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-connect',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    const wsDisconnectLambda = new NodejsFunction(this, 'WsDisconnectLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-disconnect/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-disconnect',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
      },
    });

    const radiusBroadcastLambda = new NodejsFunction(this, 'RadiusBroadcastLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/radius-broadcast-api/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'radius-broadcast-api',
        BUILD_ID: buildId,
        CACHE_HOST: cacheReplicationGroup.attrPrimaryEndPointAddress,
        CACHE_PORT: cacheReplicationGroup.attrPrimaryEndPointPort,
        CACHE_TLS_ENABLED: 'true',
        WS_SEND_TIMEOUT_MS: '10000',
      },
    });

    const wsSenderLambda = new NodejsFunction(this, 'WsSenderLambda', {
      ...publicLambdaProps,
      entry: path.join(__dirname, '../src/functions/ws-send/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'ws-send',
        BUILD_ID: buildId,
        WS_SEND_TIMEOUT_MS: '10000',
      },
    });

    const sensorLambda = new NodejsFunction(this, 'SensorLambda', {
      ...publicLambdaProps,
      entry: path.join(__dirname, '../src/functions/sensor-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'sensor-api',
        BUILD_ID: buildId,
      },
    });

    // radiusBroadcastLambda handles WS sending directly via shared ws-sender module.
    // wsSenderLambda is kept deployed for standalone use but is no longer invoked by radius-broadcast.

    // -------------------------
    // System Lambda
    // -------------------------
    const systemLambda = new NodejsFunction(this, 'SystemLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/system-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'system-api',
        BUILD_ID: buildId,
      },
    });

    // -------------------------
    // Latency Lambda
    // -------------------------
    const latencyLambda = new NodejsFunction(this, 'LatencyLambda', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/latency-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'latency-api',
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
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/maps-api/handler.ts'),
      handler: 'handler',
      environment: {
        API_VERSION: 'v1',
        SERVICE_NAME: 'maps-api',
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
        ...commonLambdaProps,
        entry: path.join(__dirname, '../src/functions/cache-debug/handler.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(20),
        environment: {
          API_VERSION: 'v1',
          SERVICE_NAME: 'cache-debug',
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
      apiName: 'msight-http-api',
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
      apiName: 'msight-sensor-http-api',
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
      apiName: 'msight-ws-api',
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
      ...commonLambdaProps,
      entry: path.join(__dirname, '../src/functions/expiration-cleanup/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        SERVICE_NAME: 'expiration-cleanup',
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
      topicName: 'msight-sensor-topic.fifo',
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
      topicName: 'msight-spat-topic',
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
    // -------------------------
    const controlTopic = new sns.Topic(this, 'MsightControlTopic', {
      topicName: 'msight-control-topic',
      displayName: 'MSight Control Channel',
    });

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

    const pyV2XLayer = new lambda.LayerVersion(this, 'PyV2XLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../.layer-build/pyv2x')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'pyv2xlib + pycrate + psycopg2 + redis — V2X ASN.1 decoding, PostgreSQL, and Valkey access',
    });

    // -------------------------
    // Sensor list — sourced from deploy.config.yaml via CDK context
    // -------------------------
    const sensorNameList: string[] = this.node.tryGetContext('sensors') ?? [];
    const spatBroadcastRadiusM: number = this.node.tryGetContext('spatBroadcastRadiusM') ?? 500;

    // -------------------------
    // ECS Cluster + sensor consumer services
    // -------------------------
    const ecsCluster = new ecs.Cluster(this, 'MsightEcsCluster', {
      vpc,
      clusterName: 'msight-cluster',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Task role — permissions for the running container (SQS, Secrets Manager, WS management)
    const sensorConsumerTaskRole = new iam.Role(this, 'SensorConsumerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: 'msight-sensor-consumer-task-role',
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

    // One SQS FIFO queue + SNS subscription + ECS Fargate service per sensor.
    // NOTE: the publisher must include sensor_name as a SNS MessageAttribute for filtering to work.
    for (const sensorName of sensorNameList) {
      const safeName = sensorName.replace(/_/g, '-').toLowerCase();

      const sensorQueue = new sqs.Queue(this, `SensorQueue-${sensorName}`, {
        queueName: `msight-sensor-${safeName}.fifo`,
        fifo: true,
        contentBasedDeduplication: true,
        visibilityTimeout: cdk.Duration.seconds(60),
        deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
        fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      });

      sensorTopic.addSubscription(
        new snsSubscriptions.SqsSubscription(sensorQueue, {
          rawMessageDelivery: true,
          filterPolicy: {
            sensor_name: sns.SubscriptionFilter.stringFilter({ allowlist: [sensorName] }),
          },
        })
      );

      // Grant the ECS task role permission to consume this queue
      sensorQueue.grantConsumeMessages(sensorConsumerTaskRole);

      const taskDef = new ecs.FargateTaskDefinition(this, `SensorConsumerTaskDef-${sensorName}`, {
        memoryLimitMiB: 2048,
        cpu: 1024,
        taskRole: sensorConsumerTaskRole,
      });

      taskDef.addContainer('consumer', {
        image: sensorConsumerImage,
        environment: {
          SENSOR_NAME: sensorName,
          QUEUE_URL: sensorQueue.queueUrl,
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
          logGroup: new logs.LogGroup(this, `SensorConsumerLogGroup-${sensorName}`, {
            logGroupName: `/msight/sensor-consumer/${sensorName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        }),
      });

      new ecs.FargateService(this, `SensorConsumerService-${sensorName}`, {
        cluster: ecsCluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        vpcSubnets: appSubnetSelection,
        securityGroups: [lambdaSg],
        assignPublicIp: false,
        circuitBreaker: { rollback: true },
        enableExecuteCommand: true,
      });
    }

    // -------------------------
    // SPaT SNS consumer Lambda (Python)
    // -------------------------
    const spatSnsConsumerLambda = new lambda.Function(this, 'SpatSnsConsumerLambda', {
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

    const adminAllowedOrigins = adminConsoleConfig.allowedOrigins ?? [
      'http://localhost:5173',
    ];

    const adminUserPool = new cognito.UserPool(this, 'MsightAdminUserPool', {
      userPoolName: 'msight-admin-pool',
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
        retention: logs.RetentionDays.ONE_WEEK,
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
        BUILD_ID: buildId,
        USER_POOL_ID: adminUserPool.userPoolId,
        USER_POOL_CLIENT_ID: adminUserPoolClient.userPoolClientId,
        HTTP_API_URL: httpApi.apiEndpoint,
        SENSOR_HTTP_API_URL: sensorHttpApi.apiEndpoint,
        WS_API_URL: wsApiUrl,
        SENSOR_TOPIC_ARN: sensorTopic.topicArn,
        SPAT_TOPIC_ARN: spatTopic.topicArn,
        CONTROL_TOPIC_ARN: controlTopic.topicArn,
        SENSOR_NAMES: sensorNameList.join(','),
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

    const adminApi = new apigwv2.HttpApi(this, 'MsightAdminApi', {
      apiName: 'msight-admin-api',
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
      integration: new HttpLambdaIntegration('AdminApiIntegration', adminApiLambda),
    });

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