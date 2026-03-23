#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MsightCloudStack } from '../lib/msight-cloud-stack';

const app = new cdk.App();

new MsightCloudStack(app, 'MsightCloudStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});