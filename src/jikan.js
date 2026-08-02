'use strict';

const cache = require('./cache');
const mapper = require('./mapper');

/**
 * Catalogue data from MyAnimeList, via Jikan.
 *
 * This is the standby for when AniList is unavailable — which happens: they
 * disable the API site-wide during load problems, and every app using them
 * goes dark at once. Jikan reads MyAnimeList instead, so it fails independently.
 *
 * Everything here returns objects in the *same shape AniList returns*, so the
 * catalogue handlers and preview builder need no knowledge of which source
 * they are looking at. Where MAL genuinely cannot supply a field (banner art,
 * per-episode air timestamps) the field is null and the callers degrade.
 *
 * Jikan is a shared free service reading a site it does not own, so requests
 * are throttled and cached hard.
 */

const BASE = 'https://api.jikan.moe/v4';
const MIN_INTERVAL_MS = 400; // Jikan asks for roughly 3 requests/second

let queue = Promise.resolve();
let lastCall = 0;

/** Serialise calls and space them out; Jikan blocks bursts. */
function throttle(fn) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even when one call rejects.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function call(pathname, params) {
  const url = new URL(BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  return throttle(async () => {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'nuvio-anime-addon' },
    });
    if (res.status === 429) throw new Error('Jikan rate limit reached');
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const body = await res.json();
    return body;
  });
}

/* ------------------------------------------------------------------ *
 * Normalisation                                                       *
 * ------------------------------------------------------------------ */

const FORMATS = {
  TV: 'TV',
  Movie: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  Special: 'SPECIAL',
  Music: 'MUSIC',
  'TV Special': 'SPECIAL',
};

const STATUSES = {
  'Currently Airing': 'RELEASING',
  'Finished Airing': 'FINISHED',
  'Not yet aired': 'NOT_YET_RELEASED',
};

const ADULT_GENRES = new Set(['Hentai', 'Erotica']);

function isAdult(anime) {
  if (typeof anime.rating === 'string' && anime.rating.toLowerCase().startsWith('rx')) return true;
  return (anime.genres || []).some((g) => ADULT_GENRES.has(g.name));
}

function seasonOf(anime) {
  if (!anime.season) return null;
  return String(anime.season).toUpperCase();
}

/**
 * Jikan anime → the AniList media shape used everywhere else.
 *
 * `id` is AniList's, resolved through the bundled mapping so that catalogue
 * items land on the same IDs whichever source produced them. Unmapped titles
 * keep a null id and are identified by `idMal` instead.
 */
function toMedia(anime) {
  if (!anime || !anime.mal_id) return null;
  const mapped = mapper.byMal(anime.mal_id);
  const images = (anime.images && anime.images.jpg) || {};
  const aired = anime.aired || {};
  const from = aired.from ? new Date(aired.from) : null;
  const to = aired.to ? new Date(aired.to) : null;

  return {
    id: mapped && mapped.anilistId ? mapped.anilistId : null,
    idMal: anime.mal_id,
    title: {
      romaji: anime.title || anime.title_english || null,
      english: anime.title_english || null,
      native: anime.title_japanese || null,
    },
    description: anime.synopsis || '',
    coverImage: {
      extraLarge: images.large_image_url || images.image_url || null,
      large: images.image_url || null,
      color: null,
    },
    // MAL has no banner art. Callers already treat this as optional.
    bannerImage: null,
    format: FORMATS[anime.type] || 'TV',
    status: STATUSES[anime.status] || null,
    episodes: anime.episodes || null,
    duration: null,
    genres: (anime.genres || []).map((g) => g.name),
    averageScore: anime.score ? Math.round(anime.score * 10) : null,
    popularity: anime.members || 0,
    favourites: anime.favorites || 0,
    season: seasonOf(anime),
    seasonYear: anime.year || (from ? from.getUTCFullYear() : null),
    countryOfOrigin: 'JP',
    isAdult: isAdult(anime),
    siteUrl: anime.url || null,
    startDate: from
      ? { year: from.getUTCFullYear(), month: from.getUTCMonth() + 1, day: from.getUTCDate() }
      : { year: null, month: null, day: null },
    endDate: to
      ? { year: to.getUTCFullYear(), month: to.getUTCMonth() + 1, day: to.getUTCDate() }
      : { year: null, month: null, day: null },
    studios: { nodes: (anime.studios || []).map((s) => ({ name: s.name })) },
    // MAL publishes a weekly broadcast slot, not a timestamp per episode.
    nextAiringEpisode: null,
    _source: 'jikan',
  };
}

function mapList(items) {
  return (items || []).map(toMedia).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Catalogue queries                                                   *
 * ------------------------------------------------------------------ */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Today's broadcast line-up.
 *
 * MAL only knows the weekly slot, so this cannot say *which* episode airs or
 * at what minute — the schedule rows fall back to listing the shows that
 * broadcast today. That is a real loss of precision against AniList, and the
 * reason AniList stays the primary source.
 */
async function airingToday(ttl = 3600) {
  const day = DAYS[new Date().getUTCDay()];
  return cache.wrap(`jikan:schedule:${day}`, ttl, async () => {
    const body = await call('/schedules', { filter: day, limit: 25 });
    return mapList(body.data);
  });
}

/** Episodes Jikan has seen recently. Shapes vary, so this reads defensively. */
async function recentEpisodes(ttl = 1800) {
  return cache.wrap('jikan:watch:episodes', ttl, async () => {
    const body = await call('/watch/episodes', {});
    const out = [];
    for (const item of body.data || []) {
      const media = toMedia(item.entry || item.anime || item);
      if (!media) continue;
      const episodes = item.episodes || [];
      const latest = episodes.length ? episodes[0] : null;
      const number = latest && (latest.mal_id || latest.episode_number);
      out.push({
        media,
        episode: Number(number) || null,
        // Jikan does not timestamp these; callers must not claim a time.
        airingAt: null,
      });
    }
    return out;
  });
}

async function top({ page = 1, limit = 25, filter, type }, ttl = 6 * 3600) {
  return cache.wrap(`jikan:top:${filter || 'all'}:${type || 'any'}:${page}`, ttl, async () => {
    const body = await call('/top/anime', { page, limit, filter, type, sfw: true });
    return mapList(body.data);
  });
}

async function season({ year, seasonName, page = 1, limit = 25 }, ttl = 2 * 3600) {
  const key = year && seasonName ? `${year}/${seasonName.toLowerCase()}` : 'now';
  return cache.wrap(`jikan:season:${key}:${page}`, ttl, async () => {
    const path = year && seasonName ? `/seasons/${year}/${seasonName.toLowerCase()}` : '/seasons/now';
    const body = await call(path, { page, limit, sfw: true });
    return mapList(body.data);
  });
}

async function search({ query, page = 1, limit = 25, type, genre }, ttl = 3600) {
  return cache.wrap(`jikan:search:${query || ''}:${type || ''}:${genre || ''}:${page}`, ttl, async () => {
    const body = await call('/anime', {
      q: query,
      page,
      limit,
      type,
      order_by: query ? undefined : 'popularity',
      sort: query ? undefined : 'asc',
      sfw: true,
    });
    return mapList(body.data);
  });
}

/** Community recommendations, used when AniList's cannot be reached. */
async function recommendations(ttl = 6 * 3600) {
  return cache.wrap('jikan:recommendations', ttl, async () => {
    const body = await call('/recommendations/anime', {});
    const out = [];
    for (const item of body.data || []) {
      for (const entry of item.entry || []) {
        const media = toMedia(entry);
        if (media) out.push(media);
      }
    }
    return out;
  });
}

/** Cheap liveness probe for /diagnose. */
async function ping() {
  const body = await call('/top/anime', { limit: 1 });
  return Array.isArray(body.data) && body.data.length > 0;
}

module.exports = {
  toMedia,
  airingToday,
  recentEpisodes,
  top,
  season,
  search,
  recommendations,
  ping,
};
