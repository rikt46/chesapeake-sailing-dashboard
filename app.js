/* ==============================================
   Tolchester Sailing Dashboard — app.js
   Live data from NOAA and weather.gov
   Sail recommendations for Pearson 31-2

   v4 — June 2026
   • Boot-only: all data, rendering, and recommendation logic lives
     in src/*.js modules. This file just wires the browser-side
     boot and re-exports the test surface.
   ============================================== */

import {
  determineSailPlan,
  shouldSmallCraftAdvisoryForceHarbor,
  applySmallCraftAdvisorySailPlan,
  buildRiskDecisionExplanation,
  buildSimpleDaySummary,
  getDefaultFloatPlan,
  normalizeFloatPlan,
  getFloatPlanReadiness,
  assessDay,
  computeAllRecommendations,
  setUserSettings,
  setUserSettingsForTests,
  getNoGoBlocker,
  getNoGoBlockerBadge,
  summarizePrimaryReason,
  compareAgainstToday,
  getDeltaBadge,
  polarBoatSpeed,
  avgPolarSpeed,
  scoreSailability,
  describeReadiness,
  buildNoaaLiveTileUrl,
  buildLocalChartTileUrl,
  latLonToTileCoords,
} from "./src/recommendation.js";

import {
  getFiveDays,
  refreshDateContext,
  getDateContext,
} from "./src/dates.js";

import {
  fmtDate,
  fmtDateCompact,
} from "./src/dates.js";

import {
  parseNoaaTime,
  parseWindMph,
  mphToKnots,
} from "./src/helpers.js";

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
} from "./src/render.js";

import { bootDashboard, buildSourceStatus } from "./src/init.js";

import {
  isHardMarineAlert,
  isSmallCraftAdvisory,
  getMarineAlertsForDay,
  isStormRelatedAlert,
  getStormOutlookForDay,
  parseCoastalWatersForecast,
  parseMarineForecastText,
  getMarineForecastForDay,
  cleanMarineConditionText,
} from "./src/marine.js";

import {
  normalizeCurrentPredictionEvents,
  getCurrentPredictionPhase,
  summarizeCurrentPrediction,
  currentEventLabel,
} from "./src/current_predictions.js";

import {
  normalizeCbibsStation,
  getBayBuoySummary,
  getBayBuoyReality,
  ndbcLatestToCbibsVariables,
} from "./src/bay_buoy.js";

import {
  normalizeUvForecast,
  getUvForDay,
} from "./src/uv.js";

import { paginateNtmAlerts } from "./src/ntm.js";

// Re-export the test surface. tests.mjs imports `dashboard` from
// "./app.js" and pulls every function the recommendation engine, the
// parsers, and the bay-buoy normaliser expose. This single re-export
// keeps the test harness happy without duplicating the import list.
const dashboardTestExports = {
  // dates
  getFiveDays,
  fmtDate,
  fmtDateCompact,
  refreshDateContext,
  getDateContext,
  // helpers
  parseWindMph,
  mphToKnots,
  parseNoaaTime,
  // recommendation
  polarBoatSpeed,
  avgPolarSpeed,
  scoreSailability,
  describeReadiness,
  determineSailPlan,
  shouldSmallCraftAdvisoryForceHarbor,
  applySmallCraftAdvisorySailPlan,
  buildRiskDecisionExplanation,
  buildSimpleDaySummary,
  getDefaultFloatPlan,
  normalizeFloatPlan,
  getFloatPlanReadiness,
  assessDay,
  computeAllRecommendations,
  setUserSettingsForTests,
  getNoGoBlocker,
  getNoGoBlockerBadge,
  summarizePrimaryReason,
  compareAgainstToday,
  getDeltaBadge,
  // render / source-status
  getObservationFreshnessSummary,
  getRecommendationBlockers,
  getRecommendationGate,
  hasRecommendationInputsAvailable,
  getFallbackDataNotice,
  buildSourceStatus,
  renderNowBar,
  // marine
  isHardMarineAlert,
  isSmallCraftAdvisory,
  getMarineAlertsForDay,
  isStormRelatedAlert,
  getStormOutlookForDay,
  parseCoastalWatersForecast,
  parseMarineForecastText,
  getMarineForecastForDay,
  cleanMarineConditionText,
  // current predictions
  normalizeCurrentPredictionEvents,
  getCurrentPredictionPhase,
  summarizeCurrentPrediction,
  // bay buoy
  normalizeCbibsStation,
  getBayBuoySummary,
  getBayBuoyReality,
  ndbcLatestToCbibsVariables,
  // uv
  normalizeUvForecast,
  getUvForDay,
  // ntm
  paginateNtmAlerts,
  // tile url helpers
  buildNoaaLiveTileUrl,
  buildLocalChartTileUrl,
  latLonToTileCoords,
};

export { dashboardTestExports };

// Boot — only in a browser. When imported by the Node test harness there is
// no `document`, so the DOM wiring and network fetches are skipped and only
// the exported functions are evaluated.
if (typeof document !== "undefined") {
  bootDashboard();
}
