import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AuthStack } from '../lib/auth-stack';
import { Stack as PreviewStack } from '../lib/stack';
import { hasExpectedSignature, validateWorkflowInput } from '../lambda/validate-asset/index';
import { parseAssetRecords } from '../lambda/workflow-starter/index';

const assetId = '307d0b55-05d1-4c0f-a0fb-4c3e1083e3df';
const sourceKey = `uploads/originals/${assetId}.png`;

test('parses an S3 notification into deterministic workflow input', () => {
  const body = JSON.stringify({
    Records: [{ s3: { object: { key: encodeURIComponent(sourceKey) } } }],
  });
  assert.deepEqual(parseAssetRecords(body), [{ assetId, sourceKey }]);
});

test('rejects a notification outside the upload prefix', () => {
  const body = JSON.stringify({
    Records: [{ s3: { object: { key: `processed/assets/${assetId}.png` } } }],
  });
  assert.throws(() => parseAssetRecords(body), /Unexpected object key/);
});

test('validates workflow identity and image signatures', () => {
  assert.deepEqual(validateWorkflowInput({ assetId, sourceKey }), { assetId, sourceKey });
  assert.throws(
    () => validateWorkflowInput({ assetId: 'another-id', sourceKey }),
    /does not identify one uploaded asset/,
  );
  assert.equal(
    hasExpectedSignature(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
    ),
    true,
  );
  assert.equal(hasExpectedSignature(Uint8Array.from([0xff, 0xd8, 0xff]), 'image/jpeg'), true);
  assert.equal(hasExpectedSignature(Uint8Array.from([0x00, 0x00, 0x00]), 'image/jpeg'), false);
});

test('keeps the user pool shared and the app client preview-scoped', () => {
  const app = new App({ context: { pr: '123', acct: '111111111111', reg: 'us-east-1' } });
  const env = { account: '111111111111', region: 'us-east-1' };
  const authStack = new AuthStack(app, 'AuthTest', { env });
  const previewStack = new PreviewStack(app, 'PreviewTest', { env });
  const auth = Template.fromStack(authStack);
  const preview = Template.fromStack(previewStack);

  auth.resourceCountIs('AWS::Cognito::UserPool', 1);
  const pools = auth.findResources('AWS::Cognito::UserPool');
  assert.equal(Object.values(pools)[0].DeletionPolicy, 'Retain');
  preview.resourceCountIs('AWS::Cognito::UserPool', 0);
  preview.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  preview.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    UserPoolId: { 'Fn::ImportValue': 'AssetSeriesUserPoolId' },
  });
});

test('provisions a Standard workflow and an SQS starter', () => {
  const app = new App({ context: { pr: '123', acct: '111111111111', reg: 'us-east-1' } });
  const preview = Template.fromStack(new PreviewStack(app, 'WorkflowTest', {
    env: { account: '111111111111', region: 'us-east-1' },
  }));

  preview.hasResourceProperties('AWS::StepFunctions::StateMachine', {
    StateMachineType: 'STANDARD',
    DefinitionString: Match.anyValue(),
    LoggingConfiguration: Match.objectLike({ Level: 'ERROR' }),
  });
  preview.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 5,
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });
});
