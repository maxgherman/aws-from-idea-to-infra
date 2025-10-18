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
