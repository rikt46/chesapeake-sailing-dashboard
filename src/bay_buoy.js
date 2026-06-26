// ============================================================
// src/bay_buoy.js — Chesapeake Bay buoy (CBIBS + NDBC fallback)
//
// Pulls live wind / wave / water-temp observations for a
// configured bay station. Tries CBIBS first (with a free API key),
// falls back to the NDBC realtime2 text feed if CBIBS is
// unavailable. Normalizes both into a common { hasData, windKts,
// gustKts, windDirDeg, waveFt, wavePeriodSec, waterTempF, … }
// summary used by the renderer.
//
// Depends on:
//   src/config.js     (BAY_BUOY_STATION, CBIBS_API_KEY)
//   src/fetchers.js   (buildRequestUrl, fetchJSON)
//   src/helpers.js    (parseSourceDate, metersPerSecondToKnots,
//                      metersToFeet, celsiusToFahrenheit)
// ============================================================

import { BAY_BUOY_STATION, CBIBS_API_KEY } from "./config.js";
import { buildRequestUrl, fetchJSON } from "./fetchers.js";
import {
  parseSourceDate,
  metersPerSecondToKnots,
  metersToFeet,
  celsiusToFahrenheit,
} from "./helpers.js";

export async function fetchBayBuoyObservations(options = {}) {
  try {
    const cbibsPayload = await fetchJSON(
      `https://mw.buoybay.noaa.gov/api/v1/json/station/${BAY_BUOY_STATION.cbibsId}?key=${CBIBS_API_KEY}`,
      options
    );
    const summary = getBayBuoySummary(cbibsPayload);
    if (summary.hasData) return { ...cbibsPayload, source: "CBIBS" };
  } catch (error) {
    console.warn("CBIBS fetch failed, trying NDBC fallback:", error);
  }

  const response = await fetch(buildRequestUrl(`https://www.ndbc.noaa.gov/data/realtime2/${BAY_BUOY_STATION.ndbcId}.txt`, options.forceRefresh), {
    cache: options.forceRefresh ? "no-store" : "default",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return {
    source: "NDBC",
    stations: [{
      stationShortName: BAY_BUOY_STATION.cbibsId,
      stationLongName: BAY_BUOY_STATION.label,
      variable: ndbcLatestToCbibsVariables(text),
    }],
  };
}

function getCbibsVariable(station, name) {
  const variable = (station && station.variable || [])
    .find((item) => item.actualName === name);
  const measurement = variable && variable.measurements && variable.measurements[0];
  if (!measurement) return null;

  const value = Number(measurement.value);
  const timestamp = parseSourceDate(measurement.time);
  if (!Number.isFinite(value) || !timestamp) return null;

  return {
    value,
    unit: variable.units || "",
    timestamp,
    reportName: variable.reportName || name,
  };
}

export function normalizeCbibsStation(payload) {
  const station = payload && Array.isArray(payload.stations) ? payload.stations[0] : null;
  if (!station) {
    return {
      hasData: false,
      stationLabel: BAY_BUOY_STATION.label,
      source: payload?.source || "NOAA CBIBS / NDBC",
      timestamp: null,
    };
  }

  const windSpeed = getCbibsVariable(station, "wind_speed");
  const windGust = getCbibsVariable(station, "wind_speed_of_gust");
  const windDir = getCbibsVariable(station, "wind_from_direction");
  const waveHeight = getCbibsVariable(station, "sea_surface_wave_significant_height");
  const wavePeriod = getCbibsVariable(station, "sea_surface_wind_wave_period");
  const waterTemp = getCbibsVariable(station, "sea_water_temperature");
  const seaNettle = getCbibsVariable(station, "seanettle_prob");
  const timestamps = [windSpeed, windGust, windDir, waveHeight, wavePeriod, waterTemp, seaNettle]
    .map((item) => item && item.timestamp)
    .filter(Boolean)
    .sort((a, b) => b - a);

  return {
    hasData: Boolean(windSpeed || waveHeight || waterTemp),
    stationLabel: station.stationLongName || BAY_BUOY_STATION.label,
    source: payload.source || "CBIBS",
    timestamp: timestamps[0] || null,
    windKts: windSpeed ? metersPerSecondToKnots(windSpeed.value) : null,
    gustKts: windGust ? metersPerSecondToKnots(windGust.value) : null,
    windDirDeg: windDir ? windDir.value : null,
    waveFt: waveHeight ? metersToFeet(waveHeight.value) : null,
    wavePeriodSec: wavePeriod ? wavePeriod.value : null,
    waterTempF: waterTemp ? celsiusToFahrenheit(waterTemp.value) : null,
    seaNettlePct: seaNettle ? seaNettle.value : null,
  };
}

function ndbcValue(value) {
  return value && value !== "MM" ? Number(value) : null;
}

export function ndbcLatestToCbibsVariables(text) {
  const latest = String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!latest) return [];

  const fields = latest.split(/\s+/);
  const [year, month, day, hour, minute] = fields;
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:00+00`;
  const values = {
    wind_from_direction: { value: ndbcValue(fields[5]), units: "Degrees True", reportName: "Wind Direction" },
    wind_speed: { value: ndbcValue(fields[6]), units: "m/s", reportName: "Wind Speed" },
    wind_speed_of_gust: { value: ndbcValue(fields[7]), units: "m/s", reportName: "Wind Gust" },
    sea_surface_wave_significant_height: { value: ndbcValue(fields[8]), units: "m", reportName: "Significant Wave Height" },
    sea_surface_wind_wave_period: { value: ndbcValue(fields[9]), units: "s", reportName: "Wave Period" },
    air_temperature: { value: ndbcValue(fields[13]), units: "C", reportName: "Air Temperature" },
    sea_water_temperature: { value: ndbcValue(fields[14]), units: "C", reportName: "Water Temperature" },
  };

  return Object.entries(values)
    .filter(([, item]) => Number.isFinite(item.value))
    .map(([actualName, item]) => ({
      actualName,
      reportName: item.reportName,
      units: item.units,
      measurements: [{
        time: timestamp,
        value: item.value,
        QA: "NDBC latest",
      }],
    }));
}

export function getBayBuoySummary(payload) {
  return normalizeCbibsStation(payload);
}

export function getBayBuoyReality(summary, dayRec) {
  if (!summary || !summary.hasData) {
    return {
      level: "missing",
      status: "Unavailable",
      note: "Live bay buoy data unavailable",
    };
  }

  const forecastHigh = dayRec && Number.isFinite(dayRec.maxWind) ? dayRec.maxWind : null;
  const forecastGust = dayRec && Number.isFinite(dayRec.estGust) ? dayRec.estGust : null;
  const windDelta = forecastHigh !== null && Number.isFinite(summary.windKts) ? summary.windKts - forecastHigh : null;
  const gustDelta = forecastGust !== null && Number.isFinite(summary.gustKts) ? summary.gustKts - forecastGust : null;
  const waveCaution = Number.isFinite(summary.waveFt) && summary.waveFt >= 2;
  const gustCaution = Number.isFinite(summary.gustKts) && summary.gustKts >= 20;
  const runningHot = (windDelta !== null && windDelta >= 5) || (gustDelta !== null && gustDelta >= 5);

  if (gustCaution || waveCaution || runningHot) {
    const reasons = [];
    if (gustCaution) reasons.push(`gusts ${Math.round(summary.gustKts)} kt`);
    if (waveCaution) reasons.push(`waves ${summary.waveFt.toFixed(1)} ft`);
    if (runningHot) reasons.push("buoy running above forecast");
    return {
      level: "caution",
      status: "Verify",
      note: reasons.join(" · "),
    };
  }

  return {
    level: "ok",
    status: "Matches",
    note: "Live buoy is not above the selected-day forecast flags",
  };
}
