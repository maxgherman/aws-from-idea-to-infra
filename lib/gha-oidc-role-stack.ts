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

    // Tight trust policy: lock to repo, event, ref pattern, and actor
    const owner = this.node.tryGetContext('owner') ?? 'OWNER';
    const repo  = this.node.tryGetContext('repo')  ?? 'REPO';
    const actor = this.node.tryGetContext('actor') ?? 'YOUR_GH_USERNAME';

    // AWS requires scoping the `sub` claim explicitly. For PRs it is
    // exactly: repo:OWNER/REPO:pull_request
    const repoSub = `repo:${owner}/${repo}:pull_request`;

    // Relaxed trust for debugging: require only audience and exact sub for PRs.
    // This ensures OIDC works; re-tighten with repository/actor/ref after success.
    const ghPrincipal = new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': repoSub,
      },
    });

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
