import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Stack as PreviewStack } from '../lib/stack';
import { summarizeAnalysis } from '../lambda/complete-asset/index';
import { handler as getAsset } from '../lambda/get-asset/index';

test('keeps a bounded label summary and accepts an empty detection', () => {
  const result = summarizeAnalysis({
    modelVersion: 'test-model',
    labels: [{ Name: 'Tree', Confidence: 98.2, Instances: [{ secret: 'unused' }] }],
  });
  assert.deepEqual(result.labels, [{ name: 'Tree', confidence: 98.2 }]);
  assert.equal(result.modelVersion, 'test-model');
  assert.equal(result.minConfidence, 80);
  assert.ok(Number.isFinite(Date.parse(result.analyzedAt)));
  assert.deepEqual(summarizeAnalysis({ modelVersion: 'test', labels: [] }).labels, []);
  assert.equal(summarizeAnalysis({
    modelVersion: 'test', labels: Array(20).fill({ Name: 'Tree', Confidence: 90 }),
  }).labels.length, 10);
  assert.throws(() => summarizeAnalysis(undefined), /missing/);
  assert.throws(() => summarizeAnalysis({
    modelVersion: 'test', labels: [{ Name: 'Tree', Confidence: NaN }],
  }), /Invalid/);
});

test('exposes analysis only to the owner of a ready asset', async (t) => {
  process.env.ALLOWED_ORIGIN = 'https://preview.cloudfront.net';
  process.env.ASSETS_TABLE_NAME = 'test-assets';
  const asset = { assetId: 'asset-1', ownerId: 'owner-1', status: 'ready', analysis: { labels: [] } };
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({ Item: asset }));
  const request = (sub: string) => ({
    pathParameters: { assetId: 'asset-1' },
    requestContext: { authorizer: { claims: { sub } } },
  });
  assert.equal((await getAsset(request('owner-2'))).statusCode, 404);
  const response = await getAsset(request('owner-1'));
  assert.deepEqual(JSON.parse(response.body).asset.analysis, { labels: [] });
  asset.status = 'processing';
  assert.equal(JSON.parse((await getAsset(request('owner-1'))).body).asset.analysis, undefined);
});

test('analyzes one private output version before ready, with separate rejection and failure paths', () => {
  const app = new App({ context: { pr: '123' } });
  const template = Template.fromStack(new PreviewStack(app, 'RekognitionTest', {
    env: { account: '111111111111', region: 'us-east-1' },
  }));
  const machine: any = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = machine.Properties.DefinitionString;
  const asl = JSON.parse(typeof definition === 'string' ? definition
    : definition['Fn::Join'][1].map((part: unknown) => typeof part === 'string' ? part : 'TOKEN').join(''));
  const task = asl.States['Analyze image labels'];
  assert.match(task.Resource, /aws-sdk:rekognition:detectLabels$/);
  assert.deepEqual(task.Parameters.Features, ['GENERAL_LABELS']);
  assert.equal(task.Parameters.MaxLabels, 10);
  assert.equal(task.Parameters.MinConfidence, 80);
  assert.equal(task.Parameters.Image.S3Object['Name.$'], '$.outputKey');
  assert.equal(task.Parameters.Image.S3Object['Version.$'], '$.outputVersion');
  assert.equal(task.ResultPath, '$.analysis');
  assert.equal(task.TimeoutSeconds, 30);
  assert.equal(asl.States['Transform asset'].Next, 'Analyze image labels');
  assert.equal(task.Next, 'Mark asset ready');
  assert.equal(task.Retry[0].JitterStrategy, 'FULL');
  assert.equal(task.Retry[0].MaxAttempts, 3);
  assert.ok(task.Retry[0].ErrorEquals.includes('Rekognition.ThrottlingException'));
  assert.equal(task.Catch[0].Next, 'Explain unsupported image');
  assert.equal(task.Catch[1].Next, 'Record processing failure');
  assert.equal(asl.States['Explain unsupported image'].Next, 'Reject invalid asset');

  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));
  const caller = policies.find((p) => JSON.stringify(p).includes('rekognition:DetectLabels'));
  assert.ok(caller);
  assert.match(JSON.stringify(caller.Properties.Roles), /AssetWorkflowRole/);
  const statements = caller.Properties.PolicyDocument.Statement;
  assert.ok(statements.some((s: any) => s.Action === 'rekognition:DetectLabels' && s.Resource === '*'));
  const read = statements.find((s: any) => s.Action === 's3:GetObjectVersion');
  assert.match(JSON.stringify(read.Resource), /processed\/assets\/\*/);
  assert.doesNotMatch(JSON.stringify(read.Resource), /uploads\/originals/);
});
