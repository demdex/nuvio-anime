'use strict';

const cache = require('./cache');
const mapper = require('./mapper');

/**
 * Catalogue data from Kitsu.
 *
 * The third source, and the one that matters when the other two fail
 * together — which is not hypothetical: when AniList disables its API,
 * every app using it falls back to Jikan at once and Jikan starts
 * returning 504s under the load. Kitsu runs its own database on its own
 * infrastructure and does not inherit either failure.
 *
 * It needs no key. The bundled mapping already carries Kitsu IDs, so titles
 * from here resolve to the same IMDb and TMDB IDs as titles from anywhere
 * else, and Nuvio's continuity holds across a source switch.
 *
 * Kitsu speaks JSON:API: filters are `filter[x]=y`, sorting is `sort=-field`,
 * and paging is `page[limit]` / `page[offset]`.
 */

// Kitsu has been migrating hosts; try the current one, then the legacy one.
const HOSTS = ['https://kitsu.app/api/edge', 'https://kitsu.io/api/edge'];

const SUBTYPES = {
  TV: 'TV',
  movie: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  special: 'SPECIAL',
  music: 'MUSIC',
};

const STATUSES = {
  current: 'RELEASING',
  finished: 'FINISHED',
  upcoming: 'NOT_YET_RELEASED',
  unreleased: 'NOT_YET_RELEASED',
  tba: 'NOT_YET_RELEASED',
};

async function call(pathname, params) {
  let lastError = null;

  for (const host of HOSTS) {
    const url = new URL(host + pathname);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.api+json', 'user-agent': 'nuvio-anime-addon' },
      });
      if (!res.ok) {
        const err = new Error(`Kitsu HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Kitsu unreachable');
}

/* ------------------------------------------------------------------ *
 * Normalisation                                                       *
 * ------------------------------------------------------------------ */

function isAdult(attrs) {
  return attrs.ageRating === 'R18' || attrs.nsfw === true;
}

function yearOf(dateString) {
  if (!dateString) return null;
  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function datePartsOf(dateString) {
  const parsed = yearOf(dateString);
  if (!parsed) return { year: null, month: null, day: null };
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
}

/**
 * Kitsu record → the AniList media shape used everywhere else.
 *
 * `id` becomes the AniList ID wherever the bundled mapping knows it, so a
 * title keeps one identity no matter which source produced it.
 */
function toMedia(record) {
  if (!record || !record.id) return null;
  const attrs = record.attributes || {};
  const kitsuId = Number(record.id);
  const mapped = mapper.byKitsu(kitsuId);
  const titles = attrs.titles || {};
  const poster = attrs.posterImage || {};
  const cover = attrs.coverImage || {};

  return {
    id: mapped && mapped.anilistId ? mapped.anilistId : null,
    idMal: mapped && mapped.malId ? mapped.malId : null,
    idKitsu: kitsuId,
    title: {
      romaji: titles.en_jp || attrs.canonicalTitle || null,
      english: titles.en || attrs.canonicalTitle || null,
      native: titles.ja_jp || null,
    },
    description: attrs.synopsis || attrs.description || '',
    coverImage: {
      extraLarge: poster.original || poster.large || poster.medium || null,
      large: poster.large || poster.medium || null,
      color: null,
    },
    bannerImage: cover.original || cover.large || null,
    format: SUBTYPES[attrs.subtype] || 'TV',
    status: STATUSES[attrs.status] || null,
    episodes: attrs.episodeCount || null,
    duration: attrs.episodeLength || null,
    // Categories are a separate JSON:API relationship; not worth a second
    // round trip per title, so genres are simply absent from this source.
    genres: [],
    // Kitsu rates out of 100 as a string; AniList's averageScore is 0-100.
    averageScore: attrs.averageRating ? Math.round(Number(attrs.averageRating)) : null,
    popularity: attrs.userCount || 0,
    favourites: attrs.favoritesCount || 0,
    season: null,
    seasonYear: datePartsOf(attrs.startDate).year,
    countryOfOrigin: 'JP',
    isAdult: isAdult(attrs),
    siteUrl: attrs.slug ? `https://kitsu.app/anime/${attrs.slug}` : null,
    startDate: datePartsOf(attrs.startDate),
    endDate: datePartsOf(attrs.endDate),
    studios: { nodes: [] },
    nextAiringEpisode: null,
    _source: 'kitsu',
  };
}

function mapList(body) {
  return (body && Array.isArray(body.data) ? body.data : []).map(toMedia).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Catalogue queries                                                   *
 * ------------------------------------------------------------------ */

function paging(page, limit) {
  return {
    'page[limit]': Math.min(limit || 20, 20),
    'page[offset]': ((page || 1) - 1) * Math.min(limit || 20, 20),
  };
}

/** Currently airing, most followed first — the closest thing to trending. */
async function airing({ page = 1, limit = 20 } = {}, ttl = 3600) {
  return cache.wrap(`kitsu:airing:${page}:${limit}`, ttl, async () =>
    mapList(await call('/anime', { 'filter[status]': 'current', sort: '-userCount', ...paging(page, limit) }))
  );
}

async function top({ page = 1, limit = 20 } = {}, ttl = 6 * 3600) {
  return cache.wrap(`kitsu:top:${page}:${limit}`, ttl, async () =>
    mapList(await call('/anime', { sort: '-averageRating', ...paging(page, limit) }))
  );
}

async function movies({ page = 1, limit = 20 } = {}, ttl = 6 * 3600) {
  return cache.wrap(`kitsu:movies:${page}:${limit}`, ttl, async () =>
    mapList(await call('/anime', { 'filter[subtype]': 'movie', sort: '-userCount', ...paging(page, limit) }))
  );
}

async function search({ query, page = 1, limit = 20 }, ttl = 3600) {
  return cache.wrap(`kitsu:search:${query}:${page}`, ttl, async () =>
    mapList(await call('/anime', { 'filter[text]': query, ...paging(page, limit) }))
  );
}

/**
 * A season, by date range.
 *
 * Kitsu has no season filter, so this brackets the season's start months and
 * accepts the slight imprecision at the edges — a show starting on the last
 * day of a season is a rounding error, not a bug worth a second API.
 */
const SEASON_MONTHS = { WINTER: [1, 3], SPRING: [4, 6], SUMMER: [7, 9], FALL: [10, 12] };

async function season({ seasonName, year, page = 1, limit = 20 }, ttl = 2 * 3600) {
  const months = SEASON_MONTHS[String(seasonName).toUpperCase()] || SEASON_MONTHS.WINTER;
  const from = `${year}-${String(months[0]).padStart(2, '0')}-01`;
  const to = `${year}-${String(months[1]).padStart(2, '0')}-31`;

  return cache.wrap(`kitsu:season:${year}:${seasonName}:${page}`, ttl, async () =>
    mapList(
      await call('/anime', {
        'filter[startDate]': `${from}..${to}`,
        sort: '-userCount',
        ...paging(page, limit),
      })
    )
  );
}

/** Cheap liveness probe for /diagnose. */
async function ping() {
  const body = await call('/anime', { 'page[limit]': 1 });
  return Boolean(body && Array.isArray(body.data) && body.data.length);
}

module.exports = { toMedia, airing, top, movies, search, season, ping, HOSTS };
