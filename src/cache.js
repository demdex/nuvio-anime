'use strict';

/**
 * Tiny in-memory TTL cache with single-flight de-duplication.
 *
 * AniList allows a limited number of requests per minute, and Nuvio asks for
 * every visible catalogue at once when the home screen opens. Without this,
 * one home screen refresh would fire a dozen identical schedule queries.
 */

const store = new Map(); // key -> { value, expires, keepUntil }
const inflight = new Map(); // key -> Promise

/**
 * How long a stale value stays available as a fallback after it expires.
 *
 * AniList disables its API from time to time to protect the site, and returns
 * 403 to everyone while it does. Without this, such an outage empties every
 * catalogue. With it, the addon keeps serving the last good rows — hours old,
 * but far better than a blank screen — until the API returns.
 */
const STALE_GRACE_SECONDS = 24 * 60 * 60;

let staleServes = 0;

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) return undefined;
  return hit.value;
}

/** The expired-but-retained value, if one is still within its grace window. */
function getStale(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.keepUntil < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlSeconds) {
  const now = Date.now();
  store.set(key, {
    value,
    expires: now + ttlSeconds * 1000,
    keepUntil: now + (ttlSeconds + STALE_GRACE_SECONDS) * 1000,
  });
  return value;
}

/**
 * Run `fn` unless a fresh cached value exists. Concurrent callers with the
 * same key share a single execution. If `fn` fails and a stale value is still
 * within its grace window, the stale value is returned instead of throwing.
 */
async function wrap(key, ttlSeconds, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const running = inflight.get(key);
  if (running) return running;

  const promise = (async () => {
    try {
      const value = await fn();
      set(key, value, ttlSeconds);
      return value;
    } catch (err) {
      const stale = getStale(key);
      if (stale !== undefined) {
        staleServes++;
        console.warn(`[cache] ${key}: serving stale data — ${err.message}`);
        return stale;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function stats() {
  let live = 0;
  let stale = 0;
  const now = Date.now();
  for (const entry of store.values()) {
    if (entry.expires > now) live++;
    else if (entry.keepUntil > now) stale++;
  }
  return { entries: store.size, live, stale, staleServes, inflight: inflight.size };
}

function clear() {
  store.clear();
  inflight.clear();
  staleServes = 0;
}

// Drop entries past their grace window every 10 minutes.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.keepUntil < now) store.delete(key);
}, 10 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

module.exports = { get, getStale, set, wrap, stats, clear, STALE_GRACE_SECONDS };
