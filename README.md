# First Steps CDK

Two stacks:

- `DeployRoleStack` — creates an MFA-protected `CdkDeployerRole` with AdministratorAccess (for now) to use for CDK deployments.
- `BudgetStack` — creates a monthly budget with email alerts (forecast ≥80%, actual ≥100%).

Prerequisites:

- AWS CLI v2, Node.js 18+, npm
- CDK bootstrap completed for your account/region

Install

```bash
npm i
```

Build and synth

```bash
npm run build

# provide email address and budget
npm run synth -- -c budgetEmail=<YOUR EMAIL> -c budgetAmount=10
```

Bootstrap (once, as admin)

```bash
cdk bootstrap --profile admin
```

Deploy the deployer role (as admin)

```bash
# provide email address and budget
cdk deploy DeployRoleStack --profile admin -c budgetEmail=<YOUR EMAIL> -c budgetAmount=10
```

Configure profiles in `~/.aws/config` ( Replace `123456789012` with your account ID.)

```ini
[admin]
aws_access_key_id=...
aws_secret_access_key=...
mfa_serial=arn:aws:iam::123456789012:mfa/your-admin-user
region=us-east-1

[dev]
role_arn=arn:aws:iam::123456789012:role/CdkDeployerRole
source_profile=admin
mfa_serial=arn:aws:iam::123456789012:mfa/your-admin-user
region=us-east-1
```

> `mfa_serial` must be the ARN of the MFA device attached to your `admin` IAM user. The CLI will prompt for your 6‑digit code when assuming the role. You can fetch the ARN via:

```bash
aws iam list-mfa-devices --user-name admin --profile admin --query 'MFADevices[0].SerialNumber' --output text
```

Verify the `dev` session

```bash
aws sts get-caller-identity --profile dev
```

Deploy the budget (as dev)

```bash
cdk deploy BudgetStack \
  -c budgetEmail=you@example.com \
  -c budgetAmount=10 \
  --profile dev
```

Notes:

- Budgets is effectively account-global; keep region consistent with your profiles.
- Tighten permissions later by scoping `CdkDeployerRole` to least privilege for your stacks.

## GitHub Actions PR Preview (OIDC)

This repo includes a minimal per‑PR preview using CDK + S3. It assumes an AWS role via GitHub OIDC (no long‑lived keys).

- Deploy the OIDC role (once)

  ```bash
  # From this repo, as your dev profile
  npx cdk deploy \
    --app "npx ts-node --prefer-ts-exts bin/gha-oidc-role.ts" \
    -c "repoSub=repo:OWNER/REPO:*" \
    --profile dev

  # Copy the RoleArn output
  ```

- Configure repository variables (GitHub UI)

  - Settings → Secrets and variables → Actions → Variables → New repository variable
  - Add:
    - `AWS_REGION` (e.g., `us-east-1`)
    - `AWS_ROLE_ARN` (the `RoleArn` from the stack output)

  The workflows are guarded and do nothing until these variables are set.

- Open a PR to trigger the preview

- `.github/workflows/infra-preview.yml` deploys an S3 bucket stack named by PR number and tags it with PR/repo/SHA/run.
- Closing the PR triggers `.github/workflows/infra-destroy.yml` which destroys the stack and bucket.

Verify (optional)

```bash
PR=123
REGION=us-east-1
STACK=Stack-PR${PR}

# Stack status
aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text

# Resolve bucket name
BUCKET=$(aws cloudformation list-stack-resources \
  --stack-name "$STACK" --region "$REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId | [0]" \
  --output text)
echo "$BUCKET"

# Check tags/security
aws s3api get-bucket-tagging        --bucket "$BUCKET" --region "$REGION"
aws s3api get-public-access-block   --bucket "$BUCKET" --region "$REGION"
aws s3api get-bucket-encryption     --bucket "$BUCKET" --region "$REGION"
```

