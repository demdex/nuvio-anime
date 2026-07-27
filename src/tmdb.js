'use strict';

const cache = require('./cache');

/**
 * Optional TMDB lookups.
 *
 * The offline mapping covers most of what is worth watching, but it lags a few
 * weeks behind for brand-new shows — exactly the ones "Airing Today" and
 * "Released in the Last Hour" are made of. When a TMDB key is configured we
 * fall back to a title search so those rows still hand Nuvio a streamable ID.
 */

const BASE = 'https://api.themoviedb.org/3';

async function call(pathname, params, apiKey) {
  const url = new URL(BASE + pathname);
  url.searchParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

/** Best-effort match of an AniList title to a TMDB record. */
async function findByTitle({ titles, year, isMovie, apiKey }, ttl = 86400) {
  if (!apiKey) return null;
  const candidates = titles.filter(Boolean);
  if (!candidates.length) return null;

  const key = `tmdb:find:${isMovie ? 'movie' : 'tv'}:${candidates[0]}:${year || ''}`;
  return cache.wrap(key, ttl, async () => {
    for (const title of candidates) {
      try {
        const data = await call(
          isMovie ? '/search/movie' : '/search/tv',
          {
            query: title,
            include_adult: false,
            [isMovie ? 'primary_release_year' : 'first_air_date_year']: year || undefined,
          },
          apiKey
        );
        const hit = (data.results || []).find(
          (r) => r.original_language === 'ja' || r.original_language === 'zh'
        );
        if (hit) return { tmdbId: hit.id, isMovie, title: hit.name || hit.title };
      } catch (err) {
        console.error('[tmdb] search failed:', err.message);
      }
    }
    return null;
  });
}

async function externalIds({ tmdbId, isMovie, apiKey }, ttl = 86400) {
  if (!apiKey || !tmdbId) return null;
  return cache.wrap(`tmdb:ext:${isMovie ? 'movie' : 'tv'}:${tmdbId}`, ttl, async () => {
    try {
      const data = await call(`/${isMovie ? 'movie' : 'tv'}/${tmdbId}/external_ids`, {}, apiKey);
      return data && data.imdb_id ? { imdbId: data.imdb_id } : null;
    } catch (err) {
      return null;
    }
  });
}

/** Episode stills and titles, used to dress up the episode list on a meta page. */
async function season({ tmdbId, seasonNumber, apiKey }, ttl = 21600) {
  if (!apiKey || !tmdbId) return null;
  return cache.wrap(`tmdb:season:${tmdbId}:${seasonNumber}`, ttl, async () => {
    try {
      const data = await call(`/tv/${tmdbId}/season/${seasonNumber}`, {}, apiKey);
      return data.episodes || null;
    } catch (err) {
      return null;
    }
  });
}

module.exports = { findByTitle, externalIds, season };
