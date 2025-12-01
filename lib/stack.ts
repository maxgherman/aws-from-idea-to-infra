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
    // Optional contexts passed by CI to make bucket name concrete (no tokens)
    const acct = this.node.tryGetContext('acct');
    const reg  = this.node.tryGetContext('reg');

    // Build props and only set an explicit name when we have concrete values
    const bucketProps: s3.BucketProps = {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    };

    if (acct && reg) {
      const name = `pr-${String(pr)}-${String(acct)}-${String(reg)}`
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '')
        .slice(0, 63)
        .replace(/[.-]+$/g, '');
      if (name.length >= 3) {
        (bucketProps as any).bucketName = name;
      }
    }

    const bucket = new s3.Bucket(this, 'PreviewBucket', bucketProps);

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
