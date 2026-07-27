'use strict';

const cache = require('./cache');

/**
 * The two scraper repositories this addon is built to sit alongside.
 *
 * Nuvio keeps two separate systems: Stremio-protocol addons (this project,
 * which supplies catalogues and metadata) and local scrapers (JavaScript
 * providers that resolve the actual video). They are installed in different
 * screens and neither can install the other, so what this module does is
 * report on the repositories, flag which of their scrapers handle anime, and
 * warn when an enabled scraper needs an ID this addon cannot supply.
 */

const REPOSITORIES = [
  {
    key: 'yoru',
    name: "Yoru's Repo",
    url: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json',
    // Nuvio's Plugins screen wants the repository root, not the manifest file.
    root: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main',
  },
  {
    key: 'allinone',
    name: 'All-in-One-Nuvio',
    url: 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json',
    root: 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main',
  },
];

/** Scrapers in those repositories that actually deal in anime. */
const ANIME_SCRAPER_IDS = new Set([
  'allanime',
  'anidb',
  'anikototv',
  'animekai',
  'animepahe',
  'animesalt',
  'animetsu',
  'animeworld',
  'anime-sama',
  'allwish',
  'hianime',
  'kurage',
  'onetouchtv',
  'vidnest-anime',
  'fibwatch',
  'mycima',
]);

const ANIME_KEYWORDS = /(anime|manga|otaku|kdrama|asian drama)/i;

function looksAnime(scraper) {
  if (ANIME_SCRAPER_IDS.has(scraper.id)) return true;
  const haystack = `${scraper.name} ${scraper.description || ''}`;
  return ANIME_KEYWORDS.test(haystack);
}

async function fetchRepository(repo) {
  const res = await fetch(repo.url, { headers: { 'user-agent': 'nuvio-anime-addon' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const manifest = await res.json();
  const scrapers = Array.isArray(manifest.scrapers) ? manifest.scrapers : [];
  return {
    ...repo,
    manifestName: manifest.name || repo.name,
    version: manifest.version || null,
    total: scrapers.length,
    anime: scrapers
      .filter(looksAnime)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        enabledByDefault: s.enabled !== false,
        limited: Boolean(s.limited),
        languages: s.contentLanguage || [],
        formats: s.formats || s.supportedFormats || [],
        logo: s.logo || null,
      })),
    reachable: true,
  };
}

/** Both repositories, with their anime scrapers listed. Cached for an hour. */
async function status() {
  return cache.wrap('plugins:status', 3600, async () => {
    const results = await Promise.all(
      REPOSITORIES.map(async (repo) => {
        try {
          return await fetchRepository(repo);
        } catch (err) {
          return { ...repo, reachable: false, error: err.message, total: 0, anime: [] };
        }
      })
    );
    return {
      repositories: results,
      animeScraperCount: results.reduce((sum, r) => sum + r.anime.length, 0),
      checkedAt: new Date().toISOString(),
    };
  });
}

module.exports = { REPOSITORIES, ANIME_SCRAPER_IDS, status };
