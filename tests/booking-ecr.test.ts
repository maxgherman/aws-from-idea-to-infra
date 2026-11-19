import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BookingEcrStack } from '../lib/booking-ecr-stack';

test('provisions an immutable, scanned ECR repository with a 10-image lifecycle rule', () => {
  const app = new App({ context: { pr: '123' } });
  const stack = new BookingEcrStack(app, 'BookingEcr-PR123', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::ECR::Repository', 1);

  template.hasResourceProperties('AWS::ECR::Repository', {
    ImageTagMutability: 'IMMUTABLE',
    ImageScanningConfiguration: { ScanOnPush: true },
    RepositoryName: 'booking-pr-123',
  });

  // Lifecycle rule retains the 10 most recent images.
  const repos: Record<string, any> = template.findResources('AWS::ECR::Repository');
  const repo = Object.values(repos)[0];
  const rules = repo.Properties.LifecyclePolicy.LifecyclePolicyText;
  const policy = JSON.parse(rules);
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].rulePriority, 1);
  assert.equal(policy.rules[0].selection.countType, 'imageCountMoreThan');
  assert.equal(policy.rules[0].selection.countNumber, 10);

  // Preview repositories are destroyed on stack deletion.
  assert.equal(repo.DeletionPolicy, 'Delete');
  assert.equal(repo.UpdateReplacePolicy, 'Delete');

  // Both outputs are present.
  template.hasOutput('RepositoryUri', {});
  template.hasOutput('RepositoryName', {});
});

test('retains the ECR repository when pr context is production', () => {
  const app = new App({ context: { pr: 'production' } });
  const stack = new BookingEcrStack(app, 'BookingEcr', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);
  const repos: Record<string, any> = template.findResources('AWS::ECR::Repository');
  const repo = Object.values(repos)[0];
  assert.equal(repo.DeletionPolicy, 'Retain');
  assert.equal(repo.UpdateReplacePolicy, 'Retain');
});

test('throws if the stack is synthesized without a concrete account and region', () => {
  const app = new App({ context: { pr: '99' } });
  assert.throws(
    () => new BookingEcrStack(app, 'BookingEcr-PR99', { env: undefined }),
    /concrete AWS account and Region/,
  );
});
