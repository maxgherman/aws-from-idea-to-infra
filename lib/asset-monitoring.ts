import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

interface AssetMonitoringProps {
  workflow: sfn.IStateMachine;
  starter: lambda.IFunction;
  admissionQueue: sqs.IQueue;
  integrationQueue: sqs.IQueue;
  deadLetterQueues: Record<string, sqs.IQueue>;
  notificationTopic: sns.ITopic;
  notificationKey: kms.IKey;
  lifecycleLogs: logs.ILogGroup;
  notificationEmail?: string;
}

export class AssetMonitoring extends Construct {
  constructor(scope: Construct, id: string, props: AssetMonitoringProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const period = cdk.Duration.minutes(5);
    const count = { period, statistic: 'Sum' };
    const maximum = { period, statistic: 'Maximum' };
    const alarmPrefix = `${stack.stackName}-Assets-`;
    const alarmSource = stack.formatArn({
      service: 'cloudwatch', resource: 'alarm', resourceName: `${alarmPrefix}*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const conditions = {
      StringEquals: { 'aws:SourceAccount': stack.account },
      ArnLike: { 'aws:SourceArn': alarmSource },
    };
    props.notificationKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions,
    }));
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Asset operational alarms',
      masterKey: props.notificationKey,
      enforceSSL: true,
    });
    alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alarmTopic.topicArn],
      conditions,
    }));
    if (props.notificationEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.notificationEmail));
    }

    const alarms: cloudwatch.Alarm[] = [];
    const alarm = (
      name: string, metric: cloudwatch.IMetric, threshold: number,
      description: string, evaluationPeriods = 1,
    ) => {
      const item = new cloudwatch.Alarm(this, name, {
        alarmName: `${alarmPrefix}${name}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        datapointsToAlarm: evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      item.addAlarmAction(new actions.SnsAction(alarmTopic));
      item.addOkAction(new actions.SnsAction(alarmTopic));
      alarms.push(item);
    };

    const failed = props.workflow.metricFailed(count);
    const timedOut = props.workflow.metricTimedOut(count);
    alarm('WorkflowFailed', failed, 1, 'Inspect failed execution history, then the failing task logs.');
    alarm('WorkflowTimedOut', timedOut, 1, 'Inspect timed-out execution history and reconcile asset metadata.');
    alarm('StarterErrors', props.starter.metricErrors(count), 1,
      'Inspect starter logs and admission queue; partial batch failures also require queue inspection.');
    alarm('StarterThrottles', props.starter.metricThrottles(count), 1,
      'Check Lambda concurrency and admission queue age before changing concurrency limits.');

    const admissionAge = props.admissionQueue.metricApproximateAgeOfOldestMessage(maximum);
    const integrationAge = props.integrationQueue.metricApproximateAgeOfOldestMessage(maximum);
    alarm('AdmissionBacklog', admissionAge, 300,
      'Admission has waited at least five minutes in two periods; inspect starter and workflow quotas.', 2);
    alarm('IntegrationBacklog', integrationAge, 3600,
      'Subscriber has waited at least one hour in two periods; drain the demonstration queue or repair its consumer.', 2);

    const dlqMetrics = Object.entries(props.deadLetterQueues).map(([name, queue]) => {
      const metric = queue.metricApproximateNumberOfMessagesVisible({ ...maximum, label: name });
      alarm(`${name}NotEmpty`, metric, 1,
        `Inspect ${name} messages and repair its delivery boundary before redrive; export before teardown.`);
      return metric;
    });
    const notificationFailures = props.notificationTopic.metricNumberOfNotificationsFailed(count);
    alarm('NotificationDeliveryFailed', notificationFailures, 1,
      'Inspect SNS subscriptions, confirmation, destination policies, KMS access, and delivery DLQs.');

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${stack.stackName}-${stack.region}-assets`,
      defaultInterval: cdk.Duration.hours(6),
      periodOverride: cloudwatch.PeriodOverride.INHERIT,
    });
    dashboard.addWidgets(new cloudwatch.AlarmStatusWidget({
      title: 'Asset processing and delivery alarms', alarms, width: 24,
    }));
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Workflow outcomes (counts)', width: 12,
        left: [props.workflow.metricSucceeded(count), failed, timedOut],
      }),
      new cloudwatch.GraphWidget({
        title: 'Admission Lambda (counts)', width: 12,
        left: [props.starter.metricErrors(count), props.starter.metricThrottles(count)],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Oldest queued message (seconds)', width: 12,
        left: [admissionAge, integrationAge],
      }),
      new cloudwatch.GraphWidget({
        title: 'Visible dead-letter messages', width: 12, left: dlqMetrics,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lifecycle SNS delivery (counts)', width: 12,
        left: [props.notificationTopic.metricNumberOfMessagesPublished(count), notificationFailures],
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Recent asset outcomes', width: 12,
        logGroupNames: [props.lifecycleLogs.logGroupName],
        queryLines: [
          'fields @timestamp, detail.assetId, detail.status, detail.reason',
          'sort @timestamp desc',
          'limit 20',
        ],
      }),
    );
    new cdk.CfnOutput(stack, 'AssetDashboardName', { value: dashboard.dashboardName });
    new cdk.CfnOutput(stack, 'AssetAlarmTopicArn', { value: alarmTopic.topicArn });
    new cdk.CfnOutput(stack, 'AssetWorkflowFailedAlarmName', { value: `${alarmPrefix}WorkflowFailed` });
  }
}
