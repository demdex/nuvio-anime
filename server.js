'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

/* ------------------------------------------------------------------ *
 * Anime (AniList-driven) modules — unchanged from nuvio-anime-addon.  *
 * ------------------------------------------------------------------ */
const animeConfig = require('./src/anime/config');
const animeCatalogs = require('./src/anime/catalogs');
const anilist = require('./src/anime/anilist');
const lists = require('./src/anime/lists');
const jikan = require('./src/anime/jikan');
const source = require('./src/anime/source');
const kitsu = require('./src/anime/kitsu');
const animeMeta = require('./src/anime/meta');
const mapper = require('./src/anime/mapper');
const animeCache = require('./src/anime/cache');

/* ------------------------------------------------------------------ *
 * Kids (TMDB brand-driven) modules — unchanged from nuvio-jr-addon.   *
 * ------------------------------------------------------------------ */
const kidsCatalogs = require('./src/kids/catalogs');
const kidsMeta = require('./src/kids/meta');

/* ------------------------------------------------------------------ *
 * Shared — one plugins module reports scraper-repo status for both.  *
 * (This is the anime addon's richer version; it also flags which      *
 * scrapers look anime-capable, which is still useful info here.)      *
 * ------------------------------------------------------------------ */
const plugins = require('./src/anime/plugins');

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
 *                                                                      *
 * One manifest, one install URL. Anime catalogues respect the same     *
 * per-user config segment the anime addon always used (AniList user,   *
 * MAL user, TMDB key, enabledCatalogs, etc). Kids catalogues carry no   *
 * config of their own and always appear, unaffected by enabledCatalogs *
 * — they're a fixed set of four brands, always on.                     *
 * ------------------------------------------------------------------ */

function catalogEntry(c) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    extra: c.extra,
    extraSupported: c.extra.map((e) => e.name),
  };
}

function buildManifest(cfg, baseUrl) {
  const wantedAnime = cfg.enabledCatalogs.length
    ? animeCatalogs.CATALOGS.filter((c) => cfg.enabledCatalogs.includes(c.id))
    : animeCatalogs.CATALOGS;

  const catalogs = [
    ...wantedAnime.map(catalogEntry),
    ...kidsCatalogs.CATALOGS.map(catalogEntry),
  ];

  return {
    id: 'community.nuvio.animekids',
    version: VERSION,
    name: 'Nuvio Anime & Kids',
    description:
      'Anime catalogues driven by the AniList airing schedule (recently aired, latest episodes, ' +
      'airing today, trending, seasonal, your own watch list) plus always-on preschool & kids ' +
      'catalogues from PBS Kids, Disney Junior, Nick Jr. and CBeebies. Every entry carries an ' +
      'IMDb or TMDB ID so Nuvio local scrapers can resolve streams.',
    // Served from this addon so the manifest never depends on someone else's CDN.
    logo: `${baseUrl}/logo.svg`,
    background: `${baseUrl}/background.svg`,
    catalogs,
    resources: [
      { name: 'catalog', types: ['series', 'movie'] },
      // Anime meta is claimed for its own AniList-native ID namespaces. Kids
      // meta is claimed for tmdb: (the Jr addon already did this on its own —
      // merging doesn't add any new competing-addon exposure). For a tmdb:
      // request, the handler below tries the anime reverse-mapping first
      // (covers anime titles that happen to carry a TMDB id) before falling
      // back to the plain TMDB meta builder the kids catalogues use.
      { name: 'meta', types: ['series', 'movie'], idPrefixes: ['anilist:', 'mal:', 'kitsu:', 'tmdb:'] },
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
  const cfg = animeConfig.parse(req.params.config);
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json(buildManifest(cfg, baseUrlOf(req)));
}

async function catalogHandler(req, res) {
  const { type, id } = req.params;
  const extra = parseExtra(req.params.extra, req.query);

  const animeDef = animeCatalogs.BY_ID.get(id);
  if (animeDef && animeDef.type === type) {
    const cfg = animeConfig.parse(req.params.config);
    try {
      const metas = await animeCatalogs.fetchCatalog(id, {
        cfg,
        skip: Number(extra.skip) || 0,
        genre: extra.genre || null,
        search: extra.search || null,
      });

      if (animeDef.requiresUser && !cfg.hasUser) {
        console.warn(`[catalog] ${id} needs an AniList username; returning empty row`);
      }

      // Personal rows go stale fast; schedule rows are fine for a few minutes.
      const maxAge = animeDef.requiresUser ? 60 : id === 'last-hour' ? 120 : 300;
      res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=600`);
      return res.json({ metas: metas || [] });
    } catch (err) {
      console.error(`[catalog] ${id} failed:`, err.message);
      // An error object would make Nuvio show a broken row; an empty row is quieter.
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ metas: [] });
    }
  }

  const kidsBrand = kidsCatalogs.BRAND_BY_ID.get(id);
  if (kidsBrand && (type === 'series' || type === 'movie')) {
    try {
      const items = await kidsCatalogs.fetchCatalog(type, id, extra);
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600');
      return res.json({ metas: items || [] });
    } catch (err) {
      console.error(`[catalog] kids ${id} failed:`, err.message);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ metas: [] });
    }
  }

  return res.status(404).json({ metas: [], err: 'Unknown catalogue' });
}

async function metaHandler(req, res) {
  const { type, id } = req.params;

  try {
    if (id.startsWith('anilist:') || id.startsWith('mal:') || id.startsWith('kitsu:')) {
      const cfg = animeConfig.parse(req.params.config);
      await mapper.load();
      const media = await animeMeta.resolveMedia(id);
      if (!media) return res.status(404).json({ meta: null, err: 'Not found' });

      const meta = await animeMeta.toFullMeta(media, cfg, id);
      meta.type = type;
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
      return res.json({ meta });
    }

    if (id.startsWith('tmdb:')) {
      // Anime titles sometimes carry a TMDB id too (the offline mapping goes
      // both ways). Try that first so an anime row's meta page still gets
      // AniList-quality data (studio, correct season/episode numbering, the
      // AniList link) instead of the plain TMDB shape.
      const cfg = animeConfig.parse(req.params.config);
      await mapper.load();
      const media = await animeMeta.resolveMedia(id);
      if (media) {
        const meta = await animeMeta.toFullMeta(media, cfg, id);
        meta.type = type;
        res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
        return res.json({ meta });
      }

      // Not anime — fall through to the kids/general TMDB meta builder.
      const tmdbId = id.split(':')[1];
      if (type !== 'series' && type !== 'movie') {
        return res.status(404).json({ meta: null, err: 'unknown type' });
      }
      const item = type === 'series' ? await kidsMeta.seriesMeta(tmdbId) : await kidsMeta.movieMeta(tmdbId);
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
      return res.json({ meta: item });
    }

    return res.status(404).json({ meta: null, err: 'Unknown id namespace' });
  } catch (err) {
    console.error(`[meta] ${id} failed:`, err.message);
    return res.status(500).json({ meta: null, err: 'Lookup failed' });
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

/** Which scrapers the companion repositories offer — used by both catalogue families. */
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
 * actually happened. Covers the anime sources; kids catalogues only need one
 * thing (a working TMDB_API_KEY), which /health also reports.
 */
async function diagnoseHandler(req, res) {
  const cfg = animeConfig.parse(req.params ? req.params.config : null);
  const configured = Boolean(req.params && req.params.config);
  const checks = [];

  // Settings live inside the URL, so the first thing worth confirming is
  // whether this request even carried any. A bare /diagnose reports on the
  // bare install and says nothing about a configured one.
  checks.push({
    name: 'Settings',
    ok: true,
    detail: configured
      ? describeConfig(cfg)
      : 'none in this URL — add your config segment: /<segment>/diagnose',
  });

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
    // Record the failure, not just report it. Otherwise the checks below can
    // say AniList is broken while activeSource() still claims it is serving.
    source.markDown(err);
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
    // Record it, so activeSource() below reflects what would really happen.
    source.markSourceDown('myanimelist', err);
    checks.push({
      name: 'MyAnimeList fallback',
      ok: false,
      detail: err.message,
      advice: anilistOk
        ? undefined
        : 'AniList is down too — Kitsu is carrying the catalogues.',
    });
  }

  try {
    const alive = await kitsu.ping();
    checks.push({
      name: 'Kitsu fallback',
      ok: alive,
      detail: alive ? 'reachable and on standby' : 'responded but returned nothing',
    });
  } catch (err) {
    source.markSourceDown('kitsu', err);
    checks.push({ name: 'Kitsu fallback', ok: false, detail: err.message });
  }

  // Actually fetch the list rather than merely confirming a username exists.
  // "A username is set" and "the list loads" are different facts, and only
  // the second one explains an empty row.
  if (!cfg.hasUser) {
    checks.push({
      name: 'Watch list',
      ok: true,
      detail: configured
        ? 'no username set — Continue Watching, New Episode Available and Recommended For You will be empty'
        : 'not checked (no settings in this URL)',
    });
  } else {
    const tracker = lists.source(cfg);
    try {
      const entries = await lists.watchlist(cfg, ['CURRENT', 'REPEATING'], 0);
      const withMedia = entries.filter((e) => e && e.media).length;
      checks.push({
        name: 'Watch list',
        ok: withMedia > 0,
        detail:
          withMedia > 0
            ? `${withMedia} in-progress title(s) from ${tracker}`
            : `${tracker} returned no in-progress titles`,
        advice:
          withMedia > 0
            ? undefined
            : tracker === 'mal'
              ? 'Check the username spelling, that the list has titles set to "Watching", and that the list is public (Profile → Settings → List visibility).'
              : 'Check the username spelling and that titles are set to "Watching". Private AniList lists need a token.',
      });
    } catch (err) {
      checks.push({
        name: 'Watch list',
        ok: false,
        detail: `${tracker}: ${err.message}`,
        advice: /504|502|rate limit/i.test(err.message)
          ? 'This is the Jikan outage. A MAL client ID routes the read through MAL\'s own API instead.'
          : undefined,
      });
    }
  }

  // Kids catalogues have exactly one dependency: a working TMDB key.
  checks.push({
    name: 'Kids catalogues (TMDB_API_KEY)',
    ok: Boolean(process.env.TMDB_API_KEY),
    detail: process.env.TMDB_API_KEY
      ? 'set — PBS Kids, Disney Junior, Nick Jr. and CBeebies rows should populate'
      : 'not set on this server — those four rows will error out. Set TMDB_API_KEY in the environment.',
  });

  const failed = checks.filter((c) => !c.ok);
  const active = source.activeSource();

  // A failing source is only an outage if no source is left standing. Saying
  // "2 checks failing" when catalogues are serving fine is alarming and wrong.
  let summary;
  if (!failed.length) summary = 'Everything checks out.';
  else if (active === 'none') summary = 'No catalogue source is reachable. Cached rows only.';
  else if (active === 'anilist') summary = `Catalogues are fine. ${failed.length} standby source(s) unavailable.`;
  else summary = `AniList is unavailable; catalogues are serving from ${active}.`;

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: active !== 'none',
    allChecksPassed: failed.length === 0,
    summary,
    servingFrom: active,
    checks,
  });
}

/** Describe settings without ever echoing a credential back. */
function describeConfig(cfg) {
  const parts = [];
  if (cfg.anilistUser) parts.push(`AniList user "${cfg.anilistUser}"`);
  if (cfg.anilistToken) parts.push('AniList token set');
  if (cfg.malUser) parts.push(`MAL user "${cfg.malUser}"`);
  parts.push(cfg.malClientId ? 'MAL client ID set' : 'no MAL client ID');
  if (cfg.tmdbApiKey) parts.push('TMDB key set (per-user fallback lookups)');
  parts.push(`list source: ${cfg.listSource}`);
  if (!cfg.anilistUser && !cfg.anilistToken && !cfg.malUser) {
    parts.push('NO USERNAME — a client ID alone cannot identify whose list to read');
  }
  return parts.join(' · ');
}

app.get(new RegExp(`^\\/${CONFIG_SEGMENT}diagnose$`), named(['config'], diagnoseHandler));

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    mapping: mapper.status(),
    source: source.status(),
    animeCache: animeCache.stats(),
    kidsTmdbConfigured: Boolean(process.env.TMDB_API_KEY),
    uptime: Math.round(process.uptime()),
  });
});

app.use((req, res) => res.status(404).json({ err: 'Not found' }));

/* ------------------------------------------------------------------ *
 * Start                                                               *
 * ------------------------------------------------------------------ */

if (require.main === module) {
  if (!process.env.TMDB_API_KEY) {
    console.warn(
      '\n⚠  TMDB_API_KEY is not set — the four Nuvio Jr kids catalogues (PBS Kids, Disney ' +
      'Junior, Nick Jr., CBeebies) will error out until it is. Copy .env.example to .env and ' +
      'add a free TMDB v3 key. Anime catalogues are unaffected.\n'
    );
  }

  // Warm the mapping so the first catalogue request is not the one that waits.
  mapper.load().then(() => {
    const status = mapper.status();
    console.log(`[mapper] ${status.anilistIds} AniList IDs mapped`);
  });

  app.listen(PORT, () => {
    console.log(`Nuvio Anime & Kids addon on http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Configure at http://127.0.0.1:${PORT}/configure`);
  });
}

module.exports = app;
