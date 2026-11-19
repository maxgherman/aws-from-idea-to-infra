#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BookingEcrStack } from '../lib/booking-ecr-stack';

const app = new cdk.App();
const pr = app.node.tryGetContext('pr');
const id = pr ? `BookingEcr-PR${pr}` : 'BookingEcr';

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const env = account && region ? { account, region } : undefined;

new BookingEcrStack(app, id, { env });
