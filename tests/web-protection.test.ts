import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Stack as PreviewStack } from '../lib/stack';
import { handler as getAsset } from '../lambda/get-asset/index';
import { handler as createUpload } from '../lambda/create-upload/index';
import { handler as createDelivery } from '../lambda/create-delivery/index';

for (const region of ['us-east-1', 'ap-southeast-2']) {
  test(`protects both public endpoints when the application is in ${region}`, () => {
    const app = new App({ context: { pr: '123', '@aws-cdk/core:validateAgainstDefaultRules': true } });
    const stack = new PreviewStack(app, 'ProtectedPreview', {
      env: { account: '111111111111', region },
    });
    const template = Template.fromStack(stack);
    const edgeStack = app.node.findChild('ProtectedPreview-Edge') as import('aws-cdk-lib').Stack;
    assert.equal(edgeStack.region, 'us-east-1');
    const edge = Template.fromStack(edgeStack);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'preview',
      MethodSettings: [Match.objectLike({ DataTraceEnabled: false, MetricsEnabled: true,
        ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 })],
    });
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      IdentityValidationExpression: { 'Fn::Join': ['', ['^', Match.anyValue(), '$']] },
    });
    const methods: any[] = Object.values(template.findResources('AWS::ApiGateway::Method'));
    assert.equal(methods.filter(m => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS').length, 3);
    assert.ok(methods.filter(m => m.Properties.HttpMethod === 'OPTIONS')
      .every(m => m.Properties.AuthorizationType === 'NONE'));
    template.resourceCountIs('AWS::ApiGateway::GatewayResponse', 2);
    const association: any = Object.values(template.findResources('AWS::WAFv2::WebACLAssociation'))[0];
    assert.match(JSON.stringify(association.Properties.ResourceArn), /\/restapis\/.*\/stages\//);
    assert.ok(association.DependsOn.some((id: string) => id.includes('DeploymentStage')));
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
    const distribution: any = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    assert.ok(!distribution.Properties.DistributionConfig.CustomErrorResponses?.some((r: any) => r.ErrorCode === 403 && r.ResponseCode === 200));
    for (const [policy, scope] of [[template, 'REGIONAL'], [edge, 'CLOUDFRONT']] as const) {
      const acl: any = Object.values(policy.findResources('AWS::WAFv2::WebACL'))[0];
      assert.equal(acl.Properties.Scope, scope);
      assert.match(acl.Properties.VisibilityConfig.MetricName, /ProtectedPreview/);
      assert.deepEqual(acl.Properties.DefaultAction, { Allow: {} });
      assert.deepEqual(acl.Properties.Rules[0].Statement.RateBasedStatement, {
        AggregateKeyType: 'IP', Limit: 2000, EvaluationWindowSec: 300,
      });
      assert.deepEqual(acl.Properties.Rules[0].Action, { Block: {} });
      assert.deepEqual(acl.Properties.Rules.slice(1).map((r: any) => r.Statement.ManagedRuleGroupStatement.Name),
        ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet']);
      assert.ok(acl.Properties.Rules.every((r: any) => r.VisibilityConfig.SampledRequestsEnabled === false));
      assert.equal(acl.Properties.VisibilityConfig.SampledRequestsEnabled, false);
      const privacy = acl.Properties.DataProtectionConfig.DataProtections;
      assert.ok(privacy.some((item: any) => item.Field.FieldType === 'BODY' && item.ExcludeRuleMatchDetails));
      assert.ok(privacy.some((item: any) => item.Field.FieldType === 'QUERY_STRING'));
      assert.ok(privacy.some((item: any) => item.Field.FieldKeys?.includes('authorization')));
      policy.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
        RedactedFields: [{ SingleHeader: { Name: 'authorization' } }, { SingleHeader: { Name: 'cookie' } }, { QueryString: {} }],
        LoggingFilter: { DefaultBehavior: 'DROP', Filters: [{ Behavior: 'KEEP', Requirement: 'MEETS_ANY',
          Conditions: [{ ActionCondition: { Action: 'BLOCK' } }, { ActionCondition: { Action: 'COUNT' } }] }] },
      });
      const log: any = Object.values(policy.findResources('AWS::Logs::LogGroup'))
        .find((r: any) => r.Properties.LogGroupName?.startsWith('aws-waf-logs-'));
      assert.equal(log.Properties.RetentionInDays, 7);
      assert.equal(log.DeletionPolicy, 'Delete');
    }
    // Cross-region synthesis exercises the export writer/reader dependency graph.
    const assembly = app.synth();
    assert.ok(assembly.getStackArtifact(stack.artifactId).dependencies
      .some(dependency => dependency.id === edgeStack.artifactId));
  });
}

test('REST claims preserve ownership checks and CORS without falling back to HTTP API claims', async (t) => {
  process.env.ASSETS_TABLE_NAME = 'test-assets';
  process.env.ALLOWED_ORIGIN = 'https://preview.cloudfront.net';
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({
    Item: { assetId: 'asset-1', ownerId: 'owner-1', status: 'ready', analysis: { labels: [] } },
  }));
  const request = (sub: string) => ({ pathParameters: { assetId: 'asset-1' },
    requestContext: { authorizer: { claims: { sub } } } });
  const own = await getAsset(request('owner-1'));
  assert.equal(own.statusCode, 200);
  assert.equal(own.headers['access-control-allow-origin'], process.env.ALLOWED_ORIGIN);
  assert.equal((await getAsset(request('owner-2'))).statusCode, 404);
  const deniedDelivery = await createDelivery(request('owner-2'));
  assert.equal(deniedDelivery.statusCode, 404);
  assert.equal(deniedDelivery.headers['access-control-allow-origin'], process.env.ALLOWED_ORIGIN);
  assert.equal((await createUpload({ ...request('owner-1'), body: '{' })).statusCode, 400);
  for (const handler of [getAsset, createUpload, createDelivery]) {
    const response = await handler({ pathParameters: { assetId: 'asset-1' },
      requestContext: { authorizer: { jwt: { claims: { sub: 'owner-1' } } } } });
    assert.ok(response.statusCode >= 400);
  }
});
