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

    // Minimal working trust: restrict to your repo + environment token form.
    const owner = this.node.tryGetContext('owner') ?? 'OWNER';
    const repo  = this.node.tryGetContext('repo')  ?? 'REPO';
    const envName = String(this.node.tryGetContext('env') ?? 'aws-preview');

    const ghPrincipal = new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${owner}/${repo}:environment:${envName}`,
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
