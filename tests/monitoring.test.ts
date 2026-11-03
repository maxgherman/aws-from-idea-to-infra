import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Stack as PreviewStack } from '../lib/stack';

for (const withEmail of [false, true]) {
  test(`monitors each preview boundary with email ${withEmail ? 'enabled' : 'disabled'}`, () => {
    const stackName = withEmail ? 'MonitoringWithEmail' : 'MonitoringWithoutEmail';
    const app = new App({ context: {
      pr: '123',
      ...(withEmail ? { notificationEmail: 'operator@example.com' } : {}),
    } });
    const template = Template.fromStack(new PreviewStack(app, stackName, {
      env: { account: '111111111111', region: 'us-east-1' },
    }));
    const resources = template.toJSON().Resources;
    const alarmTopic = Object.entries<any>(resources).find(([, resource]) =>
      resource.Type === 'AWS::SNS::Topic'
      && resource.Properties.DisplayName === 'Asset operational alarms')!;
    assert.ok(alarmTopic, 'operational alerts need a separate topic');
    assert.ok(alarmTopic[1].Properties.KmsMasterKeyId);
    const action = { Ref: alarmTopic[0] };

    // Labeled metrics synthesize through MetricDataQuery rather than top-level MetricName.
    const alarms = Object.values<any>(template.findResources('AWS::CloudWatch::Alarm')).map(item => {
      const metric = item.Properties.Metrics?.[0]?.MetricStat;
      return { Properties: {
        ...item.Properties,
        ...(metric ? { ...metric.Metric, Period: metric.Period, Statistic: metric.Stat } : {}),
      } };
    });
    assert.equal(alarms.length, withEmail ? 12 : 11);
    for (const { Properties: alarm } of alarms) {
      assert.deepEqual(alarm.AlarmActions, [action]);
      assert.deepEqual(alarm.OKActions, [action]);
      assert.equal(alarm.TreatMissingData, 'notBreaching');
      assert.equal(alarm.Period, 300);
      assert.equal(alarm.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
      assert.equal(alarm.DatapointsToAlarm, alarm.EvaluationPeriods);
      assert.ok(alarm.AlarmDescription.length > 30);
    }
    for (const metricName of ['ExecutionsFailed', 'ExecutionsTimedOut']) {
      const alarm = alarms.find(item => item.Properties.MetricName === metricName)!.Properties;
      assert.equal(alarm.Namespace, 'AWS/States');
      assert.equal(alarm.Statistic, 'Sum');
      assert.equal(alarm.Threshold, 1);
      assert.equal(alarm.Dimensions[0].Name, 'StateMachineArn');
    }
    const ageAlarms = alarms.filter(item =>
      item.Properties.MetricName === 'ApproximateAgeOfOldestMessage');
    assert.deepEqual(ageAlarms.map(item => item.Properties.Threshold).sort((a, b) => a - b), [300, 3600]);
    for (const { Properties: alarm } of ageAlarms) {
      assert.equal(alarm.Statistic, 'Maximum');
      assert.equal(alarm.EvaluationPeriods, 2);
    }
    // Tie alarms to every actual DLQ, including the optional email subscription DLQ.
    const queueIds = Object.keys(template.findResources('AWS::SQS::Queue'))
      .filter(id => id.includes('DeadLetterQueue'));
    const monitoredQueueIds = alarms
      .filter(item => item.Properties.MetricName === 'ApproximateNumberOfMessagesVisible')
      .map(item => {
        assert.equal(item.Properties.Statistic, 'Maximum');
        assert.equal(item.Properties.Threshold, 1);
        return item.Properties.Dimensions[0].Value['Fn::GetAtt'][0];
      });
    assert.deepEqual(monitoredQueueIds.sort(), queueIds.sort());

    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Action: 'sns:Publish',
        Resource: action,
        Condition: {
          StringEquals: { 'aws:SourceAccount': '111111111111' },
          ArnLike: { 'aws:SourceArn': Match.anyValue() },
        },
      })]) },
    });
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: { Statement: Match.arrayWith([Match.objectLike({
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        Condition: {
          StringEquals: { 'aws:SourceAccount': '111111111111' },
          ArnLike: { 'aws:SourceArn': Match.anyValue() },
        },
      })]) },
    });
    const dashboards = Object.values<any>(template.findResources('AWS::CloudWatch::Dashboard'));
    assert.equal(dashboards.length, 1);
    assert.equal(dashboards[0].Properties.DashboardName, `${stackName}-us-east-1-assets`);
    const body = JSON.stringify(dashboards[0].Properties.DashboardBody);
    assert.ok(body.includes('Recent asset outcomes'));
    assert.ok(body.includes('detail.assetId'));
    for (const id of queueIds) assert.ok(body.includes(id), `dashboard omits ${id}`);

    const subscriptions = Object.values<any>(template.findResources('AWS::SNS::Subscription'));
    const alarmSubscriptions = subscriptions.filter(item =>
      JSON.stringify(item.Properties.TopicArn) === JSON.stringify(action));
    assert.equal(alarmSubscriptions.length, withEmail ? 1 : 0);
    if (withEmail) {
      assert.equal(alarmSubscriptions[0].Properties.Protocol, 'email');
      assert.equal(alarmSubscriptions[0].Properties.FilterPolicy, undefined);
    }
    for (const output of ['AssetDashboardName', 'AssetAlarmTopicArn', 'AssetWorkflowFailedAlarmName']) {
      assert.ok(template.toJSON().Outputs[output], `missing output ${output}`);
    }
  });
}
