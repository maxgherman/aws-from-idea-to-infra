# AWS — from idea to infra (CDK)

Reference implementation for the “AWS — from idea to infra” tutorial series.

This repo focuses on two things:

- *Account guardrails*: a dedicated deploy role you assume with MFA, plus an optional AWS Budget.
- *PR preview infrastructure*: per‑pull‑request ephemeral infra deployed by GitHub Actions via OIDC (no long‑lived AWS keys), and torn down when the PR closes.
- *Private asset processing*: authenticated browser uploads, private S3 storage, queue-buffered Step Functions workflows, DynamoDB metadata, EventBridge lifecycle events, and owner-authorized S3 delivery of accepted assets.

## Prerequisites

- An AWS account with root locked down (MFA enabled; no root access keys).
- An IAM user for day‑to‑day work (with MFA) and an AWS CLI profile (example: `admin`).
- Node.js 24+ and `npm`.
- CDK bootstrap completed in the target account/region.

## What’s in here

This is a CDK TypeScript app with multiple entrypoints in `bin/`:

- `bin/deploy-role.ts`: creates `CdkDeployerRole` (assumable by an IAM user with MFA) and optionally a monthly AWS Budget.
- `bin/gha-oidc-role.ts`: creates the GitHub OIDC provider + `GitHubActionsDeployRole` for CI/CD.
- `bin/auth.ts`: deploys the long-lived Cognito user pool and hosted UI domain shared by previews.
- `bin/preview.ts`: deploys the per‑PR asset preview stack (Cognito app client, private S3, SQS, Step Functions, EventBridge, Lambda, DynamoDB, CloudFront, and the static site).

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
npx cdk bootstrap aws://$ACCOUNT_ID/$REGION --profile admin
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

### Create shared preview authentication

Deploy the authentication stack once per account and region. The user pool is retained independently of pull-request preview teardown.

```bash
npx cdk deploy AssetSeriesAuth \
  --app "npx ts-node bin/auth.ts" \
  --profile dev
```

Create one operator-provisioned test user in the `UserPoolId` output. Future previews import this pool and create only their own callback-specific app client.

## GitHub Actions setup

Workflows live in `.github/workflows/`:

- `infra-preview.yml`: deploy/update the per‑PR preview stack and comment the preview URL.
- `infra-destroy.yml`: destroy the per‑PR stack when the PR is closed.

In your GitHub repo settings:

- Create repository variables:

  - `AWS_REGION` (example: `us-east-1`)
  - `AWS_ROLE_ARN` (output of `GithubOidcRoleStack`)
  - `AWS_ACTOR` (your GitHub username; used as a guard)

- Create environments:

  - `aws-preview` (typically require approval)
  - `aws-teardown` (typically no approval)

- Ensure workflow tokens can comment on PRs:

- Recommended: set `Settings → Actions → General → Workflow permissions` to **Read and write**.
- Fallback: create an Actions secret `PR_COMMENT_TOKEN` (fine‑grained PAT) and the workflow will use it for PR comments.

Now: open a PR (from a branch in the same repo, not a fork). The workflow deploys `Stack-PR<number>` and comments the CloudFront URL plus the asset API URL.

## Preview access and lifecycle

- The preview stack is intentionally ephemeral: it deletes its Cognito app client, workflow, DynamoDB table, queues, and S3 objects when its PR closes.
- The shared Cognito pool and its users remain in `AssetSeriesAuth`. User self-sign-up is disabled, so provision the series test user once instead of once per preview.
- S3 notifications remain buffered in SQS. A starter Lambda creates one Standard Step Functions execution per asset, with explicit validation, transformation, ready, rejected, and failed paths.
- Terminal workflow paths publish versioned `Asset State Changed` events to a custom EventBridge bus. A filtered rule retains an operator-facing audit stream in CloudWatch Logs and sends exhausted target deliveries to a separate SQS dead-letter queue.
- Original and processed assets remain private. An owner can request a five-minute S3 download URL only after the worker accepts an asset.
- CloudFront deletes can take a few minutes; teardown may be slower than deploy.

## Tutorial docs

[aws from idea to infra](https://www.max-gherman.dev/partly-cloudy/aws-from-idea-to-infra/)
