#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# deploy.sh — Sync site files to S3 and invalidate CloudFront cache
#
# Cache strategy (matches data source update cycles):
#   HTML files      → no-cache  (always fresh; small; invalidated on deploy)
#   JS / CSS        → max-age=86400 (1 day; CloudFront invalidation busts on deploy)
#   PDF / images    → max-age=2592000 (30 days; rarely change)
#   Everything else → max-age=86400 (1 day)
#
# Usage:
#   ./deploy.sh              # uses Terraform outputs automatically
#   ./deploy.sh --bucket my-bucket --dist-id E1234ABCDEF
#
# Prerequisites:
#   - AWS CLI v2 configured (aws configure)
#   - Terraform applied (cd infra && terraform apply)
# ──────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="${SCRIPT_DIR}"
INFRA_DIR="${SCRIPT_DIR}/infra"

# ── Parse arguments or pull from Terraform ──

BUCKET=""
DIST_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --bucket)  BUCKET="$2"; shift 2 ;;
    --dist-id) DIST_ID="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$BUCKET" || -z "$DIST_ID" ]]; then
  echo "→ Reading outputs from Terraform..."
  cd "$INFRA_DIR"

  if [[ -z "$BUCKET" ]]; then
    BUCKET=$(terraform output -raw s3_bucket_name 2>/dev/null || true)
  fi
  if [[ -z "$DIST_ID" ]]; then
    DIST_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null || true)
  fi

  cd "$SCRIPT_DIR"
fi

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: Could not determine S3 bucket name."
  echo "  Run: cd infra && terraform apply"
  echo "  Or:  ./deploy.sh --bucket BUCKET_NAME --dist-id DISTRIBUTION_ID"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploying Tolchester Sailing Dashboard"
echo "  Bucket:  s3://${BUCKET}"
echo "  Dist ID: ${DIST_ID:-'(none)'}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Common excludes (applied to every sync pass) ──
# .claude/      — git worktrees and Claude Code internals, never serve to users
# .DS_Store     — macOS metadata files
# infra/        — Terraform config, never public
# .git/         — version control internals
# .github/      — CI config
# node_modules/ — not used, but guard anyway
# deploy.sh     — this script
# eslint.config.mjs — dev tooling
# tests/docs    — test harnesses, build metadata, and docs are not part of the site
# scripts/      — CI-only tooling (chart cache sync), never served

EXCLUDES=(
  "--exclude" ".claude"
  "--exclude" ".claude/*"
  "--exclude" ".claude/**"
  "--exclude" ".DS_Store"
  "--exclude" "infra/*"
  "--exclude" ".git/*"
  "--exclude" ".gitignore"
  "--exclude" ".github/*"
  "--exclude" "node_modules/*"
  "--exclude" "skills/*"
  "--exclude" "scripts/*"
  "--exclude" "deploy.sh"
  "--exclude" "eslint.config.mjs"
  "--exclude" "tests.mjs"
  "--exclude" "sailing_dashboard_tests.html"
  "--exclude" "package.json"
  "--exclude" "package-lock.json"
  "--exclude" "*.md"
  "--exclude" "*.tfvars"
  "--exclude" "*.tfstate*"
  "--exclude" ".terraform/*"
)

echo ""
echo "→ Syncing files to S3..."

# ── 1. HTML — no-cache (small, always want fresh; CloudFront invalidation covers deploys) ──
aws s3 sync "$SITE_DIR" "s3://${BUCKET}" \
  --delete \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html" \
  --exclude "*" \
  --include "*.html" \
  "${EXCLUDES[@]}"

# ── 2. CSS — 1 day (CloudFront invalidation busts on deploy; compress=true on CDN) ──
aws s3 sync "$SITE_DIR" "s3://${BUCKET}" \
  --cache-control "public, max-age=86400" \
  --content-type "text/css" \
  --exclude "*" \
  --include "*.css" \
  "${EXCLUDES[@]}"

# ── 3. JS — 1 day (CloudFront invalidation busts on deploy) ──
aws s3 sync "$SITE_DIR" "s3://${BUCKET}" \
  --cache-control "public, max-age=86400" \
  --content-type "application/javascript" \
  --exclude "*" \
  --include "*.js" \
  "${EXCLUDES[@]}"

# ── 4. PDFs and images — 30 days (static reference material, rarely changes) ──
aws s3 sync "$SITE_DIR" "s3://${BUCKET}" \
  --cache-control "public, max-age=2592000" \
  --exclude "*" \
  --include "*.pdf" \
  --include "*.png" \
  --include "*.jpg" \
  --include "*.jpeg" \
  --include "*.svg" \
  --include "*.ico" \
  --include "*.webp" \
  "${EXCLUDES[@]}"

# ── 5. Everything else (docx, pptx, etc.) — 1 day ──
aws s3 sync "$SITE_DIR" "s3://${BUCKET}" \
  --cache-control "public, max-age=86400" \
  --exclude "*.html" \
  --exclude "*.css" \
  --exclude "*.js" \
  --exclude "*.pdf" \
  --exclude "*.png" \
  --exclude "*.jpg" \
  --exclude "*.jpeg" \
  --exclude "*.svg" \
  --exclude "*.ico" \
  --exclude "*.webp" \
  "${EXCLUDES[@]}"

echo "  ✓ Files synced"

# ── Invalidate CloudFront cache ──

if [[ -n "$DIST_ID" ]]; then
  echo ""
  echo "→ Invalidating CloudFront cache..."
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text)
  echo "  ✓ Invalidation created: ${INVALIDATION_ID}"
  echo "  (Cache clears in ~30-60 seconds)"
else
  echo ""
  echo "⚠ No CloudFront distribution ID — skipping cache invalidation."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Deploy complete!"

if [[ -n "$DIST_ID" ]]; then
  cd "$INFRA_DIR"
  URL=$(terraform output -raw cloudfront_url 2>/dev/null || echo "https://<your-cloudfront-domain>.cloudfront.net")
  CUSTOM=$(terraform output -raw custom_url 2>/dev/null || echo "")
  cd "$SCRIPT_DIR"
  echo "  URL: ${URL}"
  if [[ -n "$CUSTOM" && "$CUSTOM" != *"no custom"* ]]; then
    echo "  Custom: ${CUSTOM}"
  fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
