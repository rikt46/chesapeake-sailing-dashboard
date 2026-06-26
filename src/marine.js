// ============================================================
// src/marine.js — NWS marine forecast / alert parsing
//
// Pure parsers for the marine forecast text (CWF) and the active
// marine alerts / storm outlooks. No DOM, no fetch — the
// fetchers in src/marine_fetchers.js wrap these in API calls.
//
// Depends on:
//   src/config.js    (MARINE_ALERT_ZONES, MARINE_FORECAST_ZONES)
//   src/dates.js     (getDayBounds, getDateContext, zonedHour)
//   src/helpers.js   (formatHour12, parseSourceDate)
// ============================================================

import { MARINE_FORECAST_ZONES } from "./config.js";
import { getDayBounds, getDateContext, zonedHour } from "./dates.js";
import { formatHour12, parseSourceDate } from "./helpers.js";

// ── Marine alert classification ───────────────────────────────────────────

export const HARD_MARINE_ALERT_EVENTS = [
  "Gale Warning",
  "Storm Warning",
  "Hurricane Force Wind Warning",
  "Special Marine Warning",
  "Low Water Advisory",
  "Dense Fog Advisory",
  "Hazardous Seas Warning",
];

export function isHardMarineAlert(eventName) {
  if (!eventName) return false;
  return HARD_MARINE_ALERT_EVENTS.some((event) => eventName.toLowerCase().includes(event.toLowerCase()));
}

export function isSmallCraftAdvisory(eventName) {
  if (!eventName) return false;
  const normalized = eventName.toLowerCase();
  return normalized.includes("small craft advisory") || normalized === "sca";
}

export function getMarineAlertWindow(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  const start = parseSourceDate(props.onset || props.effective || props.sent);
  const end = parseSourceDate(props.ends || props.expires);
  return { start, end };
}

export function getMarineAlertsForDay(marineAlerts, dateStr) {
  if (!marineAlerts || !Array.isArray(marineAlerts.features)) return [];

  const { dayStart, dayEnd } = getDayBounds(dateStr);

  return marineAlerts.features.filter((feature) => {
    const props = feature.properties || {};
    if (!isHardMarineAlert(props.event) && !isSmallCraftAdvisory(props.event)) return false;

    const { start, end } = getMarineAlertWindow(feature);
    const alertStart = start || dayStart;
    const alertEnd = end || dayEnd;

    return alertStart <= dayEnd && alertEnd >= dayStart;
  });
}

export function summarizeMarineAlert(feature) {
  const props = feature && feature.properties ? feature.properties : {};
  return props.event || "Marine alert";
}

// ── Storm outlook ────────────────────────────────────────────────────────

export const STORM_ALERT_EVENTS = [
  "Special Marine Warning",
  "Marine Weather Statement",
  "Severe Thunderstorm Warning",
  "Severe Thunderstorm Watch",
  "Tornado Warning",
  "Tornado Watch",
];

export function isStormRelatedAlert(eventName) {
  if (!eventName) return false;
  return STORM_ALERT_EVENTS.some((event) => eventName.toLowerCase().includes(event.toLowerCase()));
}

export function getStormAlertsForDay(marineAlerts, dateStr) {
  if (!marineAlerts || !Array.isArray(marineAlerts.features)) return [];

  const { dayStart, dayEnd } = getDayBounds(dateStr);

  return marineAlerts.features.filter((feature) => {
    const props = feature.properties || {};
    if (!isStormRelatedAlert(props.event)) return false;

    const { start, end } = getMarineAlertWindow(feature);
    const alertStart = start || dayStart;
    const alertEnd = end || dayEnd;

    return alertStart <= dayEnd && alertEnd >= dayStart;
  });
}

export function isThunderForecastText(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("thunder") || text.includes("tstorm") || text.includes("lightning");
}

export function getThunderPeriodsForDay(hourlyPeriods, dateStr) {
  if (!Array.isArray(hourlyPeriods)) return [];
  return hourlyPeriods.filter((period) => {
    const start = new Date(period.startTime);
    if (Number.isNaN(start.getTime())) return false;
    const hour = zonedHour(start);
    return period.startTime.startsWith(dateStr)
      && hour >= 8
      && hour <= 20
      && isThunderForecastText(`${period.shortForecast || ""} ${period.detailedForecast || ""}`);
  });
}

export function getStormOutlookForDay(hourlyPeriods, marineAlerts, dateStr) {
  const stormAlerts = getStormAlertsForDay(marineAlerts, dateStr);
  const thunderPeriods = getThunderPeriodsForDay(hourlyPeriods, dateStr);
  const firstThunder = thunderPeriods[0] || null;
  const firstAlert = stormAlerts[0] || null;
  const alertName = firstAlert ? summarizeMarineAlert(firstAlert) : "";

  if (alertName && isHardMarineAlert(alertName)) {
    return {
      level: "alert",
      status: "Active Warning",
      statusNote: alertName,
      thunder: firstThunder ? formatHour12(firstThunder.startTime) : "Check radar",
      thunderNote: firstThunder ? firstThunder.shortForecast : "Warning active; check radar before departure",
      alert: alertName,
      alertNote: "Active NWS storm/marine warning",
    };
  }

  if (alertName || firstThunder) {
    return {
      level: "watch",
      status: "Watch",
      statusNote: alertName || "Thunder mentioned in the hourly forecast",
      thunder: firstThunder ? formatHour12(firstThunder.startTime) : "Not timed",
      thunderNote: firstThunder ? firstThunder.shortForecast : "Storm-related marine statement active",
      alert: alertName || "None active",
      alertNote: alertName ? "NWS storm-related statement" : "No active squall warning",
    };
  }

  return {
    level: "clear",
    status: "No Signal",
    statusNote: "No thunder wording or storm marine alert for selected day",
    thunder: "None shown",
    thunderNote: "Still check radar before casting off",
    alert: "None active",
    alertNote: "No active squall warning",
  };
}

// ── Coastal waters forecast parsing ──────────────────────────────────────

export function parseCoastalWatersForecast(productText, updated) {
  const text = String(productText || "").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n\$\$\s*/);

  return MARINE_FORECAST_ZONES.map((zone) => {
    const block = blocks.find((candidate) => candidate.includes(`${zone.id}-`));
    if (!block) return null;

    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const zoneIndex = lines.findIndex((line) => line.startsWith(`${zone.id}-`));
    const label = lines[zoneIndex + 1] && !/^\d{3,4}\s/.test(lines[zoneIndex + 1])
      ? lines[zoneIndex + 1].replace(/-$/, "")
      : zone.label;
    const periods = [];
    let current = null;

    lines.slice(zoneIndex + 1).forEach((line) => {
      const periodMatch = line.match(/^\.(.+?)\.\.\.(.+)$/);
      if (periodMatch) {
        if (current) periods.push(current);
        current = {
          name: cleanMarineConditionText(periodMatch[1]).replace(/\.$/, ""),
          detailedForecast: cleanMarineConditionText(periodMatch[2]),
        };
        return;
      }

      if (current && !line.startsWith("...") && !line.startsWith("Winds and waves higher")) {
        current.detailedForecast = cleanMarineConditionText(`${current.detailedForecast} ${line}`);
      }
    });

    if (current) periods.push(current);

    return {
      id: zone.id,
      label,
      updated,
      periods,
    };
  }).filter((zone) => zone && zone.periods.length > 0);
}

export function cleanMarineConditionText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

export function extractMarineCondition(text, patterns) {
  const clean = cleanMarineConditionText(text);
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return cleanMarineConditionText(match[0]);
  }
  return "";
}

export function parseMarineForecastText(text) {
  const waves = extractMarineCondition(text, [
    /\b(?:waves|seas)\s+(?:(?:around|near|less than|up to)\s+)?\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:ft|feet|foot)(?:\s+or\s+less)?\b/i,
    /\b(?:waves|seas)\s+(?:flat|calm)\b/i,
  ]);
  const visibility = extractMarineCondition(text, [
    /\b(?:visibility|vsby)\s+(?:(?:around|near|less than|up to)\s+)?\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:nm|nautical miles?|sm|mi|miles?)(?:\s+or\s+less)?\b/i,
    /\b(?:patchy|areas of|dense)\s+fog\b/i,
  ]);

  return {
    waves: waves || "Not mentioned",
    visibility: visibility || "Not restricted",
    visibilityRestricted: Boolean(visibility),
  };
}

export function periodOverlapsDate(period, dateStr) {
  if (!period || !period.startTime) {
    return marinePeriodNameMatchesDate(period && period.name, dateStr);
  }

  if (!period || !period.startTime) return false;
  const { dayStart, dayEnd } = getDayBounds(dateStr);
  const start = new Date(period.startTime);
  const end = period.endTime ? new Date(period.endTime) : start;
  if (Number.isNaN(start.getTime())) return false;
  return start <= dayEnd && end >= dayStart;
}

export function marinePeriodNameMatchesDate(name, dateStr) {
  const label = String(name || "").toLowerCase();
  if (!label) return false;
  const todayKey = getDateContext().todayKey;
  if (dateStr === todayKey && label.includes("today")) return true;
  if (dateStr === todayKey && label.includes("tonight")) return true;

  // Use UTC noon + UTC formatting so the weekday reflects the calendar date
  // itself, not the viewer's local zone near midnight.
  const date = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const shortDay = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toLowerCase();
  const longDay = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
  return label.startsWith(shortDay) || label.startsWith(longDay);
}

export function getMarineForecastForDay(marineForecasts, dateStr) {
  if (!marineForecasts || !Array.isArray(marineForecasts.zones)) return null;

  for (const zone of marineForecasts.zones) {
    const periods = (zone.periods || []).filter((period) => periodOverlapsDate(period, dateStr));
    if (periods.length === 0) continue;

    const daytime = periods.find((period) => {
      const start = new Date(period.startTime);
      return !Number.isNaN(start.getTime()) && start.getHours() >= 6 && start.getHours() <= 18;
    }) || periods[0];
    const text = daytime.detailedForecast || daytime.shortForecast || "";
    const parsed = parseMarineForecastText(text);

    return {
      zoneId: zone.id,
      zoneLabel: zone.label,
      periodName: daytime.name || "Selected day",
      text,
      waves: parsed.waves,
      visibility: parsed.visibility,
      visibilityRestricted: parsed.visibilityRestricted,
    };
  }

  return null;
}
