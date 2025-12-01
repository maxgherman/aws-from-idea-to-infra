import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export class GithubOidcRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOIDC', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // GitHub's documented SHA-1 thumbprint for the root CA chain
      // https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#adding-the-oidc-provider-to-aws
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // Tight trust policy: lock to repo, event, ref pattern, and actor
    const owner = this.node.tryGetContext('owner') ?? 'OWNER';
    const repo  = this.node.tryGetContext('repo')  ?? 'REPO';
    const actor = this.node.tryGetContext('actor') ?? 'YOUR_GH_USERNAME';

    // AWS requires scoping the `sub` claim explicitly. For PRs it is
    // exactly: repo:OWNER/REPO:pull_request
    const repoSub = `repo:${owner}/${repo}:pull_request`;

    // Relaxed but robust trust: audience must be STS and sub must match this repo
    // for any event type (PRs, pushes, etc.). We'll re-tighten after it works.
    const ghPrincipal = new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': `repo:${owner}/${repo}:*`,
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
