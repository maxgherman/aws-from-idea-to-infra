#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Stack } from '../lib/stack';

const app = new cdk.App();
const pr = app.node.tryGetContext('pr');
const id = pr ? `Stack-PR${pr}` : 'Stack';

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const env = account && region ? { account, region } : undefined;

new Stack(app, id, { env });
