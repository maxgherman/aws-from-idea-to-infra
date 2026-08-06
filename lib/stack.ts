import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { join } from 'node:path';
import { authExports } from './auth-stack';

export class Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pr = String(this.node.tryGetContext('pr') ?? 'local');
    const repo = this.node.tryGetContext('repo');
    const sha = this.node.tryGetContext('sha');
    const run = this.node.tryGetContext('run');
    const acct = this.node.tryGetContext('acct');
    const reg = this.node.tryGetContext('reg');
    const isPreview = pr !== 'production';
    const cleanupPolicy = isPreview ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const lambdaEntry = (name: string) => join(process.cwd(), 'lambda', name, 'index.ts');

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      autoDeleteObjects: isPreview,
      removalPolicy: cleanupPolicy,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      ...(acct && reg
        ? {
            bucketName: `pr-${pr}-${String(acct)}-${String(reg)}`
              .toLowerCase()
              .replace(/[^a-z0-9.-]/g, '')
              .slice(0, 63)
              .replace(/[.-]+$/g, ''),
          }
        : {}),
    });

    const assetBucket = new s3.Bucket(this, 'AssetBucket', {
      autoDeleteObjects: isPreview,
      removalPolicy: cleanupPolicy,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [{
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        noncurrentVersionExpiration: cdk.Duration.days(30),
      }],
      cors: [{
        allowedOrigins: ['https://*.cloudfront.net'],
        allowedMethods: [s3.HttpMethods.POST],
        allowedHeaders: ['content-type'],
        exposedHeaders: ['etag'],
        maxAge: 300,
      }],
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset('site')],
      distribution,
      distributionPaths: ['/*'],
    });

    const assets = new dynamodb.Table(this, 'AssetsTable', {
      partitionKey: { name: 'assetId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: !isPreview,
      },
      removalPolicy: cleanupPolicy,
    });

    const users = cognito.UserPool.fromUserPoolId(
      this,
      'SharedUsers',
      cdk.Fn.importValue(authExports.userPoolId),
    );
    const hostedUiUrl = cdk.Fn.importValue(authExports.hostedUiUrl);

    const webClient = users.addClient('WebClient', {
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://${distribution.domainName}/`],
        logoutUrls: [`https://${distribution.domainName}/`],
        defaultRedirectUri: `https://${distribution.domainName}/`,
      },
      preventUserExistenceErrors: true,
    });

    const userAuthorizer = new authorizers.HttpUserPoolAuthorizer(
      'UserAuthorizer',
      users,
      { userPoolClients: [webClient] },
    );

    const deadLetterQueue = new sqs.Queue(this, 'AssetsDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const assetsQueue = new sqs.Queue(this, 'AssetsQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    const hello = new lambda.Function(this, 'HelloFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/hello'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: { PR_NUMBER: pr },
    });

    const createUpload = new lambdaNodejs.NodejsFunction(this, 'CreateUploadFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('create-upload'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        ASSET_BUCKET_NAME: assetBucket.bucketName,
        ASSETS_TABLE_NAME: assets.tableName,
      },
    });

    const getAsset = new lambdaNodejs.NodejsFunction(this, 'GetAssetFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('get-asset'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        ASSETS_TABLE_NAME: assets.tableName,
      },
    });

    const createDelivery = new lambdaNodejs.NodejsFunction(this, 'CreateDeliveryFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('create-delivery'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        ASSETS_TABLE_NAME: assets.tableName,
        ASSET_BUCKET_NAME: assetBucket.bucketName,
      },
    });

    const validateAsset = new lambdaNodejs.NodejsFunction(this, 'ValidateAssetFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('validate-asset'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        ASSET_BUCKET_NAME: assetBucket.bucketName,
        ASSETS_TABLE_NAME: assets.tableName,
      },
    });

    const transformAsset = new lambdaNodejs.NodejsFunction(this, 'TransformAssetFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('transform-asset'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: { ASSET_BUCKET_NAME: assetBucket.bucketName },
    });

    const completeAsset = new lambdaNodejs.NodejsFunction(this, 'CompleteAssetFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('complete-asset'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: { ASSETS_TABLE_NAME: assets.tableName },
    });

    const rejectAsset = new lambdaNodejs.NodejsFunction(this, 'RejectAssetFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('reject-asset'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ASSET_BUCKET_NAME: assetBucket.bucketName,
        ASSETS_TABLE_NAME: assets.tableName,
      },
    });

    const recordFailure = new lambdaNodejs.NodejsFunction(this, 'RecordFailureFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('record-failure'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: { ASSETS_TABLE_NAME: assets.tableName },
    });

    assetBucket.grantPut(createUpload);
    assets.grantReadWriteData(createUpload);
    assets.grantReadData(getAsset);
    assets.grantReadData(createDelivery);
    createDelivery.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [assetBucket.arnForObjects('processed/assets/*')],
    }));
    assetBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyStaleProcessedAssetSignatures',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [assetBucket.arnForObjects('processed/assets/*')],
      conditions: {
        NumericGreaterThan: {
          's3:signatureAge': 6 * 60 * 1_000,
        },
      },
    }));
    validateAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [assets.tableArn],
    }));
    validateAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [assetBucket.arnForObjects('uploads/originals/*')],
    }));
    transformAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [assetBucket.arnForObjects('uploads/originals/*')],
    }));
    transformAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [assetBucket.arnForObjects('processed/assets/*')],
    }));
    completeAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [assets.tableArn],
    }));
    rejectAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [assets.tableArn],
    }));
    rejectAsset.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [assetBucket.arnForObjects('uploads/originals/*')],
    }));
    recordFailure.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [assets.tableArn],
    }));

    const lambdaTask = (id: string, handler: lambda.IFunction) => new tasks.LambdaInvoke(this, id, {
      lambdaFunction: handler,
      payloadResponseOnly: true,
    });
    const invokeValidate = lambdaTask('Validate upload', validateAsset);
    const invokeTransform = lambdaTask('Transform asset', transformAsset);
    const invokeComplete = lambdaTask('Mark asset ready', completeAsset);
    const invokeReject = lambdaTask('Reject invalid asset', rejectAsset);
    const invokeRecordFailure = lambdaTask('Record processing failure', recordFailure);
    const ready = new sfn.Succeed(this, 'Asset ready');
    const rejected = new sfn.Succeed(this, 'Asset rejected');
    const failed = new sfn.Fail(this, 'Asset processing failed', {
      cause: 'Asset processing exhausted its retries',
    });
    invokeRecordFailure.addRetry({
      errors: ['States.TaskFailed'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });
    invokeRecordFailure.next(failed);

    for (const task of [invokeValidate, invokeTransform, invokeComplete, invokeReject]) {
      task.addRetry({
        errors: ['States.TaskFailed'],
        interval: cdk.Duration.seconds(2),
        maxAttempts: 3,
        backoffRate: 2,
      });
      task.addCatch(invokeRecordFailure, { resultPath: '$.failure' });
    }

    const definition = invokeValidate.next(
      new sfn.Choice(this, 'Bytes match declared image type?')
        .when(
          sfn.Condition.booleanEquals('$.valid', true),
          invokeTransform.next(invokeComplete).next(ready),
        )
        .otherwise(invokeReject.next(rejected)),
    );

    const workflowLogGroup = new logs.LogGroup(this, 'AssetWorkflowLogs', {
      retention: isPreview ? logs.RetentionDays.ONE_WEEK : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cleanupPolicy,
    });
    const assetWorkflow = new sfn.StateMachine(this, 'AssetWorkflow', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(5),
      logs: {
        destination: workflowLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: true,
      },
    });

    const workflowStarter = new lambdaNodejs.NodejsFunction(this, 'WorkflowStarterFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: lambdaEntry('workflow-starter'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { STATE_MACHINE_ARN: assetWorkflow.stateMachineArn },
    });
    assetWorkflow.grantStartExecution(workflowStarter);
    workflowStarter.addEventSource(new eventsources.SqsEventSource(assetsQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));
    assetBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(assetsQueue),
      { prefix: 'uploads/originals/' },
    );

    const api = new apigwv2.HttpApi(this, 'PreviewApi', {
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowOrigins: [`https://${distribution.domainName}`],
      },
    });

    api.addRoutes({
      path: '/hello',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HelloIntegration', hello),
    });
    api.addRoutes({
      path: '/assets',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('CreateUploadIntegration', createUpload),
      authorizer: userAuthorizer,
    });
    api.addRoutes({
      path: '/assets/{assetId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('GetAssetIntegration', getAsset),
      authorizer: userAuthorizer,
    });
    api.addRoutes({
      path: '/assets/{assetId}/delivery',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'CreateDeliveryIntegration',
        createDelivery,
      ),
      authorizer: userAuthorizer,
    });

    cdk.Tags.of(this).add('managed-by', 'cdk');
    cdk.Tags.of(this).add('preview', String(isPreview));
    cdk.Tags.of(this).add('pr', pr);
    if (repo) cdk.Tags.of(this).add('repo', String(repo));
    if (sha) cdk.Tags.of(this).add('sha', String(sha));
    if (run) cdk.Tags.of(this).add('run-id', String(run));
    cdk.Tags.of(siteBucket).add('resource', 'preview-site-bucket');
    cdk.Tags.of(assetBucket).add('resource', 'asset-bucket');
    cdk.Tags.of(assets).add('resource', 'asset-metadata');
    cdk.Tags.of(assetsQueue).add('resource', 'asset-events-queue');
    cdk.Tags.of(deadLetterQueue).add('resource', 'asset-events-dlq');
    cdk.Tags.of(createUpload).add('resource', 'asset-upload-api');
    cdk.Tags.of(getAsset).add('resource', 'asset-status-api');
    cdk.Tags.of(createDelivery).add('resource', 'asset-delivery-api');
    cdk.Tags.of(assetWorkflow).add('resource', 'asset-workflow');
    cdk.Tags.of(workflowStarter).add('resource', 'workflow-starter');
    cdk.Tags.of(validateAsset).add('resource', 'asset-validation');
    cdk.Tags.of(transformAsset).add('resource', 'asset-transformation');

    new cdk.CfnOutput(this, 'BucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'AssetBucketName', { value: assetBucket.bucketName });
    new cdk.CfnOutput(this, 'PreviewUrl', {
      value: `https://${distribution.domainName}/?pr=${encodeURIComponent(pr)}`,
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.apiEndpoint}/hello` });
    new cdk.CfnOutput(this, 'AssetApiBaseUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'AssetsTableName', { value: assets.tableName });
    new cdk.CfnOutput(this, 'AssetsQueueName', { value: assetsQueue.queueName });
    new cdk.CfnOutput(this, 'AssetsDeadLetterQueueName', { value: deadLetterQueue.queueName });
    new cdk.CfnOutput(this, 'AssetWorkflowArn', { value: assetWorkflow.stateMachineArn });
    new cdk.CfnOutput(this, 'UserPoolId', { value: users.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: webClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolHostedUiUrl', { value: hostedUiUrl });
    new cdk.CfnOutput(this, 'UserPoolIssuer', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${users.userPoolId}`,
    });
  }
}
