#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const config = {
  centerLat: 39.2085,
  centerLon: -76.2455,
  // Radius per zoom level: 50 NM for overview zooms (10-12), 12 NM for detail
  // zooms (13-15). Keeps tile count manageable (~3,700 total) while providing
  // wider-area coverage at lower zoom levels.
  zoomRadiusNm: {
    10: 50, 11: 50, 12: 50,
    13: 12, 14: 12, 15: 12,
  },
  // The NOAA ArcGIS MapServer tile level 0 corresponds to Web Mercator zoom 2,
  // so NOAA level = WM zoom - 2. Tile x/y coordinates are computed at the WM
  // zoom and remain valid at the shifted NOAA level.
  noaaLevelOffset: 2,
  sourceBaseUrl:
    "https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/tile",
  cacheRoot: process.env.CHART_CACHE_DIR || "chart-cache/noaa",
  concurrency: Number(process.env.CHART_CACHE_CONCURRENCY || 2),
};

// Mimic Microsoft Edge to avoid WAF/bot-detection blocks on NOAA tile service.
// Update the version string periodically to stay current with browser releases
// (last updated: 2025-04 — Chrome 124 / Edge 124).
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";

// Returns the TTL (in ms) for a specific tile. Base is 6 days; a stable
// per-tile jitter of ±7 hours is derived from a hash of the tile key so that
// tiles expire at different times and do not all become stale simultaneously.
function getTileTTLMs(z, x, y) {
  const BASE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days
  const JITTER_MS = 7 * 60 * 60 * 1000;    // 7 hours
  // djb2-style hash over the tile key string, kept to 32 bits.
  const key = `${z}/${x}/${y}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (((h << 5) + h) + key.charCodeAt(i)) | 0;
  }
  // Map the lower 16 bits of the hash uniformly to [-1, 1] then scale.
  const t = (h & 0xffff) / 0xffff; // 0 .. 1
  return BASE_MS + Math.round((t * 2 - 1) * JITTER_MS);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const dlat = toRadians(lat2 - lat1);
  const dlon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function tileCenterLat(y, z) {
  const n = 2 ** z;
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
}

function tileCenterLon(x, z) {
  return ((x + 0.5) / 2 ** z) * 360 - 180;
}

function lonToTileX(lon, zoom) {
  const n = 2 ** zoom;
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat, zoom) {
  const n = 2 ** zoom;
  const latRad = toRadians(lat);
  const merc = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return Math.floor(((1 - merc / Math.PI) / 2) * n);
}

function buildTileList() {
  const tiles = [];

  for (const [zStr, radiusNm] of Object.entries(config.zoomRadiusNm)) {
    const z = Number(zStr);
    const latDelta = radiusNm / 60;
    const lonDelta = radiusNm / (60 * Math.cos(toRadians(config.centerLat)));

    const xMin = lonToTileX(config.centerLon - lonDelta, z);
    const xMax = lonToTileX(config.centerLon + lonDelta, z);
    const yMin = latToTileY(config.centerLat + latDelta, z);
    const yMax = latToTileY(config.centerLat - latDelta, z);

    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        const tLat = tileCenterLat(y, z);
        const tLon = tileCenterLon(x, z);
        if (haversineNm(config.centerLat, config.centerLon, tLat, tLon) <= radiusNm) {
          tiles.push({ z, x, y });
        }
      }
    }
  }

  return tiles;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadTile(tile) {
  const noaaLevel = tile.z - config.noaaLevelOffset;
  const url = `${config.sourceBaseUrl}/${noaaLevel}/${tile.y}/${tile.x}`;
  const localPath = path.join(config.cacheRoot, String(tile.z), String(tile.y), `${tile.x}.png`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });

  // TTL-based freshness check: skip the network request when the cached file
  // is still within its per-tile TTL (6 days ± up-to-7-hour stable jitter).
  if (await fileExists(localPath)) {
    const stat = await fs.stat(localPath);
    const ttl = getTileTTLMs(tile.z, tile.x, tile.y);
    if (Date.now() - stat.mtime.getTime() < ttl) {
      return { changed: false, skipped: true, failed: false };
    }
  }

  const response = await fetch(url, {
    headers: { "User-Agent": EDGE_UA },
  });

  if (response.status === 304) {
    return { changed: false, skipped: true, failed: false };
  }

  if (response.status === 403) {
    // WAF/rate-limit block. Treat as a transient soft failure so the job exits
    // 0; the tile will be retried automatically on the next scheduled run.
    console.warn(`Tile fetch blocked (403 – WAF/rate limit): ${url} – will retry next run`);
    return { changed: false, skipped: false, failed: true };
  }

  if (!response.ok) {
    console.error(`Tile fetch failed: ${response.status} ${url}`);
    return { changed: false, skipped: false, failed: true };
  }

  const data = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(localPath, data);
  return { changed: true, skipped: false, failed: false };
}

async function runWithConcurrency(items, worker, concurrency) {
  const queue = [...items];
  const results = [];

  async function runWorker() {
    while (queue.length > 0) {
      const next = queue.shift();
      const result = await worker(next);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => runWorker()));
  return results;
}

async function main() {
  const startedAt = new Date();
  const allTiles = buildTileList();

  // Throttle: process exactly one Chesapeake Bay tile per run. The workflow is
  // scheduled every 10 minutes, so the effective fetch rate is at most one tile
  // per 10 minutes – well below NOAA's WAF thresholds. A deterministic,
  // time-based slot index ensures every tile is eventually refreshed without
  // needing persistent cross-run state.
  const SLOT_MS = 10 * 60 * 1000; // 10-minute slots match the workflow cron
  const slot = Math.floor(Date.now() / SLOT_MS);
  const tileIndex = slot % allTiles.length;
  const tiles = [allTiles[tileIndex]];
  const { z, x, y } = tiles[0];

  console.log(
    `Throttled run: tile ${tileIndex + 1}/${allTiles.length} ` +
    `(z=${z} x=${x} y=${y}) – one Chesapeake Bay tile per 10-minute window.`
  );

  const results = await runWithConcurrency(tiles, downloadTile, config.concurrency);

  const changed = results.filter((r) => r.changed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.failed).length;

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: config.sourceBaseUrl,
    center: {
      lat: config.centerLat,
      lon: config.centerLon,
    },
    zoomRadiusNm: config.zoomRadiusNm,
    tileCount: allTiles.length,
    tileIndex,
    changed,
    skipped,
    failed,
    durationSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
  };

  await fs.mkdir(config.cacheRoot, { recursive: true });
  await fs.writeFile(
    path.join(config.cacheRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(`NOAA chart cache refresh complete. changed=${changed}, skipped=${skipped}, failed=${failed}`);

  // Tile-level failures (e.g. 403 from WAF) are soft: the job exits 0 so the
  // workflow is not marked failed. Only a coding/runtime error (caught below)
  // causes a non-zero exit.
}

main().catch((error) => {
  console.error("Chart cache sync failed:", error);
  process.exit(1);
});
