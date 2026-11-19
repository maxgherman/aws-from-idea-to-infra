import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class BookingEcrStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    if (cdk.Token.isUnresolved(this.account) || cdk.Token.isUnresolved(this.region)) {
      throw new Error('BookingEcrStack requires a concrete AWS account and Region');
    }

    const pr = String(this.node.tryGetContext('pr') ?? 'local');
    const repo = this.node.tryGetContext('repo');
    const sha = this.node.tryGetContext('sha');
    const run = this.node.tryGetContext('run');
    const isPreview = pr !== 'production';
    const cleanupPolicy = isPreview ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    this.repository = new ecr.Repository(this, 'BookingRepository', {
      repositoryName: `booking-pr-${pr}`,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      emptyOnDelete: isPreview,
      removalPolicy: cleanupPolicy,
      lifecycleRules: [
        {
          rulePriority: 1,
          description: 'Keep the 10 most recent images',
          maxImageCount: 10,
          tagStatus: ecr.TagStatus.ANY,
        },
      ],
    });

    cdk.Tags.of(this).add('managed-by', 'cdk');
    cdk.Tags.of(this).add('preview', String(isPreview));
    cdk.Tags.of(this).add('pr', pr);
    if (repo) cdk.Tags.of(this).add('repo', String(repo));
    if (sha) cdk.Tags.of(this).add('sha', String(sha));
    if (run) cdk.Tags.of(this).add('run-id', String(run));
    cdk.Tags.of(this.repository).add('resource', 'booking-ecr-repository');

    new cdk.CfnOutput(this, 'RepositoryUri', { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'RepositoryName', { value: this.repository.repositoryName });
  }
}
