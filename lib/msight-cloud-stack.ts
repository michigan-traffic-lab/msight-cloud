import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as rds from 'aws-cdk-lib/aws-rds';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

export class MsightCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const buildId = computeBuildId();
    const preferredAz = this.node.tryGetContext('preferredAz');
    const appSubnetType = ec2.SubnetType.PRIVATE_ISOLATED;
    const hasPreferredAz = typeof preferredAz === 'string' && preferredAz.length > 0;
    const appSubnetSelection: ec2.SubnetSelection =
      hasPreferredAz
        ? { subnetType: appSubnetType, availabilityZones: [preferredAz] }
        : { subnetType: appSubnetType };
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

    // Lambda -> Proxy
    proxySg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Lambda to Proxy');

    // Lambda -> ElastiCache
    cacheSg.addIngressRule(lambdaSg, ec2.Port.tcp(6379), 'Lambda to ElastiCache');

    // Proxy -> DB
    dbSg.addIngressRule(proxySg, ec2.Port.tcp(5432), 'Proxy to Aurora');

    const preferredAppSubnetSelection: ec2.SubnetSelection = hasPreferredAz
      ? { subnetGroupName: 'app', availabilityZones: [preferredAz] }
      : { subnetGroupName: 'app' };
    const appSubnets = vpc.selectSubnets({ subnetGroupName: 'app' });
    const preferredAppSubnets = vpc.selectSubnets(preferredAppSubnetSelection);
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
      securityGroups: [lambdaSg],
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
        DB_HOST: proxy.endpoint,
        DB_PORT: '5432',
        DB_NAME: 'msight',
        DB_USER: 'msight_admin',
        DB_SECRET_ARN: cluster.secret!.secretArn,
      },
    });

    cluster.secret!.grantRead(locationLambda);

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
      path: '/v1/client/latency',
      methods: [apigwv2.HttpMethod.GET],
      integration: latencyIntegration,
    });

    // -------------------------
    // Outputs
    // -------------------------
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.apiEndpoint,
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
  }
}