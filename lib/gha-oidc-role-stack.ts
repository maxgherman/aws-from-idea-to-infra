import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class GithubOidcRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOIDC', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // Replace OWNER and REPO with your org/user and repository name
    const repoSub = this.node.tryGetContext('repoSub') ?? 'repo:OWNER/REPO:*';

    const ghPrincipal = new iam.WebIdentityPrincipal(
      provider.openIdConnectProviderArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': repoSub,
        },
      },
    );

    const role = new iam.Role(this, 'GitHubActionsRole', {
      roleName: 'GitHubActionsDeployRole',
      assumedBy: ghPrincipal,
      // Start wide; tighten to least privilege later
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),
      ],
      description: 'Assumable by GitHub Actions via OIDC for CDK deploy/destroy',
    });

    new cdk.CfnOutput(this, 'RoleArn', { value: role.roleArn });
  }
}

