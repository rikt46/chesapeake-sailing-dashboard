# Security Policy

This is a personal, static sailing dashboard for the Pearson 31-2 on the
Chesapeake Bay. It is a single-page site (HTML/CSS/vanilla JS) hosted on
S3 + CloudFront; it has no backend, no user accounts, and stores no user data.
Only the `main` branch is deployed, so the live site always reflects the latest
commit — there are no separately maintained release versions.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately rather than opening a public
issue:

- Use GitHub's **private vulnerability reporting** for this repository:
  Security → "Report a vulnerability"
  (<https://github.com/rikt46/chesapeake-sailing-dashboard/security/advisories/new>).

When reporting, include the affected file or URL, reproduction steps, and the
impact you observed. As a personal project this is maintained on a best-effort
basis — expect an initial acknowledgement within about a week.

## Scope and notes

- The dashboard reads only public NOAA/NWS/EPA/USCG feeds. Any API keys present
  in client-side code (e.g. the CBIBS buoy key) are public, free-tier tokens
  that are necessarily exposed in a static site; they grant no access to this
  project's infrastructure.
- Deployment (when configured — see `docs/AUTOMATION.md`) uses GitHub Actions
  OIDC scoped to a single repo/branch with a least-privilege IAM role, so there
  are no long-lived AWS credentials in
  the repository.
