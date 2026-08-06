import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';

export const authExports = {
  userPoolId: 'AssetSeriesUserPoolId',
  hostedUiUrl: 'AssetSeriesUserPoolHostedUiUrl',
} as const;

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const users = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const hostedUiDomain = users.addDomain('HostedUiDomain', {
      cognitoDomain: {
        domainPrefix: `asset-series-${this.account}-${this.region}`.toLowerCase(),
      },
    });

    cdk.Tags.of(this).add('managed-by', 'cdk');
    cdk.Tags.of(this).add('lifecycle', 'shared');
    cdk.Tags.of(users).add('resource', 'series-users');

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: users.userPoolId,
      exportName: authExports.userPoolId,
    });
    new cdk.CfnOutput(this, 'UserPoolHostedUiUrl', {
      value: hostedUiDomain.baseUrl(),
      exportName: authExports.hostedUiUrl,
    });
    new cdk.CfnOutput(this, 'UserPoolIssuer', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${users.userPoolId}`,
    });
  }
}
