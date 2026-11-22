// ============================================================
// src/dom.js — cached element lookup
//
// byId(id) returns the element with that ID, caching it per
// document so repeat renders skip the lookup. A cached node that
// has left the DOM is looked up again. An ID that is missing is
// logged once with console.warn, then returns null so callers
// keep their existing null guards.
// ============================================================

const cacheByDocument = new WeakMap();
const warnedIds = new Set();

export function byId(id) {
  let cache = cacheByDocument.get(document);
  if (!cache) {
    cache = new Map();
    cacheByDocument.set(document, cache);
  }
  const cached = cache.get(id);
  if (cached && cached.isConnected) return cached;

  const el = document.getElementById(id);
  if (el) {
    cache.set(id, el);
    return el;
  }
  cache.delete(id);
  if (!warnedIds.has(id)) {
    warnedIds.add(id);
    console.warn(`[dom] element #${id} not found in index.html`);
  }
  return null;
}
