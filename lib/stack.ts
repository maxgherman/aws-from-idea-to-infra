import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Tags } from 'aws-cdk-lib';

export class Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pr = String(this.node.tryGetContext('pr') ?? 'local');
    const repo = this.node.tryGetContext('repo');
    const sha = this.node.tryGetContext('sha');
    const run = this.node.tryGetContext('run');

    const bucket = new s3.Bucket(this, 'PreviewBucket', {
      bucketName: `pr-${pr}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`.toLowerCase(),
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Tag all resources in this stack for audits/cleanup
    Tags.of(this).add('managed-by', 'cdk');
    Tags.of(this).add('preview', 'true');
    Tags.of(this).add('pr', pr);
    if (repo) Tags.of(this).add('repo', String(repo));
    if (sha)  Tags.of(this).add('sha', String(sha));
    if (run)  Tags.of(this).add('run-id', String(run));
    Tags.of(bucket).add('resource', 'preview-bucket');

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}

