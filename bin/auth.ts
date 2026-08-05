#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

if (!account || !region) {
  throw new Error('CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are required');
}

new AuthStack(app, 'AssetSeriesAuth', {
  env: { account, region },
  description: 'Long-lived authentication shared by AWS from idea to infra previews',
});
