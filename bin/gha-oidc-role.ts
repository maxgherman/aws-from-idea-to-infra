#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GithubOidcRoleStack } from '../lib/gha-oidc-role-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const env = account && region ? { account, region } : undefined;

new GithubOidcRoleStack(app, 'GithubOidcRoleStack', { env });
