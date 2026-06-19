# ──────────────────────────────────────────────────────────
# Outputs
# ──────────────────────────────────────────────────────────

output "cloudfront_url" {
  description = "CloudFront distribution URL (always available)"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "custom_url" {
  description = "Custom domain URL (if configured)"
  value       = local.use_custom_domain ? "https://${var.domain_name}" : "(no custom domain configured)"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (needed for cache invalidation)"
  value       = aws_cloudfront_distribution.site.id
}

output "s3_bucket_name" {
  description = "S3 bucket name"
  value       = aws_s3_bucket.site.id
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.site.arn
}
