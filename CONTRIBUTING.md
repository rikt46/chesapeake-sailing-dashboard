# Contributing

Thanks for your interest. This is a personal single-boat dashboard, but
contributions that improve adaptability, correctness, or test coverage are
welcome.

## Development setup

```bash
npm install        # dev deps only (eslint, jsdom) — no build step
npm test           # unit test suite (115 tests)
npm run test:live  # same + live API calls (LIVE_API=1)
npm run lint       # eslint
```

Open `index.html` directly in a browser to see the dashboard — no dev server
required.

## What's in scope

- **Bug fixes** — data parsing, recommendation logic, UI glitches
- **Test coverage** — new tests for edge cases in `src/` modules
- **Adaptability** — making `src/config.js` easier to fork for other boats/locations
- **Documentation** — clearer fork guidance, correcting stale info

Out of scope: adding new data sources, redesigning the UI, or adding features
that require a backend. If you have a feature idea, open a discussion issue
first.

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

Open a **Feature request** issue. For larger changes, describe the use case
before writing code — it's easier to redirect an idea than a diff.
