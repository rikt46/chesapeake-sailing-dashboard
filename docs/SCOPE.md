# Project scope

This is a free, MIT-licensed dashboard for **one boat at one location**: a
Pearson 31-2 sailing out of Tolchester on the Chesapeake Bay. It shows what the
approach can do, is honest about its limits, and points sailors who want more
to [MySailingPlan.com](https://mysailingplan.com), the hosted version for any
boat on the Bay.

Use this page to decide whether a change belongs here before you write code.

## In scope

- Live and forecast conditions for the configured location, from free public
  sources (NWS, NOAA CO-OPS, NDBC, CBIBS, EPA UV, NOAA charts, USCG notices).
- Advice for the configured boat: sail plan, depth windows, tide and current,
  a five-day outlook and a briefing, including the sailability score and
  wind-against-current warnings the dashboard already ships.
- Clear signs when data is stale or a source has failed, with recommendations
  held back when key sources are missing.
- Forking: adapting [`src/config.js`](../src/config.js) for another boat and
  stretch of water using the README alone.
- A static site only. No backend, no accounts, no build step.

**Always welcome, no scope discussion needed:** bug and accuracy fixes, tests,
accessibility, performance, documentation, security hardening, refactoring,
fork-guide improvements, and corrections to existing station IDs or data
source endpoints.

## Out of scope

| Request | Why |
|---|---|
| More than one boat, or choosing a boat in the app | Multi-boat support is what MySailingPlan offers |
| More than one location, or choosing a location in the app | Forks cover one other location each; any location is MySailingPlan |
| User accounts, sign-in, saved plans, crew sharing | Needs a backend; offered by MySailingPlan |
| Searching for or ranking departure times | Offered by MySailingPlan |
| Importing custom or ORC polars | Offered by MySailingPlan |
| Alerts, push, email or SMS notifications | Needs a backend |
| Any server, database, serverless function, or API key that must be kept secret | Breaks the static, fork-for-free model |
| Frameworks, bundlers or a build step | Makes forking harder |

## Owner decides, case by case

The default answer is no unless the owner agrees.

- **New data sources.** Each one adds a CSP host and a new way to fail.
- **UI redesign**, including reducing the number of sections (#29).
- **Offline mode or a service worker** (#9, deferred). Only acceptable if
  cached data is clearly marked stale and no recommendation is made from it.

## Safety-critical changes

This dashboard informs a go/no-go decision. A change that loosens a wind, gust,
depth or alert threshold, hides a stale or failed data source, or removes the
advisory disclaimer needs the owner's written sign-off on that specific change.
These PRs get the `safety-critical` label.

## How decisions are recorded

Each scope decision is logged in the pinned
[roadmap issue](https://github.com/rikt46/chesapeake-sailing-dashboard/issues/30)
with the proposal, verdict, reason and date. If your idea is out of scope here,
we'll say so, thank you, and point you to MySailingPlan if it offers the
feature.
