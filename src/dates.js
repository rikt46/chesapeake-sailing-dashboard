// ============================================================
// src/dates.js — date utilities and rolling-window context
//
// Owns the five-day window state (DAYS, START_COMPACT, …) and
// activeDayIndex (which day the UI is showing). Extracted from
// the // ===== DATE HELPERS ===== section of app.js.
//
// Depends on: src/config.js (DASHBOARD_TIME_ZONE, NUM_DAYS)
// ============================================================

import { DASHBOARD_TIME_ZONE, NUM_DAYS } from "./config.js";

// ========== DATE UTILITIES ==========

export function getFiveDays() {
  // Anchor "today" to the dashboard time zone's current calendar date (the
  // boat's location), not the viewer's local clock — otherwise a browser west
  // of Eastern could pick a day-behind window late at night. Each day object
  // is local midnight of that Eastern calendar date, so fmtDate/fmtDayName
  // (which read local Y/M/D) round-trip back to the intended Eastern date.
  const map = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: DASHBOARD_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date())) {
    map[part.type] = part.value;
  }
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day);

  const days = [];
  for (let i = 0; i < NUM_DAYS; i++) {
    days.push(new Date(y, m - 1, d + i));
  }
  // End date for NOAA API (day after last)
  const end = new Date(y, m - 1, d + NUM_DAYS);
  return { days, end };
}

// Offset (ms) of `timeZone` relative to UTC at the given instant.
// Positive west of UTC is normalised so that: instant + offset = wall clock.
export function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const map = {};
  for (const part of dtf.formatToParts(instant)) map[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second)
  );
  return asUTC - instant.getTime();
}

// Convert a wall-clock time (dateStr = YYYY-MM-DD, timeStr = HH:MM:SS) in the
// dashboard time zone into an absolute Date, independent of the viewer's local
// zone or the CI runner's TZ. Double-corrects so DST boundaries resolve cleanly.
export function zonedWallClockToInstant(dateStr, timeStr, timeZone = DASHBOARD_TIME_ZONE) {
  const naiveUtc = new Date(`${dateStr}T${timeStr}Z`);
  if (Number.isNaN(naiveUtc.getTime())) return new Date(NaN);
  const offset = zoneOffsetMs(naiveUtc, timeZone);
  const instant = new Date(naiveUtc.getTime() - offset);
  const offset2 = zoneOffsetMs(instant, timeZone);
  return offset2 === offset ? instant : new Date(naiveUtc.getTime() - offset2);
}

// Absolute start/end instants for a calendar day in the dashboard time zone.
export function getDayBounds(dateStr) {
  return {
    dayStart: zonedWallClockToInstant(dateStr, "00:00:00"),
    dayEnd:   zonedWallClockToInstant(dateStr, "23:59:59"),
  };
}

// Hour-of-day (0-23) of an instant as observed in the dashboard time zone,
// so daytime-window gates don't drift with the viewer's local zone.
export function zonedHour(value, timeZone = DASHBOARD_TIME_ZONE) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return NaN;
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", hourCycle: "h23",
  }).format(d));
}

export function fmtDate(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function fmtDateCompact(d) { return fmtDate(d).replace(/-/g, ""); }
export function fmtDayName(d)     { return d.toLocaleDateString("en-US", { weekday: "long" }); }
export function fmtShortDay(d)    { return d.toLocaleDateString("en-US", { weekday: "short" }); }

// ========== ROLLING WINDOW STATE ==========
// The five-day window and which day the UI is displaying are tightly coupled —
// activeDayIndex must be clamped whenever the window recomputes. Owning both
// here avoids threading activeDayIndex through every render call.

let activeDayIndex = 0;
let DAYS           = [];
let DAY_DATES      = [];
let DAY_NAMES      = [];
let START_COMPACT  = "";
let END_COMPACT    = "";
let currentDateAnchor = "";

export function getActiveDayIndex()    { return activeDayIndex; }
export function setActiveDayIndex(n)   { activeDayIndex = Math.max(0, Math.min(DAYS.length - 1, n)); }

export function refreshDateContext(resetActiveDay = false) {
  const fiveDay = getFiveDays();
  const days = fiveDay.days;
  const dayDates = days.map(fmtDate);
  const previousAnchor = currentDateAnchor;

  DAYS = days;
  DAY_DATES = dayDates;
  DAY_NAMES = days.map(fmtDayName);
  START_COMPACT = fmtDateCompact(days[0]);
  END_COMPACT   = fmtDateCompact(fiveDay.end);
  currentDateAnchor = dayDates[0];

  if (resetActiveDay || (previousAnchor && previousAnchor !== currentDateAnchor)) {
    activeDayIndex = 0;
  } else if (activeDayIndex >= DAYS.length) {
    activeDayIndex = DAYS.length - 1;
  }
}

export function getDateContext() {
  refreshDateContext();
  return {
    days:         DAYS,
    dayDates:     DAY_DATES,
    dayNames:     DAY_NAMES,
    startCompact: START_COMPACT,
    endCompact:   END_COMPACT,
    todayKey:     currentDateAnchor,
  };
}

// Initialise the window at module load time so the first call to getDateContext()
// doesn't return empty arrays.
refreshDateContext(true);
