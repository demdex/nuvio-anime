'use strict';

const path = require('path');
const express = require('express');

const config = require('./src/config');
const catalogs = require('./src/catalogs');
const anilist = require('./src/anilist');
const lists = require('./src/lists');
const jikan = require('./src/jikan');
const source = require('./src/source');
const metaBuilder = require('./src/meta');
const mapper = require('./src/mapper');
const plugins = require('./src/plugins');
const cache = require('./src/cache');

const app = express();
const PORT = process.env.PORT || 7000;
const VERSION = require('./package.json').version;

app.disable('x-powered-by');
app.set('trust proxy', true);

// Addon clients fetch cross-origin; the protocol expects wide-open CORS.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ------------------------------------------------------------------ *
 * Manifest                                                            *
 * ------------------------------------------------------------------ */

function buildManifest(cfg, baseUrl) {
  const wanted = cfg.enabledCatalogs.length
    ? catalogs.CATALOGS.filter((c) => cfg.enabledCatalogs.includes(c.id))
    : catalogs.CATALOGS;

  return {
    id: 'community.nuvio.anime',
    version: VERSION,
    name: 'Nuvio Anime',
    description:
      'Anime catalogues driven by the AniList airing schedule — recently aired, latest episodes, ' +
      'airing today, trending, seasonal and your own watch list. Every entry carries an IMDb or ' +
      'TMDB ID so Nuvio local scrapers can resolve streams.',
    // Served from this addon so the manifest never depends on someone else's CDN.
    logo: `${baseUrl}/logo.svg`,
    background: `${baseUrl}/background.svg`,
    catalogs: wanted.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      extra: c.extra,
      extraSupported: c.extra.map((e) => e.name),
    })),
    resources: [
      { name: 'catalog', types: ['series', 'movie'] },
      // Titles that map to IMDb or TMDB are left to Cinemeta and Nuvio's own
      // TMDB integration, which already model seasons correctly. Only the
      // AniList-native IDs need metadata from here.
      { name: 'meta', types: ['series', 'movie'], idPrefixes: ['anilist:', 'mal:', 'kitsu:'] },
    ],
    types: ['series', 'movie'],
    idPrefixes: ['tt', 'tmdb:', 'anilist:', 'mal:', 'kitsu:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      configurationURL: `${baseUrl}/configure`,
    },
    contactEmail: process.env.CONTACT_EMAIL || undefined,
  };
}

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

/* ------------------------------------------------------------------ *
 * Extra-argument parsing                                              *
 * ------------------------------------------------------------------ */

/** Stremio passes extras as `key=value&key=value` inside the path. */
function parseExtra(segment, query) {
  const out = {};
  if (segment) {
    for (const pair of decodeURIComponent(segment).split('&')) {
      const index = pair.indexOf('=');
      if (index === -1) continue;
      out[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
    }
  }
  for (const [key, value] of Object.entries(query || {})) {
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Handlers                                                            *
 * ------------------------------------------------------------------ */

async function manifestHandler(req, res) {
  const cfg = config.parse(req.params.config);
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json(buildManifest(cfg, baseUrlOf(req)));
}

async function catalogHandler(req, res) {
  const cfg = config.parse(req.params.config);
  const { type, id } = req.params;
  const extra = parseExtra(req.params.extra, req.query);

  const definition = catalogs.BY_ID.get(id);
  if (!definition || definition.type !== type) {
    return res.status(404).json({ metas: [], err: 'Unknown catalogue' });
  }

  try {
    const metas = await catalogs.fetchCatalog(id, {
      cfg,
      skip: Number(extra.skip) || 0,
      genre: extra.genre || null,
      search: extra.search || null,
    });

    if (definition.requiresUser && !cfg.hasUser) {
      console.warn(`[catalog] ${id} needs an AniList username; returning empty row`);
    }

    // Personal rows go stale fast; schedule rows are fine for a few minutes.
    const maxAge = definition.requiresUser ? 60 : id === 'last-hour' ? 120 : 300;
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=600`);
    res.json({ metas: metas || [] });
  } catch (err) {
    console.error(`[catalog] ${id} failed:`, err.message);
    // An error object would make Nuvio show a broken row; an empty row is quieter.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ metas: [] });
  }
}

async function metaHandler(req, res) {
  const cfg = config.parse(req.params.config);
  const { type, id } = req.params;

  try {
    await mapper.load();
    const media = await metaBuilder.resolveMedia(id);
    if (!media) return res.status(404).json({ meta: null, err: 'Not found' });

    const meta = await metaBuilder.toFullMeta(media, cfg, id);
    meta.type = type;
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
    res.json({ meta });
  } catch (err) {
    console.error(`[meta] ${id} failed:`, err.message);
    res.status(500).json({ meta: null, err: 'Lookup failed' });
  }
}

/* ------------------------------------------------------------------ *
 * Routes                                                              *
 * ------------------------------------------------------------------ */

/**
 * Routes are written as explicit regexes rather than `/catalog/:type/:id.json`
 * strings: catalogue IDs and extra arguments contain colons, dots, equals signs
 * and ampersands, which the path-string parser splits in surprising places.
 */
const CONFIG_SEGMENT = '(?:([A-Za-z0-9_=-]+)\\/)?';

function named(names, handler) {
  return (req, res) => {
    const params = {};
    names.forEach((name, index) => {
      const value = req.params[index];
      params[name] = value === undefined ? undefined : safeDecode(value);
    });
    req.params = params;
    return handler(req, res);
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

app.get(
  new RegExp(`^\\/${CONFIG_SEGMENT}manifest\\.json$`),
  named(['config'], manifestHandler)
);

app.get(
  new RegExp(`^\\/${CONFIG_SEGMENT}catalog\\/([^\\/]+)\\/([^\\/]+?)(?:\\/(.+?))?\\.json$`),
  named(['config', 'type', 'id', 'extra'], catalogHandler)
);

app.get(
  new RegExp(`^\\/${CONFIG_SEGMENT}meta\\/([^\\/]+)\\/(.+?)\\.json$`),
  named(['config', 'type', 'id'], metaHandler)
);

app.get(new RegExp(`^\\/${CONFIG_SEGMENT}configure\\/?$`), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/', (req, res) => res.redirect('/configure'));

/** Which scrapers the companion repositories offer for anime. */
app.get('/plugins.json', async (req, res) => {
  try {
    const data = await plugins.status();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Plain-language diagnosis.
 *
 * Catalogue handlers deliberately return an empty row rather than an error,
 * so Nuvio shows a quiet gap instead of a broken shelf. The cost is that a
 * total outage and an ordinary quiet hour look identical from the outside.
 * This endpoint pays that cost back: it runs the real calls and reports what
 * actually happened.
 */
app.get('/diagnose', async (req, res) => {
  const checks = [];

  await mapper.load();
  const mapping = mapper.status();
  checks.push({
    name: 'ID mapping',
    ok: mapping.usable,
    detail: mapping.usable
      ? `${mapping.anilistIds} AniList IDs loaded from the ${mapping.origin} copy`
      : `unusable — ${mapping.lastError || 'not loaded'}`,
  });

  let anilistOk = false;
  try {
    const list = await anilist.media(
      { page: 1, perPage: 5, sort: ['TRENDING_DESC'], format_in: ['TV'] },
      0
    );
    anilistOk = list.length > 0;
    checks.push({
      name: 'AniList API',
      ok: anilistOk,
      detail: anilistOk ? `returned ${list.length} titles` : 'responded but returned nothing',
    });
  } catch (err) {
    // The two kinds of 403 need opposite responses from the operator, so say
    // which one this is rather than leaving them to guess.
    const advice =
      err.kind === 'api-disabled'
        ? 'AniList has disabled its API site-wide. This affects every app using it and resolves on their side — nothing to fix here. Cached rows keep serving in the meantime.'
        : err.kind === 'ip-blocked'
          ? "AniList has blocked this server's IP address. Shared hosts pool IPs across many projects, so this may not be caused by your own traffic. A host with a dedicated IP is the fix."
          : null;
    checks.push({
      name: 'AniList API',
      ok: false,
      detail: err.message,
      kind: err.kind || 'error',
      advice: advice || undefined,
    });
  }

  // The standby only matters when the primary is failing, but knowing whether
  // it is reachable *before* that happens is the point of checking it.
  try {
    const alive = await jikan.ping();
    checks.push({
      name: 'MyAnimeList fallback',
      ok: alive,
      detail: alive
        ? anilistOk
          ? 'reachable and on standby'
          : 'reachable — serving catalogues while AniList is unavailable'
        : 'responded but returned nothing',
    });
  } catch (err) {
    checks.push({
      name: 'MyAnimeList fallback',
      ok: false,
      detail: err.message,
      advice: anilistOk ? undefined : 'Both sources are unavailable; catalogues will serve cached rows only.',
    });
  }

  const cfg = config.parse(null);
  checks.push({
    name: 'Watch list',
    ok: true,
    detail: cfg.hasUser
      ? `configured via ${lists.source(cfg)}`
      : 'no username set — the three personal rows will be empty (this is normal for the bare URL)',
  });

  const failed = checks.filter((c) => !c.ok);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: failed.length === 0,
    summary: failed.length === 0 ? 'Everything checks out.' : `${failed.length} check(s) failing.`,
    servingFrom: source.status().active,
    checks,
  });
});

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    mapping: mapper.status(),
    source: source.status(),
    cache: cache.stats(),
    uptime: Math.round(process.uptime()),
  });
});

app.use((req, res) => res.status(404).json({ err: 'Not found' }));

/* ------------------------------------------------------------------ *
 * Start                                                               *
 * ------------------------------------------------------------------ */

if (require.main === module) {
  // Warm the mapping so the first catalogue request is not the one that waits.
  mapper.load().then(() => {
    const status = mapper.status();
    console.log(`[mapper] ${status.anilistIds} AniList IDs mapped`);
  });

  app.listen(PORT, () => {
    console.log(`Nuvio Anime addon on http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Configure at http://127.0.0.1:${PORT}/configure`);
  });
}

module.exports = app;
