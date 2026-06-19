// ============================================================
// src/helpers.js — pure utility helpers
//
// Unit conversions, string parsers, and formatting functions.
// No DOM, no fetch, no imports. Extracted from the
// // ===== HELPERS ===== section of app.js.
// ============================================================

export function parseWindMph(str) {
  if (!str) return { low: 0, high: 0, avg: 0 };
  const nums = str.match(/\d+/g);
  if (!nums) return { low: 0, high: 0, avg: 0 };
  const values = nums.map(Number);
  const low = values[0];
  const high = values.length > 1 ? values[1] : values[0];
  return { low, high, avg: (low + high) / 2 };
}

export function mphToKnots(mph) {
  return Math.round(mph * 0.868976);
}

export function degToCard(degrees) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const normalized = ((Number(degrees) % 360) + 360) % 360;
  return dirs[Math.round(normalized / 22.5) % dirs.length];
}

export function metersPerSecondToKnots(value) {
  return Number(value) * 1.943844;
}

export function metersToFeet(value) {
  return Number(value) * 3.28084;
}

export function celsiusToFahrenheit(value) {
  return (Number(value) * 9 / 5) + 32;
}

export function getWeatherIcon(forecast) {
  const f = forecast.toLowerCase();
  if (f.includes("thunder")) return "⛈";
  if (f.includes("rain") || f.includes("shower")) return "🌧";
  if (f.includes("snow")) return "🌨";
  if (f.includes("fog")) return "🌫";
  if (f.includes("cloudy") && f.includes("partly")) return "⛅";
  if (f.includes("cloudy") || f.includes("overcast")) return "☁";
  if (f.includes("sunny") || f.includes("clear")) return "☀";
  return "☀";
}

export function parseNoaaTime(tStr) {
  const [datePart, timePart] = tStr.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

export function formatTime12(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function formatHour12(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}
