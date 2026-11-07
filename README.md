# AWS from idea to infra — Day Twelve

Cumulative TypeScript CDK application for the series, through **Edge and API protection (AWS WAF)**. It includes private asset uploads, owner-authorized downloads, Step Functions image analysis, EventBridge events, SNS fan-out, and CloudWatch monitoring.

This is the series reference repository, checked out as `aws-from-idea-to-infra/` at the root of the notes workspace. Run project commands here. The CI/CD workflows run from this repository's root.

## Local verification

Use Node.js 24 and install the locked dependencies:

```bash
npm ci
npm test
```

Tests synthesize CDK templates and mock metadata operations. They do not deploy infrastructure, call Rekognition, or send notifications. Synthesis tests exercise both `us-east-1` and an application Region different from the edge ACL's Region.

## Architecture

The browser loads the site through CloudFront, then calls the regional REST API directly. Separate WAF web ACLs inspect both surfaces. The REST API uses Cognito ID tokens restricted to the current preview app client; Lambdas read REST proxy claims and enforce asset ownership.

The API issues a five-minute signed form for one S3 key and a maximum five-MiB upload. File bytes go directly to S3. S3 events enter SQS, the starter creates a Standard Workflow, task Lambdas validate and copy, and a direct Rekognition task analyzes the processed object version. Completion saves labels and ready state together. Owners read status and request a five-minute private download URL. S3 uploads and downloads do not pass through WAF.

Terminal facts go through EventBridge to the audit log and the lifecycle SNS topic. Machine subscribers receive an SQS copy; optional confirmed operator email receives rejected/failed outcomes. A separate SNS topic carries operational alarms. Existing retry and DLQ boundaries remain distinct.

## Existing CI/CD

The reference workflows retain OIDC, per-PR identity, approval for `aws-preview`, and automatic `aws-teardown` on PR close. They now operate on **all stacks in `bin/preview.ts`**:

- `Stack-PR<number>-Edge`: CloudFront web ACL and WAF logs in `us-east-1`.
- `Stack-PR<number>`: application, REST API stage, regional web ACL, and regional WAF logs in `AWS_REGION`.

CDK's cross-region references connect the edge ARN to the distribution through CloudFormation custom resources and establish deployment/deletion order. CDK marks this feature experimental; keep locked versions and test both regional layouts when upgrading. The application stack must be removed before its edge stack. Keep the preview entrypoint unchanged when the teardown workflow synthesizes the assembly.

Prerequisites remain the earlier chapters' GitHub OIDC role/environments and long-lived `AssetSeriesAuth` stack in the application Region. The target account must be CDK-bootstrapped in **both the application Region and `us-east-1`** (once if they are the same). The deployment identity must be able to assume both Regions' bootstrap roles. CloudFormation needs WAF association/log delivery permissions and permission for CDK's cross-region reference helpers. No AWS credentials belong in the application or browser.

Repository variables: `AWS_REGION`, `AWS_ROLE_ARN`, and `AWS_ACTOR`. Optional `NOTIFICATION_EMAIL` is a secret in the `aws-preview` environment. Its two SNS subscriptions still require confirmation. Outputs generate `site/config.js`; the REST stage `/preview` is part of `AssetApiBaseUrl`.

## WAF policy and operations

Each ACL applies a per-IP limit of 2,000 requests over five minutes, the AWS Common Rule Set, and Known Bad Inputs. The default is allow; terminating managed matches and the rate rule block. These are starting policies, not exact quotas or per-user limits. Shared NAT clients share an IP counter. Managed rules use their current default version; evaluate changes and false positives with normal application traffic before promotion.

WAF writes BLOCK and COUNT records to a dedicated `aws-waf-logs-*` group for each scope. Sampling is disabled. Web ACL data protection substitutes sensitive headers, the complete query string, and bodies, excluding their rule match details; logging redaction provides an additional layer. IPs and URI paths remain operational data. Restrict log access. Preview logs retain seven days, production logs one month.

After CI/CD succeeds, verify both web ACL associations, normal `/hello`, CORS preflight, sign-in, upload, labels, and private download. A single request with an empty `User-Agent` to `/hello` or the CloudFront URL should be blocked by the Common Rule Set's `NoUserAgent_HEADER` rule; correlate it with WAF logs. Do not generate a rate-limit burst. Authentication errors and WAF blocks can both appear as HTTP errors; inspect WAF logs before changing application authorization.

The chapter's verification commands and trade-offs are in `src/content/partly-cloudy/aws-from-idea-to-infra/414-edge-api-protection/index.md` in the notes repository.

## Migration and retention

This version replaces the HTTP API with a regional REST API and changes handlers to `requestContext.authorizer.claims`. Existing saved assets, user pool, workflow, buckets, tables, and event contracts remain. The generated API base URL changes and includes the stage; hard-coded old URLs must be discarded. The first rollout can briefly serve old cached configuration while the old API is being removed; refresh configuration and retry, rather than accepting tokens from another app client.

Closing a PR triggers CI/CD to remove both preview stacks in dependency order. Production keeps the existing asset data and WAF logs according to retention policies; WAF ACLs and the API association follow stack deletion. WAF inspection, log ingestion/storage, REST API requests, and the previous application services all have pricing dimensions. Neither WAF nor teardown reverses charges already incurred.
