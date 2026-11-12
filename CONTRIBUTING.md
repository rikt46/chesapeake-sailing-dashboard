# Contributing

Thanks for your interest. This is a personal single-boat dashboard, but
contributions that improve adaptability, correctness, or test coverage are
welcome.

## Development setup

Use Node.js 24 or newer. CI runs on Node.js 24.

```bash
npm install        # dev deps only (eslint, jsdom) — no build step
npm test           # unit test suite
npm run test:live  # same + live API calls (LIVE_API=1)
npm run lint       # eslint
```

Open `index.html` directly in a browser to see the dashboard — no dev server
required.

## What's in scope

This project stays a focused dashboard for one boat at one location. Read
[`docs/SCOPE.md`](docs/SCOPE.md) before starting a feature.

- **Always welcome:** bug and accuracy fixes, tests, accessibility,
  performance, documentation, security hardening, refactoring, and making
  `src/config.js` easier to fork.
- **Out of scope:** multiple boats or locations, accounts, saved plans, crew
  sharing, departure-time search, polar import, notifications, anything that
  needs a backend, and frameworks or a build step.
- **Owner decides:** new data sources, UI redesign, offline mode.

Changes to wind, gust, depth or alert thresholds, to stale or failed source
display, or to the advisory disclaimer are safety-critical and need the
owner's sign-off.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep it focused — one concern per PR.
3. Run `npm test` and `npm run lint` and ensure both pass.
4. Open a pull request. Fill out the PR template.

There are no stored AWS credentials in this repo, and the deploy workflow is
provided as a copy-paste template (see `docs/AUTOMATION.md`) — you don't need
AWS access to contribute.

## Reporting a bug

Use the **Bug report** issue template. Include the browser, the data source
that looks wrong, and the expected vs. actual value.

## Suggesting a feature

Check [`docs/SCOPE.md`](docs/SCOPE.md), then open a **Feature request** issue.
Describe the use case before writing code — it's easier to redirect an idea
than a diff.
