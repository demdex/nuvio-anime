'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * ID mapping between AniList and the IDs Nuvio actually streams with.
 *
 * Nuvio's local scrapers (AllAnime, HiAnime, AnimePahe, AnimeKai, Animetsu,
 * vidnest-anime and friends) are handed a TMDB or IMDb ID plus a season and
 * episode number. AniList numbers episodes absolutely per entry, so a mapping
 * that also carries the TMDB season and episode offset is what keeps
 * "episode 13" from resolving to the wrong season.
 *
 * Source: Fribb/anime-lists, rebuilt daily, ~7 MB, cached on disk.
 */

const SOURCE_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const CACHE_FILE = path.join(os.tmpdir(), 'nuvio-anime-list-full.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const index = {
  byAniList: new Map(),
  byMal: new Map(),
  byKitsu: new Map(),
  byImdb: new Map(), // imdb id -> array of entries (one per season)
  byTmdbTv: new Map(), // tmdb tv id -> array of entries
  byTmdbMovie: new Map(),
};

let ready = false;
let loading = null;
let loadedAt = 0;
let entryCount = 0;

async function download() {
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'nuvio-anime-addon' } });
  if (!res.ok) throw new Error(`anime-lists download failed: ${res.status}`);
  return res.text();
}

/**
 * Anything that is not a list of mapping rows must never reach the cache.
 * A captive-portal login page, a rate-limit notice or a redirect body would
 * otherwise be written to disk and reused for a day, silently emptying every
 * catalogue that depends on ID mapping.
 */
function validate(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('anime-lists payload is not an array');
  if (list.length < 1000) throw new Error(`anime-lists payload is suspiciously small (${list.length})`);
  return list;
}

async function readSource() {
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return validate(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {
    // A missing cache is normal; a corrupt one is worth saying out loud.
    if (err.code !== 'ENOENT') console.error('[mapper] cached copy unusable:', err.message);
  }

  const text = await download();
  const list = validate(text);
  try {
    fs.writeFileSync(CACHE_FILE, text);
  } catch (err) {
    /* read-only filesystem (Vercel etc.) — keep it in memory only */
  }
  return list;
}

function firstOf(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function build(list) {
  for (const map of Object.values(index)) map.clear();

  for (const raw of list) {
    const anilistId = raw.anilist_id;
    const tmdb = raw.themoviedb_id || {};
    const entry = {
      anilistId: anilistId || null,
      malId: raw.mal_id || null,
      kitsuId: raw.kitsu_id || null,
      anidbId: raw.anidb_id || null,
      imdbId: firstOf(raw.imdb_id) || null,
      tmdbTvId: typeof tmdb.tv === 'number' ? tmdb.tv : null,
      tmdbMovieId: firstOf(tmdb.movie) || null,
      tvdbId: raw.tvdb_id || null,
      // Which TMDB season this AniList entry corresponds to. Sequels are
      // separate AniList entries but the same TMDB show.
      tmdbSeason: raw.season && typeof raw.season.tmdb === 'number' ? raw.season.tmdb : null,
      tvdbSeason: raw.season && typeof raw.season.tvdb === 'number' ? raw.season.tvdb : null,
      // Added to the AniList episode number to reach the TMDB/TVDB number.
      episodeOffset:
        (raw.episode_offset && (raw.episode_offset.tmdb ?? raw.episode_offset.tvdb)) || 0,
      type: raw.type || null,
    };

    if (entry.anilistId) index.byAniList.set(entry.anilistId, entry);
    if (entry.malId) index.byMal.set(entry.malId, entry);
    if (entry.kitsuId) index.byKitsu.set(entry.kitsuId, entry);
    if (entry.imdbId) push(index.byImdb, entry.imdbId, entry);
    if (entry.tmdbTvId) push(index.byTmdbTv, entry.tmdbTvId, entry);
    if (entry.tmdbMovieId) push(index.byTmdbMovie, entry.tmdbMovieId, entry);
  }

  // Season order matters when several AniList entries share one TMDB show:
  // the lowest season is the sensible default for a bare show ID.
  for (const list2 of index.byTmdbTv.values()) list2.sort(bySeason);
  for (const list2 of index.byImdb.values()) list2.sort(bySeason);

  entryCount = list.length;
  loadedAt = Date.now();
  ready = true;
}

function bySeason(a, b) {
  return (a.tmdbSeason ?? 99) - (b.tmdbSeason ?? 99);
}

function push(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Load the mapping once. Safe to call on every request. */
function load() {
  if (ready && Date.now() - loadedAt < CACHE_TTL_MS) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      build(await readSource());
    } catch (err) {
      console.error('[mapper] load failed:', err.message);
      if (!ready) build([]); // degrade to "no mapping" rather than crash
    } finally {
      loading = null;
    }
  })();
  return loading;
}

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
 * IMDb first: Cinemeta, TMDB lookups and nearly every scraper accept it, so it
 * is the most likely to produce a playable stream. TMDB next, AniList last —
 * an AniList-only ID still browses fine, it just has fewer stream sources.
 */
function externalId(media) {
  const entry = byAniList(media.id);
  const isMovie = media.format === 'MOVIE';

  if (entry) {
    if (entry.imdbId) {
      return { id: entry.imdbId, kind: 'imdb', entry, mapped: true };
    }
    const tmdbId = isMovie ? entry.tmdbMovieId : entry.tmdbTvId;
    if (tmdbId) {
      return { id: `tmdb:${tmdbId}`, kind: 'tmdb', entry, mapped: true };
    }
  }
  return { id: `anilist:${media.id}`, kind: 'anilist', entry, mapped: false };
}

/**
 * Convert an absolute AniList episode number into the season/episode pair the
 * scrapers expect.
 */
function toSeasonEpisode(entry, absoluteEpisode) {
  const season = entry && entry.tmdbSeason != null ? entry.tmdbSeason : 1;
  const offset = entry && entry.episodeOffset ? entry.episodeOffset : 0;
  const episode = Math.max(1, Number(absoluteEpisode) + offset);
  // Season 0 in TMDB is the specials bucket; episodes there still number from 1.
  return { season, episode };
}

function status() {
  return {
    ready,
    entries: entryCount,
    anilistIds: index.byAniList.size,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
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
  status,
  SOURCE_URL,
};
