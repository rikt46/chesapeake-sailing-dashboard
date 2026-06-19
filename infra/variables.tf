# ──────────────────────────────────────────────────────────
# Variables — set in terraform.tfvars or via CLI
# ──────────────────────────────────────────────────────────

variable "project_name" {
  description = "Short slug used for resource naming (e.g. tolchester-sailing)"
  type        = string
  default     = "tolchester-sailing"
}

variable "domain_name" {
  description = "Custom domain for the site"
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for your domain"
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "AWS region for the S3 bucket (CloudFront is global)"
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    Project   = "tolchester-sailing"
    ManagedBy = "terraform"
  }
}
