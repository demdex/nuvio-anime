'use strict';

const NodeCache = require('node-cache');

// Company-id lookups rarely change: cache for a week.
const idCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 7, checkperiod: 3600 });
// Catalogue pages, meta, and provider-repo reports move more: cache for 6 hours.
const dataCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 600 });

/** Cache-aside helper: return the cached value, or compute + store it via fn(). */
async function remember(cache, key, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value !== undefined && value !== null) cache.set(key, value);
  return value;
}

module.exports = { idCache, dataCache, remember };
