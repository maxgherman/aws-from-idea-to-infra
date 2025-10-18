#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DeployRoleStack } from '../lib/deploy-role-stack';
import { BudgetStack } from '../lib/budget-stack';

const app = new cdk.App();

new DeployRoleStack(app, 'DeployRoleStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

// Budgets is effectively account-global; keep the region consistent with your CLI profile.
new BudgetStack(app, 'BudgetStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

