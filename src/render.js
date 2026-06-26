// ============================================================
// src/render.js — DOM renderers
//
// One function per dashboard panel plus a top-level renderAll()
// orchestrator. The renderers read from a module-local cachedData
// that's seeded by the dashboard's data-loading code via
// setCachedData(). No fetch logic here — that's src/fetchers.js,
// src/marine_fetchers.js, src/bay_buoy.js, src/uv.js, src/ntm.js.
//
// Depends on:
//   src/config.js             (NOAA_CURRENT_STATION, BAY_BUOY_STATION,
//                              KEEL_DRAFT_FT, CHARTED_DEPTH_MLLW,
//                              MIN_DEPTH_FT, DEFAULT_GUST_RATIO)
//   src/dates.js              (getDateContext, getActiveDayIndex,
//                              refreshDateContext, fmtDate)
//   src/helpers.js            (parseNoaaTime, formatTime12, getWeatherIcon,
//                              escapeHtml, parseWindMph, mphToKnots)
//   src/charts.js             (renderWindChart, renderTideChart)
//   src/recommendation.js     (getNoGoBlocker, summarizePrimaryReason,
//                              getBestWindowSummary, buildSafeWindows,
//                              formatWindowBoundary, getDeltaBadge,
//                              compareAgainstToday, getCrewModeConfig,
//                              getSafetyModeConfig, assessDay,
//                              computeAllRecommendations, getNoGoBlockerBadge)
//   src/marine.js             (getMarineForecastForDay, cleanMarineConditionText,
//                              getStormOutlookForDay)
//   src/uv.js                 (getUvForDay)
//   src/current_predictions.js (summarizeCurrentPrediction, currentEventLabel)
//   src/bay_buoy.js           (getBayBuoySummary, getBayBuoyReality)
//   src/fetchers.js           (fetchSource indirectly through app.js)
// ============================================================

import {
  NOAA_CURRENT_STATION,
  BAY_BUOY_STATION,
  KEEL_DRAFT_FT,
  CHARTED_DEPTH_MLLW,
  MIN_DEPTH_FT,
  DEFAULT_GUST_RATIO,
} from "./config.js";
import {
  getDateContext,
  getActiveDayIndex,
  refreshDateContext,
  fmtDate,
} from "./dates.js";
import {
  parseNoaaTime,
  formatTime12,
  getWeatherIcon,
  escapeHtml,
  parseWindMph,
  mphToKnots,
} from "./helpers.js";
import { renderWindChart, renderTideChart } from "./charts.js";
import {
  getNoGoBlocker,
  summarizePrimaryReason,
  getBestWindowSummary,
  buildSafeWindows,
  formatWindowBoundary,
  getDeltaBadge,
  compareAgainstToday,
  getCrewModeConfig,
  getSafetyModeConfig,
  getNoGoBlockerBadge,
  computeAllRecommendations,
} from "./recommendation.js";
import {
  getMarineForecastForDay,
  cleanMarineConditionText,
  getStormOutlookForDay,
} from "./marine.js";
import { getUvForDay } from "./uv.js";
import { summarizeCurrentPrediction, currentEventLabel as _currentEventLabel } from "./current_predictions.js";
import { getBayBuoySummary, getBayBuoyReality } from "./bay_buoy.js";

// ── Module-local state ─────────────────────────────────────────────────

// The dashboard's "single source of truth" for everything that
// gets passed into the renderers. Updated by setCachedData() from
// app.js after each loadAllData() cycle. Kept here so individual
// renderers don't have to thread cachedData through every call.
let cachedData = {};

let simpleViewEnabled = false;

export function getCachedData() {
  return cachedData;
}

export function setCachedData(data) {
  cachedData = data;
}

export function getSimpleViewEnabled() {
  return simpleViewEnabled;
}

export function setSimpleViewEnabled(enabled) {
  simpleViewEnabled = enabled;
}

// ── Source status (shared by renderAll, loadAllData, and auto-refresh) ─

const HARD_FRESHNESS_BUCKETS = {
  liveObservation: 90 * 60 * 1000,
  forecast: 8 * 60 * 60 * 1000,
  tidePrediction: 6 * 60 * 60 * 1000,
  notice: 6 * 60 * 60 * 1000,
};

function minutesToRoundedAge(ageMs) {
  return Math.max(0, Math.round(ageMs / 60000));
}

function formatAgeMinutes(minutes) {
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h old` : `${hours}h ${mins}m old`;
}

function formatClockLabel(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function getObservationFreshnessSummary(sourceStatuses = {}) {
  const observationStatuses = ["currentWind", "airTemp", "waterTemp", "waterLevel"]
    .map((key) => sourceStatuses[key])
    .filter((status) => status && status.primaryTimestamp instanceof Date);

  if (observationStatuses.length === 0) return null;

  const timestamps = observationStatuses
    .map((status) => status.primaryTimestamp)
    .sort((a, b) => a.getTime() - b.getTime());
  const oldest = timestamps[0];
  const newest = timestamps[timestamps.length - 1];
  const ageMs = Math.max(0, Date.now() - oldest.getTime());
  const timeLabel =
    oldest.getTime() === newest.getTime()
      ? formatClockLabel(oldest)
      : `${formatClockLabel(oldest)}-${formatClockLabel(newest)}`;

  return `NDBC TCBM2 ${timeLabel} · ${formatAgeMinutes(minutesToRoundedAge(ageMs))}`;
}

export function getRecommendationBlockers(sourceStatuses = {}) {
  return Object.values(sourceStatuses).filter((status) => {
    if (!status.requiredForRecommendation) return false;
    if (status.state === "failed" || status.state === "missing") return true;
    if (status.state === "stale" && !["forecast", "hourlyForecast"].includes(status.key)) return true;
    return false;
  });
}

export function getRecommendationGate(sourceStatuses = {}) {
  const blockers = getRecommendationBlockers(sourceStatuses);
  if (blockers.length === 0) {
    return { blocked: false, blockers: [] };
  }

  return {
    blocked: true,
    blockers,
    summary: blockers.map((status) => `${status.label}: ${status.state}`).join(" · "),
  };
}

export function getFallbackDataNotice(sourceStatuses = {}) {
  const usableRequired = Object.values(sourceStatuses)
    .filter((status) => status.requiredForRecommendation && status.ageMs !== null)
    .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));

  if (usableRequired.length === 0) return "";

  const oldest = usableRequired[0];
  return `Using oldest available required input: ${oldest.label}, ${formatAgeMinutes(minutesToRoundedAge(oldest.ageMs))}.`;
}

export function hasRecommendationInputsAvailable() {
  return Boolean(
    cachedData.hourlyPeriods && cachedData.hourlyPeriods.length > 0
    && cachedData.forecastPeriods && cachedData.forecastPeriods.length > 0
    && cachedData.tides && Array.isArray(cachedData.tides.predictions) && cachedData.tides.predictions.length > 0
    && cachedData.tideHourly && Array.isArray(cachedData.tideHourly.predictions) && cachedData.tideHourly.predictions.length > 0
  );
}

export function renderSourceStatus(sourceStatuses = {}) {
  const sectionEl = document.getElementById("sourceStatus");
  const summaryEl = document.getElementById("sourceStatusSummary");
  const listEl = document.getElementById("sourceStatusList");
  if (!sectionEl || !summaryEl || !listEl) return;

  const params = new URLSearchParams(window.location.search);
  if (!params.has("debugSources")) {
    sectionEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }

  sectionEl.hidden = false;

  const statuses = Object.values(sourceStatuses);
  if (statuses.length === 0) {
    summaryEl.textContent = "Checking upstream data sources...";
    listEl.innerHTML = "";
    return;
  }

  const blockers = getRecommendationBlockers(sourceStatuses);
  if (blockers.length > 0) {
    summaryEl.textContent = `Recommendation blocked until required data recovers: ${blockers.map((status) => status.label).join(", ")}.`;
  } else {
    summaryEl.textContent = "All required forecast and tide inputs are fresh enough to publish a sailing recommendation.";
  }

  listEl.innerHTML = statuses.map((status) => `
      <div class="source-chip source-chip--${escapeHtml(status.state)}">
        <div class="source-chip-name">${escapeHtml(status.label)}</div>
        <div class="source-chip-meta">${escapeHtml(status.provenance)} · ${escapeHtml(status.detail)}</div>
      </div>
    `).join("");
}

// ── Recommendation banner / simple view / outlook strip ───────────────

export function renderRecommendation(recs) {
  const gate = getRecommendationGate(cachedData.sourceStatuses || {});
  const el = document.getElementById("recommendation");
  const icon = document.getElementById("recIcon");
  const bannerLabel = document.getElementById("recLabel");
  const title = document.getElementById("recTitle");
  const detail = document.getElementById("recDetail");
  const risk = document.getElementById("recRisk");
  const meta = document.getElementById("recMeta");
  const briefingRating = document.getElementById("briefingRating");
  const briefingRatingNote = document.getElementById("briefingRatingNote");
  const briefingWindow = document.getElementById("briefingWindow");
  const briefingWindowNote = document.getElementById("briefingWindowNote");
  const briefingChange = document.getElementById("briefingChange");
  const briefingChangeNote = document.getElementById("briefingChangeNote");

  if (gate.blocked && cachedData.fallbackRecommendations) {
    const fallbackDay = cachedData.fallbackRecommendations[getActiveDayIndex()];
    const fallbackAgeNote = cachedData.fallbackRecommendationAgeNote || getFallbackDataNotice(cachedData.sourceStatuses || {});
    const label = getActiveDayIndex() === 0 ? "Today" : fallbackDay.dayName;

    el.setAttribute("data-level", fallbackDay.level);
    icon.innerHTML = fallbackDay.sailPlan ? fallbackDay.sailPlan.icon : "&#9888;";
    if (bannerLabel) bannerLabel.textContent = "Sail Recommendation · Using oldest available data";
    title.textContent = fallbackDay.sailPlan ? fallbackDay.sailPlan.title : "Best available guidance";
    detail.textContent =
        `${label}: Winds ${fallbackDay.avgWind}\u2013${fallbackDay.maxWind} kts sustained, gusts ~${fallbackDay.estGust} kts. ${fallbackAgeNote}`;
    if (risk) {
      const riskText = (function (d) {
        const factors = (d.cautions || []).slice();
        return factors.length > 0 ? factors.join("; ") : "";
      })(fallbackDay);
      risk.textContent = riskText;
      risk.hidden = !riskText;
    }
    if (meta) {
      meta.innerHTML = [
        fallbackDay.sailPlan ? `<span class="rec-chip">${fallbackDay.sailPlan.setup}</span>` : "",
        fallbackDay.depthWindow ? `<span class="rec-chip">${fallbackDay.depthWindow.long}</span>` : "",
        `<span class="rec-chip rec-chip--warning">${escapeHtml(fallbackAgeNote)}</span>`,
      ].filter(Boolean).join("");
    }
    if (briefingRating) briefingRating.textContent = fallbackDay.readiness || "Fallback";
    if (briefingRatingNote) briefingRatingNote.textContent = fallbackAgeNote;
    if (briefingWindow) briefingWindow.textContent = fallbackDay.depthWindow ? fallbackDay.depthWindow.leaveAfter : "Window pending";
    if (briefingWindowNote) {
      briefingWindowNote.classList.add("briefing-note--alert");
      briefingWindowNote.textContent = "Review conditions carefully before departure. This guidance is using older required data.";
    }
    if (briefingChange) briefingChange.textContent = "Fallback guidance";
    if (briefingChangeNote) briefingChangeNote.textContent = fallbackAgeNote;
    return;
  }

  if (gate.blocked) {
    el.setAttribute("data-level", "harbor-only");
    icon.innerHTML = "&#9888;";
    if (bannerLabel) bannerLabel.textContent = "Sail Recommendation · Temporarily unavailable";
    title.textContent = "Recommendation Paused";
    detail.textContent = "A required tide or forecast input is temporarily unavailable. Refresh again shortly.";
    if (risk) {
      risk.textContent = "Captain/crew logic: hold the decision until the required tide and forecast inputs recover. Without them, the app cannot show a responsible go/no-go margin.";
      risk.hidden = false;
    }
    if (meta) {
      meta.innerHTML = gate.blockers.map((status) => `<span class="rec-chip">${escapeHtml(status.label)}: ${escapeHtml(status.detail)}</span>`).join("");
    }
    if (briefingRating) briefingRating.textContent = "Blocked";
    if (briefingRatingNote) briefingRatingNote.textContent = "Waiting for a required input to recover";
    if (briefingWindow) briefingWindow.textContent = "Unavailable";
    if (briefingWindowNote) {
      briefingWindowNote.textContent = "Departure windows resume when the missing input recovers.";
      briefingWindowNote.classList.add("briefing-note--alert");
    }
    if (briefingChange) briefingChange.textContent = "Holding pattern";
    if (briefingChangeNote) briefingChangeNote.textContent = "Refresh again shortly before making a departure call.";
    return;
  }

  const day = recs[getActiveDayIndex()];
  const change = compareAgainstToday(recs, getActiveDayIndex());
  const label = getActiveDayIndex() === 0 ? "Today" : day.dayName;

  el.setAttribute("data-level", day.level);
  if (bannerLabel) {
    bannerLabel.textContent = day.dayWindowPassed
      ? `Sail Recommendation · Evening hours · ${getCrewModeConfig().label} · ${getSafetyModeConfig().label}`
      : `Sail Recommendation · ${getCrewModeConfig().label} · ${getSafetyModeConfig().label}`;
  }

  let mainMsg;
  const bspNote = day.estBsp > 0 ? ` Est. boat speed ~${day.estBsp.toFixed(1)} kts.` : "";
  const scoreNote = day.readiness ? ` Readiness: ${day.readiness}.` : "";
  if (!day.sailPlan) {
    if (day.level === "unknown") {
      icon.textContent = "\u2014";
      title.textContent = "No forecast data";
      detail.textContent = "No hourly forecast data is available for this day.";
      if (risk) {
        risk.textContent = "";
        risk.hidden = true;
      }
      if (meta) meta.innerHTML = "";
    } else {
      icon.innerHTML = "&#8230;";
      title.textContent = "Loading\u2026";
      detail.textContent = "Fetching forecast data\u2026";
      if (risk) {
        risk.textContent = "";
        risk.hidden = true;
      }
      if (meta) meta.innerHTML = "";
    }
    return;
  }

  icon.innerHTML = day.sailPlan.icon;
  title.textContent = day.sailPlan.title;
  mainMsg = `${label}: Winds ${day.avgWind}\u2013${day.maxWind} kts sustained, gusts ~${day.estGust} kts.${bspNote}${scoreNote} ${day.sailPlan.detail}`;

  if (day.cautions.length > 0) {
    mainMsg += " Caution: " + day.cautions.join("; ") + ".";
  }
  detail.textContent = mainMsg;
  if (risk) {
    const factors = (day.cautions || []).slice();
    const riskText = factors.length > 0 ? factors.join("; ") : "";
    risk.textContent = riskText;
    risk.hidden = !riskText;
  }
  if (meta) {
    const metaItems = [
      `<span class="rec-chip">${day.sailPlan.setup}</span>`,
      day.depthWindow ? `<span class="rec-chip">${day.depthWindow.long}</span>` : "",
      `<span class="rec-chip">${escapeHtml(summarizePrimaryReason(day))}</span>`,
    ].filter(Boolean);
    if (day.dayWindowPassed) {
      metaItems.push(`<span class="rec-chip rec-chip--warning">Based on evening hours \u2014 sailing window has passed</span>`);
    }
    if (cachedData.nwsRefreshNotice) {
      metaItems.push(`<span class="rec-chip rec-chip--warning">${escapeHtml(cachedData.nwsRefreshNotice)}</span>`);
    }
    meta.innerHTML = metaItems.join("");
  }

  if (briefingRating) briefingRating.textContent = day.readiness || "—";
  if (briefingRatingNote) briefingRatingNote.textContent = `Sail score: ${day.sailScore}/100`;
  if (briefingWindow) briefingWindow.textContent = day.depthWindow ? day.depthWindow.leaveAfter : "Window pending";
  if (briefingWindowNote) {
    briefingWindowNote.classList.remove("briefing-note--alert");
    if (day.level === "harbor-only") {
      briefingWindowNote.textContent = getNoGoBlocker(day);
      briefingWindowNote.classList.add("briefing-note--alert");
    } else if (day.depthInfo && day.depthInfo.safeAllDay) {
      briefingWindowNote.textContent = day.depthWindow ? day.depthWindow.returnBefore : "Depth is clear across the day";
    } else {
      briefingWindowNote.textContent = day.depthWindow ? day.depthWindow.returnBefore : "Longest depth-safe departure block";
    }
  }
  if (briefingChange) briefingChange.textContent = change.title;
  if (briefingChangeNote) briefingChangeNote.textContent = change.note;
}

export function renderSimpleSummary(recs) {
  const titleEl = document.getElementById("simpleTitle");
  const decisionEl = document.getElementById("simpleDecision");
  const copyEl = document.getElementById("simpleCopy");
  const basicsEl = document.getElementById("simpleBasics");
  if (!titleEl || !decisionEl || !copyEl || !basicsEl) return;

  const gate = getRecommendationGate(cachedData.sourceStatuses || {});
  let day = recs && recs[0] ? recs[0] : null;
  let label = "Today";

  if (gate.blocked && cachedData.fallbackRecommendations && cachedData.fallbackRecommendations[0]) {
    day = cachedData.fallbackRecommendations[0];
    label = "Today, using oldest available data";
  }

  if (gate.blocked && !day) {
    titleEl.textContent = "Recommendation paused";
    decisionEl.textContent = "Checking";
    decisionEl.dataset.decision = "unknown";
    copyEl.textContent = "A required tide or forecast input is unavailable. Refresh again before making a departure call.";
    basicsEl.innerHTML = gate.blockers.map((status) => `
        <div class="simple-basic">
          <div class="simple-basic-label">${escapeHtml(status.label)}</div>
          <div class="simple-basic-value">${escapeHtml(status.detail)}</div>
        </div>
      `).join("");
    return;
  }

  // buildSimpleDaySummary lives in src/recommendation.js but isn't exported.
  // We re-implement the minimal shape here from the day record so we don't
  // need to re-export it. (The full version is exercised by tests.mjs.)
  const isNoGo = day && day.level === "harbor-only";
  const isPlainGo = day && day.level === "full-sail";
  const decisionLabel = isNoGo ? "NO-GO" : "GO";
  const decisionKey = isNoGo ? "nogo" : isPlainGo ? "go" : "caution";
  const title = isNoGo ? "Stay in" : (day && day.sailPlan ? `Go - ${day.sailPlan.shortLabel}` : "Calculating...");
  const wind = day && day.maxWind > 0
    ? `${day.avgWind}-${day.maxWind} kt, gusts ~${day.estGust} kt`
    : "Wind pending";
  const window = day && day.depthWindow
    ? `${day.depthWindow.leaveAfter}; ${day.depthWindow.returnBefore}`
    : "Depth window pending";
  const watch = isNoGo
    ? getNoGoBlocker(day)
    : (day && day.cautions && day.cautions.length > 0)
      ? day.cautions.slice(0, 3).join("; ")
      : "No major caution flags shown";
  const reason = isNoGo ? getNoGoBlocker(day) : summarizePrimaryReason(day);
  const noGoReason = isNoGo ? reason.replace(/^No-go because /, "") : "";
  const setup = isNoGo ? "Harbor only" : (day && day.sailPlan ? day.sailPlan.setup : "Pending");
  const copy = isNoGo
    ? `${label}: no-go because ${noGoReason}.`
    : (day && day.sailPlan ? `${label}: go with ${day.sailPlan.shortLabel.toLowerCase()} guidance. ${reason}.` : `${label}: waiting for forecast.`);

  titleEl.textContent = title;
  decisionEl.textContent = decisionLabel;
  decisionEl.dataset.decision = decisionKey;
  copyEl.textContent = copy;
  basicsEl.innerHTML = [
    { label: "Plan", value: setup },
    { label: "Wind", value: wind },
    { label: "Window", value: window },
    { label: "Watch", value: watch },
  ].map((item) => `
        <div class="simple-basic">
          <div class="simple-basic-label">${escapeHtml(item.label)}</div>
          <div class="simple-basic-value">${escapeHtml(item.value)}</div>
        </div>
      `).join("");
}

export function renderOutlookStrip(recs) {
  const strip = document.getElementById("outlookStrip");
  if (!strip) return;
  const { days } = getDateContext();
  const gate = getRecommendationGate(cachedData.sourceStatuses || {});

  if (gate.blocked && cachedData.fallbackRecommendations) {
    recs = cachedData.fallbackRecommendations;
  }

  if (gate.blocked && !recs) {
    strip.innerHTML = `
        <div class="outlook-day outlook-unknown active" aria-live="polite">
          <div class="outlook-label">Recommendation paused</div>
          <div class="outlook-reason">Refresh again shortly.</div>
        </div>
      `;
    return;
  }

  strip.innerHTML = recs.map((rec, i) => {
    const label = i === 0 ? "Today" : days[i].toLocaleDateString("en-US", { weekday: "short" });
    const fullDate = days[i].toLocaleDateString("en-US", { month: "short", day: "numeric" });
    let icon;
    const cls = rec.sailPlan ? `outlook-${rec.sailPlan.tone}` : "outlook-unknown";
    if (rec.sailPlan) {
      icon = rec.sailPlan.icon;
    } else {
      icon = "&#8230;";
    }
    const windStr = rec.maxWind > 0 ? `${rec.avgWind}\u2013${rec.maxWind} kt` : "\u2014";
    const bspStr = rec.estBsp > 0 ? `~${rec.estBsp.toFixed(1)} kt BSP` : "";
    const qualityLabel = rec.sailPlan ? rec.sailPlan.shortLabel : "forecast pending";
    const planStr = rec.sailPlan ? rec.sailPlan.shortLabel : "";
    const reasonStr = summarizePrimaryReason(rec);
    const deltaStr = getDeltaBadge(recs, i);
    const blockerBadge = rec.level === "harbor-only" ? getNoGoBlockerBadge(rec) : "";
    return `
        <button
          type="button"
          class="outlook-day ${cls}${i === getActiveDayIndex() ? " active" : ""}"
          data-day-index="${i}"
          aria-pressed="${i === getActiveDayIndex() ? "true" : "false"}"
          aria-label="${label}, ${fullDate}, ${qualityLabel}"
        >
          <div class="outlook-label">${label}</div>
          <div class="outlook-date">${fullDate}</div>
          ${deltaStr ? `<div class="outlook-delta">${deltaStr}</div>` : ""}
          ${blockerBadge ? `<div class="outlook-blocker">${blockerBadge}</div>` : ""}
          <div class="outlook-icon">${icon}</div>
          <div class="outlook-wind">${windStr}</div>
          ${planStr ? `<div class="outlook-plan">${planStr}</div>` : ""}
          ${reasonStr ? `<div class="outlook-reason">${reasonStr}</div>` : ""}
          ${bspStr ? `<div class="outlook-bsp">${bspStr}</div>` : ""}
          <div class="outlook-score">${rec.readiness ?? ""}</div>
        </button>
      `;
  }).join("");

  // Click to switch day
  strip.querySelectorAll(".outlook-day").forEach((el) => {
    el.addEventListener("click", () => {
      // delegated to a global click handler installed by app.js
      el.dispatchEvent(new CustomEvent("outlook-day-click", { detail: { index: parseInt(el.dataset.dayIndex) }, bubbles: true }));
    });
  });
}

export function updateKPIs(hourlyPeriods, gustRatio, dayRec) {
  const { dayDates } = getDateContext();
  const dateFilter = dayDates[getActiveDayIndex()];
  const dayPeriods = hourlyPeriods.filter((p) => {
    const h = new Date(p.startTime).getHours();
    return p.startTime.startsWith(dateFilter) && h >= 8 && h <= 18;
  });

  if (dayPeriods.length > 0) {
    let maxWind = 0;
    const temps = [];
    const windDirs = [];

    dayPeriods.forEach((p) => {
      const wind = parseWindMph(p.windSpeed);
      const windKts = mphToKnots(wind.high);
      if (windKts > maxWind) maxWind = windKts;
      temps.push(p.temperature);
      windDirs.push(p.windDirection);
    });

    const avgWind = Math.round(dayPeriods.reduce((acc, p) => {
      return acc + mphToKnots(parseWindMph(p.windSpeed).avg);
    }, 0) / dayPeriods.length);

    const maxGust = Math.round(maxWind * gustRatio);

    document.getElementById("kpiWind").textContent = `${avgWind}\u2013${maxWind}`;
    document.getElementById("kpiWindDir").textContent = windDirs[Math.floor(windDirs.length / 2)];
    document.getElementById("kpiGust").textContent = `~${maxGust}`;
    document.getElementById("kpiGustNote").textContent = `est. ${gustRatio.toFixed(2)}× sustained`;

    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    document.getElementById("kpiAirTemp").textContent = maxTemp;
    document.getElementById("kpiAirTempRange").textContent = `${minTemp}\u2013${maxTemp}\u00b0F range`;
  } else {
    document.getElementById("kpiWind").textContent = "--";
    document.getElementById("kpiWindDir").textContent = "--";
    document.getElementById("kpiGust").textContent = "--";
    document.getElementById("kpiGustNote").textContent = "";
    document.getElementById("kpiAirTemp").textContent = "--";
    document.getElementById("kpiAirTempRange").textContent = "\u00a0";
  }

  if (dayRec && dayRec.estBsp > 0) {
    document.getElementById("kpiBsp").textContent = `~${dayRec.estBsp.toFixed(1)}`;
    document.getElementById("kpiBspNote").textContent = dayRec.readiness ? `${dayRec.readiness} day` : "from polars";
  } else {
    document.getElementById("kpiBsp").textContent = "--";
    document.getElementById("kpiBspNote").textContent = "from polars";
  }
}

function renderForecast(forecastPeriods) {
  // Show all NWS forecast periods that fall within our 5-day window
  const { dayNames } = getDateContext();
  const dayNamesLower = dayNames.map((n) => n.toLowerCase());
  const todayAliases = ["today", "tonight", "this afternoon", "this evening", "overnight"];

  const relevant = forecastPeriods.filter((p) => {
    const n = p.name.toLowerCase();
    // Match today aliases
    if (todayAliases.some((a) => n.includes(a))) return true;
    // Match day names (e.g. "Monday", "Monday Night")
    return dayNamesLower.some((dn) => n.includes(dn));
  });

  const grid = document.getElementById("forecastGrid");
  if (!grid) return;
  grid.replaceChildren();

  relevant.forEach((p) => {
    const card = document.createElement("div");
    card.className = "forecast-card";

    const period = document.createElement("div");
    period.className = "forecast-period";
    period.textContent = p.name;

    const icon = document.createElement("div");
    icon.className = "forecast-icon";
    icon.textContent = getWeatherIcon(p.shortForecast);

    const temp = document.createElement("div");
    temp.className = "forecast-temp";
    temp.textContent = `${p.temperature}\u00B0${p.temperatureUnit}`;

    const wind = document.createElement("div");
    wind.className = "forecast-wind";
    wind.textContent = `${p.windSpeed} ${p.windDirection}`;

    const desc = document.createElement("div");
    desc.className = "forecast-desc";
    desc.textContent = p.shortForecast;

    card.append(period, icon, temp, wind, desc);
    grid.appendChild(card);
  });
}

export function renderTideTable(tides) {
  if (!tides || !tides.predictions) return;

  const tbody = document.getElementById("tideTableBody");
  const { dayDates } = getDateContext();
  const dateFilter = dayDates[getActiveDayIndex()];

  const dayTides = tides.predictions.filter((p) => p.t.startsWith(dateFilter));

  tbody.replaceChildren();

  dayTides.forEach((t) => {
    const isHigh = t.type === "H";
    const cls = isHigh ? "tide-high" : "tide-low";
    const time = parseNoaaTime(t.t);

    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = formatTime12(time);

    const tdHeight = document.createElement("td");
    tdHeight.className = cls;
    tdHeight.textContent = `${parseFloat(t.v).toFixed(2)} ft`;

    const tdType = document.createElement("td");
    tdType.className = cls;
    tdType.textContent = isHigh ? "▲ High" : "▼ Low";

    tr.append(tdTime, tdHeight, tdType);
    tbody.appendChild(tr);
  });
}

function renderConditions(wind, airTemp, waterTemp, waterLevel) {
  const grid = document.getElementById("conditionsGrid");
  if (!grid) return;
  const items = [];

  if (wind && wind.data && wind.data[0]) {
    const w = wind.data[0];
    const kts = parseFloat(w.s);
    const gKts = parseFloat(w.g);
    const src = wind._source || "NOAA";
    items.push({
      label: "Wind Now",
      value: `${kts.toFixed(1)} kts`,
      note: `${w.dr} (${w.d}\u00b0) \u00b7 Gusts ${gKts.toFixed(1)} kts \u00b7 ${src}`,
    });
  }

  if (airTemp && airTemp.data && airTemp.data[0]) {
    items.push({
      label: "Air Temperature",
      value: `${Math.round(parseFloat(airTemp.data[0].v))}\u00b0F`,
      note: `as of ${airTemp.data[0].t.split(" ")[1]}`,
    });
  }

  if (waterTemp && waterTemp.data && waterTemp.data[0]) {
    items.push({
      label: "Water Temperature",
      value: `${Math.round(parseFloat(waterTemp.data[0].v))}\u00b0F`,
      note: `as of ${waterTemp.data[0].t.split(" ")[1]}`,
    });
  }

  if (waterLevel && waterLevel.data && waterLevel.data[0]) {
    items.push({
      label: "Water Level",
      value: `${parseFloat(waterLevel.data[0].v).toFixed(2)} ft`,
      note: "MLLW datum",
    });
  }

  grid.replaceChildren();

  const appendConditionCard = (label, value, note, isEmpty = false) => {
    const card = document.createElement("div");
    card.className = isEmpty ? "condition-card condition-card--empty" : "condition-card";

    const labelEl = document.createElement("div");
    labelEl.className = "condition-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("div");
    valueEl.className = "condition-value";
    valueEl.textContent = value;

    const noteEl = document.createElement("div");
    noteEl.className = "condition-note";
    noteEl.textContent = note;

    card.append(labelEl, valueEl, noteEl);
    grid.appendChild(card);
  };

  items.forEach((i) => appendConditionCard(i.label, i.value, i.note));

  if (items.length === 0) {
    appendConditionCard(
      "Current Conditions",
      "Temporarily Unavailable",
      "Live station readings will return automatically on the next refresh.",
      true
    );
  }
}

export function renderNowBar(wind, waterTemp, waterLevel) {
  const windEl = document.getElementById("nowBarWind");
  const waterEl = document.getElementById("nowBarWater");
  const levelEl = document.getElementById("nowBarLevel");

  if (windEl) {
    if (wind && wind.data && wind.data[0]) {
      const w = wind.data[0];
      const kts = parseFloat(w.s).toFixed(1);
      const gKts = parseFloat(w.g).toFixed(1);
      windEl.textContent = `${kts} kts ${w.dr} \u00b7 gusts ${gKts}`;
    } else {
      windEl.textContent = "\u2013";
    }
  }

  if (waterEl) {
    if (waterTemp && waterTemp.data && waterTemp.data[0]) {
      waterEl.textContent = `${Math.round(parseFloat(waterTemp.data[0].v))}\u00b0F`;
    } else {
      waterEl.textContent = "\u2013";
    }
  }

  if (levelEl) {
    if (waterLevel && waterLevel.data && waterLevel.data[0]) {
      const tideOffset = parseFloat(waterLevel.data[0].v);
      const estDepth = CHARTED_DEPTH_MLLW + tideOffset;
      levelEl.textContent = `${estDepth.toFixed(1)} ft`;
    } else {
      levelEl.textContent = "\u2013";
    }
  }
}

export function renderMarineConditions(marineForecasts) {
  const zoneEl = document.getElementById("marineZone");
  const periodEl = document.getElementById("marinePeriod");
  const wavesEl = document.getElementById("marineWaves");
  const visibilityEl = document.getElementById("marineVisibility");
  const visibilityNoteEl = document.getElementById("marineVisibilityNote");
  const summaryEl = document.getElementById("marineSummary");
  const uvCardEl = document.getElementById("uvCard");
  const uvIndexEl = document.getElementById("uvIndex");
  const uvNoteEl = document.getElementById("uvNote");
  if (!zoneEl || !periodEl || !wavesEl || !visibilityEl || !summaryEl) return;

  const { dayDates } = getDateContext();
  const dateStr = dayDates[getActiveDayIndex()];
  const forecast = getMarineForecastForDay(marineForecasts, dateStr);
  const uvInfo = getUvForDay(cachedData.uvIndex, dateStr);

  if (uvIndexEl) uvIndexEl.textContent = uvInfo ? String(uvInfo.peak) : "--";
  if (uvNoteEl) {
    uvNoteEl.textContent = uvInfo
      ? `${uvInfo.risk}${uvInfo.warning ? " - cover up" : ""} near ${uvInfo.timeLabel}`
      : "EPA forecast unavailable";
    uvNoteEl.classList.toggle("marine-note--caution", Boolean(uvInfo && uvInfo.warning));
  }
  if (uvCardEl) {
    uvCardEl.classList.toggle("marine-card--caution", Boolean(uvInfo && uvInfo.warning));
  }

  if (!forecast) {
    zoneEl.textContent = "--";
    periodEl.textContent = "NWS zone forecast";
    wavesEl.textContent = "--";
    visibilityEl.textContent = "--";
    if (visibilityNoteEl) {
      visibilityNoteEl.textContent = "from marine forecast text";
      visibilityNoteEl.classList.remove("marine-note--caution");
    }
    summaryEl.textContent = "Marine zone forecast unavailable for the selected day.";
    return;
  }

  zoneEl.textContent = forecast.zoneId;
  periodEl.textContent = forecast.periodName ? `${forecast.periodName} - ${forecast.zoneLabel}` : forecast.zoneLabel;
  wavesEl.textContent = forecast.waves;
  visibilityEl.textContent = forecast.visibility;
  if (visibilityNoteEl) {
    visibilityNoteEl.textContent = forecast.visibilityRestricted ? "visibility restriction mentioned" : "no restriction mentioned";
    visibilityNoteEl.classList.toggle("marine-note--caution", forecast.visibilityRestricted);
  }
  summaryEl.textContent = cleanMarineConditionText(forecast.text) || "No marine summary text available.";
}

export function renderCurrentPrediction(currentPredictions, dayRec) {
  const stationEl = document.getElementById("currentStation");
  const sourceEl = document.getElementById("currentSource");
  const phaseCard = document.getElementById("currentPhaseCard");
  const phaseEl = document.getElementById("currentPhase");
  const phaseNoteEl = document.getElementById("currentPhaseNote");
  const nextTurnEl = document.getElementById("currentNextTurn");
  const nextTurnNoteEl = document.getElementById("currentNextTurnNote");
  const oppositionCard = document.getElementById("currentOppositionCard");
  const oppositionEl = document.getElementById("currentOpposition");
  const oppositionNoteEl = document.getElementById("currentOppositionNote");
  if (!stationEl || !sourceEl || !phaseCard || !phaseEl || !phaseNoteEl || !nextTurnEl || !nextTurnNoteEl || !oppositionCard || !oppositionEl || !oppositionNoteEl) return;

  const { dayDates } = getDateContext();
  const dateStr = dayDates[getActiveDayIndex()];
  const summary = summarizeCurrentPrediction(currentPredictions, dateStr);
  const phase = summary.phase;

  stationEl.textContent = NOAA_CURRENT_STATION.label;
  sourceEl.textContent = `NOAA ${NOAA_CURRENT_STATION.id} max/slack prediction`;

  if (!summary.hasPrediction || !phase) {
    phaseEl.textContent = "Tide proxy";
    phaseNoteEl.textContent = "Official current prediction unavailable; recommendation falls back to tide phase.";
    nextTurnEl.textContent = "--";
    nextTurnNoteEl.textContent = "NOAA current events unavailable";
  } else {
    const phaseLabel = phase.phase === "slack" ? "Slack" : phase.phase === "flood" ? "Flooding" : "Ebbing";
    phaseEl.textContent = phaseLabel;
    phaseNoteEl.textContent = `${phase.currentDir} set near selected sailing window`;
    nextTurnEl.textContent = _currentEventLabel(summary.nextTurn);
    nextTurnNoteEl.textContent = summary.nextTurn ? formatTime12(summary.nextTurn.time) : "No later turn on selected day";
  }

  const hasOpposition = Boolean(dayRec && dayRec.hasCurrentOpposition);
  oppositionCard.classList.toggle("current-card--caution", hasOpposition);
  phaseCard.classList.toggle("current-card--caution", hasOpposition);
  oppositionEl.textContent = hasOpposition ? "Opposed" : "Aligned";
  oppositionNoteEl.textContent = hasOpposition
    ? (summary.hasPrediction ? "Wind opposes NOAA current prediction" : "Wind opposes tide-phase proxy")
    : "No wind-against-current flag for selected day";
  oppositionNoteEl.classList.toggle("current-note--caution", hasOpposition);
}

export function renderBayBuoyCheck(bayBuoy, dayRec) {
  const stationEl = document.getElementById("buoyStation");
  const sourceEl = document.getElementById("buoySource");
  const windCard = document.getElementById("buoyWindCard");
  const waveCard = document.getElementById("buoyWaveCard");
  const realityCard = document.getElementById("buoyRealityCard");
  const windEl = document.getElementById("buoyWind");
  const windNoteEl = document.getElementById("buoyWindNote");
  const waveEl = document.getElementById("buoyWaves");
  const waveNoteEl = document.getElementById("buoyWaveNote");
  const realityEl = document.getElementById("buoyReality");
  const realityNoteEl = document.getElementById("buoyRealityNote");
  if (!stationEl || !sourceEl || !windCard || !waveCard || !realityCard || !windEl || !windNoteEl || !waveEl || !waveNoteEl || !realityEl || !realityNoteEl) return;

  const summary = getBayBuoySummary(bayBuoy);
  const reality = getBayBuoyReality(summary, dayRec);

  stationEl.textContent = summary.stationLabel || BAY_BUOY_STATION.label;
  sourceEl.textContent = summary.timestamp
    ? `${summary.source} · ${formatTime12(summary.timestamp)}`
    : "NOAA CBIBS / NDBC";

  if (!summary.hasData) {
    windEl.textContent = "--";
    windNoteEl.textContent = "live buoy unavailable";
    waveEl.textContent = "--";
    waveNoteEl.textContent = "observed wave data unavailable";
    realityEl.textContent = reality.status;
    realityNoteEl.textContent = reality.note;
  } else {
    const windDir = Number.isFinite(summary.windDirDeg) ? (function (deg) {
      const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
      const normalized = ((Number(deg) % 360) + 360) % 360;
      return dirs[Math.round(normalized / 22.5) % dirs.length];
    })(summary.windDirDeg) : "";
    windEl.textContent = Number.isFinite(summary.windKts)
      ? `${summary.windKts.toFixed(1)} kt${windDir ? ` ${windDir}` : ""}`
      : "--";
    windNoteEl.textContent = Number.isFinite(summary.gustKts)
      ? `gusts ${summary.gustKts.toFixed(1)} kt`
      : "gust unavailable";

    waveEl.textContent = Number.isFinite(summary.waveFt) ? `${summary.waveFt.toFixed(1)} ft` : "--";
    waveNoteEl.textContent = Number.isFinite(summary.wavePeriodSec)
      ? `${Math.round(summary.wavePeriodSec)} sec period`
      : "period unavailable";

    realityEl.textContent = reality.status;
    realityNoteEl.textContent = reality.note;
  }

  const caution = reality.level === "caution";
  windCard.classList.toggle("buoy-card--caution", caution);
  waveCard.classList.toggle("buoy-card--caution", caution);
  realityCard.classList.toggle("buoy-card--caution", caution);
  realityNoteEl.classList.toggle("buoy-note--caution", caution);
}

export function renderStormWatch(hourlyPeriods, marineAlerts) {
  const statusCard = document.getElementById("stormStatusCard");
  const statusEl = document.getElementById("stormStatus");
  const statusNoteEl = document.getElementById("stormStatusNote");
  const thunderEl = document.getElementById("stormThunder");
  const thunderNoteEl = document.getElementById("stormThunderNote");
  const alertEl = document.getElementById("stormAlert");
  const alertNoteEl = document.getElementById("stormAlertNote");
  if (!statusCard || !statusEl || !statusNoteEl || !thunderEl || !thunderNoteEl || !alertEl || !alertNoteEl) return;

  const { dayDates } = getDateContext();
  const outlook = getStormOutlookForDay(hourlyPeriods || [], marineAlerts || { features: [] }, dayDates[getActiveDayIndex()]);

  statusCard.classList.toggle("storm-card--watch", outlook.level === "watch");
  statusCard.classList.toggle("storm-card--alert", outlook.level === "alert");
  statusEl.textContent = outlook.status;
  statusNoteEl.textContent = outlook.statusNote;
  statusNoteEl.classList.toggle("storm-note--watch", outlook.level === "watch");
  statusNoteEl.classList.toggle("storm-note--alert", outlook.level === "alert");

  thunderEl.textContent = outlook.thunder;
  thunderNoteEl.textContent = outlook.thunderNote;
  thunderNoteEl.classList.toggle("storm-note--watch", outlook.level === "watch");
  thunderNoteEl.classList.toggle("storm-note--alert", outlook.level === "alert");

  alertEl.textContent = outlook.alert;
  alertNoteEl.textContent = outlook.alertNote;
  alertNoteEl.classList.toggle("storm-note--alert", outlook.level === "alert");
}

export function renderDepthWindows(tideHourly) {
  const container = document.getElementById("depthWindows");
  if (!container) return;

  const { dayDates } = getDateContext();
  const dateStr = dayDates[getActiveDayIndex()];
  const anomaly = cachedData.waterLevelAnomaly || { anomalyFt: 0, label: null };
  const result = (function () {
    const minTideNeeded = MIN_DEPTH_FT - CHARTED_DEPTH_MLLW;
    if (!tideHourly || !tideHourly.predictions) return { shoalWindows: [], safeAllDay: true, minDepthOfDay: null };
    const dayPreds = tideHourly.predictions.filter((p) => p.t.substring(0, 10) === dateStr);
    if (dayPreds.length === 0) return { shoalWindows: [], safeAllDay: true, minDepthOfDay: null };
    let minDepthOfDay = Infinity;
    const shoalWindows = [];
    let inShoal = false;
    let windowStart = null;
    let windowMinDepth = Infinity;
    dayPreds.forEach((p) => {
      const tideLevel = parseFloat(p.v) + anomaly.anomalyFt;
      const actualDepth = CHARTED_DEPTH_MLLW + tideLevel;
      if (actualDepth < minDepthOfDay) minDepthOfDay = actualDepth;
      if (actualDepth < MIN_DEPTH_FT) {
        if (!inShoal) {
          windowStart = parseNoaaTime(p.t);
          windowMinDepth = actualDepth;
          inShoal = true;
        } else if (actualDepth < windowMinDepth) {
          windowMinDepth = actualDepth;
        }
      } else if (inShoal) {
        shoalWindows.push({ start: windowStart, end: parseNoaaTime(p.t), minDepth: windowMinDepth });
        inShoal = false;
      }
    });
    if (inShoal) {
      const lastP = dayPreds[dayPreds.length - 1];
      shoalWindows.push({ start: windowStart, end: parseNoaaTime(lastP.t), minDepth: windowMinDepth });
    }
    return {
      shoalWindows,
      safeAllDay: shoalWindows.length === 0,
      minDepthOfDay: minDepthOfDay === Infinity ? null : Math.round(minDepthOfDay * 10) / 10,
    };
  })();

  const anomalyNoteHtml = anomaly.label
    ? `<div class="depth-note depth-note--anomaly">\u26a0\ufe0f ${anomaly.label}</div>`
    : "";

  if (result.safeAllDay || result.minDepthOfDay === null) {
    container.innerHTML = `
        <div class="depth-status depth-safe">
          <span class="depth-icon">&#9989;</span>
          <div>
            <div class="depth-title">Clear all day \u2014 no draft restrictions</div>
            <div class="depth-note">Minimum predicted depth: ${result.minDepthOfDay !== null ? result.minDepthOfDay.toFixed(1) + " ft" : "--"} (need ${MIN_DEPTH_FT} ft for ${KEEL_DRAFT_FT} ft keel)</div>
            ${anomalyNoteHtml}
          </div>
        </div>
      `;
    return;
  }

  const dayStart = new Date(result.shoalWindows[0].start);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 0, 0);
  const safeWindows = buildSafeWindows(dateStr, result.shoalWindows);

  const allSegments = [];
  let barCursor = new Date(dayStart);
  result.shoalWindows.forEach((sw) => {
    if (sw.start > barCursor) {
      allSegments.push({ start: new Date(barCursor), end: new Date(sw.start), type: "safe" });
    }
    allSegments.push({ start: new Date(sw.start), end: new Date(sw.end), type: "shoal", minDepth: sw.minDepth });
    barCursor = new Date(sw.end);
  });
  if (barCursor < dayEnd) {
    allSegments.push({ start: new Date(barCursor), end: dayEnd, type: "safe" });
  }

  const totalMinutes = 24 * 60;
  const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();

  const barHtml = allSegments.map((seg) => {
    const startMin = minuteOfDay(seg.start);
    const endMin = seg.end.getHours() === 23 && seg.end.getMinutes() === 59 ? totalMinutes : minuteOfDay(seg.end);
    const pct = ((endMin - startMin) / totalMinutes) * 100;
    if (pct <= 0) return "";
    const cls = seg.type === "safe" ? "tl-seg-safe" : "tl-seg-shoal";
    const label = seg.type === "safe" ? "OK" : "";
    return `<div class="tl-seg ${cls}" style="width:${pct.toFixed(2)}%" title="${formatTime12(seg.start)} \u2013 ${seg.end.getHours() === 23 && seg.end.getMinutes() === 59 ? '12:00 AM' : formatTime12(seg.end)}${seg.type === 'shoal' ? ' (min ' + seg.minDepth.toFixed(1) + ' ft)' : ''}">${pct > 5 ? label : ''}</div>`;
  }).join("");

  let ticksHtml = "";
  for (let h = 0; h <= 24; h += 3) {
    const pct = (h / 24) * 100;
    const lbl = h === 0 ? "12a" : h === 12 ? "12p" : h === 24 ? "12a" : h < 12 ? h + "a" : (h - 12) + "p";
    ticksHtml += `<span class="tl-tick" style="left:${pct}%">${lbl}</span>`;
  }

  let nowMarkerHtml = "";
  const now = new Date();
  const todayStr = fmtDate(now);
  if (dateStr === todayStr) {
    const nowMin = minuteOfDay(now);
    const nowPct = (nowMin / totalMinutes) * 100;
    nowMarkerHtml = `<div class="tl-now" style="left:${nowPct.toFixed(2)}%" title="Now"><div class="tl-now-line"></div><span class="tl-now-label">Now</span></div>`;
  }

  const windowListHtml = [];
  const allWindows = [
    ...safeWindows.map((w) => ({ ...w, type: "safe" })),
    ...result.shoalWindows.map((w) => ({ ...w, type: "shoal" })),
  ].sort((a, b) => a.start - b.start);

  allWindows.forEach((w) => {
    const endLabel = formatWindowBoundary(w.end, "end");
    const startLabel = formatWindowBoundary(w.start, "start");
    if (w.type === "safe") {
      windowListHtml.push(
        `<div class="dw-row dw-safe"><span class="dw-badge dw-badge-safe">OK to Leave</span><span class="dw-time">${startLabel} \u2013 ${endLabel}</span></div>`
      );
    } else {
      windowListHtml.push(
        `<div class="dw-row dw-shoal"><span class="dw-badge dw-badge-shoal">Too Shallow</span><span class="dw-time">${startLabel} \u2013 ${endLabel}</span><span class="dw-detail">${w.minDepth.toFixed(1)} ft min</span></div>`
      );
    }
  });

  container.innerHTML = `
      <div class="depth-timeline-card">
        <div class="tl-bar-wrap">
          <div class="tl-bar">${barHtml}${nowMarkerHtml}</div>
          <div class="tl-ticks">${ticksHtml}</div>
        </div>
        <div class="dw-list">${windowListHtml.join("")}</div>
        <div class="depth-note">Charted depth ${CHARTED_DEPTH_MLLW} ft + NOAA tide predictions${anomaly.anomalyFt !== 0 ? ` + ${anomaly.anomalyFt > 0 ? "+" : ""}${anomaly.anomalyFt.toFixed(1)} ft observed offset` : ""}. Need ${MIN_DEPTH_FT} ft for ${KEEL_DRAFT_FT} ft keel.</div>
        ${anomalyNoteHtml}
      </div>
    `;
}

export function recomputeRecommendations() {
  if (!cachedData.hourlyPeriods || !cachedData.forecastPeriods || !cachedData.tides || !cachedData.tideHourly) return;

  cachedData.recommendations = computeAllRecommendations(
    cachedData.hourlyPeriods,
    cachedData.forecastPeriods,
    cachedData.tides,
    cachedData.tideHourly,
    cachedData.currentPredictions,
    cachedData.marineAlerts,
    cachedData.uvIndex,
    cachedData.gustRatio || DEFAULT_GUST_RATIO
  );

  renderAll();
}

function updateTabHighlight() {
  document.querySelectorAll(".outlook-day").forEach((el) => el.classList.remove("active"));
  const activeOutlook = document.querySelector(`.outlook-day[data-day-index="${getActiveDayIndex()}"]`);
  document.querySelectorAll(".outlook-day").forEach((el) => {
    el.setAttribute("aria-pressed", "false");
  });
  if (activeOutlook) {
    activeOutlook.classList.add("active");
    activeOutlook.setAttribute("aria-pressed", "true");
  }
}

export function renderAll() {
  refreshDateContext();
  const gr = cachedData.gustRatio || DEFAULT_GUST_RATIO;
  const dayRec = cachedData.recommendations ? cachedData.recommendations[getActiveDayIndex()] : null;
  renderSourceStatus(cachedData.sourceStatuses || {});
  if (cachedData.recommendations) {
    renderRecommendation(cachedData.recommendations);
    renderSimpleSummary(cachedData.recommendations);
    renderOutlookStrip(cachedData.recommendations);
  } else {
    renderRecommendation(null);
    renderSimpleSummary(null);
    renderOutlookStrip(null);
  }
  if (cachedData.hourlyPeriods) {
    renderWindChart(cachedData.hourlyPeriods, gr);
    updateKPIs(cachedData.hourlyPeriods, gr, dayRec);
  }
  renderCurrentPrediction(cachedData.currentPredictions, dayRec);
  renderBayBuoyCheck(cachedData.bayBuoy, dayRec);
  renderMarineConditions(cachedData.marineForecasts);
  renderStormWatch(cachedData.hourlyPeriods, cachedData.marineAlerts);
  if (cachedData.tideHourly) {
    renderTideChart(cachedData.tideHourly);
    renderDepthWindows(cachedData.tideHourly);
  }
  if (cachedData.tides) renderTideTable(cachedData.tides);
}

export function updateTimestamp(sourceStatuses = {}) {
  const now = new Date();
  const lastUpdateEl = document.getElementById("lastUpdate");
  const sourceUpdateEl = document.getElementById("sourceUpdate");

  if (lastUpdateEl) {
    lastUpdateEl.textContent =
      "Dashboard refreshed " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }

  if (sourceUpdateEl) {
    const observationSummary = getObservationFreshnessSummary(sourceStatuses);
    if (observationSummary) {
      sourceUpdateEl.textContent = observationSummary;
      sourceUpdateEl.hidden = false;
    } else {
      sourceUpdateEl.textContent = "";
      sourceUpdateEl.hidden = true;
    }
  }
}
