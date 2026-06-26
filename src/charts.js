// ============================================================
// src/charts.js — Hourly wind & tide charts (Chart.js wrappers)
//
// Two thin wrappers around Chart.js: one for the hourly wind /
// gust bar chart, one for the tide prediction line chart with
// a minimum-keel-depth threshold overlay. Reads its color palette
// from CSS custom properties on :root, so the chart picks up
// theme changes on a re-render.
//
// Depends on:
//   src/config.js    (CHARTED_DEPTH_MLLW, MIN_DEPTH_FT, KEEL_DRAFT_FT)
//   src/dates.js     (getDateContext, getActiveDayIndex)
//   src/helpers.js   (parseWindMph, mphToKnots, parseNoaaTime, formatHour12)
//   global Chart     (loaded from CDN in index.html)
// ============================================================

import { CHARTED_DEPTH_MLLW, MIN_DEPTH_FT, KEEL_DRAFT_FT } from "./config.js";
import { getDateContext, getActiveDayIndex } from "./dates.js";
import {
  parseWindMph,
  mphToKnots,
  parseNoaaTime,
  formatHour12,
} from "./helpers.js";

let windChartInstance = null;
let tideChartInstance = null;

export function getChartColors() {
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

export function renderWindChart(hourlyPeriods, gustRatio) {
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

export function renderTideChart(tideHourly) {
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
