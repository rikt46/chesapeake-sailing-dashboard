# Tolchester Sailing Dashboard — AWS Infrastructure

Static hosting on S3 + CloudFront, managed by Terraform. Automated deploys via GitHub Actions with OIDC (no stored AWS keys). Estimated cost for personal use: **< $0.50/month** after the free tier.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Browser     │────▶│  CloudFront CDN  │────▶│  S3 Bucket   │
│              │     │  (HTTPS, cache)  │     │  (private)   │
└─────────────┘     └──────────────────┘     └──────────────┘
                           │
                    ┌──────┴──────┐
                    │  ACM Cert   │  (optional, for custom domain)
                    │  Route 53   │
                    └─────────────┘

┌─────────────┐     ┌──────────────────────┐
│  git push    │────▶│  GitHub Actions      │──── OIDC ──▶ AWS IAM Role
│  to main     │     │  (optional; see      │             (least privilege)
└─────────────┘     │   docs/AUTOMATION.md) │
                    └──────────────────────┘
```

**What you get:**
- HTTPS everywhere (free via CloudFront default cert or ACM)
- Global edge caching (400+ PoPs)
- DDoS protection (AWS Shield Standard, free)
- Private S3 bucket (no public access, OAC-only)
- Versioned S3 objects (rollback capability)
- Push-to-deploy from GitHub (OIDC, no stored secrets)
- ~30-60 second deploys

## Prerequisites

1. **AWS CLI v2** — [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
2. **Terraform >= 1.5** — [Install guide](https://developer.hashicorp.com/terraform/install)
3. **AWS credentials configured** (for the initial Terraform apply only):
   ```bash
   aws configure
   # Enter your Access Key ID, Secret Access Key, region (us-east-1)
   ```

## Repo Hygiene

- Do not commit `terraform.tfstate`, `terraform.tfstate.backup`, or `terraform.tfvars`.
- Keep live domain names, hosted zone IDs, and state locations in untracked local files until you configure a remote backend.

## Step-by-Step Setup

### 1. Clone the repo

```bash
git clone git@github.com:your-github-username/your-repo.git
cd your-repo/infra
```

### 2. Configure variables

Create a local `terraform.tfvars` from the example, then keep it untracked.

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
project_name = "tolchester-sailing"
aws_region   = "us-east-1"

# Option A: CloudFront domain only (simplest)
domain_name     = ""
route53_zone_id = ""

# Option B: Custom domain
# domain_name     = "dashboard.example.com"
# route53_zone_id = "Z1234567890ABC"
```

The repo should only keep `terraform.tfvars.example` as the template. Your actual `terraform.tfvars` belongs on your machine or in a secure secret store.

### 3. Apply Terraform

```bash
terraform init
terraform plan    # review what will be created
terraform apply   # type 'yes' to confirm
```

This creates:
- S3 bucket (private, versioned, encrypted)
- CloudFront distribution (HTTPS, edge-cached)
- Origin Access Control (S3 only accessible via CloudFront)
- GitHub Actions IAM role (for CI/CD)
- Optional reuse of an existing account-wide GitHub OIDC provider
- ACM certificate + Route 53 records (if custom domain)

**Save the outputs** — you'll need them in the next step:
```
cloudfront_url              = "https://d1234abcdef.cloudfront.net"
s3_bucket_name              = "tolchester-sailing-site-a1b2c3d4"
cloudfront_distribution_id  = "E1234ABCDEF"
github_actions_role_arn     = "arn:aws:iam::123456789:role/tolchester-sailing-github-actions"
```

Wait 5-10 minutes for CloudFront to fully deploy, then visit the URL.

Deploy the site contents after infrastructure is ready:

```bash
cd ..
./deploy.sh
```

### 4. Configure GitHub Actions variables

> This repo ships **no workflow files**. First add the deploy (and optionally
> chart-cache) workflow to `.github/workflows/` in your fork by copying the
> templates in [`../docs/AUTOMATION.md`](../docs/AUTOMATION.md). Then continue
> below.

Go to **GitHub → Settings → Secrets and variables → Actions → Variables tab** and add:

| Variable name | Value (from Terraform output) |
|---|---|
| `AWS_ROLE_ARN` | `github_actions_role_arn` output |
| `S3_BUCKET_NAME` | `s3_bucket_name` output |
| `CLOUDFRONT_DIST_ID` | `cloudfront_distribution_id` output |

These are non-secret variables (not "Secrets") since they contain no credentials — the OIDC role ARN is safe to expose.

### 5. Test the pipeline

Make any change to `index.html`, `style.css`, or `app.js`, commit, and push:

```bash
git add -A && git commit -m "test deploy" && git push
```

Go to **Actions** tab on GitHub — you should see the deploy workflow running. It will:
1. Check out the code
2. Assume the IAM role via OIDC (no keys)
3. Sync files to S3 with correct content types
4. Invalidate the CloudFront cache

## How OIDC Works (No Stored Keys)

Traditional CI/CD stores AWS access keys as GitHub Secrets. OIDC is better:

1. GitHub Actions requests a short-lived JWT from GitHub's OIDC provider
2. The workflow sends this JWT to AWS STS (`AssumeRoleWithWebIdentity`)
3. AWS validates the token against the trust policy (locked to your repo + main branch)
4. AWS issues temporary credentials (15-minute TTL)
5. The workflow uses those credentials to deploy

**Benefits:**
- No long-lived AWS keys to rotate or leak
- Trust is scoped to your `owner/repo:main` only (via the `github_repo` variable)
- IAM role has least-privilege (S3 put/delete + CloudFront invalidate)
- Credentials expire automatically

## Manual Deployment

You can also deploy without GitHub Actions:

```bash
# From the project root
./deploy.sh
```

Or with explicit arguments:
```bash
./deploy.sh --bucket tolchester-sailing-site-a1b2c3d4 --dist-id E1234ABCDEF
```

## Updating the Dashboard

After the initial setup, the workflow is just:

```bash
# Edit your files...
git add -A
git commit -m "update forecast logic"
git push
# GitHub Actions deploys automatically in ~30 seconds
```

## Tearing Down

```bash
cd infra
terraform destroy   # removes everything: S3, CloudFront, IAM role, OIDC provider
```

## Cost Breakdown

| Resource | Free Tier | After Free Tier |
|----------|-----------|-----------------|
| S3 storage (~50 KB) | 5 GB free for 12 months | ~$0.001/month |
| S3 requests | 2,000 PUT + 20,000 GET free | ~$0.01/month |
| CloudFront transfer | 1 TB/month free forever | $0.085/GB |
| CloudFront requests | 10M free forever | $0.01/10K requests |
| Route 53 hosted zone | — | $0.50/month (only if custom domain) |
| ACM certificate | Always free | Always free |
| GitHub Actions | 2,000 min/month free | $0.008/min |

**Realistic monthly cost: $0.00 – $0.50**

## IAM Policy (Least Privilege)

The Terraform creates two levels of IAM:

**GitHub Actions role** (`github-oidc.tf`) — used by CI/CD:
- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on the site bucket only
- `cloudfront:CreateInvalidation` on the distribution only

**Initial setup** — your local AWS credentials need broader permissions for the one-time `terraform apply`. See the full policy below:

<details>
<summary>IAM policy for initial Terraform apply</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3SiteBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket", "s3:DeleteBucket",
        "s3:GetBucketPolicy", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy",
        "s3:GetBucketVersioning", "s3:PutBucketVersioning",
        "s3:GetBucketPublicAccessBlock", "s3:PutBucketPublicAccessBlock",
        "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration",
        "s3:GetBucketTagging", "s3:PutBucketTagging",
        "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:GetObjectTagging", "s3:PutObjectTagging"
      ],
      "Resource": [
        "arn:aws:s3:::tolchester-sailing-site-*",
        "arn:aws:s3:::tolchester-sailing-site-*/*"
      ]
    },
    {
      "Sid": "CloudFront",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateDistribution", "cloudfront:DeleteDistribution",
        "cloudfront:GetDistribution", "cloudfront:UpdateDistribution",
        "cloudfront:TagResource", "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource", "cloudfront:CreateInvalidation",
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:ListOriginAccessControls"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMForOIDC",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:TagRole", "iam:UntagRole", "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider",
        "iam:GetOpenIDConnectProvider", "iam:TagOpenIDConnectProvider",
        "iam:ListOpenIDConnectProviders"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ACM",
      "Effect": "Allow",
      "Action": [
        "acm:RequestCertificate", "acm:DeleteCertificate",
        "acm:DescribeCertificate", "acm:ListCertificates",
        "acm:AddTagsToCertificate", "acm:ListTagsForCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53",
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets", "route53:GetChange",
        "route53:ListHostedZones", "route53:GetHostedZone",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "*"
    }
  ]
}
```
</details>

## File Structure

```
sailing-dashboard/
├── index.html                    # Dashboard HTML
├── style.css                     # Styles
├── base.css                      # Base/reset styles
├── app.js                        # Application logic + polar data
├── deploy.sh                     # Quick-deploy script
├── infra/
│   ├── main.tf                   # S3, CloudFront, OAC, ACM, Route 53
│   ├── github-oidc.tf            # GitHub OIDC provider + IAM role
│   ├── variables.tf              # Input variables
│   ├── outputs.tf                # Output values
│   ├── terraform.tfvars.example  # Template for your config
│   └── README.md                 # This file
└── docs/
    └── AUTOMATION.md             # Copy-paste GitHub Actions templates
                                  # (no live workflows ship in this repo)
```

## Note: GitHub OIDC Provider

AWS allows only one GitHub OIDC provider per account. This stack can either create it or reuse an existing one.

If your account already has the provider, set `github_oidc_provider_arn` in `terraform.tfvars`:

```bash
aws iam list-open-id-connect-providers
```

```hcl
github_oidc_provider_arn = "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
```

That keeps this app stack from taking ownership of shared account-wide identity infrastructure.
