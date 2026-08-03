'use strict';

const fetch = require('node-fetch');
const { idCache, dataCache, remember } = require('./cache');
const { ENGLISH_ORIGIN_COUNTRIES } = require('./config');

const API_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

function apiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    throw new Error('TMDB_API_KEY is not set. Copy .env.example to .env and add a free TMDB v3 API key.');
  }
  return key;
}

async function tmdbGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  url.searchParams.set('api_key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Network id: env override, else the verified id baked into config.js. */
function resolveNetworkId(brand) {
  const override = process.env[brand.envNetworkId];
  return override ? Number(override) : brand.networkId;
}

/** Company id (for movie discovery): env override, else a live /search/company lookup, cached. */
async function resolveCompanyId(brand) {
  const override = process.env[brand.envCompanyId];
  if (override) return Number(override);

  return remember(idCache, `company:${brand.id}`, async () => {
    try {
      const data = await tmdbGet('/search/company', { query: brand.companyQuery });
      const results = data.results || [];
      const exact = results.find(r => r.name.toLowerCase() === brand.name.toLowerCase());
      const best = exact || results[0];
      return best ? best.id : null;
    } catch (err) {
      console.warn(`[tmdb] company search failed for ${brand.name}: ${err.message}`);
      return null;
    }
  });
}

/** True if the item is English-language or originates from a majority-English-speaking market. */
function isEnglishOrigin(item) {
  if (item.original_language && item.original_language !== 'en') return false;
  if (Array.isArray(item.origin_country) && item.origin_country.length) {
    return item.origin_country.some(c => ENGLISH_ORIGIN_COUNTRIES.includes(c));
  }
  return true;
}

async function discoverSeries(brand, { page = 1 } = {}) {
  const networkId = resolveNetworkId(brand);
  if (!networkId) return [];
  return remember(dataCache, `series:${brand.id}:${page}`, async () => {
    const data = await tmdbGet('/discover/tv', {
      with_networks: networkId,
      with_original_language: 'en',
      sort_by: 'popularity.desc',
      include_adult: false,
      page
    });
    return (data.results || []).filter(isEnglishOrigin);
  });
}

async function discoverMovies(brand, { page = 1 } = {}) {
  const companyId = await resolveCompanyId(brand);
  if (!companyId) return [];
  return remember(dataCache, `movies:${brand.id}:${page}`, async () => {
    const data = await tmdbGet('/discover/movie', {
      with_companies: companyId,
      with_original_language: 'en',
      sort_by: 'popularity.desc',
      include_adult: false,
      page
    });
    return (data.results || []).filter(isEnglishOrigin);
  });
}

function getSeriesDetails(id) {
  return remember(dataCache, `series-details:${id}`, () =>
    tmdbGet(`/tv/${id}`, { append_to_response: 'external_ids' })
  );
}

function getSeason(id, seasonNumber) {
  return remember(dataCache, `season:${id}:${seasonNumber}`, () =>
    tmdbGet(`/tv/${id}/season/${seasonNumber}`)
  );
}

function getMovieDetails(id) {
  return remember(dataCache, `movie-details:${id}`, () =>
    tmdbGet(`/movie/${id}`, { append_to_response: 'external_ids' })
  );
}

function imageUrl(path, size = 'w500') {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}

module.exports = {
  resolveNetworkId,
  resolveCompanyId,
  discoverSeries,
  discoverMovies,
  getSeriesDetails,
  getSeason,
  getMovieDetails,
  imageUrl,
  isEnglishOrigin
};
