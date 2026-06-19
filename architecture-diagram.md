# Sailing Dashboard Architecture

```mermaid
flowchart LR
  user["End User Browser"]
  github["GitHub Repo"]
  gha["GitHub Actions\nDeploy Workflow"]
  oidc["GitHub OIDC Token"]
  sts["AWS STS\nAssumeRoleWithWebIdentity"]
  iam["AWS IAM Role\nLeast-Privilege Deploy Role"]
  s3["Amazon S3\nPrivate Static Site Bucket\nVersioning + SSE-S3"]
  oac["CloudFront Origin Access Control"]
  cf["Amazon CloudFront\nCDN + HTTPS"]
  shield["AWS Shield Standard"]
  acm["AWS Certificate Manager\n(us-east-1, optional)"]
  r53["Amazon Route 53\nDNS + Validation Records\n(optional)"]
  noaa["NOAA Tides & Currents API"]
  nws["weather.gov API"]
  ndbc["NDBC Data Feed"]
  maint["Developer Workstation"]
  tf["Terraform"]

  user -->|"HTTPS requests"| cf
  shield --> cf
  cf -->|"Origin fetch via OAC"| oac
  oac --> s3

  r53 -->|"Alias A/AAAA"| cf
  acm -->|"TLS certificate"| cf
  r53 -->|"DNS validation"| acm

  user -->|"Client-side fetch"| noaa
  user -->|"Client-side fetch"| nws
  user -->|"Client-side fetch"| ndbc

  github -->|"push to main / manual dispatch"| gha
  gha --> oidc
  oidc --> sts
  sts --> iam
  iam -->|"aws s3 sync"| s3
  iam -->|"create invalidation"| cf

  maint --> tf
  tf -->|"provisions"| s3
  tf -->|"provisions"| oac
  tf -->|"provisions"| cf
  tf -->|"provisions"| iam
  tf -->|"provisions"| acm
  tf -->|"provisions"| r53
```

## Notes

- Static site files are hosted in Amazon S3 and served publicly only through Amazon CloudFront using Origin Access Control.
- The custom domain path is optional; when enabled, Route 53 aliases the domain to CloudFront and ACM provides the certificate in `us-east-1`.
- GitHub Actions deploys by assuming an AWS IAM role through GitHub OIDC and AWS STS, avoiding stored long-lived AWS keys.
- The browser fetches live sailing data directly from NOAA, NWS, and NDBC APIs; those data calls do not transit AWS infrastructure.
