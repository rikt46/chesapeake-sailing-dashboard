// ============================================================
// src/ntm.js — USCG Local Notice to Mariners (Chesapeake Bay)
//
// Pulls the four USCG ArcGIS feeds (hazards, temp AtoN changes,
// federal-aid discrepancies split into two pages, marine events),
// normalises each feature into a common shape, filters to the
// configured radius around the dashboard location, and renders
// the result into the #ntmContent panel.
//
// Self-contained state for the page index and the in-memory alert
// cache. The boot function loadAndRenderNtm() is the entry point
// that the dashboard's init code calls.
//
// Depends on:
//   src/config.js     (DASHBOARD_LOCATION, NTM_RADIUS_NM, NTM_PAGE_SIZE,
//                      NTM_FETCH_TIMEOUT_MS, USCG_DISTRICT_ATU,
//                      NTM_TARGET_WATERWAY_PATTERN,
//                      USCG_WATERWAY_DASHBOARD_URL)
//   src/helpers.js    (escapeHtml, formatDateRange, joinNonEmpty,
//                      toRadians, truncateText)
// ============================================================

import {
  DASHBOARD_LOCATION,
  NTM_RADIUS_NM,
  NTM_PAGE_SIZE,
  NTM_FETCH_TIMEOUT_MS,
  USCG_DISTRICT_ATU,
  NTM_TARGET_WATERWAY_PATTERN,
  USCG_WATERWAY_DASHBOARD_URL,
} from "./config.js";
import {
  escapeHtml,
  formatDateRange,
  joinNonEmpty,
  toRadians,
  truncateText,
} from "./helpers.js";

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

// Module-local state for the NTM panel pagination. Kept here so the
// dashboard's main app doesn't need to track NTM page state.
let ntmCurrentPage = 1;
let ntmAlertsCache = [];

// ── Feed helpers ────────────────────────────────────────────────────────

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

export function paginateNtmAlerts(alerts, pageNumber, pageSize = NTM_PAGE_SIZE) {
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

export async function loadAndRenderNtm() {
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
