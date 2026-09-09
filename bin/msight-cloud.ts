#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { MsightCloudStack } from '../lib/msight-cloud-stack';

const configPath = path.join(__dirname, '../deploy.config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error(
    'deploy.config.yaml not found. Copy deploy.config.example.yaml to deploy.config.yaml and fill in your values.'
  );
}

const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

const app = new cdk.App({
  context: {
    debugMode:            config['debugMode']            ?? false,
    preferredAz:          config['preferredAz']          ?? '',
    spatBroadcastRadiusM: config['spatBroadcastRadiusM'] ?? 500,
    adminConsole:         config['adminConsole']         ?? {},
    tags:                 config['tags']                 ?? {},
    costAllocationTagKey: config['costAllocationTagKey'] ?? 'Project',
    clientAppIds:         config['clientAppIds']         ?? [],
    deploymentName:       config['deploymentName']       ?? 'msight-cloud',
    resourceNames:        config['resourceNames']        ?? {},
    logRetentionDays:     config['logRetentionDays']     ?? {},
    configCacheTtlSeconds: config['configCacheTtlSeconds'] ?? 60,
  },
});

new MsightCloudStack(app, 'MsightCloudStack', {
  env: {
    account: String(config['account'] ?? process.env.CDK_DEFAULT_ACCOUNT ?? ''),
    region:  String(config['region']  ?? process.env.CDK_DEFAULT_REGION  ?? ''),
  },
});