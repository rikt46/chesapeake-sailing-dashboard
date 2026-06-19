// ============================================================
// src/config.js — all pure configuration constants
//
// Extracted from the top of app.js (the former CONFIG and
// PEARSON 31-2 POLAR TABLE sections). No imports — this is the
// dependency-graph leaf that every other module builds on.
// ============================================================

// ========== STATION / API IDs ==========

export const NOAA_STATION = "8573364"; // Tolchester Beach (tide gauge / water temp / water level)
// NDBC meteorological station at Tolchester Marina — primary wind source.
// Updates every 6 min; more accurate than the CO-OPS tide gauge anemometer.
export const TCBM2_STATION_ID = "TCBM2";
export const NOAA_CURRENT_STATION = {
  id: "cb1202",
  label: "Brewerton Ch Ext LB 2BE",
  floodDir: "NNW",
  ebbDir: "SSW",
};
export const WEATHER_GRID = "PHI/17,37";
export const UV_ZIP = "21620"; // Tolchester / Chestertown area
export const NWS_MARINE_OFFICE = "LWX";
// CBIBS (Chesapeake Bay buoy) API key. Request a free key and paste it here:
//   https://buoybay.noaa.gov/data/api
// As a static site the key is exposed client-side, so use a free-tier key only
// — never a credential that grants access to anything else. Left blank here so
// no personal key ships in the repo; the bay-buoy data source is simply
// unavailable until you set one.
export const CBIBS_API_KEY = "";
export const BAY_BUOY_STATION = {
  cbibsId: "AN",
  ndbcId: "44063",
  label: "Annapolis",
};
export const MARINE_ALERT_ZONES = ["ANZ531", "ANZ532"];
export const MARINE_FORECAST_ZONES = [
  { id: "ANZ531", label: "North of Pooles Island" },
  { id: "ANZ532", label: "Pooles Island to Sandy Point" },
];

// ========== LOCATION / TIME ==========

export const NUM_DAYS = 5;
// The boat sails the Chesapeake, so "today" and day windows are always
// anchored to this zone regardless of where the browser (or CI runner) is.
export const DASHBOARD_TIME_ZONE = "America/New_York";
export const DASHBOARD_LOCATION = {
  label: "Tolchester Beach",
  lat: 39.2085,
  lon: -76.2455,
};

// ========== NTM / USCG ==========

export const NTM_RADIUS_NM = 20;
export const NTM_PAGE_SIZE = 10;
export const NTM_FETCH_TIMEOUT_MS = 8000;
export const USCG_DISTRICT_ATU = 5;
export const NTM_TARGET_WATERWAY_PATTERN = /chesapeake\s*bay|chesapeake/i;
export const USCG_WATERWAY_DASHBOARD_URL =
  "https://www.arcgis.com/apps/dashboards/b9313550dd2349e59c89ace9e38bfa7f";

// ========== NOAA CHART TILES ==========

export const LOCAL_NOAA_CHART_TILE_URL = "./chart-cache/noaa/{z}/{y}/{x}.png";
export const NOAA_CHART_TILE_URL =
  "https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/tile/{z}/{y}/{x}";
export const NOAA_CHART_LEVEL_OFFSET = 2;

// ========== UI / DIAGNOSTICS ==========

export const SHOW_SOURCE_DIAGNOSTICS =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debugSources");
export const NWS_FORECAST_REFRESH_WARNING_MS = 8 * 60 * 60 * 1000;

// ========== USER / BOAT SETTINGS ==========

export const STORAGE_KEYS = {
  theme: "sailingDashboard.theme",
  crewMode: "sailingDashboard.crewMode",
  safetyMode: "sailingDashboard.safetyMode",
  simpleView: "sailingDashboard.simpleView",
  floatPlan: "sailingDashboard.floatPlan",
};

export const FLOAT_PLAN_CHECKS = [
  { key: "pfds", label: "PFDs / harnesses" },
  { key: "vhf", label: "VHF / DSC" },
  { key: "engine", label: "Fuel / engine / battery" },
  { key: "reefing", label: "Reefing plan" },
  { key: "shore", label: "Shore contact" },
];

export const DEFAULT_SETTINGS = {
  crewMode: "double",
  safetyMode: "standard",
};

export const CREW_MODES = {
  solo:   { label: "Single-handed", sustainedOffset: -3, gustOffset: -4 },
  double: { label: "Double-handed", sustainedOffset: -1, gustOffset: -2 },
  crewed: { label: "Crewed",        sustainedOffset:  0, gustOffset:  0 },
};

export const SAFETY_MODES = {
  standard:    { label: "Standard",    sustainedOffset: 0, gustOffset:  0 },
  conservative: { label: "Conservative", sustainedOffset: -2, gustOffset: -3 },
};

export const SAIL_PLANS = [
  {
    key: "full-sail",
    title: "Go Full Sail",
    shortLabel: "Full sail",
    icon: "&#9968;",
    tone: "green",
    setup: "Full main + 135% genoa",
    maxSustained: 15,
    maxGust: 20,
    detail: "Keep full canvas up, but be ready to flatten sails and depower quickly.",
  },
  {
    key: "roll-genoa",
    title: "Reduce Sail",
    shortLabel: "Reduce sail",
    icon: "&#9973;",
    tone: "yellow",
    setup: "Flatten up + roll genoa 10-20%",
    maxSustained: 18,
    maxGust: 24,
    detail: "Start taking a little out of the 135% genoa before reaching for the first reef.",
  },
  {
    key: "first-reef",
    title: "Reduce Sail",
    shortLabel: "Reduce sail",
    icon: "&#9888;",
    tone: "yellow",
    setup: "1 reef + furl genoa 15-30%",
    maxSustained: 22,
    maxGust: 28,
    detail: "This is the normal short-handed heavy-breeze setup for the Pearson 31-2.",
  },
  {
    key: "second-reef",
    title: "Deep Reef",
    shortLabel: "Deep reef",
    icon: "&#9928;",
    tone: "amber",
    setup: "2 reefs + small balanced headsail",
    maxSustained: 27,
    maxGust: 34,
    detail:
      "Put the second reef in early and keep only enough headsail out to balance the helm.",
  },
  {
    key: "harbor-only",
    title: "No-Go",
    shortLabel: "No-go",
    icon: "&#9940;",
    tone: "red",
    setup: "Harbor only",
    maxSustained: Infinity,
    maxGust: Infinity,
    detail:
      "Too much wind, too much squall risk, or too much work for a comfortable short-handed day sail.",
  },
];

// Pearson 31-2 thresholds (knots, conservative for upper Bay chop)
export const THRESHOLDS = {
  fullSail:  { maxSustained: 15, maxGust: 20 },
  firstReef: { maxSustained: 22, maxGust: 28 },
};

// Wind directions that produce short steep chop on the upper Bay
export const CHOPPY_DIRS = ["W", "WNW", "NW", "NNW", "SW", "WSW"];
export const CHOP_PENALTY_KTS = 3;

// Default gust multiplier used to estimate peak gusts from sustained wind
export const DEFAULT_GUST_RATIO = 1.25;

// Draft / depth constraints — Pearson 31-2 w/ 5.8 ft keel
// CHARTED_DEPTH_MLLW = depth at the shallowest point on your route at MLLW datum.
// Adjust this if your controlling depth is different.
export const CHARTED_DEPTH_MLLW = 5.5;  // ft — typical Tolchester approach
export const MIN_DEPTH_FT = 6.33;       // keel (5.8 ft) + 6.4" safety margin
export const KEEL_DRAFT_FT = 5.8;

// ========== PEARSON 31-2 POLAR TABLE ==========
// VPP-estimated boat speed (kts) by TWS (cols) and TWA (rows)
// Scaled from Pearson 33 polars via hull-speed / SA-D / displacement ratios.
// Source: Seapilot database, scaled by √LWL ratio = 0.970

export const POLAR_TWS = [6, 8, 10, 12, 14, 16, 20];
export const POLAR_TWA = [52, 60, 75, 90, 110, 120, 135, 150];
export const POLAR_BSP = [
  // TWS→  6     8     10    12    14    16    20
  [4.66, 5.58, 6.08, 6.29, 6.35, 6.45, 6.55],  // 52°  close-hauled
  [4.97, 5.88, 6.39, 6.59, 6.55, 6.65, 6.75],  // 60°
  [5.19, 5.98, 6.48, 6.78, 6.98, 7.08, 7.18],  // 75°
  [5.39, 6.18, 6.68, 6.88, 7.08, 7.28, 7.48],  // 90°  beam reach
  [5.05, 5.93, 6.51, 6.80, 7.09, 7.29, 7.48],  // 110°
  [4.86, 5.73, 6.31, 6.80, 7.09, 7.38, 7.77],  // 120° broad reach
  [4.28, 5.25, 6.03, 6.51, 6.90, 7.19, 7.78],  // 135°
  [3.60, 4.57, 5.35, 6.03, 6.42, 6.80, 7.49],  // 150° deep reach
];
export const HULL_SPEED = 6.76;

// ========== REFRESH INTERVALS & SOURCE CONFIG ==========

// NOAA observations update every 6 min — 10 min poll keeps us current without hammering the API
// NWS forecast API serves Cache-Control: max-age=3600 (updates once per hour on the hour)
export const CONDITION_REFRESH_MS = 10 * 60 * 1000; // 10 min
export const FORECAST_REFRESH_MS  = 60 * 60 * 1000; // 60 min — matches NWS update cycle exactly

export const SOURCE_STALE_MS = {
  liveObservation: 90 * 60 * 1000,
  forecast:         8 * 60 * 60 * 1000,
  tidePrediction:   6 * 60 * 60 * 1000,
  notice:           6 * 60 * 60 * 1000,
};

export const SOURCE_CONFIG = {
  tides: {
    label: "NOAA hi-lo tides",
    provenance: "NOAA prediction",
    staleMs: SOURCE_STALE_MS.tidePrediction,
    requiredForRecommendation: true,
  },
  tideHourly: {
    label: "NOAA depth window tides",
    provenance: "NOAA prediction",
    staleMs: SOURCE_STALE_MS.tidePrediction,
    requiredForRecommendation: true,
  },
  currentPredictions: {
    label: "NOAA current predictions",
    provenance: "NOAA current prediction",
    staleMs: SOURCE_STALE_MS.tidePrediction,
    requiredForRecommendation: false,
  },
  forecast: {
    label: "NWS daily forecast",
    provenance: "NWS forecast",
    staleMs: SOURCE_STALE_MS.forecast,
    requiredForRecommendation: false,
  },
  hourlyForecast: {
    label: "NWS hourly forecast",
    provenance: "NWS forecast",
    staleMs: SOURCE_STALE_MS.forecast,
    requiredForRecommendation: true,
  },
  marineAlerts: {
    label: "NWS marine alerts",
    provenance: "NWS alerts",
    staleMs: SOURCE_STALE_MS.forecast,
    requiredForRecommendation: false,
  },
  marineForecasts: {
    label: "NWS marine zone forecast",
    provenance: "NWS marine forecast",
    staleMs: SOURCE_STALE_MS.forecast,
    requiredForRecommendation: false,
  },
  uvIndex: {
    label: "EPA UV index",
    provenance: "EPA / NWS UV forecast",
    staleMs: SOURCE_STALE_MS.forecast,
    requiredForRecommendation: false,
  },
  bayBuoy: {
    label: "CBIBS bay buoy",
    provenance: "NOAA CBIBS / NDBC",
    staleMs: SOURCE_STALE_MS.liveObservation,
    requiredForRecommendation: false,
  },
  currentWind: {
    label: "TCBM2 live wind",
    provenance: "NDBC TCBM2 Tolchester",
    staleMs: SOURCE_STALE_MS.liveObservation,
    requiredForRecommendation: false,
  },
  airTemp: {
    label: "NOAA air temperature",
    provenance: "NOAA observation",
    staleMs: SOURCE_STALE_MS.liveObservation,
    requiredForRecommendation: false,
  },
  waterTemp: {
    label: "NOAA water temperature",
    provenance: "NOAA observation",
    staleMs: SOURCE_STALE_MS.liveObservation,
    requiredForRecommendation: false,
  },
  waterLevel: {
    label: "NOAA water level",
    provenance: "NOAA observation",
    staleMs: SOURCE_STALE_MS.liveObservation,
    requiredForRecommendation: false,
  },
  ntm: {
    label: "USCG notices",
    provenance: "USCG feed",
    staleMs: SOURCE_STALE_MS.notice,
    requiredForRecommendation: false,
  },
};
