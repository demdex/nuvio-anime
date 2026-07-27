'use strict';

/**
 * Tiny in-memory TTL cache with single-flight de-duplication.
 *
 * AniList allows a limited number of requests per minute, and Nuvio asks for
 * every visible catalogue at once when the home screen opens. Without this,
 * one home screen refresh would fire a dozen identical schedule queries.
 */

const store = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlSeconds) {
  store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  return value;
}

/**
 * Run `fn` unless a fresh cached value exists. Concurrent callers with the
 * same key share a single execution.
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
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

function stats() {
  let live = 0;
  const now = Date.now();
  for (const entry of store.values()) if (entry.expires > now) live++;
  return { entries: store.size, live, inflight: inflight.size };
}

function clear() {
  store.clear();
  inflight.clear();
}

// Drop expired entries every 10 minutes so a long-running instance does not grow forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) if (entry.expires < now) store.delete(key);
}, 10 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

module.exports = { get, set, wrap, stats, clear };
