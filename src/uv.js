// ============================================================
// src/uv.js — EPA UV index fetcher and helpers
//
// Pulls the EPA hourly UV forecast for the configured ZIP, then
// normalizes + summarises it for the dashboard. Pure functions
// (no DOM, no chart) — renderers consume `getUvForDay()` and read
// the { peak, risk, warning, timeLabel } shape.
//
// Depends on:
//   src/config.js    (UV_ZIP)
//   src/dates.js     (fmtDate)
//   src/fetchers.js  (fetchJSON)
//   src/helpers.js   (formatTime12)
// ============================================================

import { UV_ZIP } from "./config.js";
import { fmtDate } from "./dates.js";
import { fetchJSON } from "./fetchers.js";
import { formatTime12 } from "./helpers.js";

export function fetchUvIndex(options = {}) {
  return fetchJSON(
    `https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/${UV_ZIP}/JSON`,
    options
  );
}

export function normalizeUvForecast(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map((row) => {
    const rawDate = row.DATE_TIME || row.date_time || row.Date_Time || row.DATE || "";
    const rawValue = row.UV_VALUE ?? row.uv_value ?? row.UV_INDEX ?? row.Index;
    const value = Number(rawValue);
    const normalizedDate = String(rawDate).replace(" ", "T");
    const dateTime = normalizedDate ? new Date(normalizedDate) : null;
    if (!Number.isFinite(value) || !dateTime || Number.isNaN(dateTime.getTime())) return null;
    return { dateTime, value };
  }).filter(Boolean);
}

export function describeUvRisk(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value >= 11) return "Extreme";
  if (value >= 8) return "Very high";
  if (value >= 6) return "High";
  if (value >= 3) return "Moderate";
  return "Low";
}

export function getUvForDay(uvForecast, dateStr) {
  const rows = normalizeUvForecast(uvForecast).filter((item) => {
    const itemDate = fmtDate(item.dateTime);
    const hour = item.dateTime.getHours();
    return itemDate === dateStr && hour >= 10 && hour <= 16;
  });

  if (rows.length === 0) return null;

  const peak = rows.reduce((max, item) => item.value > max.value ? item : max, rows[0]);
  return {
    peak: Math.round(peak.value),
    risk: describeUvRisk(peak.value),
    warning: peak.value >= 3,
    timeLabel: formatTime12(peak.dateTime),
  };
}
