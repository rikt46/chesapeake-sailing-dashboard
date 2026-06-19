# Automation (GitHub Actions)

**This repository intentionally ships no GitHub Actions workflows**, so forking
or pushing to it triggers nothing. The two workflows below are provided as
copy-paste templates. Add whichever you want to your own fork under
`.github/workflows/`.

Both use **GitHub OIDC** to assume an AWS IAM role — there are no long-lived AWS
keys to store. The role, S3 bucket, and CloudFront distribution are created by
the Terraform in [`../infra/`](../infra/); see [`../infra/README.md`](../infra/README.md).

## Prerequisites

1. Apply the Terraform in `infra/` (creates the bucket, distribution, and the
   GitHub Actions IAM role).
2. Point the OIDC trust at *your* repo: set `github_repo = "your-username/your-repo"`
   in `infra/terraform.tfvars`, then `terraform apply`.
3. Add these **repository Variables** (Settings → Secrets and variables →
   Actions → *Variables* tab — these are non-secret, no credentials):

   | Variable | Source (Terraform output) |
   |---|---|
   | `AWS_ROLE_ARN` | `github_actions_role_arn` |
   | `S3_BUCKET_NAME` | `s3_bucket_name` |
   | `CLOUDFRONT_DIST_ID` | `cloudfront_distribution_id` |

---

## 1. Deploy on push to `main`

Runs the test suite (under both UTC and `America/New_York` to catch timezone
regressions), then syncs the site to S3 and invalidates CloudFront. The deploy
job never runs on pull requests.

Save as `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]
    paths:
      - "*.html"
      - "*.css"
      - "*.js"
      - "*.mjs"
      - "package.json"
      - "package-lock.json"
      - "!infra/**"
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  test:
    name: Unit tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    strategy:
      fail-fast: false
      matrix:
        tz: ["UTC", "America/New_York"]
    env:
      TZ: ${{ matrix.tz }}
    steps:
      - uses: actions/checkout@v6
      - run: npm ci
      - run: npm run lint
      - run: npm test

  deploy:
    name: Sync to S3 & Invalidate CloudFront
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: test
    if: github.event_name != 'pull_request'
    steps:
      - uses: actions/checkout@v6
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - name: Deploy site
        run: |
          bash ./deploy.sh \
            --bucket "${{ vars.S3_BUCKET_NAME }}" \
            --dist-id "${{ vars.CLOUDFRONT_DIST_ID }}"
      - name: Done
        run: echo "Dashboard deployed (CloudFront cache clears in ~30-60s)"
```

---

## 2. Refresh the NOAA chart-tile cache (scheduled)

Hourly job that pulls one Chesapeake Bay NOAA chart tile per run (throttled in
[`../scripts/sync_noaa_chart_cache.mjs`](../scripts/sync_noaa_chart_cache.mjs)),
writes it to S3, and invalidates the cached path. Optional — only needed if you
serve cached NOAA chart tiles from your own bucket.

Save as `.github/workflows/refresh-chart-cache.yml`:

```yaml
name: Refresh NOAA Chart Cache

on:
  schedule:
    - cron: "0 * * * *"   # hourly; pairs with the one-tile-per-run throttle
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  refresh-cache:
    name: Refresh and publish chart cache
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - name: Seed local chart cache from S3
        run: |
          mkdir -p ./chart-cache/noaa
          aws s3 sync s3://${{ vars.S3_BUCKET_NAME }}/chart-cache/noaa ./chart-cache/noaa \
            --region us-east-1
      - name: Run NOAA tile sync locally
        env:
          CHART_CACHE_DIR: chart-cache/noaa
        run: node ./scripts/sync_noaa_chart_cache.mjs
      - name: Sync chart cache to S3
        run: |
          aws s3 sync ./chart-cache/noaa s3://${{ vars.S3_BUCKET_NAME }}/chart-cache/noaa \
            --cache-control 'public, max-age=604800, stale-while-revalidate=86400' \
            --region us-east-1
      - name: Invalidate CloudFront chart cache path
        run: |
          aws cloudfront create-invalidation \
            --distribution-id "${{ vars.CLOUDFRONT_DIST_ID }}" \
            --paths "/chart-cache/noaa/*"
```

---

## Continuous integration only (no deploy)

If you want tests to run on pull requests without granting any AWS access, keep
just the `test` job from the deploy workflow and drop the `deploy` job and the
`permissions:` / `id-token` block.
