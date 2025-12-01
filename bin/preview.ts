#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Stack } from '../lib/stack';

const app = new cdk.App();
const pr = app.node.tryGetContext('pr');
const id = pr ? `Stack-PR${pr}` : 'Stack';

new Stack(app, id, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

