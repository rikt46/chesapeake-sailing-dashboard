# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed
- Current phase and the next slack or max are chosen in the station time zone
  (`DASHBOARD_TIME_ZONE`) instead of the browser's local hour. (#20)

## [1.1.0] - 2026-11-12

First tagged release since v1.0.0. It also carries the 1.0.1 changes below,
which were never tagged on their own.

### Added
- CI workflow running `npm test` under UTC and America/New_York, plus
  `npm run lint`, on pull requests and pushes to `main`. Read-only, no secrets.
  (#17)
- `engines` field requiring Node.js 24 or newer, matching CI (#33)
- Community health files: CONTRIBUTING, CODE_OF_CONDUCT, issue and pull
  request templates, and a station-ID table in the README for forks
- Regression test that a partial auto-refresh keeps the failure status of
  sources it did not re-fetch (#34)

### Changed
- Project renamed to **MySailingPlan Dashboard**, with Tolchester as the
  configured location. Page title, header, manifest, README, deploy banner and
  infra comments updated (#18)
- MySailingPlan copy in the README and the in-app Reference card no longer
  lists sailability scoring and current-opposition alerts as paid features,
  since this dashboard already ships both (#19)
- `app.js` split into focused `src/` modules. No behavior change (#12)
- Issue templates apply the new triage labels (#31)
- ESLint globals trimmed to the two libraries the page loads, Chart.js and
  Leaflet (#32)
- SECURITY.md now states that only the latest release is supported
- Contributor docs no longer hard-code the test count
- Project scope documented in `docs/SCOPE.md` and linked from README and
  CONTRIBUTING

## 1.0.1 - 2026-06-22 (never tagged; shipped in 1.1.0)

### Added
- MySailingPlan callout in README — hosted platform for any boat on the Chesapeake
- MySailingPlan link in the Reference settings card inside the dashboard

### Fixed
- Removed duplicate `<meta name="theme-color">` from `index.html`; the
  manifest's `theme_color` already covers this and the meta tag is not
  supported by Firefox or Opera

## [1.0.0] - 2026-06-20

### Added
- Initial public release
- Live NOAA wind, tide, water temperature, and water level (Station 8573364)
- NDBC TCBM2 meteorological observations (6-min updates)
- NWS hourly and daily forecast (PHI/17,37)
- Polar-tuned go / reduce-sail / no-go recommendation (Pearson 31-2)
- Sailability scoring 0–100 (speed + comfort + weather composite)
- 5-day outlook strip — tap any day to shift all panels
- Keel clearance and depth windows (5.8 ft draft, 5.5 ft charted MLLW)
- Float plan pre-departure checklist
- NOAA tidal current predictions (Brewerton Channel)
- CBIBS / NDBC bay buoy observations (Annapolis)
- NWS marine alerts and zone forecast
- EPA UV index forecast
- USCG Local Notice to Mariners (Chesapeake Bay, ~20 NM radius)
- Hourly wind + tide Chart.js charts
- Nautical chart with locally cached NOAA tiles and Leaflet live fallback
- Simple view — stripped-down go/no-go for quick reads
- Dark / light theme toggle, persisted to localStorage
- PWA web app manifest for home-screen install (iOS and Android)
- Crew / safety mode toggles (solo, double, crewed; standard, conservative)
- S3 + CloudFront hosting via Terraform (`infra/`)
- GitHub Actions deploy template — OIDC, no stored AWS keys (`docs/AUTOMATION.md`)

[Unreleased]: https://github.com/rikt46/chesapeake-sailing-dashboard/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/rikt46/chesapeake-sailing-dashboard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rikt46/chesapeake-sailing-dashboard/releases/tag/v1.0.0
