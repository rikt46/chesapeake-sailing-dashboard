// ============================================================
// src/marine_fetchers.js — NWS marine API fetchers
//
// Wraps the marine parser helpers in API calls. Returns the
// shapes expected by the dashboard renderers and source-status
// layer (e.g. { features } for alerts, { zones, productId,
// updated } for forecasts).
//
// Depends on:
//   src/config.js    (MARINE_ALERT_ZONES, NWS_MARINE_OFFICE)
//   src/fetchers.js  (buildRequestUrl, fetchJSON)
//   src/marine.js    (parseCoastalWatersForecast)
// ============================================================

import { MARINE_ALERT_ZONES, NWS_MARINE_OFFICE } from "./config.js";
import { buildRequestUrl, fetchJSON } from "./fetchers.js";
import { parseSourceDate } from "./helpers.js";
import { parseCoastalWatersForecast } from "./marine.js";

export async function fetchMarineAlerts(options = {}) {
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

export async function fetchMarineForecasts(options = {}) {
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
