// ============================================================
// src/recommendation.js — Sail recommendation engine (pure logic)
//
// All the per-day assessment, sail-plan selection, sailability
// scoring, depth-window math, and float-plan helpers. No DOM,
// no chart. Renderers live in src/render.js; this module feeds
// them the { level, sailPlan, sailScore, depthInfo, ... } shape.
//
// Depends on:
//   src/config.js    (POLAR_*, HULL_SPEED, CREW_MODES, SAFETY_MODES,
//                    SAIL_PLANS, THRESHOLDS, CHOPPY_DIRS,
//                    CHOP_PENALTY_KTS, FLOAT_PLAN_CHECKS,
//                    CHARTED_DEPTH_MLLW, MIN_DEPTH_FT, NOAA_CHART_TILE_URL,
//                    LOCAL_NOAA_CHART_TILE_URL, NOAA_CHART_LEVEL_OFFSET)
//   src/dates.js     (getDateContext, getDayBounds, zonedHour)
//   src/helpers.js   (parseWindMph, mphToKnots, degToCard,
//                    parseNoaaTime, formatHour12)
//   src/marine.js    (getMarineAlertsForDay, isHardMarineAlert,
//                    isSmallCraftAdvisory, getStormOutlookForDay)
//   src/uv.js        (getUvForDay)
//   src/current_predictions.js (getCurrentPredictionPhase)
// ============================================================

import {
  POLAR_TWS,
  POLAR_TWA,
  POLAR_BSP,
  HULL_SPEED,
  CREW_MODES,
  SAFETY_MODES,
  SAIL_PLANS,
  THRESHOLDS,
  CHOPPY_DIRS,
  CHOP_PENALTY_KTS,
  DEFAULT_GUST_RATIO,
  FLOAT_PLAN_CHECKS,
  CHARTED_DEPTH_MLLW,
  MIN_DEPTH_FT,
  KEEL_DRAFT_FT,
  NOAA_CHART_TILE_URL,
  LOCAL_NOAA_CHART_TILE_URL,
  NOAA_CHART_LEVEL_OFFSET,
  DEFAULT_SETTINGS,
} from "./config.js";

// Module-local mutable settings. The dashboard sets this whenever the
// user changes crew / safety mode; tests use setUserSettingsForTests()
// to swap it for a specific scenario. Read via getUserSettings().
let currentUserSettings = { ...DEFAULT_SETTINGS };

export function getUserSettings() {
  return currentUserSettings;
}

export function setUserSettings(settings) {
  currentUserSettings = settings;
}

export function setUserSettingsForTests(nextSettings = {}) {
  if (nextSettings.crewMode) currentUserSettings.crewMode = nextSettings.crewMode;
  if (nextSettings.safetyMode) currentUserSettings.safetyMode = nextSettings.safetyMode;
}
import {
  fmtDate,
  getDateContext,
  getDayBounds,
  zonedHour,
} from "./dates.js";
import {
  parseWindMph,
  mphToKnots,
  parseNoaaTime,
  formatTime12,
} from "./helpers.js";
import {
  getMarineAlertsForDay,
  isHardMarineAlert,
  isSmallCraftAdvisory,
  getStormOutlookForDay,
} from "./marine.js";
import { getUvForDay } from "./uv.js";
import { getCurrentPredictionPhase, summarizeCurrentPrediction } from "./current_predictions.js";

// ── Tile URL helpers (used by the Leaflet nautical chart) ──────────────

export function buildNoaaLiveTileUrl(z, x, y) {
  const noaaLevel = Math.max(0, z - NOAA_CHART_LEVEL_OFFSET);
  return NOAA_CHART_TILE_URL
    .replace("{z}", String(noaaLevel))
    .replace("{y}", String(y))
    .replace("{x}", String(x));
}

export function latLonToTileCoords(lat, lon, zoom) {
  const scale = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const latRad = (lat * Math.PI) / 180;
  const merc = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  const y = Math.floor(((1 - merc / Math.PI) / 2) * scale);
  return { x, y };
}

export function buildLocalChartTileUrl(z, x, y) {
  return LOCAL_NOAA_CHART_TILE_URL
    .replace("{z}", String(z))
    .replace("{y}", String(y))
    .replace("{x}", String(x));
}

export async function canLoadTile(url) {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Polar performance ──────────────────────────────────────────────────

// Bilinear interpolation of polar table
export function polarBoatSpeed(tws, twa) {
  // Clamp to table range
  const ws = Math.max(POLAR_TWS[0], Math.min(POLAR_TWS[POLAR_TWS.length - 1], tws));
  const wa = Math.max(POLAR_TWA[0], Math.min(POLAR_TWA[POLAR_TWA.length - 1], twa));

  // Find bracketing indices
  let wi = 0;
  for (let i = 0; i < POLAR_TWS.length - 1; i++) {
    if (POLAR_TWS[i + 1] >= ws) { wi = i; break; }
  }
  let ai = 0;
  for (let i = 0; i < POLAR_TWA.length - 1; i++) {
    if (POLAR_TWA[i + 1] >= wa) { ai = i; break; }
  }

  const wsFrac = POLAR_TWS[wi + 1] === POLAR_TWS[wi] ? 0 :
    (ws - POLAR_TWS[wi]) / (POLAR_TWS[wi + 1] - POLAR_TWS[wi]);
  const waFrac = POLAR_TWA[ai + 1] === POLAR_TWA[ai] ? 0 :
    (wa - POLAR_TWA[ai]) / (POLAR_TWA[ai + 1] - POLAR_TWA[ai]);

  const v00 = POLAR_BSP[ai][wi];
  const v10 = POLAR_BSP[ai][wi + 1];
  const v01 = POLAR_BSP[ai + 1] ? POLAR_BSP[ai + 1][wi] : v00;
  const v11 = POLAR_BSP[ai + 1] ? POLAR_BSP[ai + 1][wi + 1] : v10;

  const top = v00 + (v10 - v00) * wsFrac;
  const bot = v01 + (v11 - v01) * wsFrac;
  return top + (bot - top) * waFrac;
}

// Average BSP across multiple TWA angles for a given TWS
// (represents "how fast will I go on a typical day sail?")
export function avgPolarSpeed(tws) {
  // Weight common sailing angles: close-hauled, close reach, beam, broad
  const angles = [52, 75, 90, 120];
  let sum = 0;
  angles.forEach((a) => { sum += polarBoatSpeed(tws, a); });
  return sum / angles.length;
}

// Score a sailing day 0-100 based on Pearson 31-2 polar performance + conditions
// Higher = better sailing day
export function scoreSailability(avgWindKts, maxWindKts, estGust, maxRainSev, hasChopPenalty, hasCurrentOpposition) {
  let score = 0;

  // --- Speed component (0-50): how fast will the boat go? ---
  const bsp = avgPolarSpeed(avgWindKts);
  // At hull speed (6.76) or above → full 50 pts
  // Below that, scale linearly. Below ~3.5 kts BSP → drifting, 0 pts
  const speedPts = Math.min(50, Math.max(0, ((bsp - 3.5) / (HULL_SPEED - 3.5)) * 50));
  score += speedPts;

  // --- Comfort component (0-30): is it overpowered / dangerous? ---
  let comfortPts = 30;
  // Deduct for high winds (above full-sail threshold)
  if (maxWindKts > THRESHOLDS.fullSail.maxSustained) {
    comfortPts -= Math.min(20, (maxWindKts - THRESHOLDS.fullSail.maxSustained) * 2);
  }
  // Deduct for high gusts
  if (estGust > THRESHOLDS.fullSail.maxGust) {
    comfortPts -= Math.min(15, (estGust - THRESHOLDS.fullSail.maxGust) * 1.5);
  }
  // Chop penalty
  if (hasChopPenalty) comfortPts -= 5;
  // Current opposition
  if (hasCurrentOpposition) comfortPts -= 3;
  score += Math.max(0, comfortPts);

  // --- Weather component (0-20): rain, storms ---
  let wxPts = 20;
  if (maxRainSev === 1) wxPts -= 5;
  else if (maxRainSev === 2) wxPts -= 12;
  else if (maxRainSev >= 3) wxPts = 0;
  score += Math.max(0, wxPts);

  return Math.round(Math.min(100, Math.max(0, score)));
}

// Classify day: "good", "fair", "poor" from score
export function dayQuality(score) {
  if (score >= 60) return "good";
  if (score >= 35) return "fair";
  return "poor";
}

export function describeReadiness(score, level) {
  if (level === "harbor-only") return "No-go";
  if (score >= 85) return "Prime";
  if (score >= 70) return "Good";
  if (score >= 55) return "Watch";
  return "Marginal";
}

// ── Sail plan selection ────────────────────────────────────────────────

export function findSailPlan(key) {
  return SAIL_PLANS.find((plan) => plan.key === key) || SAIL_PLANS[0];
}

export function nudgeSailPlan(planKey, steps) {
  const idx = SAIL_PLANS.findIndex((plan) => plan.key === planKey);
  if (idx === -1) return SAIL_PLANS[0];
  return SAIL_PLANS[Math.min(SAIL_PLANS.length - 1, Math.max(0, idx + steps))];
}

export function getCrewModeConfig() {
  return CREW_MODES[currentUserSettings.crewMode] || CREW_MODES[DEFAULT_SETTINGS.crewMode];
}

export function getSafetyModeConfig() {
  return SAFETY_MODES[currentUserSettings.safetyMode] || SAFETY_MODES[DEFAULT_SETTINGS.safetyMode];
}

export function determineSailPlan(
  effectiveWind,
  effectiveGust,
  maxRainSev,
  hasChopPenalty,
  hasCurrentOpposition
) {
  if (maxRainSev >= 3) return findSailPlan("harbor-only");

  const crew = getCrewModeConfig();
  const safety = getSafetyModeConfig();
  const sustainedOffset = crew.sustainedOffset + safety.sustainedOffset;
  const gustOffset = crew.gustOffset + safety.gustOffset;

  let selected = findSailPlan("harbor-only");
  for (const plan of SAIL_PLANS) {
    if (plan.key === "harbor-only") continue;
    if (
      effectiveWind <= plan.maxSustained + sustainedOffset &&
      effectiveGust <= plan.maxGust + gustOffset
    ) {
      selected = plan;
      break;
    }
  }

  if (maxRainSev === 2 && (selected.key === "full-sail" || selected.key === "roll-genoa")) {
    selected = nudgeSailPlan(selected.key, 1);
  }
  if (hasChopPenalty && hasCurrentOpposition && selected.key === "full-sail") {
    selected = nudgeSailPlan(selected.key, 1);
  }

  return selected;
}

export function shouldSmallCraftAdvisoryForceHarbor(day) {
  const crewMode = currentUserSettings.crewMode || DEFAULT_SETTINGS.crewMode;
  const safetyMode = currentUserSettings.safetyMode || DEFAULT_SETTINGS.safetyMode;
  return crewMode === "solo"
    || safetyMode === "conservative"
    || day.estGust >= 28
    || day.hasChopPenalty
    || day.hasCurrentOpposition
    || day.maxRainSev >= 3
    || day.dayWindowPassed;
}

export function applySmallCraftAdvisorySailPlan(sailPlan, day) {
  if (shouldSmallCraftAdvisoryForceHarbor(day)) return findSailPlan("harbor-only");
  if (sailPlan.key === "full-sail" || sailPlan.key === "roll-genoa") return findSailPlan("first-reef");
  return sailPlan;
}

// ── Tide phase & current opposition ────────────────────────────────────

export function getTidePhase(tides, dateStr, hour) {
  if (!tides || !tides.predictions || tides.predictions.length < 2) return null;
  const dayTides = tides.predictions.filter((p) => p.t.startsWith(dateStr));
  if (dayTides.length < 2) return null;

  for (let i = 0; i < dayTides.length - 1; i++) {
    const t1 = parseNoaaTime(dayTides[i].t);
    const t2 = parseNoaaTime(dayTides[i + 1].t);
    const h1 = t1.getHours() + t1.getMinutes() / 60;
    const h2 = t2.getHours() + t2.getMinutes() / 60;
    if (hour >= h1 && hour < h2) {
      const isEbbing = dayTides[i].type === "H";
      return {
        phase: isEbbing ? "ebb" : "flood",
        currentDir: isEbbing ? "SSE" : "NNW",
      };
    }
  }
  return null;
}

export function windOpposesCurrentCaution(windDir, tidePhase) {
  if (!tidePhase) return false;
  const southerly = ["S", "SSE", "SE", "SSW"].includes(windDir);
  const northerly = ["N", "NNE", "NE", "NNW", "NW"].includes(windDir);
  if (tidePhase.phase === "ebb" && southerly) return true;
  if (tidePhase.phase === "flood" && northerly) return true;
  return false;
}

// ── Depth / shoal window math ─────────────────────────────────────────

// Compare latest observed water level against the nearest hourly prediction.
// Returns { anomalyFt, observed, predicted, label } where anomalyFt = observed - predicted.
// Positive anomaly = more water than predicted (wind setup); negative = less.
export function computeWaterLevelAnomaly(waterLevel, tideHourly) {
  const none = { anomalyFt: 0, observed: null, predicted: null, label: null };
  if (!waterLevel || !waterLevel.data || !waterLevel.data[0]) return none;
  if (!tideHourly || !tideHourly.predictions || tideHourly.predictions.length === 0) return none;

  const obs = waterLevel.data[0];
  const obsTime = new Date(obs.t.replace(" ", "T"));
  const obsVal = parseFloat(obs.v);
  if (Number.isNaN(obsTime.getTime()) || Number.isNaN(obsVal)) return none;

  let closest = null;
  let closestDiff = Infinity;
  for (const p of tideHourly.predictions) {
    const predTime = new Date(p.t.replace(" ", "T"));
    const diff = Math.abs(predTime - obsTime);
    if (diff < closestDiff) { closestDiff = diff; closest = p; }
  }
  if (!closest || closestDiff > 2 * 60 * 60 * 1000) return none;

  const predVal = parseFloat(closest.v);
  const anomalyFt = Math.round((obsVal - predVal) * 10) / 10;
  let label = null;
  if (Math.abs(anomalyFt) >= 0.3) {
    const dir = anomalyFt > 0 ? "above" : "below";
    label = `Water ${Math.abs(anomalyFt).toFixed(1)} ft ${dir} predicted — wind/pressure effect`;
  }
  return { anomalyFt, observed: obsVal, predicted: predVal, label };
}

export function computeDepthWindows(tideHourly, dateStr, anomalyFt = 0) {
  // Scan hourly tide predictions and find periods where depth < MIN_DEPTH_FT.
  // anomalyFt offsets each prediction by the observed vs. predicted water level difference.
  // actual depth = CHARTED_DEPTH_MLLW + tideLevelMLLW + anomalyFt
  // Returns { shoalWindows: [{start, end, minDepth}], safeAllDay: bool, minDepthOfDay }
  if (!tideHourly || !tideHourly.predictions) return { shoalWindows: [], safeAllDay: true, minDepthOfDay: null };

  const dayPreds = tideHourly.predictions.filter((p) => p.t.substring(0, 10) === dateStr);
  if (dayPreds.length === 0) return { shoalWindows: [], safeAllDay: true, minDepthOfDay: null };

  const minTideNeeded = MIN_DEPTH_FT - CHARTED_DEPTH_MLLW;
  let minDepthOfDay = Infinity;
  const shoalWindows = [];
  let inShoal = false;
  let windowStart = null;
  let windowMinDepth = Infinity;

  dayPreds.forEach((p) => {
    const tideLevel = parseFloat(p.v) + anomalyFt;
    const actualDepth = CHARTED_DEPTH_MLLW + tideLevel;
    if (actualDepth < minDepthOfDay) minDepthOfDay = actualDepth;

    if (actualDepth < MIN_DEPTH_FT) {
      if (!inShoal) {
        windowStart = parseNoaaTime(p.t);
        windowMinDepth = actualDepth;
        inShoal = true;
      } else {
        if (actualDepth < windowMinDepth) windowMinDepth = actualDepth;
      }
    } else {
      if (inShoal) {
        shoalWindows.push({ start: windowStart, end: parseNoaaTime(p.t), minDepth: windowMinDepth });
        inShoal = false;
      }
    }
  });
  // Close open window at end of day
  if (inShoal) {
    const lastP = dayPreds[dayPreds.length - 1];
    shoalWindows.push({ start: windowStart, end: parseNoaaTime(lastP.t), minDepth: windowMinDepth });
  }

  return {
    shoalWindows,
    safeAllDay: shoalWindows.length === 0,
    minDepthOfDay: minDepthOfDay === Infinity ? null : Math.round(minDepthOfDay * 10) / 10,
  };
}

export function formatWindowBoundary(d, which) {
  if (which === "start" && d.getHours() === 0 && d.getMinutes() === 0) return "midnight";
  if (which === "end" && d.getHours() === 23 && d.getMinutes() === 59) return "midnight";
  return formatTime12(d);
}

export function buildSafeWindows(dateStr, shoalWindows) {
  if (!shoalWindows || shoalWindows.length === 0) return [];

  const { dayStart, dayEnd } = getDayBounds(dateStr);
  const safeWindows = [];
  let cursor = dayStart;

  shoalWindows.forEach((sw) => {
    if (sw.start > cursor) {
      safeWindows.push({ start: new Date(cursor), end: new Date(sw.start), type: "safe" });
    }
    cursor = new Date(sw.end);
  });

  if (cursor < dayEnd) {
    safeWindows.push({ start: new Date(cursor), end: dayEnd, type: "safe" });
  }

  return safeWindows;
}

export function getBestWindowSummary(depthInfo, dateStr) {
  if (!depthInfo || depthInfo.minDepthOfDay === null) return null;
  if (depthInfo.safeAllDay) {
    return {
      short: "Depth clear all day",
      long: "Best window: depth clear all day",
      leaveAfter: "Leave anytime",
      returnBefore: "Return anytime",
    };
  }

  const safeWindows = buildSafeWindows(dateStr, depthInfo.shoalWindows);
  if (safeWindows.length === 0) {
    return {
      short: "Shoal all day",
      long: "Best window: no safe departure window",
      leaveAfter: "Wait for more water",
      returnBefore: "Harbor only",
    };
  }

  const best = safeWindows.reduce((longest, current) => {
    const currentSpan = current.end - current.start;
    const longestSpan = longest.end - longest.start;
    return currentSpan > longestSpan ? current : longest;
  });

  const startLabel = formatWindowBoundary(best.start, "start");
  const endLabel = formatWindowBoundary(best.end, "end");
  return {
    short: `${startLabel}-${endLabel}`,
    long: `Best window: ${startLabel}-${endLabel}`,
    leaveAfter: `Leave after ${startLabel}`,
    returnBefore: `Return before ${endLabel}`,
  };
}

// ── No-go and primary-reason text ─────────────────────────────────────

export function getNoGoBlocker(day) {
  if (day.marineAlert && isSmallCraftAdvisory(day.marineAlert)) {
    const gap = day.maxWind - THRESHOLDS.fullSail.maxSustained;
    const windNote = day.maxWind > 0 && gap > 0 ? ` — ${day.maxWind} kt forecast is ${gap} kt above this boat's full-sail ceiling` : "";
    if (day.hasChopPenalty) return `No-go: SCA${windNote}. ${day.dominantDir || "Bay"} wind builds short, steep chop — punishing at this LWL`;
    if (day.hasCurrentOpposition) return `No-go: SCA${windNote}. Wind against tide amplifies wave steepness in the Tolchester channel`;
    if (day.maxRainSev >= 3) return `No-go: SCA${windNote}. Squall lines on the Bay can push 40+ kt`;
    if (day.estGust >= 28) return `No-go: SCA gusts near ${day.estGust} kt — past second-reef ceiling for this short-handed boat`;
    if (day.dayWindowPassed) return "No-go: Small Craft Advisory remains active after the useful daylight sailing window";
    return `No-go: SCA${windNote}. Stacks with selected crew or safety mode`;
  }
  if (day.marineAlert) return `No-go because ${day.marineAlert} is active for the selected day`;
  if (day.maxRainSev >= 3) return "No-go because thunderstorms are in the forecast";
  if (day.depthWindow && day.depthWindow.short === "Shoal all day") return "No-go because depth never clears";
  if (day.maxWind >= 28 || day.estGust >= 34) return "No-go because the breeze is too strong for a short-handed day sail";
  if (day.hasChopPenalty && day.hasCurrentOpposition) return "No-go because steep chop will stack up against the tide";
  return "No-go because conditions stack too many risks at once";
}

export function getNoGoBlockerBadge(day) {
  if (day.marineAlert) return "Marine alert";
  if (day.maxRainSev >= 3) return "Storms";
  if (day.depthWindow && day.depthWindow.short === "Shoal all day") return "Depth";
  if (day.maxWind >= 28 || day.estGust >= 34) return "Too windy";
  if (day.hasChopPenalty && day.hasCurrentOpposition) return "Wind vs tide";
  return "Stacked risks";
}

export function summarizePrimaryReason(day) {
  if (day.level === "harbor-only") return getNoGoBlocker(day);
  if (day.marineAlert) return `${day.marineAlert} active`;
  if (day.maxRainSev >= 3) return "Storms in the forecast";
  if (day.level === "harbor-only" && day.maxWind >= 25) return "Too much breeze for comfort";
  if (day.level === "second-reef") return "Heavy breeze building";
  if (day.hasChopPenalty && day.hasCurrentOpposition) return "Steep chop with wind against tide";
  if (day.hasCurrentOpposition) return "Wind against tide";
  if (day.hasChopPenalty) return "Steep Bay chop";
  if (day.maxRainSev === 2) return "Rain likely";
  if (day.maxRainSev === 1) return "Rain around";
  if (day.depthWindow && day.depthWindow.short !== "Depth clear all day") {
    return day.depthWindow.long;
  }
  if (day.avgWind < 6) return "Light-air day";
  return "Best sailing setup";
}

export function getCaptainCrewRiskFactors(day) {
  const factors = [];
  if (!day) return factors;
  if (day.marineAlert) factors.push(`${day.marineAlert} is active`);
  if (day.estGust >= 28) factors.push(`gusts near ${day.estGust} kt`);
  if (day.maxWind >= 22 && day.estGust < 28) factors.push(`sustained wind up to ${day.maxWind} kt`);
  if (day.hasChopPenalty) factors.push(`${day.dominantDir || "Bay"} wind can build short, steep chop`);
  if (day.hasCurrentOpposition) factors.push("wind is opposing the tidal current");
  if (day.maxRainSev >= 3) factors.push("thunderstorms are possible");
  else if (day.maxRainSev === 2) factors.push("rain is likely");
  if (day.depthWindow && day.depthWindow.short === "Shoal all day") factors.push("shoal water does not clear today");
  else if (day.depthWindow && day.depthWindow.short !== "Depth clear all day") factors.push(day.depthWindow.long.toLowerCase());
  if (day.dayWindowPassed) factors.push("the useful sailing window has already passed");
  return factors;
}

export function buildRiskDecisionExplanation(day) {
  if (!day || !day.sailPlan) return "";
  const factors = getCaptainCrewRiskFactors(day);
  const hasSca = isSmallCraftAdvisory(day.marineAlert);
  const nonAlertFactors = factors.filter((factor) => factor !== `${day.marineAlert} is active`);
  const shouldExplain = day.level !== "full-sail" || factors.length > 0;
  if (!shouldExplain) return "";

  const factorText = factors.length > 0 ? factors.join("; ") : "conditions are workable but still need normal checks";
  const scaFactorText = nonAlertFactors.length > 0
    ? nonAlertFactors.join("; ")
    : "the selected crew mode, safety mode, or trip margin";
  if (day.level === "harbor-only") {
    if (hasSca) {
      const ceilingGap = day.maxWind - THRESHOLDS.fullSail.maxSustained;
      const limitGap = day.maxWind > 0 && ceilingGap > 0
        ? ` Forecast ${day.maxWind} kt sustained is ${ceilingGap} kt above this boat's full-sail ceiling.`
        : "";
      return `Captain/crew logic: SCA active.${limitGap} Harbor-only because it stacks with ${scaFactorText}. The 5.8 ft keel limits emergency refuge — Rock Hall and Still Pond are your nearest deep-water options.`;
    }
    return `Captain/crew logic: stay in because ${factorText}. The issue is not one number by itself; it is the combination leaving too little margin.`;
  }

  if (hasSca) {
    const ceilingGap = day.maxWind - THRESHOLDS.fullSail.maxSustained;
    const windNote = day.maxWind > 0 && ceilingGap > 0
      ? ` Forecast ${day.maxWind} kt is ${ceilingGap} kt above the full-sail ceiling.`
      : "";
    const marginText = nonAlertFactors.length > 0
      ? `Watch: ${nonAlertFactors.join("; ")}.`
      : "No additional chop, current, or storm penalty showing.";
    return `Captain/crew logic: SCA active.${windNote} Reef at the dock, not on the water. ${marginText} Know your bailout: the 5.8 ft keel limits shallow-water shelter to deep-draft marinas.`;
  }

  if (day.level === "second-reef") {
    return `Captain/crew logic: this is a heavy-weather setup. Go only with an experienced crew, secure the boat before leaving, and set a conservative turn-back trigger because ${factorText}.`;
  }

  if (day.level === "first-reef" || day.level === "roll-genoa") {
    return `Captain/crew logic: the recommendation reduces sail to preserve margin because ${factorText}. Brief reefing, MOB, engine-failure, and bailout choices before departure.`;
  }

  return "";
}

export function compareAgainstToday(recs, index) {
  const selected = recs[index];
  const today = recs[0];
  const severity = {
    "full-sail": 0,
    "roll-genoa": 1,
    "first-reef": 1,
    "second-reef": 2,
    "harbor-only": 3,
  };

  if (index === 0) {
    return {
      title: "Today sets the baseline",
      note: summarizePrimaryReason(selected),
    };
  }

  const delta = (severity[selected.level] ?? 0) - (severity[today.level] ?? 0);
  if (delta > 0) {
    return {
      title: "More conservative than today",
      note: summarizePrimaryReason(selected),
    };
  }
  if (delta < 0) {
    return {
      title: "More forgiving than today",
      note: summarizePrimaryReason(selected),
    };
  }

  return {
    title: "Same sail plan as today",
    note: summarizePrimaryReason(selected),
  };
}

export function getDeltaBadge(recs, index) {
  if (index === 0) return "Baseline";
  const selected = recs[index];
  const today = recs[0];
  const severity = {
    "full-sail": 0,
    "roll-genoa": 1,
    "first-reef": 1,
    "second-reef": 2,
    "harbor-only": 3,
  };
  const delta = (severity[selected.level] ?? 0) - (severity[today.level] ?? 0);
  if (delta > 0) return "More conservative";
  if (delta < 0) return "Easier than today";
  return "Same as today";
}

export function buildSimpleDaySummary(day, label = "Today") {
  if (!day || !day.sailPlan) {
    return {
      title: "Calculating...",
      decisionLabel: "Checking",
      decisionKey: "unknown",
      copy: "Waiting for the required tide and forecast data before making a go/no-go call.",
      basics: [
        { label: "Plan", value: "Pending" },
        { label: "Wind", value: "Pending" },
        { label: "Watch", value: "Refresh shortly" },
      ],
    };
  }

  const isNoGo = day.level === "harbor-only";
  const isPlainGo = day.level === "full-sail";
  const decisionLabel = isNoGo ? "NO-GO" : "GO";
  const decisionKey = isNoGo ? "nogo" : isPlainGo ? "go" : "caution";
  const title = isNoGo ? "Stay in" : `Go - ${day.sailPlan.shortLabel}`;
  const wind = day.maxWind > 0
    ? `${day.avgWind}-${day.maxWind} kt, gusts ~${day.estGust} kt`
    : "Wind pending";
  const window = day.depthWindow
    ? `${day.depthWindow.leaveAfter}; ${day.depthWindow.returnBefore}`
    : "Depth window pending";
  const watch = isNoGo
    ? getNoGoBlocker(day)
    : day.cautions.length > 0
      ? day.cautions.slice(0, 3).join("; ")
      : "No major caution flags shown";
  const reason = isNoGo ? getNoGoBlocker(day) : summarizePrimaryReason(day);
  const noGoReason = isNoGo ? reason.replace(/^No-go because /, "") : "";
  const setup = isNoGo ? "Harbor only" : day.sailPlan.setup;

  return {
    title,
    decisionLabel,
    decisionKey,
    copy: isNoGo
      ? `${label}: no-go because ${noGoReason}.`
      : `${label}: go with ${day.sailPlan.shortLabel.toLowerCase()} guidance. ${reason}.`,
    basics: [
      { label: "Plan", value: setup },
      { label: "Wind", value: wind },
      { label: "Window", value: window },
      { label: "Watch", value: watch },
    ],
  };
}

// ── Float plan ─────────────────────────────────────────────────────────

export function getDefaultFloatPlan() {
  return {
    crewCount: "2",
    expectedReturn: "",
    shoreContact: "",
    checks: FLOAT_PLAN_CHECKS.reduce((acc, item) => {
      acc[item.key] = false;
      return acc;
    }, {}),
  };
}

export function normalizeFloatPlan(value = {}) {
  const fallback = getDefaultFloatPlan();
  const checks = { ...fallback.checks, ...(value.checks || {}) };
  return {
    crewCount: String(value.crewCount || fallback.crewCount),
    expectedReturn: String(value.expectedReturn || ""),
    shoreContact: String(value.shoreContact || ""),
    checks,
  };
}

export function getFloatPlanReadiness(plan) {
  const normalized = normalizeFloatPlan(plan);
  const missing = [];
  const crewCount = Number(normalized.crewCount);
  if (!Number.isFinite(crewCount) || crewCount < 1) missing.push("crew count");
  if (!normalized.expectedReturn) missing.push("expected return");
  if (!normalized.shoreContact.trim()) missing.push("shore contact");

  FLOAT_PLAN_CHECKS.forEach((item) => {
    if (!normalized.checks[item.key]) missing.push(item.label.toLowerCase());
  });

  return {
    ready: missing.length === 0,
    missing,
    summary: missing.length === 0
      ? `Float plan ready: ${crewCount} aboard, return ${normalized.expectedReturn}, shore contact set.`
      : `Missing: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` +${missing.length - 4} more` : ""}.`,
  };
}

// ── Rain severity (used by assessDay) ─────────────────────────────────

export function rainSeverity(shortForecast) {
  const f = shortForecast.toLowerCase();
  if (f.includes("thunder") || f.includes("tstorm")) return 3;
  if (f.includes("likely") && (f.includes("rain") || f.includes("shower"))) return 2;
  if (f.includes("rain") || f.includes("shower")) return 1;
  return 0;
}

// ── Day assessment ────────────────────────────────────────────────────

export function assessDay(
  hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions,
  marineAlerts, uvForecast, gustRatio, dateStr, dayName
) {
  let daytime = hourlyPeriods.filter((p) => {
    const h = zonedHour(p.startTime);
    return p.startTime.startsWith(dateStr) && h >= 8 && h <= 18;
  });

  // If the daytime window has passed (e.g. evening), fall back to all available periods for this day
  let dayWindowPassed = false;
  if (daytime.length === 0) {
    daytime = hourlyPeriods.filter((p) => p.startTime.startsWith(dateStr));
    dayWindowPassed = daytime.length > 0;
  }

  if (daytime.length === 0) return { level: "unknown", maxWind: 0, avgWind: 0, estGust: 0, cautions: [], dominantDir: "" };

  let maxWind = 0;
  let totalWind = 0;
  let maxRainSev = 0;
  let hasChopPenalty = false;
  let hasCurrentOpposition = false;
  let dominantDir = "";
  const dirCounts = {};

  daytime.forEach((p) => {
    const wind = parseWindMph(p.windSpeed);
    const windKts = mphToKnots(wind.high);
    if (windKts > maxWind) maxWind = windKts;
    totalWind += mphToKnots(wind.avg);

    const sev = rainSeverity(p.shortForecast);
    if (sev > maxRainSev) maxRainSev = sev;

    const dir = p.windDirection;
    dirCounts[dir] = (dirCounts[dir] || 0) + 1;

    if (CHOPPY_DIRS.includes(dir) && windKts >= 10) {
      hasChopPenalty = true;
    }

    const hour = zonedHour(p.startTime);
    if (hour >= 10 && hour <= 16) {
      const phase = getCurrentPredictionPhase(currentPredictions, dateStr, hour) || getTidePhase(tides, dateStr, hour);
      if (windOpposesCurrentCaution(dir, phase)) {
        hasCurrentOpposition = true;
      }
    }
  });

  let maxCount = 0;
  for (const [dir, cnt] of Object.entries(dirCounts)) {
    if (cnt > maxCount) { maxCount = cnt; dominantDir = dir; }
  }

  const avgWind = Math.round(totalWind / daytime.length);
  const estGust = Math.round(maxWind * gustRatio);

  const effectiveWind = hasChopPenalty ? maxWind + CHOP_PENALTY_KTS : maxWind;
  const effectiveGust = hasChopPenalty ? estGust + CHOP_PENALTY_KTS : estGust;

  let sailPlan = determineSailPlan(
    effectiveWind,
    effectiveGust,
    maxRainSev,
    hasChopPenalty,
    hasCurrentOpposition
  );
  const activeMarineAlerts = getMarineAlertsForDay(marineAlerts, dateStr);
  const hardMarineAlertFeature = activeMarineAlerts.find((feature) => isHardMarineAlert(feature?.properties?.event));
  const smallCraftAdvisoryFeature = activeMarineAlerts.find((feature) => isSmallCraftAdvisory(feature?.properties?.event));
  const marineAlertFeature = hardMarineAlertFeature || smallCraftAdvisoryFeature || activeMarineAlerts[0];
  const marineAlert = marineAlertFeature ? (marineAlertFeature.properties?.event || "Marine alert") : "";
  const stormOutlook = getStormOutlookForDay(hourlyPeriods, marineAlerts, dateStr);
  const uvInfo = getUvForDay(uvForecast, dateStr);
  if (hardMarineAlertFeature) {
    sailPlan = findSailPlan("harbor-only");
  } else if (smallCraftAdvisoryFeature) {
    sailPlan = applySmallCraftAdvisorySailPlan(sailPlan, {
      estGust,
      hasChopPenalty,
      hasCurrentOpposition,
      maxRainSev,
      dayWindowPassed,
    });
  }
  const level = sailPlan.key;

  const cautions = [];
  if (marineAlert) cautions.push(`${marineAlert} active`);
  if (hasChopPenalty) cautions.push(`${dominantDir} wind builds steep chop`);
  if (hasCurrentOpposition) cautions.push("wind opposes tidal current");
  if (maxRainSev === 1) cautions.push("chance of rain");
  if (maxRainSev === 2) cautions.push("rain likely");
  if (maxRainSev === 3) cautions.push("thunderstorms forecast");
  if (stormOutlook.level === "alert" && !marineAlert) cautions.push(stormOutlook.statusNote);
  if (stormOutlook.level === "watch" && maxRainSev < 3) cautions.push(stormOutlook.statusNote);
  if (uvInfo && uvInfo.warning) cautions.push(`UV ${uvInfo.peak} (${uvInfo.risk})`);

  // Shoal / keel depth warnings — apply observed water level anomaly if available
  const anomalyFt = (currentUserSettings._waterLevelAnomaly) || 0;
  const depthInfo = computeDepthWindows(tideHourly, dateStr, anomalyFt);
  const depthWindow = getBestWindowSummary(depthInfo, dateStr);
  if (!depthInfo.safeAllDay && depthInfo.shoalWindows.length > 0) {
    const windows = depthInfo.shoalWindows.map(
      (w) => formatWindowBoundary(w.start, "start") + "–" + formatWindowBoundary(w.end, "end")
    ).join(", ");
    cautions.push(`shallow water (${windows})`);
  }

  // Polar-informed sailability score and estimated boat speed
  const estBsp = avgPolarSpeed(avgWind);
  const sailScore = scoreSailability(avgWind, maxWind, estGust, maxRainSev, hasChopPenalty, hasCurrentOpposition);
  const quality = dayQuality(sailScore);
  const readiness = describeReadiness(sailScore, level);

  // Add light-air caution from polar data
  if (avgWind < 6) {
    cautions.push("light air — expect drifting");
  }

  // Find matching NWS day-period forecast for the summary card
  const dayForecast = forecastPeriods.find((p) => {
    const n = p.name.toLowerCase();
    const { dayDates } = getDateContext();
    return n === dayName.toLowerCase() || (dateStr === dayDates[0] && (n === "today" || n === "this afternoon"));
  });

  return {
    level, maxWind, avgWind, estGust, effectiveWind,
    maxRainSev, hasChopPenalty, hasCurrentOpposition,
    dominantDir, cautions, dayForecast, dayName, marineAlert, activeMarineAlerts, stormOutlook, uvInfo,
    currentPredictionSummary: summarizeCurrentPrediction(currentPredictions, dateStr),
    estBsp, sailScore, quality, readiness, sailPlan, depthInfo, depthWindow, dayWindowPassed,
  };
}

export function computeAllRecommendations(
  hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions,
  marineAlerts, uvForecast, gustRatio
) {
  const { days, dayDates, dayNames } = getDateContext();
  return days.map((d, i) =>
    assessDay(
      hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions,
      marineAlerts, uvForecast, gustRatio, dayDates[i], dayNames[i]
    )
  );
}
