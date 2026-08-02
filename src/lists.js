'use strict';

const anilist = require('./anilist');
const jikan = require('./jikan');
const kitsu = require('./kitsu');
const mal = require('./mal');
const mapper = require('./mapper');
const router = require('./source');

/**
 * One watch list, whichever tracker it came from.
 *
 * The three personal rows do not care where progress comes from, only that
 * each entry arrives as `{ media, progress, score, updatedAt }` with AniList
 * media attached. MAL supplies the list; AniList supplies the artwork,
 * synopsis and — critically for New Episode Available — the airing schedule,
 * which MAL does not expose per episode.
 */

/** Which tracker a given config should use. */
function source(cfg) {
  if (cfg.listSource === 'mal') return cfg.malUser ? 'mal' : 'none';
  if (cfg.listSource === 'anilist') return cfg.anilistUser || cfg.anilistToken ? 'anilist' : 'none';
  // auto: whichever the user actually filled in, AniList first since it needs
  // no client ID and carries scores in a comparable shape.
  if (cfg.anilistUser || cfg.anilistToken) return 'anilist';
  if (cfg.malUser) return 'mal';
  return 'none';
}

/** How many MAL entries may fall back to one-by-one AniList lookups. */
const MAX_INDIVIDUAL_LOOKUPS = 10;

async function fromMal(cfg, statuses) {
  const entries = await mal.list({
    user: cfg.malUser,
    clientId: cfg.malClientId,
    statuses,
    ttl: 300,
  });
  if (!entries.length) return [];

  await mapper.load();

  // Most MAL IDs resolve to an AniList ID offline, which lets one batch query
  // cover the whole list. The stragglers get individual lookups, capped.
  const byAniListId = new Map();
  const strays = [];
  for (const entry of entries) {
    const mapped = mapper.byMal(entry.malId);
    if (mapped && mapped.anilistId) byAniListId.set(mapped.anilistId, entry);
    else strays.push(entry);
  }

  // Artwork and titles have to come from somewhere. AniList is best, but a
  // MyAnimeList list must not go dark just because AniList is down — that
  // would defeat the entire point of tracking on MAL. So hydration falls back
  // through the same three sources as the catalogues.
  const anilistIds = [...byAniListId.keys()];
  const kitsuIds = anilistIds
    .map((id) => {
      const entry = byAniListId.get(id);
      const mapped = mapper.byMal(entry.malId);
      return mapped ? mapped.kitsuId : null;
    })
    .filter(Boolean);

  let media = [];
  try {
    media = await router.withFallback(
      () => anilist.mediaByIds(anilistIds),
      // Jikan has no batch endpoint, so the MAL standby is skipped here
      // rather than firing one request per title through a service that is
      // rate-limited to a few per second.
      undefined,
      () => kitsu.byIds(kitsuIds)
    );
  } catch (err) {
    console.error('[lists] could not hydrate list entries:', err.message);
  }

  const out = [];
  for (const item of media) {
    // Match on whichever ID the answering source supplied.
    const entry =
      byAniListId.get(item.id) ||
      (item.idMal ? entries.find((e) => e.malId === item.idMal) : null) ||
      (item.idKitsu ? entries.find((e) => (mapper.byMal(e.malId) || {}).kitsuId === item.idKitsu) : null);
    if (entry) out.push({ ...entry, media: item });
  }

  const lookups = await Promise.all(
    strays.slice(0, MAX_INDIVIDUAL_LOOKUPS).map(async (entry) => {
      try {
        const found = await anilist.mediaById({ malId: entry.malId });
        return found ? { ...entry, media: found } : null;
      } catch (err) {
        // A stray that cannot be resolved is one missing row, not a failure.
        return null;
      }
    })
  );
  for (const hit of lookups) if (hit) out.push(hit);

  // MAL's own ordering is by last update; preserve it.
  const order = new Map(entries.map((entry, index) => [entry.malId, index]));
  out.sort((a, b) => (order.get(a.malId) ?? 0) - (order.get(b.malId) ?? 0));
  return out;
}

async function fromAniList(cfg, statuses, ttl) {
  const entries = await anilist.userList({
    userName: cfg.anilistUser,
    token: cfg.anilistToken,
    statuses,
    ttl,
  });
  return entries.map((entry) => ({
    media: entry.media,
    progress: entry.progress || 0,
    score: entry.score || 0,
    updatedAt: entry.updatedAt || 0,
  }));
}

/** The unified entry point the catalogue handlers use. */
async function watchlist(cfg, statuses, ttl = 120) {
  const which = source(cfg);
  if (which === 'none') return [];
  try {
    return which === 'mal' ? await fromMal(cfg, statuses) : await fromAniList(cfg, statuses, ttl);
  } catch (err) {
    console.error(`[lists] ${which} list failed:`, err.message);
    return [];
  }
}

module.exports = { watchlist, source };
