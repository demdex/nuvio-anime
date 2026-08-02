'use strict';

const anilist = require('./anilist');
const jikan = require('./jikan');

/**
 * Which service answers a catalogue request.
 *
 * AniList is primary: it has per-episode air timestamps, which is what the
 * schedule rows are built on. Jikan is the standby, because AniList disables
 * its API site-wide during load problems and takes every dependent app down
 * with it.
 *
 * When AniList fails in a way that will not fix itself on the next request —
 * a 403 outage or an IP block — this switches to Jikan and stops retrying for
 * a cooldown. Retrying a site-wide outage on every request just adds latency
 * to a call that is going to fail anyway.
 */

const COOLDOWN_MS = 10 * 60 * 1000;

const state = {
  degraded: false,
  since: null,
  until: 0,
  reason: null,
  kind: null,
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
  return /rate limit|ECONN|ETIMEDOUT|fetch failed|network/i.test(err.message || '');
}

/**
 * Try AniList, fall back to Jikan.
 *
 * `primary` and `standby` must return the same shape. If both fail, the
 * AniList error is what surfaces, since that is the one worth reporting.
 */
async function withFallback(primary, standby) {
  if (!isDown()) {
    try {
      const result = await primary();
      if (result && (!Array.isArray(result) || result.length)) return result;
      // An empty result is not an error; do not fail over for a quiet hour.
      return result;
    } catch (err) {
      if (isPersistent(err)) markDown(err);
      else console.warn(`[source] AniList call failed, trying MyAnimeList — ${err.message}`);
      try {
        return await standby();
      } catch (fallbackErr) {
        console.error(`[source] MyAnimeList also failed — ${fallbackErr.message}`);
        throw err;
      }
    }
  }
  return standby();
}

function status() {
  return {
    primary: 'anilist',
    active: isDown() ? 'myanimelist' : 'anilist',
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
}

module.exports = { withFallback, isDown, markDown, status, reset, anilist, jikan };
