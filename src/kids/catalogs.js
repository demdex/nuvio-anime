'use strict';

const tmdb = require('./tmdb');
const meta = require('./meta');
const { BRANDS } = require('./config');

const PAGE_SIZE = 20; // TMDB discover pages are 20 items each

const CATALOGS = [];
for (const brand of BRANDS) {
  CATALOGS.push({ id: brand.id, type: 'series', name: brand.name, extra: [{ name: 'skip' }] });
  CATALOGS.push({ id: brand.id, type: 'movie', name: brand.name, extra: [{ name: 'skip' }] });
}

const BRAND_BY_ID = new Map(BRANDS.map(b => [b.id, b]));

async function fetchCatalog(type, catalogId, extra = {}) {
  const brand = BRAND_BY_ID.get(catalogId);
  if (!brand) return null;
  if (type !== 'series' && type !== 'movie') return null;

  const skip = Number(extra.skip) || 0;
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  const items = type === 'series'
    ? await tmdb.discoverSeries(brand, { page })
    : await tmdb.discoverMovies(brand, { page });

  return meta.filterPreviews(items, type);
}

module.exports = { CATALOGS, fetchCatalog, BRAND_BY_ID };
