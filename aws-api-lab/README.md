# aws-api-lab

Contract-first REST API lab for a DevOps / AWS interview. Terraform-managed
sandbox in account `510724490747`, region `us-east-2`. Everything is prefixed
`aws-api-lab-dev`.

**Pitch:** event-driven services on AWS — Lambda, DynamoDB, EventBridge — with
everything in Terraform. This lab is a REST API with problem+json errors
(including API Gateway responses), cursor pagination and ETags on DynamoDB, and
async harvests over a queue so the request path stays boring.

Stage-by-stage build: see [PLAN.md](./PLAN.md). **Stage 0 is the current
checkpoint** — workspace, name prefix, $20 budget alarm. No API yet.

---

## Incident rules

1. This account only. Terraform sets `allowed_account_ids`; if the profile
   points elsewhere, plan fails instead of creating resources in the wrong place.
2. $20 monthly budget → SNS → `chadvansyoc11@gmail.com`. Confirm the
   subscription mail or the alarm is theater. Budgets **notify**; they do not
   hard-stop spend.
3. No NAT. No VPC Lambdas. No public S3.
4. No `Resource: "*"` on execution roles (enforced from Stage 5).
5. Log groups retain **14 days** (`local.log_retention_days`). Never-expire is
   how labs get expensive.
6. `terraform destroy` is the teardown path, not the console.
7. Secrets stay in SSM/Secrets Manager later. Never in git.
8. **Do not** enable Security Hub, GuardDuty, or Control Tower from the console
   home widgets — they bill. Cost Explorer is free and useful; turn that on.
   Skip the "earn credits" EC2/RDS tasks.

---

## Prerequisites

- Node 20+ and pnpm (already used by `llm-platform`)
- Terraform >= 1.6 (`winget install Hashicorp.Terraform`)
- AWS CLI v2 (`winget install Amazon.AWSCLI`)
- Named profile `aws-api-lab` (see bootstrap below). **Do not create root
  access keys.**

---

## Bootstrap CLI access (once)

The console login is the root user (or whatever created the account). Terraform
must not use that. Create a **programmatic IAM user** in this sandbox:

1. IAM → Users → Create user. Name: `lab-terraform`.
   Do **not** grant console access.
2. Attach `AdministratorAccess`. That is sandbox-only; a real org would use a
   bounded role. Stage 7 replaces this with GitLab OIDC.
3. Security credentials → Create access key → Command Line Interface (CLI) →
   acknowledge → create. Copy both values; the secret is shown once.
4. In a terminal:

```powershell
aws configure --profile aws-api-lab
# AWS Access Key ID:     <paste>
# AWS Secret Access Key: <paste>
# Default region name:   us-east-2
# Default output format: json
```

5. Verify the account lock:

```powershell
aws sts get-caller-identity --profile aws-api-lab
# Account must be 510724490747
```

---

## Commands

From `aws-api-lab/`:

```powershell
pnpm install
pnpm build

terraform -chdir=terraform/envs/dev init
terraform -chdir=terraform/envs/dev fmt
terraform -chdir=terraform/envs/dev plan
terraform -chdir=terraform/envs/dev apply
```

`apply` creates: one SNS topic, one email subscription (pending until you
confirm the mail), one monthly cost budget. Nothing that looks like a NAT
gateway, VPC, or always-on compute.

Teardown:

```powershell
terraform -chdir=terraform/envs/dev destroy
```

State is local: `terraform/envs/dev/terraform.tfstate` (gitignored). Lose that
file and you will have to import or delete leftovers in the console.

---

## Layout (Stage 0)

```
aws-api-lab/
├─ PLAN.md
├─ packages/errors    # stub — Stage 1 fills RFC 9457
├─ packages/domain    # stub — Stage 2, no AWS types
└─ terraform/envs/dev # prefix, budget, SNS
```
