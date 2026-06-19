#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// tests.mjs — CI-ready test runner (Node 18+, zero dependencies)
//
// Unit test failures  → exit 1 (blocks deploy)
// Live API failures   → warning only (network may be flaky in CI)
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import { JSDOM } from "jsdom";
import { dashboardTestExports as dashboard } from "./app.js";

let pass = 0, fail = 0, warn = 0, skipped = 0;
const failures = [];

// Live API tests hit real NOAA/NWS endpoints over the network. They are off by
// default so `npm test` is hermetic and deterministic (a NOAA outage must not
// fail an unrelated PR). Run them explicitly with `LIVE_API=1 npm test`.
const LIVE_API = process.env.LIVE_API === "1";

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function run(name, fn) {
  try {
    const note = fn();
    pass++;
    console.log(`  ✓  ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗  ${name}`);
    console.log(`       ${e.message}`);
  }
}

async function runAsync(name, fn) {
  try {
    const note = await fn();
    pass++;
    console.log(`  ✓  ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗  ${name}`);
    console.log(`       ${e.message}`);
  }
}

async function runLive(name, fn) {
  if (!LIVE_API) {
    skipped++;
    return;
  }
  try {
    const note = await fn();
    pass++;
    console.log(`  ✓  ${name}${note ? ` (${note})` : ''}`);
  } catch (e) {
    warn++;
    console.log(`  ⚠  ${name} [WARN — live API]`);
    console.log(`       ${e.message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ─`);
}

// ─── Functions under test ────────────────────────────────────────────────────
// app.js is imported once as an ES module (see top of file). With no `document`
// in Node it skips its DOM boot and only evaluates the exported functions.
//
// Date-dependent code reads the global `Date` at call time — getDateContext()
// recomputes on every call rather than caching — so a test can pin "now" by
// swapping globalThis.Date around the call and restoring it afterward. No module
// reload is needed. run() is synchronous, so this helper stays synchronous too.
function withFakeDate(FakeDate, fn) {
  const RealDate = globalThis.Date;
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}
const localDateStr = dashboard.fmtDate;
const localDateCompact = dashboard.fmtDateCompact;
const determineSailPlan = (effectiveWind, effectiveGust, opts = {}) => {
  dashboard.setUserSettingsForTests({
    crewMode: opts.crewMode || "double",
    safetyMode: opts.safetyMode || "standard",
  });
  return dashboard.determineSailPlan(
    effectiveWind,
    effectiveGust,
    opts.maxRainSev || 0,
    opts.hasChopPenalty || false,
    opts.hasCurrentOpposition || false
  ).key;
};
const parseWindMph = dashboard.parseWindMph;
const mphToKnots = dashboard.mphToKnots;
const polarBoatSpeed = dashboard.polarBoatSpeed;
const avgPolarSpeed = dashboard.avgPolarSpeed;
const scoreSailability = dashboard.scoreSailability;
const describeReadiness = dashboard.describeReadiness;
const isHardMarineAlert = dashboard.isHardMarineAlert;
const isSmallCraftAdvisory = dashboard.isSmallCraftAdvisory;
const shouldSmallCraftAdvisoryForceHarbor = dashboard.shouldSmallCraftAdvisoryForceHarbor;
const applySmallCraftAdvisorySailPlan = dashboard.applySmallCraftAdvisorySailPlan;
const buildRiskDecisionExplanation = dashboard.buildRiskDecisionExplanation;
const buildSimpleDaySummary = dashboard.buildSimpleDaySummary;
const getDefaultFloatPlan = dashboard.getDefaultFloatPlan;
const getFloatPlanReadiness = dashboard.getFloatPlanReadiness;
const assessDay = dashboard.assessDay;
const getMarineAlertsForDay = dashboard.getMarineAlertsForDay;
const normalizeCurrentPredictionEvents = dashboard.normalizeCurrentPredictionEvents;
const getCurrentPredictionPhase = dashboard.getCurrentPredictionPhase;
const summarizeCurrentPrediction = dashboard.summarizeCurrentPrediction;
const normalizeCbibsStation = dashboard.normalizeCbibsStation;
const getBayBuoyReality = dashboard.getBayBuoyReality;
const ndbcLatestToCbibsVariables = dashboard.ndbcLatestToCbibsVariables;
const parseCoastalWatersForecast = dashboard.parseCoastalWatersForecast;
const parseMarineForecastText = dashboard.parseMarineForecastText;
const getMarineForecastForDay = dashboard.getMarineForecastForDay;
const isStormRelatedAlert = dashboard.isStormRelatedAlert;
const getStormOutlookForDay = dashboard.getStormOutlookForDay;
const normalizeUvForecast = dashboard.normalizeUvForecast;
const getUvForDay = dashboard.getUvForDay;
const paginateNtmAlerts = dashboard.paginateNtmAlerts;
const getNoGoBlocker = dashboard.getNoGoBlocker;
const buildSourceStatus = dashboard.buildSourceStatus;
const getObservationFreshnessSummary = dashboard.getObservationFreshnessSummary;
const getRecommendationBlockers = dashboard.getRecommendationBlockers;
const getRecommendationGate = dashboard.getRecommendationGate;
const buildNoaaLiveTileUrl = dashboard.buildNoaaLiveTileUrl;
const buildLocalChartTileUrl = dashboard.buildLocalChartTileUrl;
const latLonToTileCoords = dashboard.latLonToTileCoords;
const renderNowBar = dashboard.renderNowBar;
const HULL_SPEED = 6.76;

function degToCard(d) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(d / 22.5) % 16];
}

function windColor(kt) {
  if (kt >= 25) return '#f05a5f';
  if (kt >= 15) return '#f0bc2e';
  if (kt >= 8)  return '#3a9fd6';
  return '#2ea84f';
}

function buildAssessDayFixture(overrides = {}) {
  const dateStr = overrides.dateStr || '2026-04-05';
  const windDirection = overrides.windDirection || 'E';
  const windSpeed = overrides.windSpeed || '12 mph';
  const shortForecast = overrides.shortForecast || 'Mostly sunny';
  const hourlyPeriods = Array.from({ length: 11 }, (_, index) => {
    const hour = 8 + index;
    return {
      startTime: `${dateStr}T${String(hour).padStart(2, '0')}:00:00-04:00`,
      windSpeed,
      windDirection,
      shortForecast,
    };
  });
  const forecastPeriods = [{ name: 'Sunday', shortForecast }];
  const tides = {
    predictions: [
      { t: `${dateStr} 04:00`, v: '0.2', type: 'L' },
      { t: `${dateStr} 10:00`, v: '1.2', type: 'H' },
      { t: `${dateStr} 16:00`, v: '0.2', type: 'L' },
      { t: `${dateStr} 22:00`, v: '1.2', type: 'H' },
    ],
  };
  const tideHourly = {
    predictions: Array.from({ length: 24 }, (_, hour) => ({
      t: `${dateStr} ${String(hour).padStart(2, '0')}:00`,
      v: '1.0',
    })),
  };
  const marineAlerts = {
    features: overrides.alertEvent
      ? [{
        properties: {
          event: overrides.alertEvent,
          onset: `${dateStr}T07:00:00-04:00`,
          ends: `${dateStr}T20:00:00-04:00`,
        },
      }]
      : [],
  };
  return {
    hourlyPeriods,
    forecastPeriods,
    tides,
    tideHourly,
    currentPredictions: { predictions: [] },
    marineAlerts,
    uvForecast: [],
    gustRatio: overrides.gustRatio || 1.3,
    dateStr,
    dayName: 'Sunday',
  };
}

function assessFixture(overrides = {}) {
  const fixture = buildAssessDayFixture(overrides);
  return assessDay(
    fixture.hourlyPeriods,
    fixture.forecastPeriods,
    fixture.tides,
    fixture.tideHourly,
    fixture.currentPredictions,
    fixture.marineAlerts,
    fixture.uvForecast,
    fixture.gustRatio,
    fixture.dateStr,
    fixture.dayName
  );
}

function gonogoClass(alerts, maxGust) {
  if (alerts.some((alert) => isHardMarineAlert(alert.event))) return 'nogo';
  if (alerts.some((alert) => isSmallCraftAdvisory(alert.event))) return 'caution';
  if (maxGust >= 20) return 'caution';
  return 'go';
}

function parseTidesForToday(tides, todayStr) {
  return tides.filter(t => t.t.slice(0, 10) === todayStr);
}

function findNextTide(tides, now) {
  const sorted = [...tides].sort((a, b) => new Date(a.t.replace(' ', 'T')) - new Date(b.t.replace(' ', 'T')));
  for (const t of sorted) {
    if (new Date(t.t.replace(' ', 'T')) > now) return t;
  }
  return null;
}

function findCurrentTideDirection(tides, now) {
  const sorted = [...tides].sort((a, b) => new Date(a.t.replace(' ', 'T')) - new Date(b.t.replace(' ', 'T')));
  let last = null;
  for (const t of sorted) {
    if (new Date(t.t.replace(' ', 'T')) > now) break;
    last = t;
  }
  if (!last) return 'rising';
  return last.type === 'L' ? 'rising' : 'falling';
}

async function loadPolarDomWithMocks(options = {}) {
  const htmlPath = new URL("./Pearson 31-2 Polar.html", import.meta.url);
  const source = fs.readFileSync(htmlPath, "utf8");
  const sanitized = source.replace(/<script data-pplx-inline-edit>[\s\S]*?<\/script>/, "");

  const stationUrl = "https://api.weather.gov/stations/KTEST";
  // NDBC realtime2 text format: YY MM DD hh mm WDIR WSPD GST ...
  const TCBM2_MOCK_TEXT = [
    "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
    "#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft",
    "2026 06 04 18 22 225  2.65 3.70    MM    MM    MM  MM 1015.0  27.5  23.5    MM   MM   MM    MM",
  ].join("\n");
  const { failTideCurrent = false, tcbm2Body = TCBM2_MOCK_TEXT } = options;
  const responses = {
    "https://www.ndbc.noaa.gov/data/realtime2/TCBM2.txt": tcbm2Body,
    "https://api.weather.gov/points/39.2085,-76.2455": {
      properties: {
        observationStations: "https://api.weather.gov/stations?point=test",
        forecastHourly: "https://api.weather.gov/gridpoints/PHI/17,37/forecast/hourly",
      },
    },
    "https://api.weather.gov/stations?point=test": {
      observationStations: [stationUrl],
    },
    [`${stationUrl}/observations/latest`]: {
      properties: {
        station: stationUrl,
        timestamp: "2026-06-04T14:22:00-04:00",
        windSpeed: { value: 5.14 },
        windGust: { value: 7.2 },
        windDirection: { value: 225 },
        temperature: { value: 24.2 },
      },
    },
    "https://api.weather.gov/gridpoints/PHI/17,37/forecast/hourly": {
      properties: {
        periods: [
          {
            startTime: "2026-06-04T14:00:00-04:00",
            windSpeed: "10 mph",
            windDirection: "SW",
            temperature: 75,
          },
        ],
      },
    },
    "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=pearson_polar&date=today&datum=MLLW&station=8573364&time_zone=lst_ldt&units=english&interval=hilo&format=json": {
      predictions: [
        { t: "2099-01-01 10:30", type: "H" },
        { t: "2099-01-01 16:25", type: "L" },
      ],
    },
    "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=pearson_polar&date=today&station=cb1202&time_zone=lst_ldt&units=english&interval=max_slack&bin=1&format=json": {
      current_predictions: {
        cp: [
          { Time: "2099-01-01 09:10", Type: "Slack" },
          { Time: "2099-01-01 12:00", Type: "Max Flood", Velocity_Major: "0.8" },
        ],
      },
    },
  };

  // Records every requested URL so tests can assert the params NOAA actually
  // accepts (no begin_date=today). failTideCurrent simulates NOAA's CORS-masked
  // error by rejecting those fetches, to prove wind still renders independently.
  const requestedUrls = [];
  const isTideOrCurrent = (url) =>
    url.includes("product=predictions") || url.includes("product=currents_predictions");

  const mockFetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url || "");
    requestedUrls.push(url);
    if (failTideCurrent && isTideOrCurrent(url)) {
      throw new TypeError("Failed to fetch");
    }
    if (!(url in responses)) {
      return new Response(JSON.stringify({ error: `Unhandled test URL: ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const body = responses[url];
    // Plain-text responses (e.g. NDBC realtime2) are stored as strings directly.
    const isText = typeof body === "string";
    return new Response(isText ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": isText ? "text/plain" : "application/json" },
    });
  };

  const dom = new JSDOM(sanitized, {
    runScripts: "dangerously",
    url: "https://example.test/",
    pretendToBeVisual: true,
    beforeParse(window) {
      const noop = () => {};
      window.fetch = mockFetch;
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.setInterval = () => 0;
      window.clearInterval = noop;
      window.HTMLCanvasElement.prototype.getContext = () => ({
        scale: noop,
        fillRect: noop,
        beginPath: noop,
        arc: noop,
        stroke: noop,
        setLineDash: noop,
        fillText: noop,
        moveTo: noop,
        lineTo: noop,
        closePath: noop,
        fill: noop,
      });
      window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
        width: 900,
        height: 540,
        top: 0,
        left: 0,
        right: 900,
        bottom: 540,
      });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  dom.requestedUrls = requestedUrls;
  return dom;
}


// ─── Unit tests ───────────────────────────────────────────────────────────────

section('Date / timezone safety');
run('localDateStr returns local date not UTC', () => {
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  assertEqual(localDateStr(d), expected, 'localDateStr');
});
run('localDateStr at 11pm local matches getDate()', () => {
  const now = new Date();
  const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0, 0);
  const expected = `${evening.getFullYear()}-${String(evening.getMonth()+1).padStart(2,'0')}-${String(evening.getDate()).padStart(2,'0')}`;
  assertEqual(localDateStr(evening), expected, 'localDateStr at 11pm');
});
run('localDateCompact produces 8-digit string', () => {
  const result = localDateCompact(new Date());
  assert(result.length === 8 && /^\d{8}$/.test(result), `Expected 8 digits, got ${result}`);
});
run('localDateCompact matches localDateStr stripped of dashes', () => {
  const d = new Date();
  assertEqual(localDateCompact(d), localDateStr(d).replace(/-/g,''), 'compact matches local');
});
run('refreshDateContext rolls forward when the date changes', () => {
  // Use explicit Eastern offsets so the rollover is deterministic in any runner TZ:
  // Capture the real Date before swapping it in, so FakeDate's internal
  // construction never recurses into itself once globalThis.Date === FakeDate.
  const RealDate = Date;
  // 23:55 EDT Apr 4 -> today is the 4th; 00:05 EDT Apr 5 -> rolls to the 5th.
  const firstNow = new RealDate('2026-04-04T23:55:00-04:00');
  const secondNow = new RealDate('2026-04-05T00:05:00-04:00');
  let currentNow = firstNow;

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) {
      return new RealDate(...args);
    }
    return args.length === 0 ? new RealDate(currentNow) : new RealDate(...args);
  }
  FakeDate.now = () => currentNow.getTime();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const { before, after } = withFakeDate(FakeDate, () => {
    const before = dashboard.getDateContext().todayKey;
    currentNow = secondNow;
    dashboard.refreshDateContext();
    const after = dashboard.getDateContext().todayKey;
    return { before, after };
  });

  assertEqual(before, '2026-04-04', 'initial today key');
  assertEqual(after, '2026-04-05', 'rolled today key');
});

section('Source freshness and gating');
run('buildNoaaLiveTileUrl applies NOAA zoom offset while preserving x/y', () => {
  const url = buildNoaaLiveTileUrl(12, 1180, 1562);
  assertEqual(
    url,
    'https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/tile/10/1562/1180',
    'NOAA live tile URL'
  );
});
run('latLonToTileCoords returns expected Tolchester zoom-12 tile', () => {
  const coords = latLonToTileCoords(39.2085, -76.2455, 12);
  assertEqual(coords.x, 1180, 'tile x');
  assertEqual(coords.y, 1562, 'tile y');
});
run('buildLocalChartTileUrl preserves app cache layout', () => {
  const url = buildLocalChartTileUrl(12, 1180, 1562);
  assertEqual(url, './chart-cache/noaa/12/1562/1180.png', 'local tile URL');
});
run('buildSourceStatus marks fresh NOAA observation as ok', () => {
  const RealDate = Date;
  const now = new RealDate('2026-04-05T22:00:00');

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(...args);
    return args.length === 0 ? new RealDate(now) : new RealDate(...args);
  }
  FakeDate.now = () => now.getTime();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const status = withFakeDate(FakeDate, () => dashboard.buildSourceStatus(
    'currentWind',
    { data: [{ t: '2026-04-05 21:42', s: '19.63' }] },
    new RealDate('2026-04-05T22:00:00')
  ));

  assertEqual(status.state, 'ok', 'fresh observation state');
  assert(status.detail.includes('Updated'), `expected Updated detail, got ${status.detail}`);
});
run('buildSourceStatus marks stale hourly forecast when update time is too old', () => {
  const RealDate = Date;
  const now = new RealDate('2026-04-05T22:00:00');

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(...args);
    return args.length === 0 ? new RealDate(now) : new RealDate(...args);
  }
  FakeDate.now = () => now.getTime();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const status = withFakeDate(FakeDate, () => dashboard.buildSourceStatus(
    'hourlyForecast',
    { properties: { periods: [{ startTime: '2026-04-06T08:00:00' }], updateTime: '2026-04-05T13:00:00' } },
    new RealDate('2026-04-05T22:00:00')
  ));

  assertEqual(status.state, 'stale', 'stale forecast state');
});
run('getRecommendationBlockers returns only required unhealthy sources', () => {
  const blockers = getRecommendationBlockers({
    tides: { key: 'tides', label: 'NOAA hi-lo tides', requiredForRecommendation: true, state: 'ok' },
    tideHourly: { key: 'tideHourly', label: 'NOAA depth window tides', requiredForRecommendation: true, state: 'stale' },
    currentWind: { key: 'currentWind', label: 'NOAA live wind', requiredForRecommendation: false, state: 'failed' },
  });

  assertEqual(blockers.length, 1, 'blocker count');
  assertEqual(blockers[0].key, 'tideHourly', 'required stale source blocks recommendation');
});
run('getRecommendationGate does not block stale NWS hourly forecast', () => {
  const gate = getRecommendationGate({
    tides: { key: 'tides', label: 'NOAA hi-lo tides', requiredForRecommendation: true, state: 'ok' },
    tideHourly: { key: 'tideHourly', label: 'NOAA depth window tides', requiredForRecommendation: true, state: 'ok' },
    hourlyForecast: { key: 'hourlyForecast', label: 'NWS hourly forecast', requiredForRecommendation: true, state: 'stale' },
  });

  assert(!gate.blocked, 'gate should allow stale NWS forecast');
});
run('getRecommendationGate still blocks stale tide inputs', () => {
  const gate = getRecommendationGate({
    tides: { key: 'tides', label: 'NOAA hi-lo tides', requiredForRecommendation: true, state: 'ok' },
    tideHourly: { key: 'tideHourly', label: 'NOAA depth window tides', requiredForRecommendation: true, state: 'stale' },
    hourlyForecast: { key: 'hourlyForecast', label: 'NWS hourly forecast', requiredForRecommendation: true, state: 'stale' },
  });

  assert(gate.blocked, 'gate should still block stale tide data');
  assertEqual(gate.blockers[0].key, 'tideHourly', 'tide window source is the blocker');
});
run('getObservationFreshnessSummary shows oldest NOAA observation age', () => {
  const RealDate = Date;
  const now = new RealDate('2026-04-06T14:45:00');

  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(...args);
    return args.length === 0 ? new RealDate(now) : new RealDate(...args);
  }
  FakeDate.now = () => now.getTime();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const summary = withFakeDate(FakeDate, () => dashboard.getObservationFreshnessSummary({
    currentWind: { primaryTimestamp: new RealDate('2026-04-06T10:30:00') },
    waterTemp: { primaryTimestamp: new RealDate('2026-04-06T10:36:00') },
    waterLevel: { primaryTimestamp: new RealDate('2026-04-06T10:42:00') },
  }));

  assertEqual(summary, 'NDBC TCBM2 10:30 AM-10:42 AM · 4h 15m old', 'observation freshness summary');
});

section('NOAA tide data parsing');
run('parseTidesForToday returns only matching dates', () => {
  const tides = [
    {t:'2026-03-19 01:47', v:'0.022', type:'L'},
    {t:'2026-03-19 07:52', v:'1.385', type:'H'},
    {t:'2026-03-20 02:21', v:'-0.027', type:'L'},
    {t:'2026-03-20 08:36', v:'1.501', type:'H'},
  ];
  const r = parseTidesForToday(tides, '2026-03-19');
  assertEqual(r.length, 2, 'tide count');
  assertEqual(r[0].type, 'L', 'first is Low');
  assertEqual(r[1].type, 'H', 'second is High');
});
run('parseTidesForToday returns empty array on date mismatch', () => {
  const tides = [{t:'2026-03-19 07:52', v:'1.385', type:'H'}];
  assertEqual(parseTidesForToday(tides, '2026-03-20').length, 0, 'empty result');
});
run('findNextTide returns next upcoming tide', () => {
  const now = new Date('2026-03-19T10:00:00');
  const tides = [
    {t:'2026-03-19 01:47', v:'0.022',   type:'L'},
    {t:'2026-03-19 07:52', v:'1.385',   type:'H'},
    {t:'2026-03-19 14:25', v:'-0.056',  type:'L'},
    {t:'2026-03-19 20:15', v:'1.182',   type:'H'},
  ];
  const next = findNextTide(tides, now);
  assert(next !== null, 'should find a tide');
  assertEqual(next.type, 'L', 'next at 10am should be 14:25 Low');
  assertEqual(next.t.slice(11,16), '14:25', 'time should be 14:25');
});
run('findCurrentTideDirection: falling after a High', () => {
  const now = new Date('2026-03-19T10:00:00');
  const tides = [
    {t:'2026-03-19 01:47', v:'0.022',  type:'L'},
    {t:'2026-03-19 07:52', v:'1.385',  type:'H'},
    {t:'2026-03-19 14:25', v:'-0.056', type:'L'},
  ];
  assertEqual(findCurrentTideDirection(tides, now), 'falling', 'should be falling');
});
run('findCurrentTideDirection: rising after a Low', () => {
  const now = new Date('2026-03-19T16:00:00');
  const tides = [
    {t:'2026-03-19 14:25', v:'-0.056', type:'L'},
    {t:'2026-03-19 20:15', v:'1.182',  type:'H'},
  ];
  assertEqual(findCurrentTideDirection(tides, now), 'rising', 'should be rising');
});
run('NOAA space separator fix: T-replacement gives valid date', () => {
  const d = new Date('2026-03-19 14:25'.replace(' ', 'T'));
  assert(!isNaN(d.getTime()), 'should parse');
  assertEqual(d.getHours(), 14, 'hour');
  assertEqual(d.getMinutes(), 25, 'minute');
});
run('Sort order correct after space→T fix', () => {
  const tides = [
    {t:'2026-03-19 20:15'}, {t:'2026-03-19 07:52'},
    {t:'2026-03-19 01:47'}, {t:'2026-03-19 14:25'},
  ];
  const sorted = [...tides].sort((a,b) => new Date(a.t.replace(' ','T')) - new Date(b.t.replace(' ','T')));
  assertEqual(sorted[0].t.slice(11,16), '01:47', 'first');
  assertEqual(sorted[3].t.slice(11,16), '20:15', 'last');
});
run('Negative tide value parses correctly', () => {
  const val = parseFloat('-0.056');
  assert(val < 0, 'should be negative');
  assert(Math.abs(val - (-0.056)) < 0.001, 'value');
});

section('Wind / direction utilities');
run('degToCard: 0° → N',    () => assertEqual(degToCard(0),   'N',  '0°'));
run('degToCard: 90° → E',   () => assertEqual(degToCard(90),  'E',  '90°'));
run('degToCard: 180° → S',  () => assertEqual(degToCard(180), 'S',  '180°'));
run('degToCard: 270° → W',  () => assertEqual(degToCard(270), 'W',  '270°'));
run('degToCard: 225° → SW', () => assertEqual(degToCard(225), 'SW', '225°'));
run('windColor: calm (0 kt) → green',      () => assertEqual(windColor(0),  '#2ea84f', 'calm'));
run('windColor: moderate (10 kt) → blue',  () => assertEqual(windColor(10), '#3a9fd6', 'moderate'));
run('windColor: strong (18 kt) → amber',   () => assertEqual(windColor(18), '#f0bc2e', 'strong'));
run('windColor: dangerous (30 kt) → red',  () => assertEqual(windColor(30), '#f05a5f', 'dangerous'));

section('Go/No-Go logic');
run('Gale warning → nogo',          () => assertEqual(gonogoClass([{event:'Gale Warning'}], 5), 'nogo',    'warning'));
run('No advisory, gusts < 20 → go', () => assertEqual(gonogoClass([], 15), 'go',      '<20'));
run('No advisory, gusts ≥ 20 → caution', () => assertEqual(gonogoClass([], 22), 'caution', '≥20'));
run('SCA downgrades low gusts to caution', () => assertEqual(gonogoClass([{event:'SCA'}], 8), 'caution', 'sca caution'));
run('Boundary: 19 kt → go',         () => assertEqual(gonogoClass([], 19), 'go',      '19 kt'));
run('Boundary: 20 kt → caution',    () => assertEqual(gonogoClass([], 20), 'caution', '20 kt'));

section('Sail plan logic');
run('Double/standard, 14/18 → full-sail',   () => assertEqual(determineSailPlan(14, 18, {crewMode:'double', safetyMode:'standard'}), 'full-sail',   '14/18'));
run('Double/standard, 17/22 → roll-genoa',  () => assertEqual(determineSailPlan(17, 22, {crewMode:'double', safetyMode:'standard'}), 'roll-genoa',  '17/22'));
run('Solo mode reefs earlier (17/22 → first-reef)', () => assertEqual(determineSailPlan(17, 22, {crewMode:'solo', safetyMode:'standard'}), 'first-reef', 'solo'));
run('25/32 double/standard → second-reef',  () => assertEqual(determineSailPlan(25, 32, {crewMode:'double', safetyMode:'standard'}), 'second-reef', '25/32'));
run('Thunderstorm (rainSev 3) → harbor-only', () => assertEqual(determineSailPlan(18, 24, {crewMode:'double', safetyMode:'standard', maxRainSev:3}), 'harbor-only', 'tstorm'));
run('Chop plus current opposition downgrades a full-sail day', () => {
  assertEqual(
    determineSailPlan(14, 18, { crewMode: 'double', safetyMode: 'standard', hasChopPenalty: true, hasCurrentOpposition: true }),
    'roll-genoa',
    'wind-against-tide downgrade'
  );
});

section('NWS wind string parsing');
run('"10 mph" → avg 10, high 10', () => {
  const r = parseWindMph('10 mph');
  assertEqual(r.avg, 10, 'avg'); assertEqual(r.high, 10, 'high');
});
run('"5 to 15 mph" → avg 10, high 15', () => {
  const r = parseWindMph('5 to 15 mph');
  assertEqual(r.avg, 10, 'avg'); assertEqual(r.high, 15, 'high');
});
run('"0 mph" (calm) → avg 0, high 0', () => {
  const r = parseWindMph('0 mph');
  assertEqual(r.avg, 0, 'avg'); assertEqual(r.high, 0, 'high');
});
run('null → avg 0, high 0 (no crash)', () => {
  const r = parseWindMph(null);
  assertEqual(r.avg, 0, 'avg'); assertEqual(r.high, 0, 'high');
});
run('"10 mph" converts to ~9 knots', () => {
  assertEqual(mphToKnots(parseWindMph('10 mph').high), 9, '10 mph → 9 kt');
});
run('"23 mph" converts to ~20 knots (full-sail threshold)', () => {
  const kts = mphToKnots(parseWindMph('23 mph').high);
  assert(kts >= 19 && kts <= 21, `Expected ~20 kt, got ${kts}`);
});

section('Polar speed interpolation');
run('6 kts / 90° ≈ 5.39 kts BSP', () => {
  const bsp = polarBoatSpeed(6, 90);
  assert(Math.abs(bsp - 5.39) < 0.05, `Expected ~5.39, got ${bsp.toFixed(2)}`);
});
run('10 kts / 90° ≈ 6.68 kts BSP', () => {
  const bsp = polarBoatSpeed(10, 90);
  assert(Math.abs(bsp - 6.68) < 0.05, `Expected ~6.68, got ${bsp.toFixed(2)}`);
});
run('20 kts / 90° ≈ 7.48 kts BSP', () => {
  const bsp = polarBoatSpeed(20, 90);
  assert(Math.abs(bsp - 7.48) < 0.05, `Expected ~7.48, got ${bsp.toFixed(2)}`);
});
run('More wind → faster (6 vs 10 kts avg)', () => {
  assert(avgPolarSpeed(10) > avgPolarSpeed(6), 'faster in more breeze');
});
run('Very light air (2 kts) clamped, returns valid BSP', () => {
  const bsp = polarBoatSpeed(2, 90);
  assert(bsp > 0 && bsp <= HULL_SPEED + 0.5, `BSP ${bsp} should be positive and ≤ hull speed`);
});
run('Close-hauled (52°) slower than beam reach (90°) at 10 kts', () => {
  assert(polarBoatSpeed(10, 90) > polarBoatSpeed(10, 52), 'beam > close-hauled');
});
run('avgPolarSpeed at 10 kts in range 5.5–7.0', () => {
  const avg = avgPolarSpeed(10);
  assert(avg >= 5.5 && avg <= 7.0, `${avg.toFixed(2)} out of expected range`);
  return `${avg.toFixed(2)} kts avg`;
});

section('Sailability scoring');
run('Ideal day (10 kts, no rain) scores ≥ 75', () => {
  const s = scoreSailability(10, 12, 15, 0, false, false);
  assert(s >= 75, `Expected ≥75, got ${s}`);
  return `score: ${s}`;
});
run('Gale force (35 kts) scores lower than ideal day', () => {
  const ideal = scoreSailability(10, 12, 15, 0, false, false);
  const gale  = scoreSailability(35, 40, 50, 0, false, false);
  assert(gale < ideal, `Gale (${gale}) should score below ideal (${ideal})`);
  // comfort component is fully zeroed; wx is unaffected by wind alone
  assert(gale <= 75, `Gale score ${gale} unexpectedly high`);
  return `gale: ${gale}, ideal: ${ideal}`;
});
run('Rain likely (sev 2) reduces score', () => {
  const noRain = scoreSailability(10, 12, 15, 0, false, false);
  const rain   = scoreSailability(10, 12, 15, 2, false, false);
  assert(rain < noRain, `rain (${rain}) should be < no-rain (${noRain})`);
});
run('Thunderstorm (sev 3) zeroes weather points (lower than no rain)', () => {
  const noRain = scoreSailability(10, 12, 15, 0, false, false);
  const tstorm = scoreSailability(10, 12, 15, 3, false, false);
  // wx component drops from 20 to 0 — should lose exactly 20 pts vs no-rain
  assertEqual(noRain - tstorm, 20, 'thunderstorm should cost exactly 20 wx pts');
  return `tstorm: ${tstorm}, no-rain: ${noRain}`;
});
run('Chop deducts points', () => {
  const noChop = scoreSailability(12, 14, 18, 0, false, false);
  const chop   = scoreSailability(12, 14, 18, 0, true,  false);
  assert(chop < noChop, `chop (${chop}) < no chop (${noChop})`);
});
run('Current opposition deducts points', () => {
  const noOpp = scoreSailability(12, 14, 18, 0, false, false);
  const opp   = scoreSailability(12, 14, 18, 0, false, true);
  assert(opp < noOpp, `opp (${opp}) < no opp (${noOpp})`);
});
run('Score always 0–100', () => {
  for (const args of [
    [0, 0, 0, 0, false, false],
    [50, 60, 75, 3, true, true],
    [10, 12, 15, 0, false, false],
  ]) {
    const s = scoreSailability(...args);
    assert(s >= 0 && s <= 100, `Score ${s} out of range for ${JSON.stringify(args)}`);
  }
});

section('Readiness labels');
run('harbor-only → "No-go" regardless of score', () => assertEqual(describeReadiness(99, 'harbor-only'), 'No-go',    ''));
run('score 85 → "Prime"',                         () => assertEqual(describeReadiness(85, 'full-sail'),   'Prime',    ''));
run('score 70 → "Good"',                          () => assertEqual(describeReadiness(70, 'full-sail'),   'Good',     ''));
run('score 84 → "Good" (below Prime threshold)',   () => assertEqual(describeReadiness(84, 'full-sail'),   'Good',     ''));
run('score 55 → "Watch"',                         () => assertEqual(describeReadiness(55, 'roll-genoa'),  'Watch',    ''));
run('score 54 → "Marginal"',                      () => assertEqual(describeReadiness(54, 'roll-genoa'),  'Marginal', ''));
run('score 0 → "Marginal"',                       () => assertEqual(describeReadiness(0,  'first-reef'),  'Marginal', ''));

section('NWS marine alerts');
run('Small Craft Advisory is serious but not a hard marine alert', () => {
  assert(isSmallCraftAdvisory('Small Craft Advisory'), 'Small Craft Advisory should be recognized');
  assert(!isHardMarineAlert('Small Craft Advisory'), 'Small Craft Advisory should not hard-gate every sailing day');
});
run('Dangerous marine warnings remain hard marine alerts', () => {
  [
    'Gale Warning',
    'Storm Warning',
    'Hurricane Force Wind Warning',
    'Special Marine Warning',
    'Dense Fog Advisory',
    'Low Water Advisory',
    'Hazardous Seas Warning',
  ].forEach((event) => assert(isHardMarineAlert(event), `${event} should hard-gate sailing`));
});
run('Small Craft Advisory no-goes for conservative or compounded risk', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  assert(!shouldSmallCraftAdvisoryForceHarbor({
    estGust: 22,
    hasChopPenalty: false,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  }), 'moderate SCA should not automatically force harbor-only');

  dashboard.setUserSettingsForTests({ crewMode: 'solo', safetyMode: 'standard' });
  assert(shouldSmallCraftAdvisoryForceHarbor({
    estGust: 22,
    hasChopPenalty: false,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  }), 'solo SCA should force harbor-only');

  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  assert(shouldSmallCraftAdvisoryForceHarbor({
    estGust: 22,
    hasChopPenalty: true,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  }), 'SCA plus steep chop should force harbor-only');
});
run('Small Craft Advisory reefs early when not compounded', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const plan = applySmallCraftAdvisorySailPlan({ key: 'full-sail' }, {
    estGust: 22,
    hasChopPenalty: false,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  });
  assertEqual(plan.key, 'first-reef', 'SCA should recommend heavy-weather mode without forcing no-go');
});
run('Small Craft Advisory explanation says risk signal, not automatic no-go', () => {
  const explanation = buildRiskDecisionExplanation({
    level: 'first-reef',
    sailPlan: { key: 'first-reef' },
    marineAlert: 'Small Craft Advisory',
    estGust: 22,
    maxWind: 18,
    dominantDir: 'S',
    hasChopPenalty: false,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  });
  assert(explanation.includes('SCA active'), 'SCA explanation should identify the advisory');
  assert(explanation.toLowerCase().includes('reef at the dock'), 'SCA explanation should give practical crew action');
});
run('Small Craft Advisory no-go explanation names stacked risks', () => {
  const explanation = buildRiskDecisionExplanation({
    level: 'harbor-only',
    sailPlan: { key: 'harbor-only' },
    marineAlert: 'Small Craft Advisory',
    estGust: 24,
    maxWind: 20,
    dominantDir: 'NW',
    hasChopPenalty: true,
    hasCurrentOpposition: false,
    maxRainSev: 0,
    dayWindowPassed: false,
  });
  assert(explanation.includes('Harbor-only because it stacks with'), 'SCA no-go should explain compounding risk');
  assert(explanation.includes('5.8 ft keel'), 'SCA no-go should name the keel escape limitation');
});
run('assessDay treats moderate Small Craft Advisory as reef-early guidance', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const rec = assessFixture({ alertEvent: 'Small Craft Advisory' });
  assertEqual(rec.sailPlan.key, 'first-reef', 'SCA should move a full-sail fixture into first reef');
  assertEqual(rec.level, 'first-reef', 'recommendation level should match sail plan');
  assertEqual(rec.marineAlert, 'Small Craft Advisory', 'marine alert summary');
  assert(rec.cautions.includes('Small Craft Advisory active'), 'cautions should include active SCA');

  const explanation = buildRiskDecisionExplanation(rec);
  assert(explanation.includes('SCA active'), 'assessDay SCA explanation should identify advisory');
  assert(explanation.toLowerCase().includes('reef at the dock'), 'assessDay SCA explanation should include crew action');
  assert(explanation.includes('No additional chop, current, or storm'), 'moderate fixture should name limited risk stack');
});
run('assessDay turns Small Craft Advisory plus Bay chop into harbor-only', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const rec = assessFixture({
    alertEvent: 'Small Craft Advisory',
    windDirection: 'NW',
  });
  assertEqual(rec.sailPlan.key, 'harbor-only', 'SCA plus chop should no-go through assessDay');
  assert(rec.hasChopPenalty, 'fixture should trip chop penalty');
  assert(rec.cautions.includes('NW wind builds steep chop'), 'cautions should name steep chop');
  assert(getNoGoBlocker(rec).startsWith('No-go: SCA'), 'no-go blocker should start with SCA identification');
  assert(getNoGoBlocker(rec).includes('NW'), 'no-go blocker should name the chop direction');

  const explanation = buildRiskDecisionExplanation(rec);
  assert(explanation.includes('Harbor-only because it stacks with'), 'explanation should state harbor-only and stacking');
  assert(explanation.includes('5.8 ft keel'), 'explanation should name the keel escape limitation');
});
run('assessDay keeps hard marine warnings as automatic harbor-only', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const rec = assessFixture({ alertEvent: 'Gale Warning' });
  assertEqual(rec.sailPlan.key, 'harbor-only', 'hard warning should force harbor-only');
  assertEqual(rec.marineAlert, 'Gale Warning', 'hard alert summary');
  assertEqual(getNoGoBlocker(rec), 'No-go because Gale Warning is active for the selected day', 'hard warning blocker');
});
run('simple summary reduces assessDay output to a go/no-go day call', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const rec = assessFixture({ alertEvent: 'Small Craft Advisory' });
  const summary = buildSimpleDaySummary(rec);
  assertEqual(summary.decisionLabel, 'GO', 'moderate SCA remains a go decision');
  assertEqual(summary.decisionKey, 'caution', 'moderate SCA should be colored as caution');
  assert(summary.title.includes('Reduce sail'), 'title should name the simple sail plan');
  assert(summary.copy.includes('go with reduce sail guidance'), 'copy should summarize the day plainly');
  assert(summary.basics.some((item) => item.label === 'Wind' && item.value.includes('kt')), 'basics should include wind');
});
run('simple summary shows hard warnings as no-go', () => {
  dashboard.setUserSettingsForTests({ crewMode: 'double', safetyMode: 'standard' });
  const rec = assessFixture({ alertEvent: 'Gale Warning' });
  const summary = buildSimpleDaySummary(rec);
  assertEqual(summary.decisionLabel, 'NO-GO', 'hard warning decision');
  assertEqual(summary.decisionKey, 'nogo', 'hard warning color key');
  assert(summary.copy.includes('no-go because Gale Warning is active'), 'copy should explain no-go reason');
});
run('float plan readiness requires crew, return, shore contact, and checklist', () => {
  const readiness = getFloatPlanReadiness(getDefaultFloatPlan());
  assert(!readiness.ready, 'empty float plan should not be ready');
  assert(readiness.missing.includes('expected return'), 'expected return missing');
  assert(readiness.missing.includes('shore contact'), 'shore contact missing');
  assert(readiness.missing.includes('pfds / harnesses'), 'PFDs missing');
});
run('float plan readiness passes when practical departure items are complete', () => {
  const plan = getDefaultFloatPlan();
  plan.crewCount = '3';
  plan.expectedReturn = '17:30';
  plan.shoreContact = 'Alex 555-0100';
  Object.keys(plan.checks).forEach((key) => { plan.checks[key] = true; });
  const readiness = getFloatPlanReadiness(plan);
  assert(readiness.ready, 'complete float plan should be ready');
  assert(readiness.summary.includes('3 aboard'), 'summary should include crew count');
  assert(readiness.summary.includes('17:30'), 'summary should include expected return');
});
run('Marine Weather Statement is not a hard marine alert', () => {
  assert(!isHardMarineAlert('Marine Weather Statement'), 'Marine Weather Statement should not hard-gate by itself');
});
run('filters serious marine alerts overlapping the selected Chesapeake day', () => {
  const alerts = {
    features: [
      {
        properties: {
          event: 'Small Craft Advisory',
          onset: '2026-04-05T14:00:00-04:00',
          ends: '2026-04-05T20:00:00-04:00',
        },
      },
      {
        // Next-day SCA — starts well into Apr 6 Eastern, must NOT match Apr 5.
        properties: {
          event: 'Small Craft Advisory',
          onset: '2026-04-06T10:00:00-04:00',
          ends: '2026-04-06T16:00:00-04:00',
        },
      },
      {
        // Non-serious event on the selected day — must be excluded.
        properties: {
          event: 'Marine Weather Statement',
          onset: '2026-04-05T12:00:00-04:00',
          ends: '2026-04-05T13:00:00-04:00',
        },
      },
    ],
  };

  const matching = getMarineAlertsForDay(alerts, '2026-04-05');
  assertEqual(matching.length, 1, 'only the same-day serious alert overlaps selected day');
  assertEqual(matching[0].properties.event, 'Small Craft Advisory', 'matching event');
});

section('NWS marine forecast parsing');
run('extracts waves and visibility from marine forecast text', () => {
  const parsed = parseMarineForecastText('S winds 10 kt. Waves 1 to 2 ft. Vsby 1 NM or less in fog.');
  assertEqual(parsed.waves, 'Waves 1 to 2 ft', 'waves');
  assertEqual(parsed.visibility, 'Vsby 1 NM or less', 'visibility');
  assert(parsed.visibilityRestricted, 'visibility should be restricted');
});
run('uses first matching zone period for selected day', () => {
  const marineForecasts = {
    zones: [
      {
        id: 'ANZ532',
        label: 'Pooles Island to Sandy Point',
        periods: [
          {
            name: 'Today',
            startTime: '2026-04-05T06:00:00-04:00',
            endTime: '2026-04-05T18:00:00-04:00',
            detailedForecast: 'E winds 5 to 10 kt. Waves around 1 ft.',
          },
        ],
      },
    ],
  };
  const forecast = getMarineForecastForDay(marineForecasts, '2026-04-05');
  assertEqual(forecast.zoneId, 'ANZ532', 'zone');
  assertEqual(forecast.waves, 'Waves around 1 ft', 'waves');
  assertEqual(forecast.visibility, 'Not restricted', 'visibility fallback');
});
run('parses NWS CWF text product into zone periods', () => {
  const zones = parseCoastalWatersForecast(`
ANZ531-042000-
Chesapeake Bay from Pooles Island to Sandy Point-
758 AM EDT Mon May 4 2026

.TODAY...S winds 10 to 15 kt. Waves 1 to 2 ft.
.TONIGHT...S winds 10 to 15 kt. Waves 2 ft.

$$

ANZ532-042000-
Chesapeake Bay from Sandy Point to North Beach-
758 AM EDT Mon May 4 2026

.TODAY...S winds 10 to 15 kt. Waves
2 ft. Visibility 1 nm in showers.
.TUE...S winds 15 to 20 kt. Waves 2 to 3 ft.

$$
`, '2026-05-04T11:58:00+00:00');
  assertEqual(zones.length, 2, 'zone count');
  const forecast = getMarineForecastForDay({ zones }, '2026-05-05');
  assertEqual(forecast.zoneId, 'ANZ532', 'matching zone');
  assertEqual(forecast.waves, 'Waves 2 to 3 ft', 'waves');
});

section('NOAA current predictions');
run('normalizes NOAA max/slack current prediction rows', () => {
  const events = normalizeCurrentPredictionEvents({
    current_predictions: {
      cp: [
        { Time: '2026-04-05 08:10', Type: 'Slack' },
        { Time: '2026-04-05 11:20', Type: 'Max Flood', Velocity_Major: '0.8' },
        { Time: 'bad', Type: 'Max Ebb', Velocity_Major: '1.0' },
      ],
    },
  });
  assertEqual(events.length, 2, 'valid current events');
  assertEqual(events[1].type, 'flood', 'flood type');
  assertEqual(events[1].speed, 0.8, 'speed');
});
run('uses NOAA current prediction phase during daytime', () => {
  const currentPredictions = {
    current_predictions: {
      cp: [
        { Time: '2026-04-05 08:00', Type: 'Slack' },
        { Time: '2026-04-05 11:00', Type: 'Max Flood', Velocity_Major: '0.9', meanFloodDir: 348 },
        { Time: '2026-04-05 14:00', Type: 'Slack' },
        { Time: '2026-04-05 17:00', Type: 'Max Ebb', Velocity_Major: '1.1' },
      ],
    },
  };
  const phase = getCurrentPredictionPhase(currentPredictions, '2026-04-05', 12);
  assertEqual(phase.phase, 'flood', 'phase');
  assertEqual(phase.currentDir, 'NNW', 'flood direction');
});
run('summarizes next NOAA current turn', () => {
  const currentPredictions = {
    current_predictions: {
      cp: [
        { Time: '2026-04-05 08:00', Type: 'Slack' },
        { Time: '2026-04-05 11:00', Type: 'Max Flood', Velocity_Major: '0.9' },
        { Time: '2026-04-05 14:00', Type: 'Slack' },
      ],
    },
  };
  const summary = summarizeCurrentPrediction(currentPredictions, '2026-04-05');
  assert(summary.hasPrediction, 'has current predictions');
  assert(summary.events.length === 3, 'event count');
});

section('Bay buoy observations');
run('normalizes CBIBS latest buoy observations', () => {
  const summary = normalizeCbibsStation({
    source: 'CBIBS',
    stations: [{
      stationLongName: 'Annapolis',
      variable: [
        { actualName: 'wind_speed', units: 'm/s', measurements: [{ time: '2026-05-04T13:12:00+00', value: 3.32 }] },
        { actualName: 'wind_speed_of_gust', units: 'm/s', measurements: [{ time: '2026-05-04T13:12:00+00', value: 4.6 }] },
        { actualName: 'wind_from_direction', units: 'Degrees Magnetic', measurements: [{ time: '2026-05-04T13:12:00+00', value: 200.2 }] },
        { actualName: 'sea_surface_wave_significant_height', units: 'm', measurements: [{ time: '2026-05-04T13:12:00+00', value: 0.287 }] },
        { actualName: 'sea_surface_wind_wave_period', units: 's', measurements: [{ time: '2026-05-04T13:12:00+00', value: 2.65 }] },
      ],
    }],
  });
  assert(summary.hasData, 'has buoy data');
  assertEqual(summary.stationLabel, 'Annapolis', 'station label');
  assert(Math.abs(summary.windKts - 6.45) < 0.05, `wind ${summary.windKts}`);
  assert(Math.abs(summary.waveFt - 0.94) < 0.05, `wave ${summary.waveFt}`);
});
run('parses NDBC latest text as buoy variables', () => {
  const variables = ndbcLatestToCbibsVariables(`#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
2026 05 04 12 54 190 3.0 5.0 0.3 3 MM MM MM 13.7 14.2 MM MM MM MM`);
  const summary = normalizeCbibsStation({ source: 'NDBC', stations: [{ stationLongName: 'Annapolis', variable: variables }] });
  assert(summary.hasData, 'has NDBC data');
  assert(Math.abs(summary.gustKts - 9.72) < 0.05, `gust ${summary.gustKts}`);
  assert(Math.abs(summary.waveFt - 0.98) < 0.05, `wave ${summary.waveFt}`);
});
run('flags buoy observations running above forecast', () => {
  const reality = getBayBuoyReality({
    hasData: true,
    windKts: 18,
    gustKts: 24,
    waveFt: 1.2,
  }, {
    maxWind: 12,
    estGust: 16,
  });
  assertEqual(reality.level, 'caution', 'reality level');
  assert(reality.note.includes('buoy running above forecast'), 'above forecast note');
});

section('Storm watch');
run('Special Marine Warning is storm-related', () => {
  assert(isStormRelatedAlert('Special Marine Warning'), 'Special Marine Warning should feed storm watch');
});
run('thunder wording produces storm watch timing', () => {
  const outlook = getStormOutlookForDay([
    {
      startTime: '2026-04-05T13:00:00-04:00',
      shortForecast: 'Showers and thunderstorms likely',
    },
  ], { features: [] }, '2026-04-05');
  assertEqual(outlook.level, 'watch', 'storm level');
  assert(outlook.thunder !== 'None shown', 'thunder timing should be present');
});
run('active Special Marine Warning produces storm alert', () => {
  const outlook = getStormOutlookForDay([], {
    features: [
      {
        properties: {
          event: 'Special Marine Warning',
          onset: '2026-04-05T12:00:00-04:00',
          ends: '2026-04-05T14:00:00-04:00',
        },
      },
    ],
  }, '2026-04-05');
  assertEqual(outlook.level, 'alert', 'storm alert level');
  assertEqual(outlook.alert, 'Special Marine Warning', 'alert event');
});

section('EPA UV forecast');
run('normalizes EPA hourly UV forecast rows', () => {
  const rows = normalizeUvForecast([
    { DATE_TIME: '2026-04-05 13:00', UV_VALUE: '5' },
    { DATE_TIME: 'bad', UV_VALUE: 'oops' },
  ]);
  assertEqual(rows.length, 1, 'valid rows');
  assertEqual(rows[0].value, 5, 'uv value');
});
run('moderate UV produces a selected-day warning', () => {
  const uv = getUvForDay([
    { DATE_TIME: '2026-04-05 09:00', UV_VALUE: '2' },
    { DATE_TIME: '2026-04-05 13:00', UV_VALUE: '4' },
    { DATE_TIME: '2026-04-06 13:00', UV_VALUE: '8' },
  ], '2026-04-05');
  assertEqual(uv.peak, 4, 'peak uv');
  assertEqual(uv.risk, 'Moderate', 'risk');
  assert(uv.warning, 'moderate UV should warn');
});
run('low UV does not warn', () => {
  const uv = getUvForDay([{ DATE_TIME: '2026-04-05 13:00', UV_VALUE: '2' }], '2026-04-05');
  assertEqual(uv.peak, 2, 'peak uv');
  assert(!uv.warning, 'low UV should not warn');
});

section('LNM pagination');
run('paginates 25 alerts into 3 pages', () => {
  const alerts = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
  const page2 = paginateNtmAlerts(alerts, 2, 10);
  assertEqual(page2.totalPages, 3, 'total pages');
  assertEqual(page2.currentPage, 2, 'current page');
  assertEqual(page2.pageAlerts.length, 10, 'page length');
  assertEqual(page2.pageAlerts[0].id, 11, 'first item on page 2');
  assert(page2.showPagination, 'should show pagination');
});
run('clamps page below range to first page', () => {
  const alerts = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
  const page0 = paginateNtmAlerts(alerts, 0, 10);
  assertEqual(page0.currentPage, 1, 'current page should clamp to 1');
  assertEqual(page0.pageAlerts[0].id, 1, 'first item on clamped first page');
});
run('clamps page above range to last page', () => {
  const alerts = Array.from({ length: 12 }, (_, i) => ({ id: i + 1 }));
  const page99 = paginateNtmAlerts(alerts, 99, 10);
  assertEqual(page99.currentPage, 2, 'current page should clamp to last page');
  assertEqual(page99.pageAlerts.length, 2, 'last page length');
  assertEqual(page99.pageAlerts[0].id, 11, 'first item on last page');
});

section('Polar page live integration');
await runAsync('live weather panel renders weather + tide/current and auto-selects overlay in Live Mode', async () => {
  const dom = await loadPolarDomWithMocks();
  const doc = dom.window.document;

  assert(doc.getElementById('liveWind').textContent.includes('kn'), 'live wind should render in knots');
  assert(doc.getElementById('liveGust').textContent.includes('kn'), 'live gust should render in knots');
  assert(doc.getElementById('liveNote').textContent.includes('Source: NDBC TCBM2'), 'live source should be NDBC TCBM2 on success');
  assert(doc.getElementById('liveTide').textContent.includes('High'), 'next tide should render');
  assert(doc.getElementById('liveCurrent').textContent.includes('Slack') || doc.getElementById('liveCurrent').textContent.includes('Flood') || doc.getElementById('liveCurrent').textContent.includes('Ebb'), 'next current should render');
  assertEqual(doc.getElementById('liveModeBadge').textContent, 'Live Mode ON', 'live mode badge should show on');

  const buttons = [...doc.querySelectorAll('.tws-btn')];
  assert(buttons.length > 0, 'TWS overlay buttons should exist');
  assert(buttons.every((b) => b.disabled), 'buttons should be disabled while Live Mode is on');

  const activeCount = buttons.filter((b) => b.classList.contains('active')).length;
  assertEqual(activeCount, 1, 'exactly one nearest overlay should be active in Live Mode');

  // Regression guard: NOAA rejects begin_date=today/end_date=today with a 400
  // whose error response omits CORS headers, so the tide/current fetch must use
  // the supported single-day form date=today.
  const tideCurrentReqs = dom.requestedUrls.filter((u) => u.includes('tidesandcurrents'));
  assert(tideCurrentReqs.length > 0, 'tide/current should be requested');
  assert(
    tideCurrentReqs.every((u) => !u.includes('begin_date=today') && u.includes('date=today')),
    'tide/current must use date=today, not begin_date=today/end_date=today',
  );

  dom.window.close();
});

await runAsync('live weather fallback never requests NWS observation station endpoints', async () => {
  const tcbm2MissingWind = [
    "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE",
    "2026 06 04 18 22 225  99.0 99.0    MM    MM    MM  MM 1015.0  27.5  23.5    MM   MM   MM    MM",
  ].join("\n");
  const dom = await loadPolarDomWithMocks({ tcbm2Body: tcbm2MissingWind });
  const doc = dom.window.document;

  assert(doc.getElementById('liveWind').textContent.includes('kn'), 'forecast fallback should still render wind');
  assert(doc.getElementById('liveNote').textContent.includes('Source: NOAA/NWS hourly forecast (gridpoint)'), 'fallback source label should be forecast only');
  assert(!doc.getElementById('liveNote').textContent.toLowerCase().includes('observation'), 'fallback source label must not imply observations');
  assert(
    dom.requestedUrls.every((u) => !u.includes('observationStations') && !u.includes('/stations') && !u.includes('/observations/latest')),
    'live weather must never request observationStations, /stations, or /observations/latest',
  );

  dom.window.close();
});

await runAsync('live wind still renders when the tide/current fetch fails', async () => {
  // tide/current reject (as a real CORS failure would); wind must be unaffected.
  const dom = await loadPolarDomWithMocks({ failTideCurrent: true });
  const doc = dom.window.document;

  assert(doc.getElementById('liveWind').textContent.includes('kn'), 'wind should still render when tide/current fail');
  assertEqual(doc.getElementById('liveTide').textContent, '--', 'tide shows -- when its fetch fails');
  assertEqual(doc.getElementById('liveCurrent').textContent, '--', 'current shows -- when its fetch fails');
  assert(!/Loading/.test(doc.getElementById('liveNote').textContent), 'loading note should clear once wind resolves');

  dom.window.close();
});

await runAsync('turning Live Mode off restores manual overlays and re-enables controls', async () => {
  const dom = await loadPolarDomWithMocks();
  const doc = dom.window.document;
  const buttons = [...doc.querySelectorAll('.tws-btn')];

  dom.window.toggleLiveMode();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEqual(doc.getElementById('liveModeBadge').textContent, 'Live Mode OFF', 'live mode badge should show off');
  assert(buttons.every((b) => !b.disabled), 'buttons should re-enable when Live Mode is off');

  const activeCount = buttons.filter((b) => b.classList.contains('active')).length;
  assertEqual(activeCount, 7, 'manual overlays should restore to all enabled curves');

  dom.window.close();
});

section('Now-bar DOM rendering');
run('Valid wind data renders speed, direction, and gusts', () => {
  const dom = new JSDOM(`<div id="nowBarWind"></div><div id="nowBarWater"></div><div id="nowBarLevel"></div>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    renderNowBar(
      { data: [{ s: '12.34', g: '18.55', dr: 'SE' }] },
      null,
      null
    );
    assertEqual(globalThis.document.getElementById('nowBarWind').textContent, '12.3 kts SE · gusts 18.6', 'wind text');
  } finally {
    globalThis.document = priorDocument;
    dom.window.close();
  }
});
run('Missing wind data shows em-dash fallback', () => {
  const dom = new JSDOM(`<div id="nowBarWind"></div><div id="nowBarWater"></div><div id="nowBarLevel"></div>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    renderNowBar(null, null, null);
    assertEqual(globalThis.document.getElementById('nowBarWind').textContent, '\u2013', 'wind fallback');
  } finally {
    globalThis.document = priorDocument;
    dom.window.close();
  }
});
run('Water temp rounds to nearest degree Fahrenheit', () => {
  const dom = new JSDOM(`<div id="nowBarWind"></div><div id="nowBarWater"></div><div id="nowBarLevel"></div>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    renderNowBar(null, { data: [{ v: '63.6' }] }, null);
    assertEqual(globalThis.document.getElementById('nowBarWater').textContent, '64°F', 'water temp');
  } finally {
    globalThis.document = priorDocument;
    dom.window.close();
  }
});
run('Water level renders estimated depth with one decimal place', () => {
  const dom = new JSDOM(`<div id="nowBarWind"></div><div id="nowBarWater"></div><div id="nowBarLevel"></div>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    renderNowBar(null, null, { data: [{ v: '0.33' }] });
    assertEqual(globalThis.document.getElementById('nowBarLevel').textContent, '5.8 ft', 'water level');
  } finally {
    globalThis.document = priorDocument;
    dom.window.close();
  }
});
run('Missing water level shows em-dash fallback', () => {
  const dom = new JSDOM(`<div id="nowBarWind"></div><div id="nowBarWater"></div><div id="nowBarLevel"></div>`);
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    renderNowBar(null, null, null);
    assertEqual(globalThis.document.getElementById('nowBarLevel').textContent, '\u2013', 'water level fallback');
  } finally {
    globalThis.document = priorDocument;
    dom.window.close();
  }
});

section('Dashboard return links');
run('Polar page includes a dashboard return link', () => {
  const source = fs.readFileSync(new URL('./Pearson 31-2 Polar.html', import.meta.url), 'utf8');
  assert(source.includes('href="./index.html"'), 'Polar page is missing dashboard href');
  assert(source.includes('Dashboard'), 'Polar page is missing dashboard link label');
});
run('Speed polar diagram page includes a dashboard return link', () => {
  const source = fs.readFileSync(new URL('./Pearson 31-2 Speed Polar Diagram/index.html', import.meta.url), 'utf8');
  assert(source.includes('href="../index.html"'), 'Speed polar diagram page is missing dashboard href');
  assert(source.includes('Dashboard'), 'Speed polar diagram page is missing dashboard link label');
});
run('Polar reference sheet includes a dashboard return link', () => {
  const source = fs.readFileSync(new URL('./Pearson 31-2 Polar Reference Sheet/index.html', import.meta.url), 'utf8');
  assert(source.includes('href="../index.html"'), 'Polar reference sheet is missing dashboard href');
  assert(source.includes('Back to Dashboard'), 'Polar reference sheet is missing dashboard link label');
});

// ─── Live API tests (opt-in via LIVE_API=1; warnings only — never block) ─────
// Skipped by default so `npm test` stays hermetic. Run with `LIVE_API=1 npm test`.

if (LIVE_API) section('Live API: NOAA (warnings only)');
await runLive('Fetch hi-lo tide predictions (station 8573364)', async () => {
  const now = new Date();
  const today = localDateCompact(now);
  const end   = localDateCompact(new Date(now.getTime() + 2 * 86400000));
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${today}&end_date=${end}&station=8573364&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`;
  const r = await fetch(url);
  const d = await r.json();
  assert(d.predictions, 'Response missing predictions');
  assert(d.predictions.length >= 4, `Expected ≥4 tide events, got ${d.predictions.length}`);
  return `${d.predictions.length} tide events`;
});
await runLive('Fetch water temperature', async () => {
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=8573364&product=water_temperature&units=english&time_zone=lst_ldt&format=json';
  const r = await fetch(url);
  const d = await r.json();
  assert(d.data?.[0]?.v, 'Missing water temp value');
  const temp = parseFloat(d.data[0].v);
  assert(temp > 32 && temp < 90, `Water temp ${temp}°F out of range`);
  return `${temp.toFixed(1)}°F`;
});
await runLive('Fetch live wind observation', async () => {
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=8573364&product=wind&units=english&format=json&time_zone=lst_ldt';
  const r = await fetch(url);
  const d = await r.json();
  assert(d.data?.[0]?.s !== undefined, 'Missing wind speed');
  const kt = parseFloat(d.data[0].s);
  assert(kt >= 0 && kt < 120, `Wind ${kt} kt out of range`);
  return `${kt.toFixed(1)} kt ${d.data[0].dr}`;
});

if (LIVE_API) section('Live API: NWS (warnings only)');
await runLive('Hourly forecast: ≥24 periods with required fields', async () => {
  const r = await fetch('https://api.weather.gov/gridpoints/PHI/17,37/forecast/hourly', {headers:{'User-Agent':'SailingDashTest/1.0'}});
  const d = await r.json();
  assert(Array.isArray(d.properties?.periods), 'Missing periods array');
  assert(d.properties.periods.length >= 24, `Expected ≥24 periods, got ${d.properties.periods.length}`);
  const p = d.properties.periods[0];
  for (const f of ['startTime','temperature','windSpeed','windDirection','shortForecast']) {
    assert(p[f] !== undefined, `Period missing: ${f}`);
  }
  assertEqual(p.temperatureUnit, 'F', 'temperatureUnit');
  assert(typeof p.windSpeed === 'string', 'windSpeed should be string');
  return `${d.properties.periods.length} periods`;
});
await runLive('Wind strings parse cleanly across 24 periods', async () => {
  const r = await fetch('https://api.weather.gov/gridpoints/PHI/17,37/forecast/hourly', {headers:{'User-Agent':'SailingDashTest/1.0'}});
  const d = await r.json();
  let failures = 0;
  d.properties.periods.slice(0, 24).forEach(p => {
    const parsed = parseWindMph(p.windSpeed);
    if (parsed.high < 0 || parsed.high > 200) failures++;
  });
  assertEqual(failures, 0, `${failures} unparseable wind strings`);
  return '24 periods parsed cleanly';
});
await runLive('Daily forecast covers ≥5 days', async () => {
  const r = await fetch('https://api.weather.gov/gridpoints/PHI/17,37/forecast', {headers:{'User-Agent':'SailingDashTest/1.0'}});
  const d = await r.json();
  assert(d.properties?.periods?.length >= 10, `Expected ≥10 periods, got ${d.properties?.periods?.length}`);
  return `${d.properties.periods.length} periods`;
});
await runLive('NWS Cache-Control: s-maxage or max-age ≥ 3600', async () => {
  const r = await fetch('https://api.weather.gov/gridpoints/PHI/17,37/forecast/hourly', {headers:{'User-Agent':'SailingDashTest/1.0'}});
  const cc = r.headers.get('cache-control') || '';
  // NWS serves either max-age=3600 or s-maxage=3600 (or both) — confirm hourly update cadence
  assert(cc.includes('3600'), `Expected 3600 in Cache-Control, got: "${cc}"`);
  return `Cache-Control: ${cc}`;
});
await runLive('Marine alerts (ANZ532) returns features array', async () => {
  const r = await fetch('https://api.weather.gov/alerts/active?zone=ANZ532', {headers:{'User-Agent':'SailingDashTest/1.0'}});
  const d = await r.json();
  assert(Array.isArray(d.features), 'features should be array');
  return `${d.features.length} active alerts`;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${pass} passed  |  ${fail} failed  |  ${warn} API warnings`);
if (skipped > 0) {
  console.log(`  ${skipped} live API test${skipped === 1 ? '' : 's'} skipped — run with LIVE_API=1 npm test`);
}
console.log('─'.repeat(50));

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  ✗  ${f}`));
  console.log('');
}

if (fail > 0) {
  process.exit(1);
}
