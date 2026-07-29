'use strict';

const anilist = require('./anilist');
const mal = require('./mal');
const mapper = require('./mapper');

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

  const batched = await anilist.mediaByIds([...byAniListId.keys()]);
  const out = [];
  for (const media of batched) {
    const entry = byAniListId.get(media.id);
    if (entry) out.push({ ...entry, media });
  }

  const lookups = await Promise.all(
    strays.slice(0, MAX_INDIVIDUAL_LOOKUPS).map(async (entry) => {
      try {
        const media = await anilist.mediaById({ malId: entry.malId });
        return media ? { ...entry, media } : null;
      } catch (err) {
        console.error('[lists] MAL entry lookup failed:', err.message);
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
