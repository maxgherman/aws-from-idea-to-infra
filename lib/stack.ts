import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Tags } from 'aws-cdk-lib';

export class Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pr = String(this.node.tryGetContext('pr') ?? 'local');
    const repo = this.node.tryGetContext('repo');
    const sha = this.node.tryGetContext('sha');
    const run = this.node.tryGetContext('run');
    const acct = this.node.tryGetContext('acct');
    const reg = this.node.tryGetContext('reg');

    const bucketProps: s3.BucketProps = {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      ...(acct && reg
        ? {
            bucketName: `pr-${String(pr)}-${String(acct)}-${String(reg)}`
              .toLowerCase()
              .replace(/[^a-z0-9.-]/g, '')
              .slice(0, 63)
              .replace(/[.-]+$/g, ''),
          }
        : {}),
    };

    const bucket = new s3.Bucket(this, 'SiteBucket', bucketProps);

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset('site')],
      distribution,
      distributionPaths: ['/*'],
    });

    const hello = new lambda.Function(this, 'HelloFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/hello'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        PR_NUMBER: pr,
      },
    });

    const api = new apigwv2.HttpApi(this, 'PreviewApi', {
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowOrigins: ['*'],
      },
    });

    api.addRoutes({
      path: '/hello',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HelloIntegration', hello),
    });

    Tags.of(this).add('managed-by', 'cdk');
    Tags.of(this).add('preview', 'true');
    Tags.of(this).add('pr', pr);
    if (repo) Tags.of(this).add('repo', String(repo));
    if (sha) Tags.of(this).add('sha', String(sha));
    if (run) Tags.of(this).add('run-id', String(run));
    Tags.of(bucket).add('resource', 'preview-bucket');
    Tags.of(hello).add('resource', 'preview-api-function');

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'PreviewUrl', {
      value: `https://${distribution.domainName}/?pr=${encodeURIComponent(pr)}`,
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.url}hello` });
  }
}
