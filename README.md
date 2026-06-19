# Tolchester Sailing Dashboard

A personal, single-page sailing dashboard for a **Pearson 31-2** sailing the
upper **Chesapeake Bay** out of Tolchester Beach, MD. It pulls live wind, tide,
current, weather, and notice-to-mariners data from public NOAA / NWS / EPA /
USCG feeds and turns it into an at-a-glance go / reduce-sail / no-go
recommendation tuned to the boat's polars and the skipper's crew/safety mode.

It's a static site — plain HTML, CSS, and vanilla ES-module JavaScript, no
backend and no build step — designed to be hosted on S3 + CloudFront.

## Tech overview

- **Frontend:** vanilla JS ES modules ([`app.js`](app.js) + [`src/`](src/)),
  no framework, no bundler.
- **Data:** browser fetches directly from NOAA Tides & Currents, weather.gov
  (NWS), NDBC, EPA UV, and USCG feeds — none of it transits a backend.
- **Hosting:** private S3 bucket served via CloudFront (Origin Access Control),
  optional Route 53 + ACM custom domain.
- **Deploy:** GitHub Actions assumes an AWS IAM role via OIDC (no stored AWS
  keys); see [`infra/`](infra/) and [`architecture-diagram.md`](architecture-diagram.md).

## Make it your own

This dashboard is hard-tuned to one boat and one stretch of water. To adapt it,
edit [`src/config.js`](src/config.js) — it holds, in one place:

- **Location & timezone** — `DASHBOARD_LOCATION`, `DASHBOARD_TIME_ZONE`.
- **Data stations** — NOAA tide/current station IDs, the NDBC wind station,
  NWS forecast grid and marine zones, UV ZIP, etc.
- **Boat model** — the Pearson 31-2 polar table (`POLAR_*`), hull speed, keel
  draft / depth constraints, and the sail-plan wind thresholds.
- **Crew & safety modes** — wind offsets applied to the recommendation.

### CBIBS API key

`src/config.js` ships a **public, free-tier** CBIBS (Chesapeake Bay buoy) API
key. Because this is a static site the key is necessarily visible in client-side
code; it grants no access to this project's infrastructure. If you fork this,
please request your own free key rather than reusing it, so you're not sharing a
rate limit: <https://buoybay.noaa.gov/data/api>.

## Develop & test

```bash
npm install        # dev deps only (eslint, jsdom)
npm test           # run the test suite (tests.mjs)
npm run test:live  # run tests against live APIs (LIVE_API=1)
npm run lint       # eslint
```

There's no dev server — open `index.html` in a browser, or serve the directory
with any static file server.

## Deploy your own copy

The whole AWS footprint is Terraform in [`infra/`](infra/). In short:

1. `cp infra/terraform.tfvars.example infra/terraform.tfvars` and fill in your
   own `domain_name`, `route53_zone_id`, region, etc. (`terraform.tfvars` is
   gitignored — keep your real values out of version control).
2. `cd infra && terraform init && terraform apply`.
3. Run [`deploy.sh`](deploy.sh) locally, or set up the optional GitHub Actions
   automation described in [`docs/AUTOMATION.md`](docs/AUTOMATION.md).

See [`infra/README.md`](infra/README.md) for the full walkthrough.

> **Note:** this public repo ships **no GitHub Actions workflows**, so nothing
> deploys or runs automatically when you fork it. The deploy and chart-cache
> automation are provided as copy-paste templates in
> [`docs/AUTOMATION.md`](docs/AUTOMATION.md) — add them to your own fork if you
> want push-to-deploy.

## License

[MIT](LICENSE) © rikt46
