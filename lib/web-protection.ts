import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as waf from 'aws-cdk-lib/aws-wafv2';

export interface WebProtectionProps {
  scope: 'CLOUDFRONT' | 'REGIONAL';
  isPreview: boolean;
}

/** One policy per protected surface; IP counters are independent between ACLs. */
export class WebProtection extends Construct {
  readonly acl: waf.CfnWebACL;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: WebProtectionProps) {
    super(scope, id);
    const metricPrefix = `${cdk.Stack.of(this).stackName}-${id}`.slice(0, 64);
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: false,
      metricName: `${metricPrefix}-${metricName}`,
    });
    this.acl = new waf.CfnWebACL(this, 'Acl', {
      scope: props.scope,
      defaultAction: { allow: {} },
      description: 'Managed request inspection and per-IP rate protection',
      visibilityConfig: visibility('AssetWebAcl'),
      dataProtectionConfig: {
        dataProtections: [
          { field: { fieldType: 'SINGLE_HEADER', fieldKeys: ['authorization', 'cookie', 'x-api-key', 'x-amz-security-token'] }, action: 'SUBSTITUTION', excludeRuleMatchDetails: true },
          { field: { fieldType: 'QUERY_STRING' }, action: 'SUBSTITUTION', excludeRuleMatchDetails: true },
          { field: { fieldType: 'BODY' }, action: 'SUBSTITUTION', excludeRuleMatchDetails: true },
        ],
      },
      rules: [
        {
          name: 'PerIpRateLimit', priority: 0, action: { block: {} },
          statement: { rateBasedStatement: {
            aggregateKeyType: 'IP', limit: 2000, evaluationWindowSec: 300,
          } },
          visibilityConfig: visibility('PerIpRateLimit'),
        },
        ...['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'].map((name, index) => ({
          name, priority: 10 + index, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
          visibilityConfig: visibility(name),
        })),
      ],
    });
    this.logGroup = new logs.LogGroup(this, 'Requests', {
      logGroupName: `aws-waf-logs-${cdk.Stack.of(this).stackName}-${id}`,
      retention: props.isPreview ? logs.RetentionDays.ONE_WEEK : logs.RetentionDays.ONE_MONTH,
      removalPolicy: props.isPreview ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });
    new waf.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.acl.attrArn,
      logDestinationConfigs: [cdk.Stack.of(this).formatArn({
        service: 'logs', resource: 'log-group', resourceName: this.logGroup.logGroupName,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })],
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
        { queryString: {} },
      ],
      // LoggingFilter is an untyped CloudFormation JSON object: use CFN casing.
      loggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [{ Behavior: 'KEEP', Requirement: 'MEETS_ANY', Conditions: [
          { ActionCondition: { Action: 'BLOCK' } },
          { ActionCondition: { Action: 'COUNT' } },
        ] }],
      },
    });
  }
}

/** CloudFront WAF resources must be managed in us-east-1, regardless of app Region. */
export class EdgeProtectionStack extends cdk.Stack {
  readonly protection: WebProtection;
  constructor(scope: Construct, id: string, props: cdk.StackProps & { isPreview: boolean }) {
    super(scope, id, props);
    this.protection = new WebProtection(this, 'EdgeProtection', {
      scope: 'CLOUDFRONT', isPreview: props.isPreview,
    });
    new cdk.CfnOutput(this, 'EdgeWebAclArn', { value: this.protection.acl.attrArn });
    new cdk.CfnOutput(this, 'EdgeWafLogGroupName', { value: this.protection.logGroup.logGroupName });
  }
}
