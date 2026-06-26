// ============================================================
// src/current_predictions.js — NOAA tidal current prediction parser
//
// Walks the NOAA currents_predictions API response (which is
// shaped differently from the tide API) and exposes a normalized
// stream of { time, type, speed, meanFloodDir, meanEbbDir } events
// plus helpers for the current phase at a given instant.
//
// Depends on:
//   src/config.js    (NOAA_CURRENT_STATION for fallback direction labels)
//   src/dates.js     (fmtDate)
//   src/helpers.js   (parseSourceDate, degToCard)
// ============================================================

import { NOAA_CURRENT_STATION } from "./config.js";
import { fmtDate } from "./dates.js";
import { parseSourceDate, degToCard } from "./helpers.js";

export function normalizeCurrentEventType(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("slack")) return "slack";
  if (text.includes("flood")) return "flood";
  if (text.includes("ebb")) return "ebb";
  return "";
}

export function normalizeCurrentPredictionEvents(payload) {
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

export function getCurrentDirectionLabel(event, phase) {
  if (phase === "ebb") {
    return Number.isFinite(event && event.meanEbbDir) ? degToCard(event.meanEbbDir) : NOAA_CURRENT_STATION.ebbDir;
  }
  if (phase === "flood") {
    return Number.isFinite(event && event.meanFloodDir) ? degToCard(event.meanFloodDir) : NOAA_CURRENT_STATION.floodDir;
  }
  return "";
}

export function getCurrentPhaseFromEvents(events, targetTime) {
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

export function getCurrentPredictionPhase(currentPredictions, dateStr, hour) {
  const events = normalizeCurrentPredictionEvents(currentPredictions);
  if (events.length === 0) return null;
  const targetTime = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00`);
  const phase = getCurrentPhaseFromEvents(events, targetTime);
  if (!phase) return null;
  return { ...phase, source: "NOAA current prediction" };
}

export function summarizeCurrentPrediction(currentPredictions, dateStr) {
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
