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
  parseSourceDate,
  formatTime12,
  formatHour12,
  escapeHtml,
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
  fetchUvIndex,
  normalizeUvForecast,
  getUvForDay,
} from "./src/uv.js";

import {
  normalizeCurrentPredictionEvents,
  getCurrentPredictionPhase,
  summarizeCurrentPrediction,
} from "./src/current_predictions.js";

import {
  fetchBayBuoyObservations,
  normalizeCbibsStation,
  getBayBuoySummary,
  getBayBuoyReality,
  ndbcLatestToCbibsVariables,
} from "./src/bay_buoy.js";

import {
  isHardMarineAlert,
  isSmallCraftAdvisory,
  getMarineAlertsForDay,
  getMarineAlertWindow,
  summarizeMarineAlert,
  isStormRelatedAlert,
  getStormOutlookForDay,
  parseCoastalWatersForecast,
  parseMarineForecastText,
  getMarineForecastForDay,
  cleanMarineConditionText,
} from "./src/marine.js";

import { fetchMarineAlerts, fetchMarineForecasts } from "./src/marine_fetchers.js";

import {
  paginateNtmAlerts,
  loadAndRenderNtm,
} from "./src/ntm.js";

import {
  getChartColors,
  renderWindChart,
  renderTideChart,
} from "./src/charts.js";

import {
  buildNoaaLiveTileUrl,
  buildLocalChartTileUrl,
  latLonToTileCoords,
  canLoadTile,
  polarBoatSpeed,
  avgPolarSpeed,
  scoreSailability,
  dayQuality,
  describeReadiness,
  findSailPlan,
  nudgeSailPlan,
  getCrewModeConfig,
  getSafetyModeConfig,
  determineSailPlan,
  shouldSmallCraftAdvisoryForceHarbor,
  applySmallCraftAdvisorySailPlan,
  getTidePhase,
  windOpposesCurrentCaution,
  computeWaterLevelAnomaly,
  computeDepthWindows,
  getBestWindowSummary,
  formatWindowBoundary,
  buildSafeWindows,
  getNoGoBlocker,
  getNoGoBlockerBadge,
  summarizePrimaryReason,
  getCaptainCrewRiskFactors,
  buildRiskDecisionExplanation,
  compareAgainstToday,
  getDeltaBadge,
  buildSimpleDaySummary,
  getDefaultFloatPlan,
  normalizeFloatPlan,
  getFloatPlanReadiness,
  rainSeverity,
  assessDay,
  computeAllRecommendations,
  setUserSettings,
  setUserSettingsForTests,
} from "./src/recommendation.js";

import {
  setCachedData,
  getCachedData,
  setSimpleViewEnabled,
  renderNowBar,
  renderAll,
  recomputeRecommendations,
  updateTimestamp,
  renderSourceStatus,
  hasRecommendationInputsAvailable,
  getObservationFreshnessSummary,
  getRecommendationBlockers,
  getRecommendationGate,
  getFallbackDataNotice,
  renderRecommendation,
  renderSimpleSummary,
  renderOutlookStrip,
  updateKPIs,
  renderCurrentPrediction,
  renderBayBuoyCheck,
  renderMarineConditions,
  renderStormWatch,
  renderDepthWindows,
  renderTideTable,
} from "./src/render.js";

import {
  NOAA_CURRENT_STATION,
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

  // STORAGE_KEYS, FLOAT_PLAN_CHECKS, DEFAULT_SETTINGS, CREW_MODES, SAFETY_MODES,
  // SAIL_PLANS, THRESHOLDS, CHOPPY_DIRS, CHOP_PENALTY_KTS, DEFAULT_GUST_RATIO,
  // CHARTED_DEPTH_MLLW, MIN_DEPTH_FT, KEEL_DRAFT_FT — imported from src/config.js

  // ========== PEARSON 31-2 POLAR TABLE ==========
  // POLAR_TWS, POLAR_TWA, POLAR_BSP, HULL_SPEED — imported from src/config.js.
  // Tile URL helpers, polar interpolation, scoring, day classification,
  // sail-plan selection, and the per-day assessment all live in
  // src/recommendation.js (imported above).

  // CONDITION_REFRESH_MS, FORECAST_REFRESH_MS, SOURCE_STALE_MS, SOURCE_CONFIG
  // — imported from src/config.js

  // getActiveDayIndex() lives in src/dates.js — use getActiveDayIndex()/setActiveDayIndex().
  let conditionTimer = null;
  let forecastTimer = null;
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

  // Sail plan helpers, depth window math, no-go and primary-reason
  // text, and the day comparison all live in src/recommendation.js
  // (imported above).

  // Date context state + refreshDateContext/getDateContext — in src/dates.js.
  // The module initialises the window at import time (refreshDateContext(true)).


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

  // Render functions (renderSourceStatus, renderRecommendation, renderSimpleSummary,
  // renderOutlookStrip, renderDepthWindows, renderTideTable, renderConditions,
  // renderNowBar, renderMarineConditions, renderStormWatch, renderCurrentPrediction,
  // renderBayBuoyCheck, renderForecast, updateKPIs, updateTimestamp, updateTabHighlight,
  // renderAll, recomputeRecommendations, currentEventLabel) live in src/render.js

  // Per-source status + fetch wrapper. Used by loadAllData / startAutoRefresh
  // and exposed via dashboardTestExports for tests.mjs.

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

  // ========== INIT: THEME / VIEW MODE / SETTINGS / FLOAT PLAN ==========
  // These are user-interaction wiring (button clicks, form changes,
  // localStorage persistence). They call into render.js / recommendation.js
  // to recompute and re-render after the user changes a setting.

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
        setUserSettings(userSettings);
        renderSailingSettings();
        recomputeRecommendations();
      });
    });

    document.querySelectorAll("[data-safety-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        userSettings.safetyMode = button.dataset.safetyMode;
        savePreference(STORAGE_KEYS.safetyMode, userSettings.safetyMode);
        setUserSettings(userSettings);
        renderSailingSettings();
        recomputeRecommendations();
      });
    });

    setUserSettings(userSettings);
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

  // ── Local Notice to Mariners moved to src/ntm.js (loadAndRenderNtm is the boot entry point).

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
