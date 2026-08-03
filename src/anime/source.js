'use strict';

const anilist = require('./anilist');
const jikan = require('./jikan');
const kitsu = require('./kitsu');

/**
 * Which service answers a catalogue request.
 *
 * Three sources, tried in order:
 *
 *  1. **AniList** — the only one with per-episode air timestamps, which is
 *     what the schedule rows are built on. Primary for that reason alone.
 *  2. **MyAnimeList**, via Jikan — good catalogue data, weekly broadcast
 *     slots only.
 *  3. **Kitsu** — its own database on its own infrastructure.
 *
 * The third source is not paranoia. When AniList disabled its API site-wide,
 * every app depending on it fell back to Jikan simultaneously and Jikan began
 * returning 504s under the load. Two sources that fail together are one
 * source. Kitsu shares no infrastructure with either.
 *
 * A source that fails persistently is skipped for a cooldown rather than
 * retried on every request, since retrying a site-wide outage only adds
 * latency to a call that is going to fail anyway.
 */

const COOLDOWN_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [400, 1200];

const state = {
  degraded: false,
  since: null,
  until: 0,
  reason: null,
  kind: null,
  // Per-source cooldowns for the standbys.
  down: new Map(), // name -> { until, reason }
};

function isDown() {
  if (!state.degraded) return false;
  if (Date.now() > state.until) {
    // Cooldown elapsed; let the next call try AniList again.
    state.degraded = false;
    state.reason = null;
    state.kind = null;
    state.since = null;
    return false;
  }
  return true;
}

function markDown(err) {
  if (!state.degraded) {
    state.since = new Date().toISOString();
    console.warn(`[source] AniList unavailable, falling back to MyAnimeList — ${err.message}`);
  }
  state.degraded = true;
  state.until = Date.now() + COOLDOWN_MS;
  state.reason = err.message;
  state.kind = err.kind || 'error';
}

/** Errors that mean "do not bother asking again for a while". */
function isPersistent(err) {
  if (err.status === 403) return true;
  if (err.status >= 500) return true;
  // Not every layer attaches a status, so the message is checked too —
  // without this a repeatedly-504ing source is retried on every request.
  return /rate limit|HTTP 5\d\d|ECONN|ETIMEDOUT|fetch failed|network|unreachable/i.test(
    err.message || ''
  );
}

/**
 * Errors worth one more immediate attempt.
 *
 * A 504 from an overloaded free API is usually a queue that cleared by the
 * time you ask again; a 403 never is. Retrying the first and not the second
 * is the difference between resilience and wasting the request budget.
 */
function isTransient(err) {
  const message = err.message || '';
  if (err.status === 429) return false;
  return /HTTP 50[234]|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message);
}

async function attempt(name, fn) {
  let lastError = null;
  for (let tryIndex = 0; tryIndex <= RETRY_DELAYS_MS.length; tryIndex++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const delay = RETRY_DELAYS_MS[tryIndex];
      if (delay === undefined || !isTransient(err)) break;
      console.warn(`[source] ${name} transient failure, retrying in ${delay}ms — ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function sourceIsDown(name) {
  const entry = state.down.get(name);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    state.down.delete(name);
    return false;
  }
  return true;
}

function markSourceDown(name, err) {
  state.down.set(name, { until: Date.now() + COOLDOWN_MS, reason: err.message });
}

/**
 * Try each source in turn.
 *
 * All three must return the same shape. If every one fails, the first error
 * surfaces, since AniList's is the one that explains the situation. Sources
 * with no handler for a given row are simply skipped.
 */
async function withFallback(primary, standby, tertiary) {
  const chain = [
    { name: 'anilist', fn: primary },
    { name: 'myanimelist', fn: standby },
    { name: 'kitsu', fn: tertiary },
  ].filter((step) => typeof step.fn === 'function');

  let firstError = null;

  for (const step of chain) {
    if (step.name === 'anilist' ? isDown() : sourceIsDown(step.name)) continue;

    try {
      const result = await attempt(step.name, step.fn);
      if (step.name !== 'anilist') {
        console.warn(`[source] served from ${step.name}`);
      }
      return result;
    } catch (err) {
      if (!firstError) firstError = err;
      if (step.name === 'anilist') {
        if (isPersistent(err)) markDown(err);
        console.warn(`[source] AniList failed — ${err.message}`);
      } else {
        if (isPersistent(err)) markSourceDown(step.name, err);
        console.warn(`[source] ${step.name} failed — ${err.message}`);
      }
    }
  }

  // Every source is down. Throwing lets the cache serve stale data if it has
  // any, which is the last line of defence before an empty row.
  throw firstError || new Error('no catalogue source available');
}

/** The source that would answer right now. */
function activeSource() {
  if (!isDown()) return 'anilist';
  if (!sourceIsDown('myanimelist')) return 'myanimelist';
  if (!sourceIsDown('kitsu')) return 'kitsu';
  return 'none';
}

function status() {
  const standbys = {};
  for (const name of ['myanimelist', 'kitsu']) {
    const entry = state.down.get(name);
    standbys[name] = entry && Date.now() < entry.until
      ? { available: false, reason: entry.reason, retryAfter: new Date(entry.until).toISOString() }
      : { available: true };
  }

  return {
    primary: 'anilist',
    active: activeSource(),
    standbys,
    degraded: state.degraded,
    since: state.since,
    reason: state.reason,
    kind: state.kind,
    retryAfter: state.degraded ? new Date(state.until).toISOString() : null,
  };
}

/** For tests and for an operator who wants to force a retry. */
function reset() {
  state.degraded = false;
  state.since = null;
  state.until = 0;
  state.reason = null;
  state.kind = null;
  state.down.clear();
}

module.exports = {
  withFallback,
  isDown,
  markDown,
  markSourceDown,
  sourceIsDown,
  activeSource,
  status,
  reset,
  isTransient,
  anilist,
  jikan,
  kitsu,
};
