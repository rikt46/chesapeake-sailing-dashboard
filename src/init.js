// ============================================================
// src/init.js — User-interaction init + data loader
//
// Wires the dashboard: theme toggle, view-mode toggle, crew/safety
// settings, float plan form, refresh button, auto-refresh timer,
// and the initial loadAllData() that fetches everything from the
// upstream APIs and triggers a full render.
//
// State (cachedData, simpleViewEnabled, userSettings) lives in
// render.js and recommendation.js; init.js is a thin orchestrator
// that imports the setters and calls them after the user changes
// a setting.
//
// Depends on:
//   src/config.js          (CONDITION_REFRESH_MS, FORECAST_REFRESH_MS,
//                            SOURCE_CONFIG, STORAGE_KEYS,
//                            DEFAULT_SETTINGS, DEFAULT_GUST_RATIO,
//                            DASHBOARD_LOCATION,
//                            LOCAL_NOAA_CHART_TILE_URL,
//                            NOAA_CHART_TILE_URL,
//                            NOAA_CHART_LEVEL_OFFSET, SHOW_SOURCE_DIAGNOSTICS,
//                            NWS_FORECAST_REFRESH_WARNING_MS)
//   src/dates.js           (getActiveDayIndex, setActiveDayIndex,
//                            refreshDateContext)
//   src/helpers.js         (parseSourceDate, escapeHtml)
//   src/fetchers.js        (fetchTides, fetchTideHourly, …, fetchWaterLevel)
//   src/marine_fetchers.js (fetchMarineAlerts, fetchMarineForecasts)
//   src/bay_buoy.js        (fetchBayBuoyObservations)
//   src/uv.js              (fetchUvIndex)
//   src/ntm.js             (loadAndRenderNtm)
//   src/recommendation.js  (setUserSettings, getDefaultFloatPlan,
//                            normalizeFloatPlan, getFloatPlanReadiness,
//                            computeWaterLevelAnomaly)
//   src/render.js          (setCachedData, getCachedData,
//                            setSimpleViewEnabled, renderWindChart,
//                            renderTideChart, renderAll, renderDepthWindows,
//                            renderNowBar, updateKPIs, renderSourceStatus,
//                            updateTimestamp, recomputeRecommendations)
//   src/charts.js          (renderWindChart, renderTideChart)
//   global L               (Leaflet, loaded from CDN in index.html)
// ============================================================

import {
  CONDITION_REFRESH_MS,
  FORECAST_REFRESH_MS,
  SOURCE_CONFIG,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_GUST_RATIO,
  DASHBOARD_LOCATION,
  LOCAL_NOAA_CHART_TILE_URL,
  NOAA_CHART_TILE_URL,
  NOAA_CHART_LEVEL_OFFSET,
  SHOW_SOURCE_DIAGNOSTICS,
  NWS_FORECAST_REFRESH_WARNING_MS,
} from "./config.js";
import {
  getActiveDayIndex,
  setActiveDayIndex,
  refreshDateContext,
} from "./dates.js";
import { parseSourceDate, escapeHtml } from "./helpers.js";
import {
  fetchTides,
  fetchTideHourly,
  fetchCurrentPredictions,
  fetchForecast,
  fetchHourlyForecast,
  fetchCurrentWind,
  fetchAirTemp,
  fetchWaterTemp,
  fetchWaterLevel,
} from "./fetchers.js";
import { fetchMarineAlerts, fetchMarineForecasts } from "./marine_fetchers.js";
import { fetchBayBuoyObservations } from "./bay_buoy.js";
import { fetchUvIndex } from "./uv.js";
import { loadAndRenderNtm } from "./ntm.js";
import {
  setUserSettings,
  getDefaultFloatPlan,
  normalizeFloatPlan,
  getFloatPlanReadiness,
  computeWaterLevelAnomaly,
} from "./recommendation.js";
import {
  setCachedData,
  getCachedData,
  setSimpleViewEnabled,
  renderAll,
  renderDepthWindows,
  renderNowBar,
  updateKPIs,
  renderSourceStatus,
  updateTimestamp,
  recomputeRecommendations,
} from "./render.js";

// ── Local state ────────────────────────────────────────────────────────

const userSettings = { ...DEFAULT_SETTINGS };
let conditionTimer = null;
let forecastTimer = null;

export function getUserSettings() { return userSettings; }

// ── localStorage helpers ──────────────────────────────────────────────

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

// ── Source-status helpers (per source) ────────────────────────────────

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
    return parseSourceDate(
      payload?.current_predictions?.cp?.[0]?.Time
      || payload?.current_predictions?.[0]?.Time
      || payload?.predictions?.[0]?.t
      || payload?.cp?.[0]?.Time
      || null
    );
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
    return payload.stations?.[0]?.variable?.[0]?.measurements?.[0]?.time
      ? parseSourceDate(payload.stations[0].variable[0].measurements[0].time)
      : null;
  }

  if (sourceKey === "ntm") {
    return null;
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
    const candidates = [
      payload?.current_predictions?.cp,
      payload?.current_predictions,
      payload?.predictions,
      payload?.cp,
      payload,
    ];
    return candidates.some((c) => Array.isArray(c) && c.length > 0);
  }
  if (sourceKey === "marineAlerts") {
    return Array.isArray(payload.features);
  }
  if (sourceKey === "marineForecasts") {
    return Array.isArray(payload.zones) && payload.zones.some((zone) => Array.isArray(zone.periods) && zone.periods.length > 0);
  }
  if (sourceKey === "uvIndex") {
    return Array.isArray(payload) && payload.length > 0;
  }
  if (sourceKey === "bayBuoy") {
    return Array.isArray(payload.stations) && payload.stations.length > 0;
  }
  if (sourceKey === "ntm") {
    return Array.isArray(payload.alerts) || Array.isArray(payload.items) || (payload.alerts && payload.alerts.length > 0);
  }
  if (["currentWind", "airTemp", "waterTemp", "waterLevel"].includes(sourceKey)) {
    return Array.isArray(payload.data) && payload.data.length > 0;
  }
  return true;
}

export function buildSourceStatus(sourceKey, payload, fetchedAt, error = null) {
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

// ── User-interaction init ─────────────────────────────────────────────

export function initTheme() {
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
      const cd = getCachedData();
      if (cd.hourlyPeriods) {
        import("./charts.js").then(({ renderWindChart }) => {
          renderWindChart(cd.hourlyPeriods, cd.gustRatio || DEFAULT_GUST_RATIO);
        });
      }
      if (cd.tideHourly) {
        import("./charts.js").then(({ renderTideChart }) => {
          renderTideChart(cd.tideHourly);
        });
      }
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

export function initViewModeToggle() {
  const simpleViewEnabled = readPreference(STORAGE_KEYS.simpleView, "false") === "true";
  setSimpleViewEnabled(simpleViewEnabled);
  applyViewMode();

  const toggle = document.getElementById("simpleViewToggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const next = !document.body.classList.contains("simple-view");
    setSimpleViewEnabled(next);
    if (next) setActiveDayIndex(0);
    savePreference(STORAGE_KEYS.simpleView, next ? "true" : "false");
    applyViewMode();
    renderAll();
  });
}

function applyViewMode() {
  const isSimple = document.body.classList.contains("simple-view");
  // Toggle is already in the right state from the previous setSimpleViewEnabled call.
  if (isSimple) setActiveDayIndex(0);

  const toggle = document.getElementById("simpleViewToggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", isSimple ? "true" : "false");
    toggle.textContent = isSimple ? "Full view" : "Simple view";
  }
}

export function initSailingSettings() {
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

export function initFloatPlan() {
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

export function initRefreshButton() {
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

// ── Initial data load + auto-refresh ──────────────────────────────────

function hasRecommendationInputsAvailable() {
  const cd = getCachedData();
  return Boolean(
    cd.hourlyPeriods && cd.hourlyPeriods.length > 0
    && cd.forecastPeriods && cd.forecastPeriods.length > 0
    && cd.tides && Array.isArray(cd.tides.predictions) && cd.tides.predictions.length > 0
    && cd.tideHourly && Array.isArray(cd.tideHourly.predictions) && cd.tideHourly.predictions.length > 0
  );
}

export async function loadAllData(options = {}) {
  try {
    refreshDateContext();
    const previousHourlyTimestamp = getCachedData().sourceStatuses && getCachedData().sourceStatuses.hourlyForecast
      ? getCachedData().sourceStatuses.hourlyForecast.primaryTimestamp
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

    const previous = getCachedData();
    const tides = tidesSource.payload || previous.tides || null;
    const tideHourly = tideHourlySource.payload || previous.tideHourly || null;
    const currentPredictions = currentPredictionsSource.payload || previous.currentPredictions || { current_predictions: [] };
    const forecast = forecastSource.payload || (previous.forecastPeriods ? { properties: { periods: previous.forecastPeriods } } : null);
    const hourly = hourlySource.payload || (previous.hourlyPeriods ? { properties: { periods: previous.hourlyPeriods } } : null);
    const marineAlerts = marineAlertsSource.payload || previous.marineAlerts || { features: [] };
    const marineForecasts = marineForecastsSource.payload || previous.marineForecasts || { zones: [] };
    const uvIndex = uvIndexSource.payload || previous.uvIndex || [];
    const bayBuoy = bayBuoySource.payload || previous.bayBuoy || null;
    const wind = windSource.payload || previous.currentWind || null;
    const waterTemp = waterTempSource.payload || previous.waterTemp || null;
    const waterLevel = waterLevelSource.payload || null;
    const hourlyPeriods = hourly && hourly.properties ? hourly.properties.periods : [];
    const forecastPeriods = forecast && forecast.properties ? forecast.properties.periods : [];
    const gr = DEFAULT_GUST_RATIO;

    const sourceStatuses = {
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

    const updatedCachedData = {
      ...previous,
      tides,
      tideHourly,
      currentPredictions,
      hourlyPeriods,
      forecastPeriods,
      marineAlerts,
      marineForecasts,
      uvIndex,
      bayBuoy,
      currentWind: wind,
      waterTemp,
      gustRatio: gr,
      sourceStatuses,
    };
    updatedCachedData.waterLevelAnomaly = computeWaterLevelAnomaly(waterLevel, tideHourly);
    updatedCachedData.nwsRefreshNotice = "";
    updatedCachedData.fallbackRecommendations = null;
    updatedCachedData.fallbackRecommendationAgeNote = "";
    setCachedData(updatedCachedData);

    const currentHourlyTimestamp = hourlySource.status.primaryTimestamp;
    const noNewNwsForecast = Boolean(
      options.forceRefresh
      && previousHourlyTimestamp
      && currentHourlyTimestamp
      && previousHourlyTimestamp.getTime() === currentHourlyTimestamp.getTime()
    );
    if (noNewNwsForecast && hourlySource.status.ageMs !== null && hourlySource.status.ageMs >= NWS_FORECAST_REFRESH_WARNING_MS) {
      updatedCachedData.nwsRefreshNotice =
        `NWS has not released a newer hourly forecast yet. Current forecast is ${formatAgeMinutes(minutesToRoundedAge(hourlySource.status.ageMs))}.`;
    }

    const gate = (function (statuses) {
      const blockers = Object.values(statuses).filter((status) => {
        if (!status.requiredForRecommendation) return false;
        if (status.state === "failed" || status.state === "missing") return true;
        if (status.state === "stale" && !["forecast", "hourlyForecast"].includes(status.key)) return true;
        return false;
      });
      return { blocked: blockers.length > 0, blockers };
    })(sourceStatuses);

    let recommendations = null;
    if (hasRecommendationInputsAvailable()) {
      const { computeAllRecommendations } = await import("./recommendation.js");
      recommendations = computeAllRecommendations(
        hourlyPeriods, forecastPeriods, tides, tideHourly, currentPredictions,
        marineAlerts, uvIndex, gr
      );
    }

    if (gate.blocked && recommendations) {
      updatedCachedData.fallbackRecommendations = recommendations;
      updatedCachedData.fallbackRecommendationAgeNote = (function (statuses) {
        const usableRequired = Object.values(statuses)
          .filter((status) => status.requiredForRecommendation && status.ageMs !== null)
          .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
        if (usableRequired.length === 0) return "";
        const oldest = usableRequired[0];
        return `Using oldest available required input: ${oldest.label}, ${formatAgeMinutes(minutesToRoundedAge(oldest.ageMs))}.`;
      })(sourceStatuses);
    }
    updatedCachedData.recommendations = gate.blocked ? null : recommendations;
    setCachedData(updatedCachedData);

    renderSourceStatus(sourceStatuses);
    renderAll();
    const dayRec = updatedCachedData.recommendations ? updatedCachedData.recommendations[getActiveDayIndex()] : null;
    updateKPIs(hourlyPeriods, gr, dayRec);
    renderNowBar(wind, waterTemp, waterLevel);
    updateTimestamp(sourceStatuses);

  } catch (err) {
    console.error("Failed to load data:", err);
    setCachedData({});
    const recTitle = document.getElementById("recTitle");
    const recDetail = document.getElementById("recDetail");
    if (recTitle) recTitle.textContent = "Data Unavailable";
    if (recDetail) recDetail.textContent = "Unable to fetch conditions. Check your connection and try again.";
  }
}

export function startAutoRefresh() {
  conditionTimer = setInterval(async () => {
    const [windSource, airTempSource, waterTempSource, waterLevelSource] = await Promise.all([
      fetchSource("currentWind", fetchCurrentWind),
      fetchSource("airTemp", fetchAirTemp),
      fetchSource("waterTemp", fetchWaterTemp),
      fetchSource("waterLevel", fetchWaterLevel),
    ]);

    const previous = getCachedData();
    const nextStatuses = {
      ...(previous.sourceStatuses || {}),
      currentWind: windSource.status,
      airTemp: airTempSource.status,
      waterTemp: waterTempSource.status,
      waterLevel: waterLevelSource.status,
    };
    const next = { ...previous, sourceStatuses: nextStatuses };
    if (windSource.payload) next.currentWind = windSource.payload;
    if (waterTempSource.payload) next.waterTemp = waterTempSource.payload;
    if (waterLevelSource.payload && previous.tideHourly) {
      next.waterLevelAnomaly = computeWaterLevelAnomaly(waterLevelSource.payload, previous.tideHourly);
      if (previous.tideHourly) renderDepthWindows(previous.tideHourly);
    }
    setCachedData(next);

    renderNowBar(
      windSource.payload || previous.currentWind,
      waterTempSource.payload || previous.waterTemp,
      waterLevelSource.payload
    );
    const dayRec = previous.recommendations ? previous.recommendations[getActiveDayIndex()] : null;
    updateKPIs(previous.hourlyPeriods || [], previous.gustRatio || DEFAULT_GUST_RATIO, dayRec);
    renderSourceStatus(nextStatuses);
    updateTimestamp(nextStatuses);
  }, CONDITION_REFRESH_MS);

  forecastTimer = setInterval(() => {
    loadAllData();
  }, FORECAST_REFRESH_MS);
}

// ── Leaflet nautical chart ───────────────────────────────────────────

export function initNauticalMap() {
  const el = document.getElementById("nauticalMap");
  if (!el || typeof L === "undefined") return;

  const map = L.map("nauticalMap", {
    center: [DASHBOARD_LOCATION.lat, DASHBOARD_LOCATION.lon],
    zoom: 12,
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,
  });

  const chartLayerOptions = {
    attribution: "Charts &copy; NOAA Office of Coast Survey",
    tileSize: 256,
    minZoom: 10,
    maxZoom: 16,
  };

  let activeChartLayer = null;
  let usingLiveFallback = false;

  function buildNoaaLiveTileUrl(z, x, y) {
    const noaaLevel = Math.max(0, z - NOAA_CHART_LEVEL_OFFSET);
    return NOAA_CHART_TILE_URL
      .replace("{z}", String(noaaLevel))
      .replace("{y}", String(y))
      .replace("{x}", String(x));
  }

  function buildLocalChartTileUrl(z, x, y) {
    return LOCAL_NOAA_CHART_TILE_URL
      .replace("{z}", String(z))
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

  async function canLoadTile(url) {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  }

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
    .bindTooltip("Tolchester Marina", { permanent: false, direction: "top" });
}

// ── Boot the dashboard ───────────────────────────────────────────────

export function bootDashboard() {
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
