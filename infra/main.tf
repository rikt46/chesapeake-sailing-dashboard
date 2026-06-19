# ──────────────────────────────────────────────────────────
# Tolchester Sailing Dashboard — AWS Static Hosting
#
# Architecture:
#   S3 (private) → CloudFront (OAC) → optional custom domain
#
# Cost estimate: < $0.50/month for personal use
# ──────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket  = "tolchester-sailing-tfstate"
    key     = "sailing-dashboard/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
}

# ACM certificates for CloudFront MUST be in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# ──────────────────────────────────────────────────────────
# Locals
# ──────────────────────────────────────────────────────────

locals {
  use_custom_domain = var.domain_name != ""
  bucket_name       = "${var.project_name}-site-${random_id.suffix.hex}"
}

resource "random_id" "suffix" {
  byte_length = 4
}

# ──────────────────────────────────────────────────────────
# S3 Bucket — private, no public access
# ──────────────────────────────────────────────────────────

resource "aws_s3_bucket" "site" {
  bucket = local.bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Expire old noncurrent object versions after 7 days to control storage costs.
# Current (live) versions are kept indefinitely; only superseded versions are cleaned up.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {
      prefix = "" # apply to all objects
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    # Also clean up incomplete multipart uploads after 1 day
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Upload site files to S3
# ──────────────────────────────────────────────────────────
# CloudFront Origin Access Control (OAC)
# ──────────────────────────────────────────────────────────

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.project_name}-oac"
  description                       = "OAC for ${var.project_name} S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 bucket policy — allow CloudFront OAC only
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
          }
        }
      }
    ]
  })
}

# ──────────────────────────────────────────────────────────
# ACM Certificate (only if custom domain is set)
# ──────────────────────────────────────────────────────────

resource "aws_acm_certificate" "site" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
    # Guard against an empty domain_name (e.g. a checkout with no tfvars)
    # silently planning to destroy the live certificate.
    prevent_destroy = true
  }

  tags = var.tags
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_custom_domain ? {
    (var.domain_name) = one(aws_acm_certificate.site[0].domain_validation_options)
  } : {}

  allow_overwrite = true
  name            = each.value.resource_record_name
  records         = [each.value.resource_record_value]
  ttl             = 60
  type            = each.value.resource_record_type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "site" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ──────────────────────────────────────────────────────────
# CloudFront Security Response Headers
#
# The page-level <meta> CSP in index.html covers script/style/connect-src, but a
# few protections can only be delivered as real HTTP response headers:
#   - HSTS              (force HTTPS on repeat visits)
#   - X-Content-Type-Options: nosniff
#   - Referrer-Policy
#   - frame-ancestors / X-Frame-Options  (anti-clickjacking — NOT settable via <meta>)
# ──────────────────────────────────────────────────────────

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${var.project_name}-security-headers"
  comment = "Security headers for the sailing dashboard"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000 # 1 year
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      # Only frame-ancestors here — the rest of the CSP lives in the page <meta>.
      # frame-ancestors cannot be expressed via <meta>, so it must be a header.
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }
  }
}

# ──────────────────────────────────────────────────────────
# CloudFront Distribution
# ──────────────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  is_ipv6_enabled = true
  # Serve the dashboard shell at the origin root only; do not rewrite asset 404s.
  default_root_object = "index.html"
  comment             = "Tolchester Sailing Dashboard"
  price_class         = "PriceClass_100" # US, Canada, Europe only — cheapest

  aliases = local.use_custom_domain ? [var.domain_name] : []

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-${local.bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "s3-${local.bucket_name}"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600  # 1 hour — good for a weather dashboard
    max_ttl                = 86400 # 1 day
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # Use custom cert if domain is set, otherwise CloudFront default
    cloudfront_default_certificate = local.use_custom_domain ? false : true
    acm_certificate_arn            = local.use_custom_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  tags = var.tags
}

# ──────────────────────────────────────────────────────────
# Route 53 DNS Record (only if custom domain is set)
# ──────────────────────────────────────────────────────────

resource "aws_route53_record" "site" {
  count = local.use_custom_domain ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }

  lifecycle {
    # Guard against an empty domain_name silently tearing down the live A record.
    prevent_destroy = true
  }
}

# IPv6 AAAA record
resource "aws_route53_record" "site_ipv6" {
  count = local.use_custom_domain ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }

  lifecycle {
    # Guard against an empty domain_name silently tearing down the live AAAA record.
    prevent_destroy = true
  }
}
