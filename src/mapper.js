'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * ID mapping between AniList and the IDs Nuvio actually streams with.
 *
 * Nuvio's local scrapers are handed a TMDB or IMDb ID plus a season and
 * episode number. AniList numbers episodes absolutely and treats every sequel
 * as a separate entry, so a mapping that also carries the TMDB season and an
 * episode offset is what keeps "episode 13" from resolving to the wrong
 * season.
 *
 * Loading strategy, in order:
 *
 *  1. `data/mapping.json`, committed to the repo and trimmed to the fields
 *     this addon uses. Loads from disk in milliseconds with no network.
 *  2. A newer copy in the OS temp directory, if a refresh has fetched one.
 *  3. A live download, only when neither of the above exists.
 *
 * The bundled file is what makes this safe on serverless hosts, where every
 * cold start previously paid for a 7 MB download inside the request timeout.
 */

const SOURCE_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const BUNDLED_FILE = path.join(__dirname, '..', 'data', 'mapping.json');
const CACHE_FILE = path.join(os.tmpdir(), 'nuvio-anime-mapping.json');
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const MIN_ROWS = 1000;

const index = {
  byAniList: new Map(),
  byMal: new Map(),
  byKitsu: new Map(),
  byImdb: new Map(),
  byTmdbTv: new Map(),
  byTmdbMovie: new Map(),
};

let ready = false;
let loading = null;
let loadedAt = 0;
let entryCount = 0;
let origin = null;
let lastError = null;
let builtAt = null;

/* ------------------------------------------------------------------ *
 * Parsing                                                             *
 * ------------------------------------------------------------------ */

function firstOf(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Rows in the bundled file are positional; see scripts/build-mapping.js. */
function fromBundledRow(row) {
  return {
    anilistId: row[0] || null,
    malId: row[1] || null,
    imdbId: row[2] || null,
    tmdbTvId: row[3] || null,
    tmdbMovieId: row[4] || null,
    tmdbSeason: row[5] != null ? row[5] : null,
    episodeOffset: row[6] || 0,
    kitsuId: row[7] || null,
  };
}

/** Rows in the upstream file are full objects. */
function fromUpstreamRow(raw) {
  const tmdb = raw.themoviedb_id || {};
  const offsets = raw.episode_offset || {};
  return {
    anilistId: raw.anilist_id || null,
    malId: raw.mal_id || null,
    imdbId: firstOf(raw.imdb_id) || null,
    tmdbTvId: typeof tmdb.tv === 'number' ? tmdb.tv : null,
    tmdbMovieId: firstOf(tmdb.movie) || null,
    tmdbSeason: raw.season && typeof raw.season.tmdb === 'number' ? raw.season.tmdb : null,
    episodeOffset: offsets.tmdb ?? offsets.tvdb ?? 0,
    kitsuId: raw.kitsu_id || null,
  };
}

/**
 * Accept either shape, and refuse anything that is not plausibly the mapping.
 * A captive-portal page or a rate-limit notice must never become the index.
 */
function parse(text) {
  const data = JSON.parse(text);

  if (data && Array.isArray(data.rows)) {
    if (data.rows.length < MIN_ROWS) throw new Error(`bundled mapping too small (${data.rows.length})`);
    return { entries: data.rows.map(fromBundledRow), builtAt: data.builtAt || null };
  }
  if (Array.isArray(data)) {
    if (data.length < MIN_ROWS) throw new Error(`upstream mapping too small (${data.length})`);
    return { entries: data.filter((r) => r.anilist_id).map(fromUpstreamRow), builtAt: null };
  }
  throw new Error('payload is not a mapping');
}

/* ------------------------------------------------------------------ *
 * Index building                                                      *
 * ------------------------------------------------------------------ */

function bySeason(a, b) {
  return (a.tmdbSeason ?? 99) - (b.tmdbSeason ?? 99);
}

function push(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function build(entries, from, when) {
  // Build into fresh maps and swap only on success, so a bad load can never
  // leave the index half-populated for in-flight requests.
  const next = {
    byAniList: new Map(),
    byMal: new Map(),
    byKitsu: new Map(),
    byImdb: new Map(),
    byTmdbTv: new Map(),
    byTmdbMovie: new Map(),
  };

  for (const entry of entries) {
    if (entry.anilistId) next.byAniList.set(entry.anilistId, entry);
    if (entry.malId) next.byMal.set(entry.malId, entry);
    if (entry.kitsuId) next.byKitsu.set(entry.kitsuId, entry);
    if (entry.imdbId) push(next.byImdb, entry.imdbId, entry);
    if (entry.tmdbTvId) push(next.byTmdbTv, entry.tmdbTvId, entry);
    if (entry.tmdbMovieId) push(next.byTmdbMovie, entry.tmdbMovieId, entry);
  }

  for (const list of next.byTmdbTv.values()) list.sort(bySeason);
  for (const list of next.byImdb.values()) list.sort(bySeason);

  Object.assign(index, next);
  entryCount = entries.length;
  loadedAt = Date.now();
  origin = from;
  builtAt = when;
  lastError = null;
  ready = true;
}

/* ------------------------------------------------------------------ *
 * Sources                                                             *
 * ------------------------------------------------------------------ */

function readFile(file) {
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.entries.length) throw new Error('mapping parsed to zero entries');
  return parsed;
}

async function download() {
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'nuvio-anime-addon' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parse(text); // validate before it goes anywhere near the cache
  try {
    fs.writeFileSync(CACHE_FILE, text);
  } catch (err) {
    /* read-only filesystem — keep it in memory only */
  }
  return parsed;
}

/**
 * Load the mapping. Cheap to call on every request.
 *
 * A failure here never marks the mapping ready. That distinction matters: an
 * index that is empty but flagged ready silently empties every catalogue for
 * as long as the flag stands, which is exactly the failure this addon hit in
 * production. An unready mapping is retried; a ready one is trusted.
 */
function load() {
  if (ready && Date.now() - loadedAt < REFRESH_AFTER_MS) return Promise.resolve();
  if (loading) return loading;

  loading = (async () => {
    // 1. A freshly refreshed copy, if one is sitting in temp.
    try {
      const stat = fs.statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < REFRESH_AFTER_MS) {
        const parsed = readFile(CACHE_FILE);
        build(parsed.entries, 'cache', parsed.builtAt);
        return;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[mapper] temp copy unusable:', err.message);
    }

    // 2. The copy shipped with the addon. This is the normal path.
    try {
      const parsed = readFile(BUNDLED_FILE);
      build(parsed.entries, 'bundled', parsed.builtAt);
      return;
    } catch (err) {
      console.error('[mapper] bundled mapping unusable:', err.message);
      lastError = `bundled: ${err.message}`;
    }

    // 3. Nothing on disk. Fetch, and leave the mapping unready if that fails.
    try {
      const parsed = await download();
      build(parsed.entries, 'download', parsed.builtAt);
    } catch (err) {
      console.error('[mapper] download failed:', err.message);
      lastError = `download: ${err.message}`;
      // Deliberately not marking ready — the next request retries.
    }
  })().finally(() => {
    loading = null;
  });

  return loading;
}

/* ------------------------------------------------------------------ *
 * Lookups                                                             *
 * ------------------------------------------------------------------ */

function byAniList(id) {
  return index.byAniList.get(Number(id)) || null;
}

function byMal(id) {
  return index.byMal.get(Number(id)) || null;
}

function byKitsu(id) {
  return index.byKitsu.get(Number(id)) || null;
}

function byImdb(id) {
  const list = index.byImdb.get(String(id));
  return list ? list[0] : null;
}

function allByImdb(id) {
  return index.byImdb.get(String(id)) || [];
}

function byTmdb(id, type) {
  const map = type === 'movie' ? index.byTmdbMovie : index.byTmdbTv;
  const list = map.get(Number(id));
  return list ? list[0] : null;
}

/**
 * Pick the ID a catalogue item should carry.
 *
 * IMDb first: it has the widest scraper support. TMDB next. AniList last — it
 * still browses fine, it just has fewer stream sources.
 *
 * Media may arrive from AniList (an `id`) or from Jikan (only an `idMal`), so
 * both are tried. A catalogue item must land on the same external ID whichever
 * source produced it, or switching sources would break Nuvio's continuity.
 */
function externalId(media) {
  const entry = byAniList(media.id) || (media.idMal ? byMal(media.idMal) : null);
  const isMovie = media.format === 'MOVIE';

  if (entry) {
    if (entry.imdbId) return { id: entry.imdbId, kind: 'imdb', entry, mapped: true };
    const tmdbId = isMovie ? entry.tmdbMovieId : entry.tmdbTvId;
    if (tmdbId) return { id: `tmdb:${tmdbId}`, kind: 'tmdb', entry, mapped: true };
  }

  if (media.id) return { id: `anilist:${media.id}`, kind: 'anilist', entry, mapped: false };
  if (media.idMal) return { id: `mal:${media.idMal}`, kind: 'mal', entry, mapped: false };
  return { id: null, kind: 'none', entry, mapped: false };
}

/** Convert an absolute AniList episode number into a season/episode pair. */
function toSeasonEpisode(entry, absoluteEpisode) {
  const season = entry && entry.tmdbSeason != null ? entry.tmdbSeason : 1;
  const offset = entry && entry.episodeOffset ? entry.episodeOffset : 0;
  const episode = Math.max(1, Number(absoluteEpisode) + offset);
  return { season, episode };
}

/** True when the index is genuinely usable, not merely "attempted". */
function isUsable() {
  return ready && index.byAniList.size > 0;
}

function status() {
  return {
    ready,
    usable: isUsable(),
    entries: entryCount,
    anilistIds: index.byAniList.size,
    origin,
    builtAt,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
    lastError,
    source: SOURCE_URL,
  };
}

module.exports = {
  load,
  byAniList,
  byMal,
  byKitsu,
  byImdb,
  allByImdb,
  byTmdb,
  externalId,
  toSeasonEpisode,
  isUsable,
  status,
  SOURCE_URL,
  BUNDLED_FILE,
};
