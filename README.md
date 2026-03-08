# AWS — from idea to infra (CDK)

Reference implementation for the “AWS — from idea to infra” tutorial series.

This repo focuses on two things:

- *Account guardrails*: a dedicated deploy role you assume with MFA, plus an optional AWS Budget.
- *PR preview infrastructure*: per‑pull‑request ephemeral infra deployed by GitHub Actions via OIDC (no long‑lived AWS keys), and torn down when the PR closes.

## Prerequisites

- An AWS account with root locked down (MFA enabled; no root access keys).
- An IAM user for day‑to‑day work (with MFA) and an AWS CLI profile (example: `admin`).
- Node.js 18+ and `npm`.
- AWS CDK v2 (`npm i -g aws-cdk@2`).
- CDK bootstrap completed in the target account/region.

## What’s in here

This is a CDK TypeScript app with multiple entrypoints in `bin/`:

- `bin/deploy-role.ts`: creates `CdkDeployerRole` (assumable by an IAM user with MFA) and optionally a monthly AWS Budget.
- `bin/gha-oidc-role.ts`: creates the GitHub OIDC provider + `GitHubActionsDeployRole` for CI/CD.
- `bin/preview.ts`: deploys the per‑PR preview stack (S3 + CloudFront + static site upload).

Stacks live in `lib/`.

Static site content is in `site/` (replace this with your real build output when ready).

## Local usage (one‑time setup)

Install dependencies:

```bash
npm ci
```

Bootstrap CDK (once per account/region):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile admin)
REGION=us-east-1
cdk bootstrap aws://$ACCOUNT_ID/$REGION --profile admin
```

### Create the deploy role (CdkDeployerRole)

Deploy as your `admin` profile:

```bash
npx cdk deploy DeployRoleStack \
  --app "npx ts-node --prefer-ts-exts bin/deploy-role.ts" \
  --profile admin \
  -c adminUser=Admin
```

### Optional: add a monthly budget

```bash
npx cdk deploy BudgetStack \
  --app "npx ts-node --prefer-ts-exts bin/deploy-role.ts" \
  --profile dev \
  -c budgetEmail=you@example.com \
  -c budgetAmount=10
```

### Create the GitHub OIDC role (for CI/CD)

Deploy once (using a profile that can deploy CDK stacks, e.g. `dev` which assumes `CdkDeployerRole`):

```bash
npx cdk deploy GithubOidcRoleStack \
  --app "npx ts-node --prefer-ts-exts bin/gha-oidc-role.ts" \
  --profile dev \
  -c owner=YOUR_GITHUB_OWNER \
  -c repo=YOUR_GITHUB_REPO \
  -c env=aws-preview \
  -c teardownEnv=aws-teardown
```

Copy the `RoleArn` output — you’ll use it as `AWS_ROLE_ARN` in GitHub.

## GitHub Actions setup

Workflows live in `.github/workflows/`:

- `infra-preview.yml`: deploy/update the per‑PR preview stack and comment the preview URL.
- `infra-destroy.yml`: destroy the per‑PR stack when the PR is closed.

In your GitHub repo settings:

1) Create repository variables:

- `AWS_REGION` (example: `us-east-1`)
- `AWS_ROLE_ARN` (output of `GithubOidcRoleStack`)
- `AWS_ACTOR` (your GitHub username; used as a guard)

2) Create environments:

- `aws-preview` (typically require approval)
- `aws-teardown` (typically no approval)

3) Ensure workflow tokens can comment on PRs:

- Recommended: set `Settings → Actions → General → Workflow permissions` to **Read and write**.
- Fallback: create an Actions secret `PR_COMMENT_TOKEN` (fine‑grained PAT) and the workflow will use it for PR comments.

Now: open a PR (from a branch in the same repo, not a fork). The workflow deploys `Stack-PR<number>` and comments the CloudFront URL.

## Notes

- The preview stack is designed to be ephemeral: it uses destructive removal policies and auto-deletes S3 objects on teardown.
- CloudFront deletes can take a few minutes; teardown may be slower than deploy.

## Tutorial docs

[aws from idea to infra](https://www.max-gherman.dev/partly-cloudy/aws-from-idea-to-infra/)
