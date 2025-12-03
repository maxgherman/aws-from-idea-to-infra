import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class DeployRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Allow a specific IAM user (default: Admin) to assume the role with MFA
    const adminUser = String(this.node.tryGetContext('adminUser') ?? 'Admin');
    const account = cdk.Stack.of(this).account;
    const assumedBy = new iam.ArnPrincipal(
      `arn:aws:iam::${account}:user/${adminUser}`,
    ).withConditions({
      Bool: { 'aws:MultiFactorAuthPresent': 'true' },
    });

    const role = new iam.Role(this, 'CdkDeployerRole', {
      roleName: 'CdkDeployerRole',
      description: 'Admin role used to deploy CDK stacks during development',
      assumedBy,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
    });

    new cdk.CfnOutput(this, 'RoleArn', { value: role.roleArn });
  }
}
