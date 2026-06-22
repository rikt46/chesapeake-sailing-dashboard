# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.1] - 2026-06-22

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
