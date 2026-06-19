/* ==============================================
   Tolchester Sailing Dashboard — app.js
   Live data from NOAA and weather.gov
   Sail recommendations for Pearson 31-2

   v3 — March 2026
   • Rolling 5-day forecast (today + 4 days)
   • Per-day sail recommendation with chop / tide / rain logic
   • Clickable outlook cards drive the full dashboard
   • Conservative gust estimate (default 1.25× sustained wind)
   • Wind-direction fetch penalty (W/NW chop)
   • Tide-vs-wind opposition detection
   • Graduated rain severity
   • Auto-refresh (10 min conditions, 30 min forecast)
   ============================================== */

// ES module. Loaded in the browser via <script type="module"> and imported by
// the Node test harness (tests.mjs). Module scope is isolated and implicitly
// strict, so the former IIFE wrapper and "use strict" are no longer needed.

import {
  getFiveDays,
  zoneOffsetMs,
  zonedWallClockToInstant,
  getDayBounds,
  zonedHour,
  fmtDate,
  fmtDateCompact,
  fmtDayName,
  fmtShortDay,
  getActiveDayIndex,
  setActiveDayIndex,
  refreshDateContext,
  getDateContext,
} from "./src/dates.js";

import {
  parseWindMph,
  mphToKnots,
  degToCard,
  metersPerSecondToKnots,
  metersToFeet,
  celsiusToFahrenheit,
  getWeatherIcon,
  parseNoaaTime,
  formatTime12,
  formatHour12,
} from "./src/helpers.js";

import {
  buildRequestUrl,
  fetchJSON,
  fetchTides,
  fetchTideHourly,
  fetchCurrentPredictions,
  fetchCurrentWind,
  fetchAirTemp,
  fetchWaterTemp,
  fetchWaterLevel,
  fetchForecast,
  fetchHourlyForecast,
} from "./src/fetchers.js";

import {
  NOAA_CURRENT_STATION,
  UV_ZIP,
  NWS_MARINE_OFFICE,
  CBIBS_API_KEY,
  BAY_BUOY_STATION,
  MARINE_ALERT_ZONES,
  MARINE_FORECAST_ZONES,
  NUM_DAYS,
  DASHBOARD_TIME_ZONE,
  DASHBOARD_LOCATION,
  NTM_RADIUS_NM,
  NTM_PAGE_SIZE,
  NTM_FETCH_TIMEOUT_MS,
  USCG_DISTRICT_ATU,
  NTM_TARGET_WATERWAY_PATTERN,
  USCG_WATERWAY_DASHBOARD_URL,
  LOCAL_NOAA_CHART_TILE_URL,
  NOAA_CHART_TILE_URL,
  NOAA_CHART_LEVEL_OFFSET,
  SHOW_SOURCE_DIAGNOSTICS,
  NWS_FORECAST_REFRESH_WARNING_MS,
  STORAGE_KEYS,
  FLOAT_PLAN_CHECKS,
  DEFAULT_SETTINGS,
  CREW_MODES,
  SAFETY_MODES,
  SAIL_PLANS,
  THRESHOLDS,
  CHOPPY_DIRS,
  CHOP_PENALTY_KTS,
  DEFAULT_GUST_RATIO,
  CHARTED_DEPTH_MLLW,
  MIN_DEPTH_FT,
  KEEL_DRAFT_FT,
  POLAR_TWS,
  POLAR_TWA,
  POLAR_BSP,
  HULL_SPEED,
  CONDITION_REFRESH_MS,
  FORECAST_REFRESH_MS,
  SOURCE_STALE_MS,
  SOURCE_CONFIG,
} from "./src/config.js";

  // ========== CONFIG ==========
  // Constants live in src/config.js (imported above).

  const NTM_FEEDS = [
    {
      key: "hazards",
      category: "hazard",
      categoryLabel: "Hazard",
      severity: 4,
      serviceUrl: "https://services8.arcgis.com/6ldl6K67FkYzPtEE/arcgis/rest/services/USCG_Local_Notices_to_Mariners_Maritime_Safety_Points/FeatureServer/0",
      where: `ATU = ${USCG_DISTRICT_ATU} AND SUB_CATEGORY = 'Hazards To Navigation'`,
      outFields: ["TITLE", "WATERWAY_NAME", "DATE_BEGIN", "DATE_END", "DATE_CREATED", "DATE_MODIFIED", "DESCRIPTION", "STATUS", "MRN"],
      normalize: normalizeMsiPointFeature,
    },
    {
      key: "temp-aton-changes",
      category: "temp-change",
      categoryLabel: "Temp Change",
      severity: 3,
      serviceUrl: "https://services8.arcgis.com/6ldl6K67FkYzPtEE/arcgis/rest/services/USCG_Local_Notices_to_Mariners_Temporary_AtoN_Changes/FeatureServer/0",
      where: `ATU = ${USCG_DISTRICT_ATU}`,
      outFields: ["NAME", "WATERWAY_NAME", "DATE_CREATED", "MRN", "BNM_NUM", "LLNR", "TC_STATUS", "TC_CORR_STATUS", "MSI_STATUS", "AID_TYPE", "AID_SUBTYPE", "COLOR", "DESCRIPTION_TYPE"],
      normalize: normalizeTempChangeFeature,
    },
    {
      key: "federal-aid-discrepancies-a",
      category: "damaged-aid",
      categoryLabel: "Damaged Aid",
      severity: 2,
      serviceUrl: "https://services8.arcgis.com/6ldl6K67FkYzPtEE/arcgis/rest/services/USCG_Local_Notices_to_Mariners_Federal_Aid_Discrepancies/FeatureServer/0",
      where: `ATU = ${USCG_DISTRICT_ATU}`,
      outFields: ["NAME", "WATERWAY_NAME", "DATE_CREATED", "MRN", "BNM_NUM", "LLNR", "DISCREP_STATUS", "DISCREP_CORR_STATUS", "MSI_STATUS", "AID_TYPE", "AID_SUBTYPE", "COLOR", "DESCRIPTION_TYPE"],
      resultOffset: 0,
      resultRecordCount: 250,
      normalize: normalizeFedDiscrepancyFeature,
    },
    {
      key: "federal-aid-discrepancies-b",
      category: "damaged-aid",
      categoryLabel: "Damaged Aid",
      severity: 2,
      serviceUrl: "https://services8.arcgis.com/6ldl6K67FkYzPtEE/arcgis/rest/services/USCG_Local_Notices_to_Mariners_Federal_Aid_Discrepancies/FeatureServer/0",
      where: `ATU = ${USCG_DISTRICT_ATU}`,
      outFields: ["NAME", "WATERWAY_NAME", "DATE_CREATED", "MRN", "BNM_NUM", "LLNR", "DISCREP_STATUS", "DISCREP_CORR_STATUS", "MSI_STATUS", "AID_TYPE", "AID_SUBTYPE", "COLOR", "DESCRIPTION_TYPE"],
      resultOffset: 250,
      resultRecordCount: 250,
      normalize: normalizeFedDiscrepancyFeature,
    },
    {
      key: "marine-events",
      category: "marine-event",
      categoryLabel: "Marine Event",
      severity: 1,
      serviceUrl: "https://services8.arcgis.com/6ldl6K67FkYzPtEE/arcgis/rest/services/USCG_Local_Notices_to_Mariners_Maritime_Safety_Points/FeatureServer/0",
      where: `ATU = ${USCG_DISTRICT_ATU} AND SUB_CATEGORY = 'Marine Events'`,
      outFields: ["TITLE", "WATERWAY_NAME", "DATE_BEGIN", "DATE_END", "DATE_CREATED", "DATE_MODIFIED", "DESCRIPTION", "STATUS", "MRN"],
      normalize: normalizeMsiPointFeature,
    },
  ];

  // STORAGE_KEYS, FLOAT_PLAN_CHECKS, DEFAULT_SETTINGS, CREW_MODES, SAFETY_MODES,
  // SAIL_PLANS, THRESHOLDS, CHOPPY_DIRS, CHOP_PENALTY_KTS, DEFAULT_GUST_RATIO,
  // CHARTED_DEPTH_MLLW, MIN_DEPTH_FT, KEEL_DRAFT_FT — imported from src/config.js

  // ========== PEARSON 31-2 POLAR TABLE ==========
  // POLAR_TWS, POLAR_TWA, POLAR_BSP, HULL_SPEED — imported from src/config.js

  function buildNoaaLiveTileUrl(z, x, y) {
    const noaaLevel = Math.max(0, z - NOAA_CHART_LEVEL_OFFSET);
    return NOAA_CHART_TILE_URL
      .replace("{z}", String(noaaLevel))
      .replace("{y}", String(y))
      .replace("{x}", String(x));
  }

  function latLonToTileCoords(lat, lon, zoom) {
    const scale = 2 ** zoom;
    const x = Math.floor(((lon + 180) / 360) * scale);
    const latRad = (lat * Math.PI) / 180;
    const merc = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const y = Math.floor(((1 - merc / Math.PI) / 2) * scale);
    return { x, y };
  }

  function buildLocalChartTileUrl(z, x, y) {
    return LOCAL_NOAA_CHART_TILE_URL
      .replace("{z}", String(z))
      .replace("{y}", String(y))
      .replace("{x}", String(x));
  }

  async function canLoadTile(url) {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Bilinear interpolation of polar table
  function polarBoatSpeed(tws, twa) {
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
  function avgPolarSpeed(tws) {
    // Weight common sailing angles: close-hauled, close reach, beam, broad
    const angles = [52, 75, 90, 120];
    let sum = 0;
    angles.forEach((a) => { sum += polarBoatSpeed(tws, a); });
    return sum / angles.length;
  }

  // Score a sailing day 0-100 based on Pearson 31-2 polar performance + conditions
  // Higher = better sailing day
  function scoreSailability(avgWindKts, maxWindKts, estGust, maxRainSev, hasChopPenalty, hasCurrentOpposition) {
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
  function dayQuality(score) {
    if (score >= 60) return "good";
    if (score >= 35) return "fair";
    return "poor";
  }

  function describeReadiness(score, level) {
    if (level === "harbor-only") return "No-go";
    if (score >= 85) return "Prime";
    if (score >= 70) return "Good";
    if (score >= 55) return "Watch";
    return "Marginal";
  }

  // CONDITION_REFRESH_MS, FORECAST_REFRESH_MS, SOURCE_STALE_MS, SOURCE_CONFIG
  // — imported from src/config.js

  // getActiveDayIndex() lives in src/dates.js — use getActiveDayIndex()/setActiveDayIndex().
  let windChartInstance = null;
  let tideChartInstance = null;
  let conditionTimer = null;
  let forecastTimer = null;
  let ntmCurrentPage = 1;
  let ntmAlertsCache = [];
  let simpleViewEnabled = false;

  // Cached data for tab switching and refresh
  const cachedData = {};
  const userSettings = { ...DEFAULT_SETTINGS };

  // buildRequestUrl — imported from src/fetchers.js above (shared by the
  // marine fetchers that remain in this file).

  // ========== DATE HELPERS ==========
  // getFiveDays, zoneOffsetMs, zonedWallClockToInstant, getDayBounds, zonedHour,
  // fmtDate, fmtDateCompact, fmtDayName, fmtShortDay, refreshDateContext,
  // getDateContext — imported from src/dates.js above.

  function readPreference(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore storage failures.
    }
  }

  function readJsonPreference(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJsonPreference(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage failures.
    }
  }

  function getCrewModeConfig() {
    return CREW_MODES[userSettings.crewMode] || CREW_MODES[DEFAULT_SETTINGS.crewMode];
  }

  function getSafetyModeConfig() {
    return SAFETY_MODES[userSettings.safetyMode] || SAFETY_MODES[DEFAULT_SETTINGS.safetyMode];
  }

  function findSailPlan(key) {
    return SAIL_PLANS.find((plan) => plan.key === key) || SAIL_PLANS[0];
  }

  function nudgeSailPlan(planKey, steps) {
    const idx = SAIL_PLANS.findIndex((plan) => plan.key === planKey);
    if (idx === -1) return SAIL_PLANS[0];
    return SAIL_PLANS[Math.min(SAIL_PLANS.length - 1, Math.max(0, idx + steps))];
  }

  function determineSailPlan(effectiveWind, effectiveGust, maxRainSev, hasChopPenalty, hasCurrentOpposition) {
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

  function formatWindowBoundary(d, which) {
    if (which === "start" && d.getHours() === 0 && d.getMinutes() === 0) return "midnight";
    if (which === "end" && d.getHours() === 23 && d.getMinutes() === 59) return "midnight";
    return formatTime12(d);
  }

  function buildSafeWindows(dateStr, shoalWindows) {
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

  function getBestWindowSummary(depthInfo, dateStr) {
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

  function getNoGoBlocker(day) {
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

  function getNoGoBlockerBadge(day) {
    if (day.marineAlert) return "Marine alert";
    if (day.maxRainSev >= 3) return "Storms";
    if (day.depthWindow && day.depthWindow.short === "Shoal all day") return "Depth";
    if (day.maxWind >= 28 || day.estGust >= 34) return "Too windy";
    if (day.hasChopPenalty && day.hasCurrentOpposition) return "Wind vs tide";
    return "Stacked risks";
  }

  function summarizePrimaryReason(day) {
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

  function getCaptainCrewRiskFactors(day) {
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

  function buildRiskDecisionExplanation(day) {
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

  function compareAgainstToday(recs, index) {
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

  function getDeltaBadge(recs, index) {
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

  function buildSimpleDaySummary(day, label = "Today") {
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

  function getDefaultFloatPlan() {
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

  function normalizeFloatPlan(value = {}) {
    const fallback = getDefaultFloatPlan();
    const checks = { ...fallback.checks, ...(value.checks || {}) };
    return {
      crewCount: String(value.crewCount || fallback.crewCount),
      expectedReturn: String(value.expectedReturn || ""),
      shoreContact: String(value.shoreContact || ""),
      checks,
    };
  }

  function getFloatPlanReadiness(plan) {
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

  // Date context state + refreshDateContext/getDateContext — in src/dates.js.
  // The module initialises the window at import time (refreshDateContext(true)).

  function parseSourceDate(value) {
    if (!value) return null;
    const sourceValue = String(value);
    const normalizedValue = sourceValue.replace(/([+-]\d{2})$/, "$1:00");
    const parsed = sourceValue.includes(" ") ? parseNoaaTime(sourceValue) : new Date(normalizedValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function getSourcePrimaryTimestamp(sourceKey, payload) {
    if (!payload) return null;

    if (["currentWind", "airTemp", "waterTemp", "waterLevel"].includes(sourceKey)) {
      return parseSourceDate(payload.data && payload.data[0] ? payload.data[0].t : null);
    }

    if (sourceKey === "forecast" || sourceKey === "hourlyForecast") {
      return parseSourceDate(
        payload.properties && (payload.properties.updateTime || payload.properties.updated || payload.properties.generatedAt)
      );
    }

    if (sourceKey === "currentPredictions") {
      const timestamps = normalizeCurrentPredictionEvents(payload)
        .map((event) => event.time)
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime());
      return timestamps[0] || null;
    }

    if (sourceKey === "marineAlerts") {
      const timestamps = (payload.features || [])
        .map((feature) => feature.properties || {})
        .map((props) => parseSourceDate(props.updated || props.sent || props.effective || props.onset))
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime());
      return timestamps[0] || null;
    }

    if (sourceKey === "marineForecasts") {
      const timestamps = (payload.zones || [])
        .map((zone) => parseSourceDate(zone.updated))
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime());
      return timestamps[0] || null;
    }

    if (sourceKey === "bayBuoy") {
      return getBayBuoySummary(payload).timestamp;
    }

    return null;
  }

  function hasSourcePayload(sourceKey, payload) {
    if (!payload) return false;
    if (sourceKey === "tides" || sourceKey === "tideHourly") {
      return Array.isArray(payload.predictions) && payload.predictions.length > 0;
    }
    if (sourceKey === "forecast" || sourceKey === "hourlyForecast") {
      return Array.isArray(payload.properties && payload.properties.periods) && payload.properties.periods.length > 0;
    }
    if (sourceKey === "currentPredictions") {
      return normalizeCurrentPredictionEvents(payload).length > 0;
    }
    if (sourceKey === "marineAlerts") {
      return Array.isArray(payload.features);
    }
    if (sourceKey === "marineForecasts") {
      return Array.isArray(payload.zones) && payload.zones.some((zone) => Array.isArray(zone.periods) && zone.periods.length > 0);
    }
    if (sourceKey === "uvIndex") {
      return normalizeUvForecast(payload).length > 0;
    }
    if (sourceKey === "bayBuoy") {
      return getBayBuoySummary(payload).hasData;
    }
    if (["currentWind", "airTemp", "waterTemp", "waterLevel"].includes(sourceKey)) {
      return Array.isArray(payload.data) && payload.data.length > 0;
    }
    return true;
  }

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

  function getObservationFreshnessSummary(sourceStatuses = {}) {
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

    // Derive a short source label from the wind source config so it stays
    // accurate when the source changes (e.g. TCBM2 vs CO-OPS fallback).
    const windProvenance = SOURCE_CONFIG.currentWind?.provenance || "NOAA obs";
    const sourceLabel = windProvenance.split(" ").slice(0, 2).join(" "); // "NDBC TCBM2"
    return `${sourceLabel} ${timeLabel} · ${formatAgeMinutes(minutesToRoundedAge(ageMs))}`;
  }

  function buildSourceStatus(sourceKey, payload, fetchedAt, error = null) {
    const config = SOURCE_CONFIG[sourceKey];
    const primaryTimestamp = getSourcePrimaryTimestamp(sourceKey, payload);
    const freshnessRef = primaryTimestamp || fetchedAt;
    const ageMs = freshnessRef ? Date.now() - freshnessRef.getTime() : null;
    let state = "ok";
    let detail;

    if (error) {
      state = "failed";
      detail = `Fetch failed at ${formatClockLabel(fetchedAt)}`;
    } else if (!hasSourcePayload(sourceKey, payload)) {
      state = "missing";
      detail = `No usable data at ${formatClockLabel(fetchedAt)}`;
    } else if (ageMs !== null && ageMs > config.staleMs) {
      state = "stale";
      detail = `${primaryTimestamp ? `Updated ${formatClockLabel(primaryTimestamp)}` : `Fetched ${formatClockLabel(fetchedAt)}`} · ${formatAgeMinutes(minutesToRoundedAge(ageMs))}`;
    } else {
      detail = `${primaryTimestamp ? `Updated ${formatClockLabel(primaryTimestamp)}` : `Fetched ${formatClockLabel(fetchedAt)}`} · ${config.provenance}`;
    }

    return {
      key: sourceKey,
      label: config.label,
      provenance: config.provenance,
      requiredForRecommendation: config.requiredForRecommendation,
      state,
      fetchedAt,
      primaryTimestamp,
      ageMs,
      detail,
    };
  }

  async function fetchSource(sourceKey, fetcher, options = {}) {
    const fetchedAt = new Date();

    try {
      const payload = await fetcher(options);
      return {
        payload,
        status: buildSourceStatus(sourceKey, payload, fetchedAt),
      };
    } catch (error) {
      console.warn(`Fetch failed for ${sourceKey}:`, error);
      return {
        payload: null,
        status: buildSourceStatus(sourceKey, null, fetchedAt, error),
      };
    }
  }

  function getRecommendationBlockers(sourceStatuses = {}) {
    return Object.values(sourceStatuses).filter((status) => {
      if (!status.requiredForRecommendation) return false;
      if (status.state === "failed" || status.state === "missing") return true;
      if (status.state === "stale" && !["forecast", "hourlyForecast"].includes(status.key)) return true;
      return false;
    });
  }

  function getRecommendationGate(sourceStatuses = {}) {
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

  function getFallbackDataNotice(sourceStatuses = {}) {
    const usableRequired = Object.values(sourceStatuses)
      .filter((status) => status.requiredForRecommendation && status.ageMs !== null)
      .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));

    if (usableRequired.length === 0) return "";

    const oldest = usableRequired[0];
    return `Using oldest available required input: ${oldest.label}, ${formatAgeMinutes(minutesToRoundedAge(oldest.ageMs))}.`;
  }

  function hasRecommendationInputsAvailable() {
    return Boolean(
      cachedData.hourlyPeriods && cachedData.hourlyPeriods.length > 0
      && cachedData.forecastPeriods && cachedData.forecastPeriods.length > 0
      && cachedData.tides && Array.isArray(cachedData.tides.predictions) && cachedData.tides.predictions.length > 0
      && cachedData.tideHourly && Array.isArray(cachedData.tideHourly.predictions) && cachedData.tideHourly.predictions.length > 0
    );
  }

  function renderSourceStatus(sourceStatuses = {}) {
    const sectionEl = document.getElementById("sourceStatus");
    const summaryEl = document.getElementById("sourceStatusSummary");
    const listEl = document.getElementById("sourceStatusList");
    if (!sectionEl || !summaryEl || !listEl) return;

    if (!SHOW_SOURCE_DIAGNOSTICS) {
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

  // ========== DATA FETCHERS ==========
  // The core NOAA/NWS fetchers (fetchJSON, buildRequestUrl,
  // fetchTides, fetchTideHourly, fetchCurrentPredictions, fetchCurrentWind,
  // fetchAirTemp, fetchWaterTemp, fetchWaterLevel, fetchForecast,
  // fetchHourlyForecast) live in src/fetchers.js (imported above).
  // The marine fetchers below stay here until src/marine.js is extracted —
  // they depend on parsers (parseCoastalWatersForecast, getBayBuoySummary,
  // ndbcLatestToCbibsVariables) that remain in this file.

  async function fetchMarineAlerts(options = {}) {
    const responses = await Promise.all(MARINE_ALERT_ZONES.map((zone) =>
      fetch(buildRequestUrl(`https://api.weather.gov/alerts/active?zone=${zone}`, options.forceRefresh), {
        cache: options.forceRefresh ? "no-store" : "default",
        headers: { "User-Agent": "TolchesterSailingDashboard" },
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
    ));

    const seen = new Set();
    const features = responses
      .flatMap((payload) => Array.isArray(payload.features) ? payload.features : [])
      .filter((feature) => {
        const id = feature.id || feature.properties?.id || feature.properties?.event || JSON.stringify(feature.properties || {});
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

    return { features };
  }

  async function fetchMarineForecasts(options = {}) {
    const list = await fetchJSON(`https://api.weather.gov/products/types/CWF/locations/${NWS_MARINE_OFFICE}`, options);
    const latest = (list && list["@graph"] || [])
      .filter((product) => product && product.id)
      .sort((a, b) => parseSourceDate(b.issuanceTime) - parseSourceDate(a.issuanceTime))[0];

    if (!latest) throw new Error("No NWS CWF marine forecast products available");

    const product = await fetchJSON(`https://api.weather.gov/products/${latest.id}`, options);
    const zones = parseCoastalWatersForecast(product.productText || "", product.issuanceTime);

    if (zones.length === 0) {
      throw new Error("No marine zone forecasts available");
    }

    return { zones, productId: latest.id, updated: product.issuanceTime || latest.issuanceTime || null };
  }

  function fetchUvIndex(options = {}) {
    return fetchJSON(
      `https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/${UV_ZIP}/JSON`,
      options
    );
  }

  async function fetchBayBuoyObservations(options = {}) {
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

  // ========== HELPERS ==========
  // Pure utility functions live in src/helpers.js (imported above).

  // ========== RAIN SEVERITY ==========

  function rainSeverity(shortForecast) {
    const f = shortForecast.toLowerCase();
    if (f.includes("thunder") || f.includes("tstorm")) return 3;
    if (f.includes("likely") && (f.includes("rain") || f.includes("shower"))) return 2;
    if (f.includes("rain") || f.includes("shower")) return 1;
    return 0;
  }

  const HARD_MARINE_ALERT_EVENTS = [
    "Gale Warning",
    "Storm Warning",
    "Hurricane Force Wind Warning",
    "Special Marine Warning",
    "Low Water Advisory",
    "Dense Fog Advisory",
    "Hazardous Seas Warning",
  ];

  function isHardMarineAlert(eventName) {
    if (!eventName) return false;
    return HARD_MARINE_ALERT_EVENTS.some((event) => eventName.toLowerCase().includes(event.toLowerCase()));
  }

  function isSmallCraftAdvisory(eventName) {
    if (!eventName) return false;
    const normalized = eventName.toLowerCase();
    return normalized.includes("small craft advisory") || normalized === "sca";
  }

  function shouldSmallCraftAdvisoryForceHarbor(day) {
    const crewMode = userSettings.crewMode || DEFAULT_SETTINGS.crewMode;
    const safetyMode = userSettings.safetyMode || DEFAULT_SETTINGS.safetyMode;
    return crewMode === "solo"
      || safetyMode === "conservative"
      || day.estGust >= 28
      || day.hasChopPenalty
      || day.hasCurrentOpposition
      || day.maxRainSev >= 3
      || day.dayWindowPassed;
  }

  function applySmallCraftAdvisorySailPlan(sailPlan, day) {
    if (shouldSmallCraftAdvisoryForceHarbor(day)) return findSailPlan("harbor-only");
    if (sailPlan.key === "full-sail" || sailPlan.key === "roll-genoa") return findSailPlan("first-reef");
    return sailPlan;
  }

  function getMarineAlertWindow(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    const start = parseSourceDate(props.onset || props.effective || props.sent);
    const end = parseSourceDate(props.ends || props.expires);
    return { start, end };
  }

  function getMarineAlertsForDay(marineAlerts, dateStr) {
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

  function summarizeMarineAlert(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    return props.event || "Marine alert";
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

  function normalizeCbibsStation(payload) {
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

  function ndbcLatestToCbibsVariables(text) {
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

  function getBayBuoySummary(payload) {
    return normalizeCbibsStation(payload);
  }

  function getBayBuoyReality(summary, dayRec) {
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

  function normalizeCurrentEventType(value) {
    const text = String(value || "").toLowerCase();
    if (text.includes("slack")) return "slack";
    if (text.includes("flood")) return "flood";
    if (text.includes("ebb")) return "ebb";
    return "";
  }

  function normalizeCurrentPredictionEvents(payload) {
    const candidates = [
      payload?.current_predictions?.cp,
      payload?.current_predictions,
      payload?.predictions,
      payload?.cp,
      payload,
    ];
    const rows = candidates.find((candidate) => Array.isArray(candidate)) || [];

    return rows.map((row) => {
      const rawTime = row.Time || row.time || row.t || row.DateTime || row.DATE_TIME;
      const time = rawTime ? parseSourceDate(String(rawTime)) : null;
      const type = normalizeCurrentEventType(row.Type || row.type || row.Event || row.event);
      const rawSpeed = row.Velocity_Major ?? row.velocity_major ?? row.Speed ?? row.speed ?? row.Velocity ?? row.v;
      const speed = rawSpeed === undefined || rawSpeed === "" ? null : Math.abs(Number(rawSpeed));
      const meanFloodDir = Number(row.meanFloodDir ?? row.MeanFloodDir ?? row.MEAN_FLOOD_DIR);
      const meanEbbDir = Number(row.meanEbbDir ?? row.MeanEbbDir ?? row.MEAN_EBB_DIR);
      if (!time || Number.isNaN(time.getTime()) || !type) return null;
      return {
        time,
        type,
        speed: Number.isFinite(speed) ? speed : null,
        meanFloodDir: Number.isFinite(meanFloodDir) ? meanFloodDir : null,
        meanEbbDir: Number.isFinite(meanEbbDir) ? meanEbbDir : null,
      };
    }).filter(Boolean).sort((a, b) => a.time - b.time);
  }

  function getCurrentDirectionLabel(event, phase) {
    if (phase === "ebb") {
      return Number.isFinite(event && event.meanEbbDir) ? degToCard(event.meanEbbDir) : NOAA_CURRENT_STATION.ebbDir;
    }
    if (phase === "flood") {
      return Number.isFinite(event && event.meanFloodDir) ? degToCard(event.meanFloodDir) : NOAA_CURRENT_STATION.floodDir;
    }
    return "";
  }

  function getCurrentPhaseFromEvents(events, targetTime) {
    if (!events || events.length === 0 || !targetTime) return null;

    let previous = null;
    let next = null;
    for (const event of events) {
      if (event.time <= targetTime) previous = event;
      if (event.time > targetTime) {
        next = event;
        break;
      }
    }

    if (!previous && next) {
      const phase = next.type === "ebb" ? "ebb" : next.type === "flood" ? "flood" : "slack";
      return { phase, currentDir: getCurrentDirectionLabel(next, phase), previous, next };
    }
    if (!previous) return null;

    if (previous.type === "slack") {
      const phase = next && next.type !== "slack" ? next.type : "slack";
      return { phase, currentDir: getCurrentDirectionLabel(next || previous, phase), previous, next };
    }

    return {
      phase: previous.type,
      currentDir: getCurrentDirectionLabel(previous, previous.type),
      speed: previous.speed,
      previous,
      next,
    };
  }

  function getCurrentPredictionPhase(currentPredictions, dateStr, hour) {
    const events = normalizeCurrentPredictionEvents(currentPredictions);
    if (events.length === 0) return null;
    const targetTime = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00`);
    const phase = getCurrentPhaseFromEvents(events, targetTime);
    if (!phase) return null;
    return { ...phase, source: "NOAA current prediction" };
  }

  function summarizeCurrentPrediction(currentPredictions, dateStr) {
    const events = normalizeCurrentPredictionEvents(currentPredictions)
      .filter((event) => fmtDate(event.time) === dateStr);
    const targetHour = dateStr === fmtDate(new Date()) ? new Date().getHours() : 13;
    const phase = getCurrentPredictionPhase(currentPredictions, dateStr, targetHour);
    const nextTurn = events.find((event) => event.time > new Date(`${dateStr}T${String(targetHour).padStart(2, "0")}:00:00`)) || null;

    return {
      events,
      phase,
      nextTurn,
      hasPrediction: events.length > 0,
    };
  }

  const STORM_ALERT_EVENTS = [
    "Special Marine Warning",
    "Marine Weather Statement",
    "Severe Thunderstorm Warning",
    "Severe Thunderstorm Watch",
    "Tornado Warning",
    "Tornado Watch",
  ];

  function isStormRelatedAlert(eventName) {
    if (!eventName) return false;
    return STORM_ALERT_EVENTS.some((event) => eventName.toLowerCase().includes(event.toLowerCase()));
  }

  function getStormAlertsForDay(marineAlerts, dateStr) {
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

  function isThunderForecastText(value) {
    const text = String(value || "").toLowerCase();
    return text.includes("thunder") || text.includes("tstorm") || text.includes("lightning");
  }

  function getThunderPeriodsForDay(hourlyPeriods, dateStr) {
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

  function getStormOutlookForDay(hourlyPeriods, marineAlerts, dateStr) {
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

  function parseCoastalWatersForecast(productText, updated) {
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

  function cleanMarineConditionText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\.$/, "")
      .trim();
  }

  function extractMarineCondition(text, patterns) {
    const clean = cleanMarineConditionText(text);
    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match) return cleanMarineConditionText(match[0]);
    }
    return "";
  }

  function parseMarineForecastText(text) {
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

  function periodOverlapsDate(period, dateStr) {
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

  function marinePeriodNameMatchesDate(name, dateStr) {
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

  function getMarineForecastForDay(marineForecasts, dateStr) {
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

  function normalizeUvForecast(payload) {
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

  function describeUvRisk(value) {
    if (!Number.isFinite(value)) return "Unavailable";
    if (value >= 11) return "Extreme";
    if (value >= 8) return "Very high";
    if (value >= 6) return "High";
    if (value >= 3) return "Moderate";
    return "Low";
  }

  function getUvForDay(uvForecast, dateStr) {
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
      timeLabel: formatClockLabel(peak.dateTime),
    };
  }

  // ========== TIDE PHASE HELPER ==========

  function getTidePhase(tides, dateStr, hour) {
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

  function windOpposesCurrentCaution(windDir, tidePhase) {
    if (!tidePhase) return false;
    const southerly = ["S", "SSE", "SE", "SSW"].includes(windDir);
    const northerly = ["N", "NNE", "NE", "NNW", "NW"].includes(windDir);
    if (tidePhase.phase === "ebb" && southerly) return true;
    if (tidePhase.phase === "flood" && northerly) return true;
    return false;
  }

  // ========== KEEL CLEARANCE / DEPTH WINDOWS ==========

  // Compare latest observed water level against the nearest hourly prediction.
  // Returns { anomalyFt, observed, predicted, label } where anomalyFt = observed - predicted.
  // Positive anomaly = more water than predicted (wind setup); negative = less.
  function computeWaterLevelAnomaly(waterLevel, tideHourly) {
    const none = { anomalyFt: 0, observed: null, predicted: null, label: null };
    if (!waterLevel || !waterLevel.data || !waterLevel.data[0]) return none;
    if (!tideHourly || !tideHourly.predictions || tideHourly.predictions.length === 0) return none;

    const obs = waterLevel.data[0];
    const obsTime = new Date(obs.t.replace(" ", "T"));
    const obsVal = parseFloat(obs.v);
    if (isNaN(obsTime.getTime()) || isNaN(obsVal)) return none;

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

  function computeDepthWindows(tideHourly, dateStr, anomalyFt = 0) {
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

  function renderDepthWindows(tideHourly) {
    const container = document.getElementById("depthWindows");
    if (!container) return;

    const { dayDates } = getDateContext();
    const dateStr = dayDates[getActiveDayIndex()];
    const anomaly = cachedData.waterLevelAnomaly || { anomalyFt: 0, label: null };
    const result = computeDepthWindows(tideHourly, dateStr, anomaly.anomalyFt);

    const anomalyNoteHtml = anomaly.label
      ? `<div class="depth-note depth-note--anomaly">\u26a0\ufe0f ${anomaly.label}</div>`
      : "";

    // All-day safe — simple green message
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

    // Build safe windows (inverse of shoal windows)
    const dayStart = new Date(result.shoalWindows[0].start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 0, 0);
    const safeWindows = buildSafeWindows(dateStr, result.shoalWindows);

    // Build timeline segments (interleaved safe + shoal) for the bar
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
    function minuteOfDay(d) {
      return d.getHours() * 60 + d.getMinutes();
    }

    // Timeline bar segments
    const barHtml = allSegments.map((seg) => {
      const startMin = minuteOfDay(seg.start);
      const endMin = seg.end.getHours() === 23 && seg.end.getMinutes() === 59 ? totalMinutes : minuteOfDay(seg.end);
      const pct = ((endMin - startMin) / totalMinutes) * 100;
      if (pct <= 0) return "";
      const cls = seg.type === "safe" ? "tl-seg-safe" : "tl-seg-shoal";
      const label = seg.type === "safe" ? "OK" : "";
      return `<div class="tl-seg ${cls}" style="width:${pct.toFixed(2)}%" title="${formatTime12(seg.start)} \u2013 ${seg.end.getHours() === 23 && seg.end.getMinutes() === 59 ? '12:00 AM' : formatTime12(seg.end)}${seg.type === 'shoal' ? ' (min ' + seg.minDepth.toFixed(1) + ' ft)' : ''}">${pct > 5 ? label : ''}</div>`;
    }).join("");

    // Hour tick marks (every 3 hours)
    let ticksHtml = "";
    for (let h = 0; h <= 24; h += 3) {
      const pct = (h / 24) * 100;
      const lbl = h === 0 ? "12a" : h === 12 ? "12p" : h === 24 ? "12a" : h < 12 ? h + "a" : (h - 12) + "p";
      ticksHtml += `<span class="tl-tick" style="left:${pct}%">${lbl}</span>`;
    }

    // Current-time marker (only for today)
    let nowMarkerHtml = "";
    const now = new Date();
    const todayStr = fmtDate(now);
    if (dateStr === todayStr) {
      const nowMin = minuteOfDay(now);
      const nowPct = (nowMin / totalMinutes) * 100;
      nowMarkerHtml = `<div class="tl-now" style="left:${nowPct.toFixed(2)}%" title="Now"><div class="tl-now-line"></div><span class="tl-now-label">Now</span></div>`;
    }

    // Window list — safe windows as green, shoal as red
    const windowListHtml = [];

    // Merge and sort all windows by start time
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

  // ========== SAIL RECOMMENDATION ==========

  function assessDay(hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions, marineAlerts, uvForecast, gustRatio, dateStr, dayName) {
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
    const marineAlert = marineAlertFeature ? summarizeMarineAlert(marineAlertFeature) : "";
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
    const anomalyFt = (cachedData.waterLevelAnomaly && cachedData.waterLevelAnomaly.anomalyFt) || 0;
    const depthInfo = computeDepthWindows(tideHourly, dateStr, anomalyFt);
    const depthWindow = getBestWindowSummary(depthInfo, dateStr);
    if (!depthInfo.safeAllDay && depthInfo.shoalWindows.length > 0) {
      const windows = depthInfo.shoalWindows.map(
        (w) => formatTime12(w.start) + "\u2013" + formatTime12(w.end)
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
      cautions.push("light air \u2014 expect drifting");
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

  function computeAllRecommendations(hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions, marineAlerts, uvForecast, gustRatio) {
    const { days, dayDates, dayNames } = getDateContext();
    return days.map((d, i) =>
      assessDay(hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions, marineAlerts, uvForecast, gustRatio, dayDates[i], dayNames[i])
    );
  }

  // ========== RENDER: RECOMMENDATION BANNER ==========

  function renderRecommendation(recs) {
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
        const riskText = buildRiskDecisionExplanation(fallbackDay);
        risk.textContent = riskText;
        risk.hidden = !riskText;
      }
      if (meta) {
        meta.innerHTML = [
          fallbackDay.sailPlan ? `<span class="rec-chip">${fallbackDay.sailPlan.setup}</span>` : "",
          fallbackDay.depthWindow ? `<span class="rec-chip">${fallbackDay.depthWindow.long}</span>` : "",
          `<span class="rec-chip rec-chip--warning">${fallbackAgeNote}</span>`,
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
      const riskText = buildRiskDecisionExplanation(day);
      risk.textContent = riskText;
      risk.hidden = !riskText;
    }
    if (meta) {
      const metaItems = [
        `<span class="rec-chip">${day.sailPlan.setup}</span>`,
        day.depthWindow ? `<span class="rec-chip">${day.depthWindow.long}</span>` : "",
        `<span class="rec-chip">${summarizePrimaryReason(day)}</span>`,
      ].filter(Boolean);
      if (day.dayWindowPassed) {
        metaItems.push(`<span class="rec-chip rec-chip--warning">Based on evening hours \u2014 sailing window has passed</span>`);
      }
      if (cachedData.nwsRefreshNotice) {
        metaItems.push(`<span class="rec-chip rec-chip--warning">${cachedData.nwsRefreshNotice}</span>`);
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

  function renderSimpleSummary(recs) {
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

    const summary = buildSimpleDaySummary(day, label);
    titleEl.textContent = summary.title;
    decisionEl.textContent = summary.decisionLabel;
    decisionEl.dataset.decision = summary.decisionKey;
    copyEl.textContent = summary.copy;
    basicsEl.innerHTML = summary.basics.map((item) => `
      <div class="simple-basic">
        <div class="simple-basic-label">${escapeHtml(item.label)}</div>
        <div class="simple-basic-value">${escapeHtml(item.value)}</div>
      </div>
    `).join("");
  }

  // ========== RENDER: 5-DAY OUTLOOK STRIP ==========

  function renderOutlookStrip(recs) {
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
      const label = i === 0 ? "Today" : fmtShortDay(days[i]);
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
        setActiveDayIndex(parseInt(el.dataset.dayIndex));
        renderAll();
        updateTabHighlight();
      });
    });
  }

  // ========== KPI UPDATES ==========

  function updateKPIs(hourlyPeriods, gustRatio, dayRec) {
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

  // ========== CHARTS ==========

  function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue("--color-primary").trim(),
      warning: style.getPropertyValue("--color-warning").trim(),
      text: style.getPropertyValue("--color-text").trim(),
      textMuted: style.getPropertyValue("--color-text-muted").trim(),
      textFaint: style.getPropertyValue("--color-text-faint").trim(),
      border: style.getPropertyValue("--color-border").trim(),
      surface: style.getPropertyValue("--color-surface").trim(),
      success: style.getPropertyValue("--color-success").trim(),
      error: style.getPropertyValue("--color-error").trim(),
    };
  }

  function renderWindChart(hourlyPeriods, gustRatio) {
    const { dayDates } = getDateContext();
    const dateFilter = dayDates[getActiveDayIndex()];
    const periods = hourlyPeriods.filter((p) => p.startTime.startsWith(dateFilter));

    const labels = periods.map((p) => formatHour12(p.startTime));
    const sustained = periods.map((p) => mphToKnots(parseWindMph(p.windSpeed).high));
    const gusts = periods.map((p) => Math.round(mphToKnots(parseWindMph(p.windSpeed).high) * gustRatio));

    const c = getChartColors();
    const ctx = document.getElementById("windChart").getContext("2d");

    if (windChartInstance) windChartInstance.destroy();

    windChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Sustained (kts)",
            data: sustained,
            backgroundColor: c.primary + "cc",
            borderColor: c.primary,
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.7,
          },
          {
            label: `Est. Gust (\u00d7${gustRatio.toFixed(2)})`,
            data: gusts,
            backgroundColor: c.warning + "55",
            borderColor: c.warning,
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: {
              color: c.textMuted,
              font: { family: "'DM Sans'", size: 11 },
              boxWidth: 12,
              boxHeight: 12,
              borderRadius: 2,
              useBorderRadius: true,
            },
          },
          tooltip: {
            backgroundColor: c.surface,
            titleColor: c.text,
            bodyColor: c.textMuted,
            borderColor: c.border,
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
            titleFont: { family: "'DM Sans'", weight: "600" },
            bodyFont: { family: "'JetBrains Mono'", size: 12 },
          },
        },
        scales: {
          x: {
            ticks: {
              color: c.textFaint,
              font: { family: "'DM Sans'", size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            min: 0,
            ticks: {
              color: c.textFaint,
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (v) => v + " kt",
            },
            grid: { color: c.border + "40", drawBorder: false },
            border: { display: false },
          },
        },
      },
    });
  }

  function renderTideChart(tideHourly) {
    if (!tideHourly || !tideHourly.predictions) return;

    const { dayDates } = getDateContext();
    const dateFilter = dayDates[getActiveDayIndex()];
    const filtered = tideHourly.predictions.filter((p) => p.t.substring(0, 10) === dateFilter);

    const labels = filtered.map((p) => {
      const time = parseNoaaTime(p.t);
      let h = time.getHours();
      const ampm = h >= 12 ? "p" : "a";
      h = h % 12 || 12;
      return h + ampm;
    });

    const values = filtered.map((p) => parseFloat(p.v));

    // Min tide level needed for MIN_DEPTH_FT depth: MIN_DEPTH_FT - CHARTED_DEPTH_MLLW
    const minTideLine = MIN_DEPTH_FT - CHARTED_DEPTH_MLLW;
    const thresholdData = values.map(() => minTideLine);

    const c = getChartColors();
    const ctx = document.getElementById("tideChart").getContext("2d");

    if (tideChartInstance) tideChartInstance.destroy();

    tideChartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Tide (ft MLLW)",
            data: values,
            borderColor: c.primary,
            backgroundColor: c.primary + "18",
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHitRadius: 10,
            borderWidth: 2,
          },
          {
            label: `Min for ${KEEL_DRAFT_FT} ft keel`,
            data: thresholdData,
            borderColor: c.error + "99",
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHitRadius: 0,
            fill: false,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: {
              color: c.textMuted,
              font: { family: "'DM Sans'", size: 10 },
              boxWidth: 12,
              boxHeight: 2,
              useBorderRadius: false,
              filter: (item) => item.datasetIndex === 1, // only show threshold legend
            },
          },
          tooltip: {
            backgroundColor: c.surface,
            titleColor: c.text,
            bodyColor: c.textMuted,
            borderColor: c.border,
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
            titleFont: { family: "'DM Sans'", weight: "600" },
            bodyFont: { family: "'JetBrains Mono'", size: 12 },
            callbacks: {
              label: (item) => {
                if (item.datasetIndex === 1) return `Min tide for ${MIN_DEPTH_FT} ft depth: ${minTideLine.toFixed(2)} ft`;
                const depth = CHARTED_DEPTH_MLLW + item.parsed.y;
                return `${item.parsed.y.toFixed(2)} ft MLLW (${depth.toFixed(1)} ft depth)`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: c.textFaint,
              font: { family: "'DM Sans'", size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            ticks: {
              color: c.textFaint,
              font: { family: "'JetBrains Mono'", size: 10 },
              callback: (v) => v.toFixed(1) + " ft",
            },
            grid: { color: c.border + "40", drawBorder: false },
            border: { display: false },
          },
        },
      },
    });
  }

  // ========== FORECAST GRID ==========

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

  // ========== TIDE TABLE ==========

  function renderTideTable(tides) {
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

  // ========== CURRENT CONDITIONS ==========

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

  // ========== RENDER: LIVE NOW BAR ==========

  function renderNowBar(wind, waterTemp, waterLevel) {
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

  function renderMarineConditions(marineForecasts) {
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

  function currentEventLabel(event) {
    if (!event) return "--";
    const type = event.type === "slack" ? "Slack" : event.type === "flood" ? "Max flood" : "Max ebb";
    const speed = event.speed !== null && event.type !== "slack" ? ` ${event.speed.toFixed(1)} kt` : "";
    return `${type}${speed}`;
  }

  function renderCurrentPrediction(currentPredictions, dayRec) {
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
      nextTurnEl.textContent = currentEventLabel(summary.nextTurn);
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

  function renderBayBuoyCheck(bayBuoy, dayRec) {
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
      const windDir = Number.isFinite(summary.windDirDeg) ? degToCard(summary.windDirDeg) : "";
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

  function renderStormWatch(hourlyPeriods, marineAlerts) {
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

  function recomputeRecommendations() {
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

  // ========== THEME TOGGLE ==========

  function initTheme() {
    const toggle = document.querySelector("[data-theme-toggle]");
    const root = document.documentElement;
    let theme = readPreference(
      STORAGE_KEYS.theme,
      window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    );
    root.setAttribute("data-theme", theme);
    updateThemeIcon(toggle, theme);

    if (toggle) {
      toggle.addEventListener("click", () => {
        theme = theme === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", theme);
        savePreference(STORAGE_KEYS.theme, theme);
        updateThemeIcon(toggle, theme);
        if (cachedData.hourlyPeriods) renderWindChart(cachedData.hourlyPeriods, cachedData.gustRatio || DEFAULT_GUST_RATIO);
        if (cachedData.tideHourly) renderTideChart(cachedData.tideHourly);
      });
    }
  }

  function updateThemeIcon(toggle, theme) {
    if (!toggle) return;
    toggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
    toggle.innerHTML =
      theme === "dark"
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  function initViewModeToggle() {
    simpleViewEnabled = readPreference(STORAGE_KEYS.simpleView, "false") === "true";
    applyViewMode();

    const toggle = document.getElementById("simpleViewToggle");
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      simpleViewEnabled = !simpleViewEnabled;
      if (simpleViewEnabled) setActiveDayIndex(0);
      savePreference(STORAGE_KEYS.simpleView, simpleViewEnabled ? "true" : "false");
      applyViewMode();
      renderAll();
    });
  }

  function applyViewMode() {
    document.body.classList.toggle("simple-view", simpleViewEnabled);
    if (simpleViewEnabled) setActiveDayIndex(0);

    const toggle = document.getElementById("simpleViewToggle");
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", simpleViewEnabled ? "true" : "false");
    toggle.textContent = simpleViewEnabled ? "Full view" : "Simple view";
  }

  function initSailingSettings() {
    userSettings.crewMode = readPreference(STORAGE_KEYS.crewMode, DEFAULT_SETTINGS.crewMode);
    userSettings.safetyMode = readPreference(STORAGE_KEYS.safetyMode, DEFAULT_SETTINGS.safetyMode);

    document.querySelectorAll("[data-crew-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        userSettings.crewMode = button.dataset.crewMode;
        savePreference(STORAGE_KEYS.crewMode, userSettings.crewMode);
        renderSailingSettings();
        recomputeRecommendations();
      });
    });

    document.querySelectorAll("[data-safety-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        userSettings.safetyMode = button.dataset.safetyMode;
        savePreference(STORAGE_KEYS.safetyMode, userSettings.safetyMode);
        renderSailingSettings();
        recomputeRecommendations();
      });
    });

    renderSailingSettings();
  }

  function renderSailingSettings() {
    document.querySelectorAll("[data-crew-mode]").forEach((button) => {
      const isActive = button.dataset.crewMode === userSettings.crewMode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    document.querySelectorAll("[data-safety-mode]").forEach((button) => {
      const isActive = button.dataset.safetyMode === userSettings.safetyMode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function readFloatPlanFromDom() {
    const plan = getDefaultFloatPlan();
    const crewCount = document.getElementById("floatCrewCount");
    const expectedReturn = document.getElementById("floatReturnTime");
    const shoreContact = document.getElementById("floatShoreContact");
    plan.crewCount = crewCount ? crewCount.value : plan.crewCount;
    plan.expectedReturn = expectedReturn ? expectedReturn.value : "";
    plan.shoreContact = shoreContact ? shoreContact.value : "";
    document.querySelectorAll("[data-float-check]").forEach((input) => {
      plan.checks[input.dataset.floatCheck] = input.checked;
    });
    return normalizeFloatPlan(plan);
  }

  function renderFloatPlan(plan) {
    const normalized = normalizeFloatPlan(plan);
    const crewCount = document.getElementById("floatCrewCount");
    const expectedReturn = document.getElementById("floatReturnTime");
    const shoreContact = document.getElementById("floatShoreContact");
    const status = document.getElementById("floatPlanStatus");
    const summary = document.getElementById("floatPlanSummary");

    if (crewCount) crewCount.value = normalized.crewCount;
    if (expectedReturn) expectedReturn.value = normalized.expectedReturn;
    if (shoreContact) shoreContact.value = normalized.shoreContact;
    document.querySelectorAll("[data-float-check]").forEach((input) => {
      input.checked = Boolean(normalized.checks[input.dataset.floatCheck]);
    });

    const readiness = getFloatPlanReadiness(normalized);
    if (status) {
      status.textContent = readiness.ready ? "Ready" : "Not ready";
      status.dataset.ready = readiness.ready ? "true" : "false";
    }
    if (summary) summary.textContent = readiness.summary;
  }

  function saveAndRenderFloatPlan() {
    const plan = readFloatPlanFromDom();
    saveJsonPreference(STORAGE_KEYS.floatPlan, plan);
    renderFloatPlan(plan);
  }

  function initFloatPlan() {
    const panel = document.querySelector(".float-plan-panel");
    if (!panel) return;
    const saved = readJsonPreference(STORAGE_KEYS.floatPlan, getDefaultFloatPlan());
    renderFloatPlan(saved);

    panel.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", saveAndRenderFloatPlan);
      input.addEventListener("change", saveAndRenderFloatPlan);
    });

    const reset = document.getElementById("floatPlanReset");
    if (reset) {
      reset.addEventListener("click", () => {
        const empty = getDefaultFloatPlan();
        saveJsonPreference(STORAGE_KEYS.floatPlan, empty);
        renderFloatPlan(empty);
      });
    }
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

  function renderAll() {
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

  // ========== REFRESH BUTTON ==========

  function initRefreshButton() {
    const btn = document.getElementById("refreshBtn");
    const forceRefreshToggle = document.getElementById("forceRefreshToggle");
    if (btn) {
      btn.addEventListener("click", () => {
        btn.classList.add("spinning");
        loadAllData({ forceRefresh: !!(forceRefreshToggle && forceRefreshToggle.checked) }).finally(() => {
          setTimeout(() => btn.classList.remove("spinning"), 600);
        });
      });
    }
  }

  // ========== AUTO-REFRESH ==========

  function startAutoRefresh() {
    conditionTimer = setInterval(async () => {
      const [windSource, airTempSource, waterTempSource, waterLevelSource] = await Promise.all([
        fetchSource("currentWind", fetchCurrentWind),
        fetchSource("airTemp", fetchAirTemp),
        fetchSource("waterTemp", fetchWaterTemp),
        fetchSource("waterLevel", fetchWaterLevel),
      ]);

      cachedData.sourceStatuses = {
        ...(cachedData.sourceStatuses || {}),
        currentWind: windSource.status,
        airTemp: airTempSource.status,
        waterTemp: waterTempSource.status,
        waterLevel: waterLevelSource.status,
      };

      if (windSource.payload) cachedData.currentWind = windSource.payload;
      if (waterTempSource.payload) cachedData.waterTemp = waterTempSource.payload;
      if (waterLevelSource.payload && cachedData.tideHourly) {
        cachedData.waterLevelAnomaly = computeWaterLevelAnomaly(waterLevelSource.payload, cachedData.tideHourly);
        renderDepthWindows(cachedData.tideHourly);
      }

      renderNowBar(
        windSource.payload || cachedData.currentWind,
        waterTempSource.payload || cachedData.waterTemp,
        waterLevelSource.payload
      );
      const dayRec = cachedData.recommendations ? cachedData.recommendations[getActiveDayIndex()] : null;
      updateKPIs(cachedData.hourlyPeriods || [], cachedData.gustRatio || DEFAULT_GUST_RATIO, dayRec);
      renderSourceStatus(cachedData.sourceStatuses);
      updateTimestamp(cachedData.sourceStatuses);
    }, CONDITION_REFRESH_MS);

    forecastTimer = setInterval(() => {
      loadAllData();
    }, FORECAST_REFRESH_MS);
  }

  function updateTimestamp(sourceStatuses = {}) {
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

  // ========== MAIN INIT ==========

  async function loadAllData(options = {}) {
    try {
      refreshDateContext();
      const previousHourlyTimestamp = cachedData.sourceStatuses && cachedData.sourceStatuses.hourlyForecast
        ? cachedData.sourceStatuses.hourlyForecast.primaryTimestamp
        : null;
      const [tidesSource, tideHourlySource, currentPredictionsSource, forecastSource, hourlySource, marineAlertsSource, marineForecastsSource, uvIndexSource, bayBuoySource, windSource, airTempSource, waterTempSource, waterLevelSource] =
        await Promise.all([
          fetchSource("tides", fetchTides, options),
          fetchSource("tideHourly", fetchTideHourly, options),
          fetchSource("currentPredictions", fetchCurrentPredictions, options),
          fetchSource("forecast", fetchForecast, options),
          fetchSource("hourlyForecast", fetchHourlyForecast, options),
          fetchSource("marineAlerts", fetchMarineAlerts, options),
          fetchSource("marineForecasts", fetchMarineForecasts, options),
          fetchSource("uvIndex", fetchUvIndex, options),
          fetchSource("bayBuoy", fetchBayBuoyObservations, options),
          fetchSource("currentWind", fetchCurrentWind, options),
          fetchSource("airTemp", fetchAirTemp, options),
          fetchSource("waterTemp", fetchWaterTemp, options),
          fetchSource("waterLevel", fetchWaterLevel, options),
        ]);

      const tides = tidesSource.payload || cachedData.tides || null;
      const tideHourly = tideHourlySource.payload || cachedData.tideHourly || null;
      const currentPredictions = currentPredictionsSource.payload || cachedData.currentPredictions || { current_predictions: [] };
      const forecast = forecastSource.payload || (cachedData.forecastPeriods ? { properties: { periods: cachedData.forecastPeriods } } : null);
      const hourly = hourlySource.payload || (cachedData.hourlyPeriods ? { properties: { periods: cachedData.hourlyPeriods } } : null);
      const marineAlerts = marineAlertsSource.payload || cachedData.marineAlerts || { features: [] };
      const marineForecasts = marineForecastsSource.payload || cachedData.marineForecasts || { zones: [] };
      const uvIndex = uvIndexSource.payload || cachedData.uvIndex || [];
      const bayBuoy = bayBuoySource.payload || cachedData.bayBuoy || null;
      const wind = windSource.payload || cachedData.currentWind || null;
      const waterTemp = waterTempSource.payload || cachedData.waterTemp || null;
      const waterLevel = waterLevelSource.payload || null;
      const hourlyPeriods = hourly && hourly.properties ? hourly.properties.periods : [];
      const forecastPeriods = forecast && forecast.properties ? forecast.properties.periods : [];
      const gr = DEFAULT_GUST_RATIO;

      cachedData.sourceStatuses = {
        tides: tidesSource.status,
        tideHourly: tideHourlySource.status,
        currentPredictions: currentPredictionsSource.status,
        forecast: forecastSource.status,
        hourlyForecast: hourlySource.status,
        marineAlerts: marineAlertsSource.status,
        marineForecasts: marineForecastsSource.status,
        uvIndex: uvIndexSource.status,
        bayBuoy: bayBuoySource.status,
        currentWind: windSource.status,
        airTemp: airTempSource.status,
        waterTemp: waterTempSource.status,
        waterLevel: waterLevelSource.status,
      };
      cachedData.tides = tides;
      cachedData.tideHourly = tideHourly;
      cachedData.currentPredictions = currentPredictions;
      cachedData.hourlyPeriods = hourlyPeriods;
      cachedData.forecastPeriods = forecastPeriods;
      cachedData.marineAlerts = marineAlerts;
      cachedData.marineForecasts = marineForecasts;
      cachedData.uvIndex = uvIndex;
      cachedData.bayBuoy = bayBuoy;
      cachedData.currentWind = wind;
      cachedData.waterTemp = waterTemp;
      cachedData.gustRatio = gr;
      cachedData.waterLevelAnomaly = computeWaterLevelAnomaly(waterLevel, tideHourly);
      cachedData.nwsRefreshNotice = "";
      cachedData.fallbackRecommendations = null;
      cachedData.fallbackRecommendationAgeNote = "";

      const currentHourlyTimestamp = hourlySource.status.primaryTimestamp;
      const noNewNwsForecast = Boolean(
        options.forceRefresh
        && previousHourlyTimestamp
        && currentHourlyTimestamp
        && previousHourlyTimestamp.getTime() === currentHourlyTimestamp.getTime()
      );
      if (noNewNwsForecast && hourlySource.status.ageMs !== null && hourlySource.status.ageMs >= NWS_FORECAST_REFRESH_WARNING_MS) {
        cachedData.nwsRefreshNotice =
          `NWS has not released a newer hourly forecast yet. Current forecast is ${formatAgeMinutes(minutesToRoundedAge(hourlySource.status.ageMs))}.`;
      }

      const computedRecommendations = hasRecommendationInputsAvailable()
        ? computeAllRecommendations(hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions, marineAlerts, uvIndex, gr)
        : null;

      // Compute all 5-day recommendations only when required sources are healthy.
      const gate = getRecommendationGate(cachedData.sourceStatuses);
      const recs = gate.blocked ? null : computedRecommendations;
      if (gate.blocked && computedRecommendations) {
        cachedData.fallbackRecommendations = computedRecommendations;
        cachedData.fallbackRecommendationAgeNote = getFallbackDataNotice(cachedData.sourceStatuses);
      }
      cachedData.recommendations = recs;

      // Render everything
      renderSourceStatus(cachedData.sourceStatuses);
      renderRecommendation(recs);
      renderOutlookStrip(recs);
      updateKPIs(hourlyPeriods, gr, recs ? recs[getActiveDayIndex()] : null);
      renderWindChart(hourlyPeriods, gr);
      renderCurrentPrediction(currentPredictions, recs ? recs[getActiveDayIndex()] : null);
      renderBayBuoyCheck(bayBuoy, recs ? recs[getActiveDayIndex()] : null);
      renderMarineConditions(marineForecasts);
      renderStormWatch(hourlyPeriods, marineAlerts);
      renderTideChart(tideHourly);
      renderDepthWindows(tideHourly);
      renderTideTable(tides);
      renderNowBar(wind, waterTemp, waterLevel);
      updateTimestamp(cachedData.sourceStatuses);

    } catch (err) {
      console.error("Failed to load data:", err);
      cachedData.sourceStatuses = {};
      cachedData.nwsRefreshNotice = "";
      renderSourceStatus(cachedData.sourceStatuses);
      document.getElementById("recTitle").textContent = "Data Unavailable";
      document.getElementById("recDetail").textContent = "Unable to fetch conditions. Check your connection and try again.";
    }
  }

  // ── Local Notice to Mariners ──────────────────────────────────────────────

  function buildNtmBoundingBox(lat, lon, radiusNm) {
    const latDelta = radiusNm / 60;
    const lonDelta = radiusNm / (60 * Math.cos((lat * Math.PI) / 180));

    return {
      minLat: lat - latDelta,
      maxLat: lat + latDelta,
      minLon: lon - lonDelta,
      maxLon: lon + lonDelta,
    };
  }

  function buildArcGisGeoJsonUrl(feed, bbox) {
    const url = new URL(`${feed.serviceUrl}/query`);
    url.searchParams.set("where", feed.where);
    url.searchParams.set("geometry", `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`);
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("outFields", feed.outFields.join(","));
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "geojson");

    if (feed.resultOffset) {
      url.searchParams.set("resultOffset", String(feed.resultOffset));
    }
    if (feed.resultRecordCount) {
      url.searchParams.set("resultRecordCount", String(feed.resultRecordCount));
    }

    return url.toString();
  }

  function parseArcGisDate(value) {
    if (value == null || value === "") return null;

    if (typeof value === "number") {
      return new Date(value > 1e12 ? value : value * 1000);
    }

    if (typeof value === "string" && /^\d+$/.test(value)) {
      const numeric = Number(value);
      return new Date(numeric > 1e12 ? numeric : numeric * 1000);
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function truncateText(value, maxLength = 180) {
    if (!value) return "";
    const clean = String(value).replace(/\s+/g, " ").trim();
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
  }

  function formatDateRange(startDate, endDate) {
    const format = (date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    if (startDate && endDate) {
      return `${format(startDate)} - ${format(endDate)}`;
    }
    if (startDate) {
      return `From ${format(startDate)}`;
    }
    if (endDate) {
      return `Until ${format(endDate)}`;
    }
    return "Active now";
  }

  function joinNonEmpty(parts, separator = " · ") {
    return parts.filter(Boolean).join(separator);
  }

  function toRadians(value) {
    return (value * Math.PI) / 180;
  }

  function distanceNm(lat1, lon1, lat2, lon2) {
    const earthRadiusNm = 3440.065;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusNm * c;
  }

  function aidTypeLabel(aidType) {
    if (aidType === "FD") return "Federal aid";
    if (aidType === "PA") return "Private aid";
    return "Aid to navigation";
  }

  function normalizeMsiPointFeature(feature, feed) {
    const props = feature.properties || {};
    const geometry = feature.geometry || {};
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    const lon = coords && coords.length >= 2 ? Number(coords[0]) : null;
    const lat = coords && coords.length >= 2 ? Number(coords[1]) : null;
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);

    return {
      id: joinNonEmpty([feed.key, props.MRN, props.TITLE], "-"),
      category: feed.category,
      categoryLabel: feed.categoryLabel,
      severity: feed.severity,
      title: props.TITLE || feed.categoryLabel,
      waterway: props.WATERWAY_NAME || "Unknown waterway",
      lat: hasPoint ? lat : null,
      lon: hasPoint ? lon : null,
      startDate: parseArcGisDate(props.DATE_BEGIN || props.DATE_CREATED),
      endDate: parseArcGisDate(props.DATE_END),
      description: truncateText(props.DESCRIPTION || props.TITLE || ""),
      sourceRef: props.MRN || props.STATUS || "USCG MSI",
    };
  }

  function normalizeTempChangeFeature(feature, feed) {
    const props = feature.properties || {};
    const geometry = feature.geometry || {};
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    const lon = coords && coords.length >= 2 ? Number(coords[0]) : null;
    const lat = coords && coords.length >= 2 ? Number(coords[1]) : null;
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
    const statusText = props.TC_STATUS || props.TC_CORR_STATUS || props.MSI_STATUS;
    const characteristics = joinNonEmpty([props.AID_SUBTYPE, props.COLOR, props.DESCRIPTION_TYPE], " ");
    const description = joinNonEmpty([
      statusText,
      characteristics,
      props.LLNR ? `LLNR ${props.LLNR}` : "",
      props.BNM_NUM ? `BNM ${props.BNM_NUM}` : "",
    ]);

    return {
      id: joinNonEmpty([feed.key, props.MRN, props.NAME], "-"),
      category: feed.category,
      categoryLabel: feed.categoryLabel,
      severity: feed.severity,
      title: props.NAME || "Temporary AtoN change",
      waterway: props.WATERWAY_NAME || "Unknown waterway",
      lat: hasPoint ? lat : null,
      lon: hasPoint ? lon : null,
      startDate: parseArcGisDate(props.DATE_CREATED),
      endDate: null,
      description: truncateText(description || aidTypeLabel(props.AID_TYPE)),
      sourceRef: props.MRN || props.MSI_STATUS || "USCG temp change",
    };
  }

  function normalizeFedDiscrepancyFeature(feature, feed) {
    const props = feature.properties || {};
    const geometry = feature.geometry || {};
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    const lon = coords && coords.length >= 2 ? Number(coords[0]) : null;
    const lat = coords && coords.length >= 2 ? Number(coords[1]) : null;
    const hasPoint = Number.isFinite(lat) && Number.isFinite(lon);
    const statusText = props.DISCREP_STATUS || props.DISCREP_CORR_STATUS || props.MSI_STATUS;
    const characteristics = joinNonEmpty([props.AID_SUBTYPE, props.COLOR, props.DESCRIPTION_TYPE], " ");
    const description = joinNonEmpty([
      statusText,
      characteristics,
      props.LLNR ? `LLNR ${props.LLNR}` : "",
      props.BNM_NUM ? `BNM ${props.BNM_NUM}` : "",
    ]);

    return {
      id: joinNonEmpty([feed.key, props.MRN, props.NAME], "-"),
      category: feed.category,
      categoryLabel: feed.categoryLabel,
      severity: feed.severity,
      title: props.NAME || "Federal aid discrepancy",
      waterway: props.WATERWAY_NAME || "Unknown waterway",
      lat: hasPoint ? lat : null,
      lon: hasPoint ? lon : null,
      startDate: parseArcGisDate(props.DATE_CREATED),
      endDate: null,
      description: truncateText(description || aidTypeLabel(props.AID_TYPE)),
      sourceRef: props.MRN || props.MSI_STATUS || "USCG discrepancy",
    };
  }

  function isNtmTargetWaterway(waterwayName) {
    if (!waterwayName) return false;
    return NTM_TARGET_WATERWAY_PATTERN.test(waterwayName);
  }

  async function fetchNtmFeed(feed, bbox) {
    try {
      const res = await fetch(buildArcGisGeoJsonUrl(feed, bbox), {
        signal: AbortSignal.timeout(NTM_FETCH_TIMEOUT_MS),
        cache: "default",
      });

      if (!res.ok) return { ok: false, items: [] };

      const payload = await res.json();
      const features = Array.isArray(payload.features) ? payload.features : [];
      const items = features
        .map((feature) => feed.normalize(feature, feed))
        .map((item) => {
          if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) {
            return { ...item, distanceNm: Number.POSITIVE_INFINITY };
          }

          return {
            ...item,
            distanceNm: distanceNm(DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon, item.lat, item.lon),
          };
        })
        .filter(
          (item) => item.title && item.waterway && isNtmTargetWaterway(item.waterway) && item.distanceNm <= NTM_RADIUS_NM
        );

      return { ok: true, items };
    } catch {
      return { ok: false, items: [] };
    }
  }

  function dedupeNtmItems(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.category}|${item.title}|${item.waterway}|${item.sourceRef}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function sortNtmItems(items) {
    return [...items].sort((left, right) => {
      if (left.distanceNm !== right.distanceNm) {
        return left.distanceNm - right.distanceNm;
      }

      if (right.severity !== left.severity) {
        return right.severity - left.severity;
      }

      const leftTime = left.startDate ? left.startDate.getTime() : 0;
      const rightTime = right.startDate ? right.startDate.getTime() : 0;
      return rightTime - leftTime;
    });
  }

  function paginateNtmAlerts(alerts, pageNumber, pageSize = NTM_PAGE_SIZE) {
    const totalItems = alerts.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(totalPages, Math.max(1, pageNumber || 1));
    const pageStart = (currentPage - 1) * pageSize;
    const pageAlerts = alerts.slice(pageStart, pageStart + pageSize);

    return {
      totalItems,
      totalPages,
      currentPage,
      pageAlerts,
      showPagination: totalPages > 1,
    };
  }

  function isActiveNtmItem(item, now = new Date()) {
    if (!item) return false;
    if (item.endDate && item.endDate < now) return false;
    return true;
  }

  function setNtmVisibility(isVisible) {
    const section = document.getElementById("ntmSection");
    if (!section) return;
    section.hidden = !isVisible;
  }

  function renderNtmAlert(item) {
    const distanceLabel = Number.isFinite(item.distanceNm)
      ? `${item.distanceNm.toFixed(1)} NM from port`
      : "Distance unavailable";

    return `
      <article class="ntm-alert ntm-alert-${escapeHtml(item.category)}">
        <div class="ntm-alert-topline">
          <span class="ntm-severity ntm-severity-${escapeHtml(item.category)}">${escapeHtml(item.categoryLabel)}</span>
          <span class="ntm-date-range">${escapeHtml(formatDateRange(item.startDate, item.endDate))}</span>
        </div>
        <h3 class="ntm-alert-title">${escapeHtml(item.title)}</h3>
        <div class="ntm-alert-waterway">${escapeHtml(item.waterway)}</div>
        <div class="ntm-alert-distance">${escapeHtml(distanceLabel)}</div>
        <p class="ntm-alert-description">${escapeHtml(item.description || "Local notice active in this waterway.")}</p>
      </article>
    `;
  }

  function renderNtmSection(alerts, pageNumber = 1) {
    const container = document.getElementById("ntmContent");
    if (!container) return;

    const activeCount = alerts.length;
    const countLabel = activeCount === 1 ? "1 active" : `${activeCount} active`;

    if (activeCount === 0) {
      container.innerHTML = `
        <div class="ntm-shell">
          <div class="ntm-shell-header">
            <div>
              <div class="ntm-kicker">USCG District 5 live feeds</div>
              <p class="ntm-status-line">Checked Chesapeake Bay hazards, temp changes, damaged aids, and marine events within ~${NTM_RADIUS_NM} NM.</p>
            </div>
            <span class="ntm-count-badge ntm-count-badge-clear">0 clear</span>
          </div>
          <div class="ntm-clear-state">
            <div class="ntm-clear-title">No active alerts near ${escapeHtml(DASHBOARD_LOCATION.label)}</div>
            <p class="ntm-clear-copy">No current Coast Guard alerts matched the Chesapeake Bay search area.</p>
          </div>
          <div class="ntm-footer-link-wrap">
            <a class="ntm-footer-link" href="${USCG_WATERWAY_DASHBOARD_URL}" target="_blank" rel="noopener noreferrer">Open Coast Guard source map</a>
          </div>
        </div>
      `;
      setNtmVisibility(true);
      return;
    }

    const {
      totalPages,
      currentPage,
      pageAlerts,
      showPagination,
    } = paginateNtmAlerts(alerts, pageNumber, NTM_PAGE_SIZE);

    container.innerHTML = `
      <div class="ntm-shell">
        <div class="ntm-shell-header">
          <div>
            <div class="ntm-kicker">USCG District 5 live feeds</div>
            <p class="ntm-status-line">Chesapeake Bay alerts within ~${NTM_RADIUS_NM} NM of ${escapeHtml(DASHBOARD_LOCATION.label)}, sorted by distance from port.</p>
          </div>
          <span class="ntm-count-badge ntm-count-badge-alert">${escapeHtml(countLabel)}</span>
        </div>
        <div class="ntm-alert-list">
          ${pageAlerts.map(renderNtmAlert).join("")}
        </div>
        ${showPagination ? `
          <div class="ntm-pagination" aria-label="Notice pagination controls">
            <button id="ntmPrevPage" class="ntm-page-btn" type="button" ${currentPage === 1 ? "disabled" : ""}>Previous</button>
            <span class="ntm-page-meta">Page ${currentPage} of ${totalPages}</span>
            <button id="ntmNextPage" class="ntm-page-btn" type="button" ${currentPage === totalPages ? "disabled" : ""}>Next</button>
          </div>
        ` : ""}
        <div class="ntm-footer-link-wrap">
          <a class="ntm-footer-link" href="${USCG_WATERWAY_DASHBOARD_URL}" target="_blank" rel="noopener noreferrer">Open Coast Guard source map</a>
        </div>
      </div>
    `;

    const prevBtn = document.getElementById("ntmPrevPage");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        ntmCurrentPage = Math.max(1, currentPage - 1);
        renderNtmSection(ntmAlertsCache, ntmCurrentPage);
      });
    }

    const nextBtn = document.getElementById("ntmNextPage");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        ntmCurrentPage = Math.min(totalPages, currentPage + 1);
        renderNtmSection(ntmAlertsCache, ntmCurrentPage);
      });
    }

    setNtmVisibility(true);
  }

  async function loadAndRenderNtm() {
    const bbox = buildNtmBoundingBox(DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon, NTM_RADIUS_NM);
    const settled = await Promise.allSettled(NTM_FEEDS.map((feed) => fetchNtmFeed(feed, bbox)));
    const successfulResults = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((result) => result.ok);

    if (successfulResults.length === 0) {
      setNtmVisibility(false);
      return;
    }

    const activeAlerts = successfulResults
      .flatMap((result) => result.items)
      .filter((item) => isActiveNtmItem(item));

    const alerts = sortNtmItems(dedupeNtmItems(activeAlerts));
    ntmAlertsCache = alerts;
    ntmCurrentPage = 1;
    renderNtmSection(ntmAlertsCache, ntmCurrentPage);
  }

  // ── Nautical chart ────────────────────────────────────────────────────────
  // Centered on Tolchester Marina (39.2085°N, 76.2455°W), zoom 12 ≈ 5 NM view
  function initNauticalMap() {
    const el = document.getElementById('nauticalMap');
    if (!el || typeof L === 'undefined') return;

    const map = L.map('nauticalMap', {
      center: [DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon],
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,   // prevent accidental scroll-hijack on page
    });

    const chartLayerOptions = {
      attribution: 'Charts &copy; NOAA Office of Coast Survey',
      tileSize: 256,
      minZoom: 10,
      maxZoom: 16,
    };

    let activeChartLayer = null;
    let usingLiveFallback = false;

    function createLiveChartLayer() {
      const layer = L.tileLayer("", chartLayerOptions);
      layer.getTileUrl = function getTileUrl(coords) {
        return buildNoaaLiveTileUrl(coords.z, coords.x, coords.y);
      };
      return layer;
    }

    function switchToLiveLayer() {
      if (usingLiveFallback) return;
      usingLiveFallback = true;

      if (activeChartLayer) {
        map.removeLayer(activeChartLayer);
      }

      activeChartLayer = createLiveChartLayer().addTo(map);
    }

    async function addChartLayer() {
      try {
        const manifestRes = await fetch("./chart-cache/noaa/manifest.json", { cache: "no-store" });
        if (manifestRes.ok) {
          const manifest = await manifestRes.json();
          if ((manifest.tileCount || 0) > 0) {
            const probe = latLonToTileCoords(DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon, map.getZoom());
            const probeOk = await canLoadTile(buildLocalChartTileUrl(map.getZoom(), probe.x, probe.y));
            if (!probeOk) {
              switchToLiveLayer();
              return;
            }

            activeChartLayer = L.tileLayer(LOCAL_NOAA_CHART_TILE_URL, chartLayerOptions);
            activeChartLayer.on("tileerror", switchToLiveLayer);
            activeChartLayer.addTo(map);
            return;
          }
        }
      } catch {
        // Fall through to the live NOAA tiles if the local cache is unavailable.
      }

      switchToLiveLayer();
    }

    addChartLayer();

    // Marina marker
    L.marker([DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon])
      .addTo(map)
      .bindTooltip('Tolchester Marina', { permanent: false, direction: 'top' });
  }

  function setUserSettingsForTests(nextSettings = {}) {
    if (nextSettings.crewMode) userSettings.crewMode = nextSettings.crewMode;
    if (nextSettings.safetyMode) userSettings.safetyMode = nextSettings.safetyMode;
  }

  const dashboardTestExports = {
    getFiveDays,
    fmtDate,
    fmtDateCompact,
    refreshDateContext,
    getDateContext,
    buildSourceStatus,
    getObservationFreshnessSummary,
    getRecommendationBlockers,
    getRecommendationGate,
    parseNoaaTime,
    determineSailPlan,
    parseWindMph,
    mphToKnots,
    polarBoatSpeed,
    avgPolarSpeed,
    scoreSailability,
    describeReadiness,
    isHardMarineAlert,
    isSmallCraftAdvisory,
    shouldSmallCraftAdvisoryForceHarbor,
    applySmallCraftAdvisorySailPlan,
    buildRiskDecisionExplanation,
    buildSimpleDaySummary,
    getDefaultFloatPlan,
    normalizeFloatPlan,
    getFloatPlanReadiness,
    assessDay,
    getMarineAlertsForDay,
    normalizeCurrentPredictionEvents,
    getCurrentPredictionPhase,
    summarizeCurrentPrediction,
    normalizeCbibsStation,
    getBayBuoySummary,
    getBayBuoyReality,
    ndbcLatestToCbibsVariables,
    parseCoastalWatersForecast,
    parseMarineForecastText,
    getMarineForecastForDay,
    isStormRelatedAlert,
    getStormOutlookForDay,
    normalizeUvForecast,
    getUvForDay,
    paginateNtmAlerts,
    setUserSettingsForTests,
    summarizePrimaryReason,
    getNoGoBlocker,
    getNoGoBlockerBadge,
    buildNoaaLiveTileUrl,
    buildLocalChartTileUrl,
    latLonToTileCoords,
    renderNowBar,
  };

  export { dashboardTestExports };

  // Boot — only in a browser. When imported by the Node test harness there is
  // no `document`, so the DOM wiring and network fetches are skipped and only
  // the exported functions are evaluated.
  if (typeof document !== "undefined") {
    initTheme();
    initViewModeToggle();
    initSailingSettings();
    initFloatPlan();
    initRefreshButton();
    loadAllData();
    startAutoRefresh();
    initNauticalMap();
    loadAndRenderNtm();
  }
