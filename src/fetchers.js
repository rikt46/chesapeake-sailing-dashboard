// ============================================================
// src/fetchers.js — NOAA / NWS data fetchers
//
// Network access layer: the core tide, current, wind, temperature
// and forecast fetchers, plus the shared fetch helpers
// (buildRequestUrl, fetchJSON). Each returns the raw
// upstream JSON shape; parsing/normalization lives elsewhere.
// Extracted from the // ===== DATA FETCHERS ===== section of app.js.
//
// Depends on:
//   src/config.js  (station IDs, weather grid)
//   src/dates.js   (getDateContext → start/end window)
//   src/helpers.js (degToCard for wind direction)
//
// Note: the marine-specific fetchers (alerts, CWF forecasts, UV,
// bay buoy) and the source-status layer (buildSourceStatus) remain
// in app.js — they depend on the marine parsers extracted in a
// later step.
// ============================================================

import {
  NOAA_STATION,
  TCBM2_STATION_ID,
  NOAA_CURRENT_STATION,
  WEATHER_GRID,
} from "./config.js";
import { getDateContext } from "./dates.js";
import { degToCard, metersPerSecondToKnots } from "./helpers.js";

// Append a cache-busting query param when a forced refresh is requested,
// otherwise return the URL untouched so the browser cache can serve it.
export function buildRequestUrl(url, forceRefresh = false) {
  if (!forceRefresh) return url;
  const base = typeof window !== "undefined" ? window.location.origin : undefined;
  const nextUrl = new URL(url, base);
  nextUrl.searchParams.set("_refresh", String(Date.now()));
  return nextUrl.toString();
}

export async function fetchJSON(url, options = {}) {
  const res = await fetch(buildRequestUrl(url, options.forceRefresh), {
    cache: options.forceRefresh ? "no-store" : "default",
    ...(options.headers ? { headers: options.headers } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function fetchTides(options = {}) {
  const { startCompact, endCompact } = getDateContext();
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${startCompact}&end_date=${endCompact}&station=${NOAA_STATION}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`,
    options
  );
}

export function fetchTideHourly(options = {}) {
  const { startCompact, endCompact } = getDateContext();
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${startCompact}&end_date=${endCompact}&station=${NOAA_STATION}` +
    `&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json`,
    options
  );
}

export function fetchCurrentPredictions(options = {}) {
  const { startCompact, endCompact } = getDateContext();
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?begin_date=${startCompact}&end_date=${endCompact}&station=${NOAA_CURRENT_STATION.id}` +
    `&product=currents_predictions&time_zone=lst_ldt&units=english&format=json&interval=max_slack`,
    options
  );
}

// Fetch wind from NDBC TCBM2 (Tolchester Marina met station, updates every 6 min).
// Normalize to the same {data:[{t,s,d,dr,g}]} shape CO-OPS returns so the rest
// of the rendering code is unchanged. Falls back to CO-OPS 8573364 if TCBM2
// fails or reports no valid wind data.
export async function fetchCurrentWind(options = {}) {
  try {
    const url = buildRequestUrl(
      `https://www.ndbc.noaa.gov/data/realtime2/${TCBM2_STATION_ID}.txt`,
      options.forceRefresh
    );
    const res = await fetch(url, { cache: options.forceRefresh ? "no-store" : "default" });
    if (!res.ok) throw new Error(`NDBC ${res.status}`);
    const text = await res.text();

    // First non-header line is the latest observation.
    const line = text.split(/\n/).map(l => l.trim()).find(l => l && !l.startsWith("#"));
    if (!line) throw new Error("TCBM2: no data rows");
    const f = line.split(/\s+/);
    // NDBC columns: YY MM DD hh mm WDIR WSPD GST …
    const wspdMs = parseFloat(f[6]);
    const gustMs = parseFloat(f[7]);
    const wdir   = parseFloat(f[5]);
    if (!Number.isFinite(wspdMs) || wspdMs === 99.0) throw new Error("TCBM2: MM wind");

    const sKt = wspdMs * 1.94384;
    const gKt = Number.isFinite(gustMs) && gustMs !== 99.0 ? gustMs * 1.94384 : null;
    const [yr, mo, dy, hh, mm] = f;
    const fullYear = yr.length === 2
      ? (Number(yr) < 70 ? 2000 + Number(yr) : 1900 + Number(yr))
      : Number(yr);
    // Build an ISO 8601 UTC string so parseSourceDate uses new Date() (UTC-aware)
    // rather than parseNoaaTime() which treats the timestamp as local time.
    const t = `${String(fullYear).padStart(4, "0")}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:00Z`;

    return {
      _source: "TCBM2",
      data: [{
        t,
        s: sKt.toFixed(2),
        d: Number.isFinite(wdir) ? String(wdir) : "0",
        dr: Number.isFinite(wdir) ? degToCard(wdir) : "--",
        g: gKt !== null ? gKt.toFixed(2) : String(sKt * 1.25),
      }],
    };
  } catch {
    // Fallback: CO-OPS 8573364 tide-gauge anemometer
    return fetchJSON(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?date=latest&station=${NOAA_STATION}&product=wind&time_zone=lst_ldt&units=english&format=json`,
      options
    );
  }
}

export function fetchAirTemp(options = {}) {
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?date=latest&station=${NOAA_STATION}&product=air_temperature&time_zone=lst_ldt&units=english&format=json`,
    options
  );
}

export function fetchWaterTemp(options = {}) {
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?date=latest&station=${NOAA_STATION}&product=water_temperature&time_zone=lst_ldt&units=english&format=json`,
    options
  );
}

export function fetchWaterLevel(options = {}) {
  return fetchJSON(
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?date=latest&station=${NOAA_STATION}&product=water_level&datum=MLLW&time_zone=lst_ldt&units=english&format=json`,
    options
  );
}

export function fetchForecast(options = {}) {
  return fetchJSON(`https://api.weather.gov/gridpoints/${WEATHER_GRID}/forecast`, {
    ...options,
    headers: { "User-Agent": "TolchesterSailingDashboard", ...options.headers },
  });
}

export function fetchHourlyForecast(options = {}) {
  return fetchJSON(`https://api.weather.gov/gridpoints/${WEATHER_GRID}/forecast/hourly`, {
    ...options,
    headers: { "User-Agent": "TolchesterSailingDashboard", ...options.headers },
  });
}
