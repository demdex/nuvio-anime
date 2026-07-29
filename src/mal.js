'use strict';

const cache = require('./cache');

/**
 * MyAnimeList list reading.
 *
 * Two ways in, because they trade off differently:
 *
 *  - **MAL API v2** with an `X-MAL-CLIENT-ID` header. Public lists need no
 *    OAuth flow, just a client ID from myanimelist.net/apiconfig. Stable,
 *    documented, generous limits. This is the path to prefer.
 *  - **Jikan v4**, which needs no signup at all but is a scraper of MAL's
 *    own pages. Its list endpoint has changed shape more than once, so the
 *    parser below is deliberately tolerant, and its rate limit is tight.
 *
 * Either way this module returns only *list* data — MAL ID, progress, score.
 * Artwork, synopses and airing schedules still come from AniList, so the rows
 * look identical whichever tracker you use.
 */

const MAL_ENDPOINT = 'https://api.myanimelist.net/v2';
const JIKAN_ENDPOINT = 'https://api.jikan.moe/v4';
const MAX_PAGES = 4;

/** This addon's internal statuses, in MAL's vocabulary. */
const STATUS_MAP = {
  CURRENT: 'watching',
  REPEATING: 'watching',
  PAUSED: 'on_hold',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
  PLANNING: 'plan_to_watch',
};

function toMalStatuses(statuses) {
  const out = new Set();
  for (const status of statuses) if (STATUS_MAP[status]) out.add(STATUS_MAP[status]);
  return [...out];
}

/* ------------------------------------------------------------------ *
 * MAL API v2                                                          *
 * ------------------------------------------------------------------ */

async function fetchViaMal({ user, clientId, malStatus }) {
  const entries = [];
  let url =
    `${MAL_ENDPOINT}/users/${encodeURIComponent(user)}/animelist` +
    `?fields=list_status&limit=1000&sort=list_updated_at` +
    (malStatus ? `&status=${malStatus}` : '');

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetch(url, {
      headers: { 'X-MAL-CLIENT-ID': clientId, accept: 'application/json' },
    });
    if (res.status === 404) throw new Error(`MAL user "${user}" not found`);
    if (res.status === 403) throw new Error('MAL rejected the client ID, or the list is private');
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);

    const body = await res.json();
    for (const item of body.data || []) {
      const node = item.node || {};
      const status = item.list_status || {};
      entries.push({
        malId: node.id,
        progress: status.num_episodes_watched || 0,
        score: status.score || 0,
        updatedAt: status.updated_at ? Math.floor(new Date(status.updated_at).getTime() / 1000) : 0,
        status: status.status || null,
      });
    }
    url = body.paging && body.paging.next ? body.paging.next : null;
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Jikan v4                                                            *
 * ------------------------------------------------------------------ */

/**
 * Jikan has returned this list in at least three shapes over its life, so
 * every field is read through a set of aliases rather than one fixed path.
 */
function readJikanEntry(item) {
  const node = item.node || item.anime || item.entry || item;
  const listStatus = item.list_status || item;
  const malId = node.mal_id || node.id;
  if (!malId) return null;

  const progress =
    listStatus.num_episodes_watched ??
    listStatus.episodes_watched ??
    listStatus.watched_episodes ??
    item.num_watched_episodes ??
    0;

  return {
    malId,
    progress: Number(progress) || 0,
    score: Number(listStatus.score || item.score || 0),
    updatedAt: listStatus.updated_at
      ? Math.floor(new Date(listStatus.updated_at).getTime() / 1000)
      : 0,
    status: listStatus.status || null,
  };
}

async function fetchViaJikan({ user, malStatus }) {
  const entries = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${JIKAN_ENDPOINT}/users/${encodeURIComponent(user)}/animelist` +
      `?page=${page}` + (malStatus ? `&status=${malStatus}` : '');

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) throw new Error(`MAL user "${user}" not found on Jikan`);
    if (res.status === 429) throw new Error('Jikan rate limit reached — add a MAL client ID');
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);

    const body = await res.json();
    const batch = (body.data || []).map(readJikanEntry).filter(Boolean);
    entries.push(...batch);

    const hasNext = body.pagination && body.pagination.has_next_page;
    if (!hasNext || !batch.length) break;
    // Jikan asks for a delay between calls; one second is the polite minimum.
    await new Promise((r) => setTimeout(r, 1000));
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Public                                                              *
 * ------------------------------------------------------------------ */

/**
 * A user's MAL list, as `{ malId, progress, score, updatedAt }`.
 * MAL filters server-side by one status at a time, so several statuses mean
 * several calls; results are merged with the highest progress winning.
 */
async function list({ user, clientId, statuses = ['CURRENT'], ttl = 300 }) {
  if (!user) return [];
  const malStatuses = toMalStatuses(statuses);
  const key = `mal:${user}:${malStatuses.join(',')}:${clientId ? 'api' : 'jikan'}`;

  return cache.wrap(key, ttl, async () => {
    const merged = new Map();
    for (const malStatus of malStatuses.length ? malStatuses : [null]) {
      const batch = clientId
        ? await fetchViaMal({ user, clientId, malStatus })
        : await fetchViaJikan({ user, malStatus });

      for (const entry of batch) {
        const existing = merged.get(entry.malId);
        if (!existing || entry.progress > existing.progress) merged.set(entry.malId, entry);
      }
    }
    return [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  });
}

module.exports = { list, STATUS_MAP, toMalStatuses };
