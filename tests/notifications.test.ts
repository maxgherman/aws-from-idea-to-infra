import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Stack as PreviewStack } from '../lib/stack';

const env = { account: '111111111111', region: 'us-east-1' };

test('fans terminal lifecycle events out to durable and filtered subscribers', () => {
  const app = new App({
    context: {
      pr: '123',
      acct: env.account,
      reg: env.region,
      notificationEmail: 'operator@example.com',
    },
  });
  const preview = Template.fromStack(new PreviewStack(app, 'NotificationsTest', { env }));

  preview.resourceCountIs('AWS::SNS::Topic', 1);
  preview.hasResourceProperties('AWS::SNS::Topic', {
    DisplayName: 'Asset lifecycle notifications',
    KmsMasterKeyId: Match.anyValue(),
  });
  preview.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
    KeyPolicy: {
      Statement: Match.arrayWith([Match.objectLike({
        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
        Effect: 'Allow',
        Principal: { Service: 'events.amazonaws.com' },
        Resource: '*',
      })]),
    },
  });

  preview.hasResourceProperties('AWS::Events::Rule', {
    Description: 'Fan out terminal asset events to notification subscribers',
    EventPattern: {
      source: ['com.example.assets'],
      'detail-type': ['Asset State Changed'],
      detail: { status: ['ready', 'rejected', 'failed'] },
    },
    State: 'ENABLED',
    Targets: [Match.objectLike({
      Arn: Match.anyValue(),
      DeadLetterConfig: { Arn: Match.anyValue() },
      RetryPolicy: {
        MaximumEventAgeInSeconds: 86400,
        MaximumRetryAttempts: 185,
      },
    })],
  });

  preview.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'sqs',
    RawMessageDelivery: true,
    RedrivePolicy: { deadLetterTargetArn: Match.anyValue() },
  });
  preview.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email-json',
    Endpoint: 'operator@example.com',
    FilterPolicyScope: 'MessageBody',
    FilterPolicy: {
      detail: { status: ['rejected', 'failed'] },
    },
    RedrivePolicy: { deadLetterTargetArn: Match.anyValue() },
  });

  const outputs = preview.toJSON().Outputs;
  for (const output of [
    'AssetNotificationTopicArn',
    'AssetNotificationIntegrationQueueName',
    'AssetNotificationRuleDeadLetterQueueName',
    'AssetNotificationSqsDeadLetterQueueName',
    'AssetNotificationEmailDeadLetterQueueName',
  ]) {
    assert.ok(outputs[output], `missing ${output} stack output`);
  }
});

test('keeps operator email delivery opt-in', () => {
  const app = new App({
    context: { pr: '123', acct: env.account, reg: env.region },
  });
  const preview = Template.fromStack(new PreviewStack(app, 'NotificationsWithoutEmailTest', {
    env,
  }));

  preview.resourceCountIs('AWS::SNS::Subscription', 1);
  assert.equal(
    preview.toJSON().Outputs.AssetNotificationEmailDeadLetterQueueName,
    undefined,
  );
});
