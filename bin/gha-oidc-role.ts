#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GithubOidcRoleStack } from '../lib/gha-oidc-role-stack';

const app = new cdk.App();
new GithubOidcRoleStack(app, 'GithubOidcRoleStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

