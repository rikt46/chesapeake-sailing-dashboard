# ──────────────────────────────────────────────────────────
# GitHub Actions OIDC → AWS IAM Role
#
# This lets GitHub Actions deploy to S3/CloudFront without
# storing any AWS access keys. GitHub's OIDC provider issues
# a short-lived token that AWS trusts via this role.
#
# The trust policy restricts access to:
#   - Only the specific repo (set github_repo to your "owner/name")
#   - Only the main branch
# ──────────────────────────────────────────────────────────

variable "github_repo" {
  description = "GitHub repo in 'owner/name' format"
  type        = string
  default     = "your-github-username/your-repo"
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN to reuse instead of creating the account-wide singleton in this stack"
  type        = string
  default     = ""
}

# ── OIDC Identity Provider ──
# Only one of these exists per AWS account. If you already have one
# (e.g., from another project), import it:
#   terraform import aws_iam_openid_connect_provider.github arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == "" ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC thumbprint — required by AWS but not actually used
  # for validation (AWS validates the cert chain directly)
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]

  tags = var.tags
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn != "" ? 1 : 0
  arn   = var.github_oidc_provider_arn
}

# ── IAM Role for GitHub Actions ──

data "aws_caller_identity" "current" {}

locals {
  github_oidc_provider_arn = var.github_oidc_provider_arn != "" ? data.aws_iam_openid_connect_provider.github[0].arn : aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "github_actions" {
  name = "${var.project_name}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = local.github_oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Only allow the main branch of this specific repo
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
          }
        }
      }
    ]
  })

  tags = var.tags
}

# ── Policy: S3 deploy + CloudFront invalidation (least privilege) ──

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "${var.project_name}-deploy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3Sync"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.site.arn,
          "${aws_s3_bucket.site.arn}/*"
        ]
      },
      {
        Sid    = "CloudFrontInvalidate"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation"
        ]
        Resource = aws_cloudfront_distribution.site.arn
      }
    ]
  })
}

# ── Outputs ──

output "github_actions_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (add this to your workflow)"
  value       = aws_iam_role.github_actions.arn
}
