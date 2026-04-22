import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
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

    const deadLetterQueue = new sqs.Queue(this, 'JobsDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const jobsQueue = new sqs.Queue(this, 'JobsQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    const submitJob = new lambda.Function(this, 'SubmitJobFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/submit-job'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        PR_NUMBER: pr,
        QUEUE_URL: jobsQueue.queueUrl,
      },
    });

    jobsQueue.grantSendMessages(submitJob);

    const worker = new lambda.Function(this, 'WorkerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/worker'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PR_NUMBER: pr,
      },
    });

    worker.addEventSource(
      new eventsources.SqsEventSource(jobsQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    const api = new apigwv2.HttpApi(this, 'PreviewApi', {
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowOrigins: ['*'],
      },
    });

    api.addRoutes({
      path: '/hello',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HelloIntegration', hello),
    });

    api.addRoutes({
      path: '/jobs',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SubmitJobIntegration', submitJob),
    });

    Tags.of(this).add('managed-by', 'cdk');
    Tags.of(this).add('preview', 'true');
    Tags.of(this).add('pr', pr);
    if (repo) Tags.of(this).add('repo', String(repo));
    if (sha) Tags.of(this).add('sha', String(sha));
    if (run) Tags.of(this).add('run-id', String(run));
    Tags.of(bucket).add('resource', 'preview-bucket');
    Tags.of(hello).add('resource', 'preview-api-function');
    Tags.of(submitJob).add('resource', 'preview-job-submit-function');
    Tags.of(worker).add('resource', 'preview-worker-function');
    Tags.of(jobsQueue).add('resource', 'preview-jobs-queue');
    Tags.of(deadLetterQueue).add('resource', 'preview-jobs-dlq');

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'PreviewUrl', {
      value: `https://${distribution.domainName}/?pr=${encodeURIComponent(pr)}`,
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.url}hello` });
    new cdk.CfnOutput(this, 'JobUrl', { value: `${api.url}jobs` });
    new cdk.CfnOutput(this, 'JobsQueueName', { value: jobsQueue.queueName });
    new cdk.CfnOutput(this, 'JobsDeadLetterQueueName', { value: deadLetterQueue.queueName });
  }
}
