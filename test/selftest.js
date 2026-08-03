'use strict';

/**
 * Offline self-test.
 *
 * Stubs AniList, TMDB and GitHub so the whole request path can be checked
 * without touching the network: routing, extra-argument parsing, ID mapping,
 * season/episode conversion and the shape of every JSON response.
 *
 * Run with: npm run selftest
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAPPING_FILE = path.join(__dirname, '..', 'data', 'mapping.json');

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

if (!fs.existsSync(MAPPING_FILE)) {
  console.error(`Missing bundled mapping at ${MAPPING_FILE}.`);
  console.error('Build it with: npm run build:mapping');
  process.exit(1);
}

// Re-expand the bundled positional rows into the upstream field names the
// fixtures below are written against.
const bundled = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
const mappingRows = bundled.rows.map((r) => ({
  anilist_id: r[0],
  mal_id: r[1],
  imdb_id: r[2],
  themoviedb_id: { tv: r[3], movie: r[4] ? [r[4]] : undefined },
  season: r[5] != null ? { tmdb: r[5] } : null,
  episode_offset: { tmdb: r[6] },
  kitsu_id: r[7],
}));

/** Three real entries: one plain series, one later season, one film. */
const seriesRow = mappingRows.find(
  (r) => r.anilist_id && r.mal_id && r.kitsu_id && r.imdb_id && r.themoviedb_id && r.themoviedb_id.tv &&
    r.season && r.season.tmdb === 1
);
const sequelRow = mappingRows.find(
  (r) => r.anilist_id && r.themoviedb_id && r.themoviedb_id.tv && r.season && r.season.tmdb >= 2
);
const movieRow = mappingRows.find(
  (r) => r.anilist_id && r.imdb_id && r.themoviedb_id && r.themoviedb_id.movie
);

assert.ok(seriesRow && sequelRow && movieRow, 'fixture rows found in mapping');
assert.ok(Array.isArray(mappingRows) && mappingRows.length > 1000, 'mapping cache looks intact');

function makeMedia(row, overrides) {
  return Object.assign(
    {
      id: row.anilist_id,
      idMal: row.mal_id,
      title: { romaji: `Fixture ${row.anilist_id}`, english: `Fixture EN ${row.anilist_id}`, native: 'フィクスチャ' },
      description: 'A <br>test<br> synopsis.',
      coverImage: { extraLarge: 'https://example.invalid/cover.jpg', large: 'https://example.invalid/c.jpg' },
      bannerImage: 'https://example.invalid/banner.jpg',
      format: row.themoviedb_id && row.themoviedb_id.movie ? 'MOVIE' : 'TV',
      status: 'RELEASING',
      episodes: 12,
      duration: 24,
      genres: ['Action', 'Adventure'],
      averageScore: 84,
      popularity: 120000,
      favourites: 900,
      season: 'SUMMER',
      seasonYear: 2026,
      countryOfOrigin: 'JP',
      isAdult: false,
      siteUrl: 'https://anilist.co/anime/1',
      startDate: { year: 2026, month: 7, day: 5 },
      endDate: { year: null, month: null, day: null },
      studios: { nodes: [{ name: 'Fixture Studio' }] },
      nextAiringEpisode: { episode: 6, airingAt: Math.floor(Date.now() / 1000) + 3600, timeUntilAiring: 3600 },
    },
    overrides
  );
}

const SERIES = makeMedia(seriesRow);
const SEQUEL = makeMedia(sequelRow, { format: 'TV' });
const MOVIE = makeMedia(movieRow, { format: 'MOVIE', episodes: 1, nextAiringEpisode: null });
const ADULT = makeMedia(seriesRow, { id: 999999, isAdult: true, title: { romaji: 'Adult Fixture' } });
const UNMAPPED = makeMedia({ anilist_id: 987654321, mal_id: null }, { format: 'TV' });

const now = Math.floor(Date.now() / 1000);

function schedule() {
  return [
    { id: 1, episode: 5, airingAt: now - 600, media: SERIES },
    { id: 2, episode: 14, airingAt: now - 4000, media: SEQUEL },
    { id: 3, episode: 6, airingAt: now - 90000, media: SERIES },
    { id: 4, episode: 2, airingAt: now - 200000, media: UNMAPPED },
    { id: 5, episode: 3, airingAt: now - 300, media: ADULT },
    { id: 6, episode: 9, airingAt: now + 7200, media: SEQUEL },
  ];
}

const REPO_MANIFEST = {
  name: 'Fixture Repo',
  version: '1.0.0',
  scrapers: [
    { id: 'animepahe', name: 'AnimePahe', description: 'Anime', enabled: true, contentLanguage: ['en'] },
    { id: 'hianime', name: 'HiAnime', description: 'Anime streaming', enabled: true, limited: true },
    { id: 'uhdmovies', name: 'UHDMovies', description: 'Movies', enabled: true },
  ],
};

/* ------------------------------------------------------------------ *
 * Network stub                                                        *
 * ------------------------------------------------------------------ */

const calls = { anilist: 0, tmdb: 0, github: 0, mal: 0, jikan: 0, jikanCatalog: 0, kitsu: 0 };

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

global.fetch = async (url, options) => {
  const href = typeof url === 'string' ? url : url.toString();

  if (href.includes('graphql.anilist.co')) {
    calls.anilist++;
    if (global.__ANILIST_DOWN__) {
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({
          errors: [{ message: 'The AniList API has been temporarily disabled due to severe stability issues.', status: 403 }],
          data: null,
        }),
        text: async () => '{}',
      };
    }
    const query = JSON.parse(options.body).query;

    if (query.includes('airingSchedules')) {
      return jsonResponse({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: schedule() } } });
    }
    if (query.includes('MediaListCollection')) {
      return jsonResponse({
        data: {
          MediaListCollection: {
            lists: [
              {
                status: 'CURRENT',
                entries: [
                  { id: 1, progress: 3, updatedAt: now - 100, score: 9, status: 'CURRENT', media: SERIES },
                  { id: 2, progress: 14, updatedAt: now - 500, score: 8, status: 'CURRENT', media: SEQUEL },
                ],
              },
            ],
          },
        },
      });
    }
    if (query.includes('recommendations(')) {
      return jsonResponse({
        data: {
          Page: {
            media: [
              { id: SERIES.id, recommendations: { nodes: [{ rating: 40, mediaRecommendation: MOVIE }] } },
            ],
          },
        },
      });
    }
    if (query.includes('media(id_in: $ids')) {
      return jsonResponse({ data: { Page: { media: [SERIES] } } });
    }
    if (query.includes('Media(id: $id')) {
      return jsonResponse({
        data: {
          Media: Object.assign({}, SERIES, {
            relations: { edges: [] },
            airingSchedule: { nodes: [{ episode: 1, airingAt: now - 600000 }, { episode: 2, airingAt: now - 500000 }] },
          }),
        },
      });
    }
    return jsonResponse({
      data: { Page: { pageInfo: { hasNextPage: true }, media: [SERIES, SEQUEL, MOVIE, ADULT, UNMAPPED] } },
    });
  }

  if (href.includes('api.themoviedb.org')) {
    calls.tmdb++;
    if (href.includes('/search/')) {
      return jsonResponse({
        results: [
          { id: 4242, name: 'Fixture Show', title: 'Fixture Show', original_language: 'ja' },
        ],
      });
    }
    if (href.includes('/external_ids')) {
      return jsonResponse({ imdb_id: 'tt7654321' });
    }
    return jsonResponse({ episodes: [{ episode_number: 1, name: 'Pilot', still_path: '/x.jpg', air_date: '2026-07-05' }] });
  }

  if (href.includes('api.myanimelist.net')) {
    calls.mal++;
    return jsonResponse({
      data: [
        { node: { id: seriesRow.mal_id, title: 'Fixture' },
          list_status: { status: 'watching', score: 9, num_episodes_watched: 3, updated_at: '2026-07-20T10:00:00+00:00' } },
        { node: { id: 424242, title: 'Unmapped Fixture' },
          list_status: { status: 'watching', score: 7, num_episodes_watched: 1, updated_at: '2026-07-19T10:00:00+00:00' } },
      ],
      paging: {},
    });
  }

  if (href.includes('api.jikan.moe') && !href.includes('/animelist')) {
    calls.jikanCatalog++;
    if (global.__JIKAN_DOWN__) {
      return { ok: false, status: 504, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    }
    const jikanAnime = (malId, title, type) => ({
      mal_id: malId,
      url: 'https://myanimelist.net/anime/' + malId,
      images: { jpg: { image_url: 'i.jpg', large_image_url: 'l.jpg' } },
      title,
      title_english: title + ' EN',
      title_japanese: 'JP',
      type: type || 'TV',
      episodes: 12,
      status: 'Currently Airing',
      score: 8.2,
      members: 90000,
      synopsis: 'Standby synopsis.',
      genres: [{ name: 'Action' }],
      studios: [{ name: 'Standby Studio' }],
      aired: { from: '2026-07-05T00:00:00+00:00' },
      season: 'summer',
      year: 2026,
      rating: 'PG-13',
    });
    const rows = [jikanAnime(seriesRow.mal_id, 'Standby Show'), jikanAnime(777777, 'Unmapped Standby')];
    if (href.includes('/watch/episodes')) {
      return jsonResponse({ data: rows.map((r) => ({ entry: r, episodes: [{ mal_id: 7 }] })) });
    }
    if (href.includes('/recommendations/anime')) {
      return jsonResponse({ data: [{ entry: rows }] });
    }
    return jsonResponse({ data: rows, pagination: { has_next_page: false } });
  }

  if (href.includes('api.jikan.moe')) {
    calls.jikan++;
    return jsonResponse({
      data: [
        { entry: { mal_id: seriesRow.mal_id, title: 'Fixture' }, watching_status: 1, score: 8, episodes_watched: 5 },
      ],
      pagination: { has_next_page: false },
    });
  }

  if (href.includes('anime-lists')) {
    // The mapping must come from the bundled file, never the network. If this
    // fires, the bundled copy is missing and the addon would be degraded.
    throw new Error('bundled mapping missing; run npm run build:mapping');
  }

  if (href.includes('kitsu.app') || href.includes('kitsu.io')) {
    calls.kitsu++;
    if (global.__KITSU_DOWN__) throw new Error('fetch failed');
    const rec = (id, kitsuId, title, subtype) => ({
      id: String(kitsuId),
      attributes: {
        canonicalTitle: title,
        titles: { en_jp: title, en: title + ' EN', ja_jp: 'JP' },
        synopsis: 'Kitsu synopsis.',
        posterImage: { original: 'p.jpg', large: 'pl.jpg' },
        coverImage: { original: 'c.jpg' },
        subtype: subtype || 'TV',
        status: 'current',
        episodeCount: 12,
        averageRating: '81.5',
        userCount: 40000,
        startDate: '2026-07-05',
        ageRating: 'PG',
        slug: 'kitsu-show',
      },
    });
    if (href.includes('filter%5Bid%5D') || href.includes('filter[id]')) {
      // Echo back the ids that were asked for, so hydration can match them.
      const raw = decodeURIComponent(href).split('filter[id]=')[1] || '';
      const ids = raw.split('&')[0].split(',').filter(Boolean);
      return jsonResponse({ data: ids.map((id, i) => rec(i, Number(id), 'Kitsu Hydrated')) });
    }
    return jsonResponse({
      data: [rec(1, seriesRow.kitsu_id || 1, 'Kitsu Show'), rec(2, 888888, 'Unmapped Kitsu')],
    });
  }

  if (href.includes('raw.githubusercontent.com')) {
    calls.github++;
    return jsonResponse(REPO_MANIFEST);
  }

  throw new Error(`unexpected fetch: ${href}`);
};

/* ------------------------------------------------------------------ *
 * Harness                                                             *
 * ------------------------------------------------------------------ */

const app = require('../server');
const configLib = require('../src/anime/config');
const mapper = require('../src/anime/mapper');

let failures = 0;
let passes = 0;

function check(label, fn) {
  try {
    fn();
    passes++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}\n       ${err.message}`);
  }
}

function get(server, pathname) {
  const { port } = server.address();
  return fetchLocal(`http://127.0.0.1:${port}${pathname}`);
}

// The global fetch is stubbed, so localhost requests use http directly.
const http = require('http');
function fetchLocal(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            /* html or empty */
          }
          resolve({ status: res.statusCode, body: parsed, raw: body });
        });
      })
      .on('error', reject);
  });
}

async function main() {
  await mapper.load();
  const status = mapper.status();
  console.log(`\nmapping: ${status.anilistIds} AniList IDs\n`);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('manifest');
  const manifest = await get(server, '/manifest.json');
  check('serves a manifest', () => assert.strictEqual(manifest.status, 200));
  const ANIME_CATALOG_IDS = new Set([
    'recently-aired', 'latest-episodes', 'airing-today', 'last-hour', 'trending',
    'top-rated', 'continue-watching', 'new-episode', 'movies', 'seasonal', 'recommended',
  ]);
  check('declares eleven anime catalogues', () =>
    assert.strictEqual(manifest.body.catalogs.filter((c) => ANIME_CATALOG_IDS.has(c.id)).length, 11));
  check('also declares the four always-on kids brands (series + movie each)', () =>
    assert.strictEqual(manifest.body.catalogs.filter((c) => !ANIME_CATALOG_IDS.has(c.id)).length, 8));
  check('catalogue order starts with Recently Aired', () =>
    assert.strictEqual(manifest.body.catalogs[0].id, 'recently-aired'));
  check('includes Latest Episodes', () =>
    assert.ok(manifest.body.catalogs.some((c) => c.id === 'latest-episodes')));
  check('movies row is typed movie', () =>
    assert.strictEqual(manifest.body.catalogs.find((c) => c.id === 'movies').type, 'movie'));
  check('is configurable', () => assert.strictEqual(manifest.body.behaviorHints.configurable, true));

  const cfgSegment = configLib.encode({ anilistUser: 'tester', titleLanguage: 'english', hideUnmapped: true });
  const configured = await get(server, `/${cfgSegment}/manifest.json`);
  check('serves a configured manifest', () => assert.strictEqual(configured.status, 200));
  check('round-trips settings', () =>
    assert.strictEqual(configLib.parse(cfgSegment).anilistUser, 'tester'));

  console.log('\ncatalogues');
  for (const catalog of manifest.body.catalogs) {
    const res = await get(server, `/${cfgSegment}/catalog/${catalog.type}/${catalog.id}.json`);
    check(`${catalog.id} responds with metas`, () => {
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.metas), 'metas is an array');
    });
  }

  const recent = await get(server, `/catalog/series/recently-aired.json`);
  check('recently-aired de-duplicates shows', () => {
    const ids = recent.body.metas.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
  check('recently-aired badges the episode', () =>
    assert.ok(/Ep \d+/.test(recent.body.metas[0].name)));
  check('recently-aired hides adult titles by default', () =>
    assert.ok(!recent.body.metas.some((m) => /Adult/.test(m.name))));
  check('IDs are streamable (tt or tmdb:)', () =>
    assert.ok(recent.body.metas.every((m) => /^(tt\d+|tmdb:\d+)/.test(m.id))));

  const latest = await get(server, '/catalog/series/latest-episodes.json');
  check('latest-episodes returns rows', () => assert.ok(latest.body.metas.length > 0));

  const unmappedAllowed = configLib.encode({ hideUnmapped: false });
  const withUnmapped = await get(server, `/${unmappedAllowed}/catalog/series/recently-aired.json`);
  check('unmapped titles appear when allowed', () =>
    assert.ok(withUnmapped.body.metas.some((m) => m.id.startsWith('anilist:'))));

  const skipped = await get(server, '/catalog/series/trending/skip=40.json');
  check('parses skip from the path', () => assert.strictEqual(skipped.status, 200));

  const genre = await get(server, '/catalog/series/top-rated/genre=Action.json');
  check('parses genre from the path', () => assert.strictEqual(genre.status, 200));

  const searched = await get(server, '/catalog/series/trending/search=cowboy%20bebop.json');
  check('parses search from the path', () => assert.strictEqual(searched.status, 200));

  const bogus = await get(server, '/catalog/series/does-not-exist.json');
  check('unknown catalogue 404s cleanly', () => {
    assert.strictEqual(bogus.status, 404);
    assert.ok(Array.isArray(bogus.body.metas));
  });

  const personal = await get(server, `/${cfgSegment}/catalog/series/continue-watching.json`);
  check('continue-watching uses the profile', () => assert.ok(personal.body.metas.length > 0));
  check('continue-watching shows the next episode', () =>
    assert.ok(/Ep 4 of 12/.test(personal.body.metas[0].name)));

  const anonymous = await get(server, '/catalog/series/continue-watching.json');
  check('continue-watching is empty without a profile', () =>
    assert.strictEqual(anonymous.body.metas.length, 0));

  const behind = await get(server, `/${cfgSegment}/catalog/series/new-episode.json`);
  check('new-episode flags unwatched episodes', () =>
    assert.ok(behind.body.metas.some((m) => /is out|episodes behind/.test(m.name))));

  console.log('\nmyanimelist');
  const malCfg = configLib.encode({ malUser: 'chad', malClientId: 'fixture-client' });
  const malWatching = await get(server, `/${malCfg}/catalog/series/continue-watching.json`);
  check('MAL list drives continue-watching', () => assert.ok(malWatching.body.metas.length > 0));
  check('MAL progress becomes the next episode', () =>
    assert.ok(/Ep 4 of 12/.test(malWatching.body.metas[0].name)));
  check('MAL path used the official API', () => assert.ok(calls.mal > 0));
  check('MAL entries still get streamable IDs', () =>
    assert.ok(malWatching.body.metas.every((m) => /^(tt\d+|tmdb:\d+)/.test(m.id))));

  const jikanCfg = configLib.encode({ malUser: 'chad' });
  const viaJikan = await get(server, `/${jikanCfg}/catalog/series/continue-watching.json`);
  check('falls back to Jikan without a client ID', () => {
    assert.ok(calls.jikan > 0);
    assert.ok(viaJikan.body.metas.length > 0);
  });

  const pinnedMal = configLib.parse(configLib.encode({ listSource: 'mal', anilistUser: 'someone' }));
  check('pinning MAL ignores an AniList username', () => assert.strictEqual(pinnedMal.hasUser, false));

  const listsLib = require('../src/anime/lists');
  check('auto prefers AniList when both are set', () =>
    assert.strictEqual(
      listsLib.source(configLib.parse(configLib.encode({ anilistUser: 'a', malUser: 'b' }))),
      'anilist'
    ));
  check('auto falls to MAL when only MAL is set', () =>
    assert.strictEqual(listsLib.source(configLib.parse(configLib.encode({ malUser: 'b' }))), 'mal'));

  console.log('\ntmdb fallback');
  const withKey = configLib.encode({ tmdbApiKey: 'fixture-key', hideUnmapped: false });
  const rescued = await get(server, `/${withKey}/catalog/series/recently-aired.json`);
  check('unmapped titles get an ID from TMDB', () => {
    assert.ok(
      rescued.body.metas.some((m) => m.id === 'tt7654321'),
      'expected the unmapped fixture to resolve to an IMDb ID'
    );
  });
  check('no AniList-only IDs remain when TMDB can resolve them', () =>
    assert.ok(!rescued.body.metas.some((m) => m.id.startsWith('anilist:'))));
  check('rescued rows keep their episode deep link', () => {
    const row = rescued.body.metas.find((m) => m.id === 'tt7654321');
    assert.ok(row.behaviorHints && /^tt7654321:\d+:\d+$/.test(row.behaviorHints.defaultVideoId));
  });
  check('the fallback actually called TMDB', () => assert.ok(calls.tmdb > 0));

  const noKey = await get(server, `/${unmappedAllowed}/catalog/series/recently-aired.json`);
  check('no TMDB key means no lookups, not an error', () =>
    assert.ok(noKey.body.metas.some((m) => m.id.startsWith('anilist:'))));

  console.log('\nmeta');
  const metaRes = await get(server, `/meta/series/anilist:${UNMAPPED.id}.json`);
  check('serves meta for AniList IDs', () => {
    assert.strictEqual(metaRes.status, 200);
    assert.ok(metaRes.body.meta);
  });
  check('meta lists episodes', () => assert.ok(metaRes.body.meta.videos.length > 0));
  check('episode IDs are id:season:episode', () =>
    assert.ok(/:\d+:\d+$/.test(metaRes.body.meta.videos[0].id)));
  check('meta strips HTML from the synopsis', () =>
    assert.ok(!/</.test(metaRes.body.meta.description)));

  console.log('\nseason mapping');
  const seriesEntry = mapper.byAniList(seriesRow.anilist_id);
  const sequelEntry = mapper.byAniList(sequelRow.anilist_id);
  check('season 1 episodes pass through', () =>
    assert.deepStrictEqual(mapper.toSeasonEpisode(seriesEntry, 3), {
      season: seriesRow.season.tmdb,
      episode: 3,
    }));
  check('later seasons carry their season number', () =>
    assert.strictEqual(mapper.toSeasonEpisode(sequelEntry, 1).season, sequelRow.season.tmdb));
  check('missing mapping falls back to season 1', () =>
    assert.deepStrictEqual(mapper.toSeasonEpisode(null, 7), { season: 1, episode: 7 }));

  console.log('\ngraphql');
  // AniList rejects a document that declares a variable it never uses, and
  // silently returns nothing useful for an enum value that does not exist.
  // Both failures look identical from the outside — an empty catalogue — so
  // they are worth catching here rather than in production.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'anime', 'anilist.js'), 'utf8');
  const documents = [...source.matchAll(/const (\w*QUERY)\s*=\s*`([\s\S]*?)`/g)];
  check('finds every query document', () => assert.ok(documents.length >= 5));
  check('every declared variable is used', () => {
    for (const [, name, doc] of documents) {
      const header = doc.slice(0, doc.indexOf('{'));
      for (const declared of header.match(/\$\w+/g) || []) {
        const uses = (doc.match(new RegExp('\\' + declared + '\\b', 'g')) || []).length;
        assert.ok(uses >= 2, `${name}: ${declared} is declared but never used`);
      }
    }
  });

  const AIRING_SORTS = ['ID', 'ID_DESC', 'MEDIA_ID', 'MEDIA_ID_DESC', 'TIME', 'TIME_DESC', 'EPISODE', 'EPISODE_DESC'];
  check('airing sort values exist in AniList', () => {
    const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'anime', 'catalogs.js'), 'utf8');
    for (const match of catalogSource.match(/sort: '([A-Z_]+)'/g) || []) {
      const value = match.split("'")[1];
      assert.ok(AIRING_SORTS.includes(value), `${value} is not an AiringSort`);
    }
  });

  console.log('\nMyAnimeList failover');
  {
    const sourceLib = require('../src/anime/source');
    const cacheLib = require('../src/anime/cache');
    cacheLib.clear();
    sourceLib.reset();

    global.__ANILIST_DOWN__ = true;
    const before = calls.jikanCatalog;

    const trendingDown = await get(server, '/catalog/series/trending.json');
    check('trending still returns rows when AniList is 403', () =>
      assert.ok(trendingDown.body.metas.length > 0, 'expected MAL-sourced rows'));
    check('the standby was actually used', () => assert.ok(calls.jikanCatalog > before));
    check('MAL-sourced rows still carry streamable IDs', () =>
      assert.ok(trendingDown.body.metas.some((m) => /^(tt\d+|tmdb:\d+)/.test(m.id))));

    const seasonalDown = await get(server, '/catalog/series/seasonal.json');
    check('seasonal falls back too', () => assert.ok(seasonalDown.body.metas.length > 0));

    const moviesDown = await get(server, '/catalog/movie/movies.json');
    check('movies fall back too', () => assert.ok(moviesDown.body.metas.length > 0));

    const scheduleDown = await get(server, '/catalog/series/airing-today.json');
    check('schedule rows survive without air timestamps', () =>
      assert.ok(scheduleDown.body.metas.length > 0));
    check('no fabricated air time in the badge', () => {
      // timeAgo(null) used to render "NaNd ago"; nothing like it may appear.
      const bad = scheduleDown.body.metas.filter((m) => /NaN|Invalid|undefined/.test(m.name));
      assert.strictEqual(bad.length, 0, `bad badges: ${bad.map((m) => m.name).join(', ')}`);
    });

    check('source reports itself degraded', () => {
      const st = sourceLib.status();
      assert.strictEqual(st.active, 'myanimelist');
      assert.strictEqual(st.kind, 'api-disabled');
    });

    const diagDown = await get(server, '/diagnose');
    check('diagnose names the active source', () =>
      assert.strictEqual(diagDown.body.servingFrom, 'myanimelist'));
    check('diagnose explains the AniList outage', () => {
      const anilistCheck = diagDown.body.checks.find((c) => c.name === 'AniList API');
      assert.strictEqual(anilistCheck.kind, 'api-disabled');
      assert.ok(/nothing to fix here/i.test(anilistCheck.advice || ''));
    });

    global.__ANILIST_DOWN__ = false;
    sourceLib.reset();
    cacheLib.clear();

    const recovered = await get(server, '/catalog/series/trending.json');
    check('recovers to AniList once it returns', () => {
      assert.ok(recovered.body.metas.length > 0);
      assert.strictEqual(sourceLib.status().active, 'anilist');
    });
  }

  console.log('\nMAL list survives an AniList outage');
  {
    const sourceLib = require('../src/anime/source');
    const cacheLib = require('../src/anime/cache');
    cacheLib.clear();
    sourceLib.reset();

    // The exact production situation: MAL list is fine, AniList is 403. The
    // list must still render — hydrating it from AniList was the bug.
    global.__ANILIST_DOWN__ = true;
    const cfgMal = configLib.encode({ malUser: 'chad', malClientId: 'fixture-client' });

    const watching = await get(server, `/${cfgMal}/catalog/series/continue-watching.json`);
    check('continue-watching renders from MAL while AniList is 403', () =>
      assert.ok(watching.body.metas.length > 0, 'MAL list must not depend on AniList'));
    check('hydrated rows carry a title and poster', () => {
      const row = watching.body.metas[0];
      assert.ok(row.name && row.name.length > 1, 'row has a name');
      assert.ok(row.poster, 'row has a poster');
    });
    check('hydrated rows keep the watch progress badge', () =>
      assert.ok(/Ep \d+/.test(watching.body.metas[0].name), watching.body.metas[0].name));

    global.__ANILIST_DOWN__ = false;
    sourceLib.reset();
    cacheLib.clear();
  }

  console.log('\nconfigured diagnose');
  {
    const cfgMal = configLib.encode({ malUser: 'chad', malClientId: 'fixture-client' });
    const d = await get(server, `/${cfgMal}/diagnose`);
    check('diagnose accepts a config segment', () => assert.strictEqual(d.status, 200));

    const settings = d.body.checks.find((c) => c.name === 'Settings');
    check('reports the settings it received', () => {
      assert.ok(/MAL user "chad"/.test(settings.detail));
      assert.ok(/MAL client ID set/.test(settings.detail));
    });
    check('never echoes the credential itself', () =>
      assert.ok(!/fixture-client/.test(JSON.stringify(d.body))));

    const watch = d.body.checks.find((c) => c.name === 'Watch list');
    check('actually fetches the list rather than assuming', () => {
      assert.strictEqual(watch.ok, true);
      assert.ok(/from mal/.test(watch.detail), watch.detail);
    });

    // The exact mistake: a client ID with no username.
    const idOnly = configLib.encode({ malClientId: 'fixture-client' });
    const dIdOnly = await get(server, `/${idOnly}/diagnose`);
    const idOnlySettings = dIdOnly.body.checks.find((c) => c.name === 'Settings');
    check('calls out a client ID with no username', () =>
      assert.ok(/NO USERNAME/.test(idOnlySettings.detail), idOnlySettings.detail));

    const bare = await get(server, '/diagnose');
    const bareSettings = bare.body.checks.find((c) => c.name === 'Settings');
    check('bare diagnose says it carries no settings', () =>
      assert.ok(/none in this URL/.test(bareSettings.detail)));
  }

  console.log('\nboth primaries down (the real outage)');
  {
    const sourceLib = require('../src/anime/source');
    const cacheLib = require('../src/anime/cache');
    cacheLib.clear();
    sourceLib.reset();

    // AniList 403 site-wide, and Jikan 504 because every other app just
    // failed over onto it. This is the situation that took the addon down.
    global.__ANILIST_DOWN__ = true;
    global.__JIKAN_DOWN__ = true;
    const kitsuBefore = calls.kitsu;

    const trending = await get(server, '/catalog/series/trending.json');
    check('catalogues still serve when AniList and Jikan are both down', () =>
      assert.ok(trending.body.metas.length > 0, 'expected Kitsu-sourced rows'));
    check('Kitsu was actually reached', () => assert.ok(calls.kitsu > kitsuBefore));
    check('Kitsu rows resolve to streamable IDs via the bundled mapping', () =>
      assert.ok(trending.body.metas.some((m) => /^(tt\d+|tmdb:\d+)/.test(m.id))));

    check('active source is reported as kitsu', () =>
      assert.strictEqual(sourceLib.activeSource(), 'kitsu'));

    const diag = await get(server, '/diagnose');
    check('diagnose stays ok while a source remains', () => {
      assert.strictEqual(diag.body.ok, true);
      assert.strictEqual(diag.body.allChecksPassed, false);
      assert.strictEqual(diag.body.servingFrom, 'kitsu');
    });
    check('diagnose summary is not needlessly alarming', () =>
      assert.ok(/serving from kitsu/i.test(diag.body.summary)));

    // Now lose Kitsu too: everything is gone.
    global.__KITSU_DOWN__ = true;
    sourceLib.reset();
    cacheLib.clear();
    const dead = await get(server, '/diagnose');
    check('diagnose reports a true outage when nothing is left', () => {
      assert.strictEqual(dead.body.ok, false);
      assert.ok(/no catalogue source/i.test(dead.body.summary));
    });

    global.__ANILIST_DOWN__ = false;
    global.__JIKAN_DOWN__ = false;
    global.__KITSU_DOWN__ = false;
    sourceLib.reset();
    cacheLib.clear();
  }

  check('504 is treated as retryable, 403 is not', () => {
    const sourceLib = require('../src/anime/source');
    assert.strictEqual(sourceLib.isTransient(new Error('Jikan HTTP 504')), true);
    assert.strictEqual(sourceLib.isTransient(new Error('AniList 403: disabled')), false);
  });

  console.log('\nupstream failure resilience');
  {
    const cacheLib = require('../src/anime/cache');
    cacheLib.clear();

    // Prime a value, let it expire, then fail the refresh. The stale value
    // must come back — this is what stops an AniList outage blanking Nuvio.
    await cacheLib.wrap('probe', 0.05, async () => ['good']);
    await new Promise((r) => setTimeout(r, 80));

    let served;
    let threw = false;
    try {
      served = await cacheLib.wrap('probe', 0.05, async () => {
        throw new Error('AniList 403: The AniList API has been temporarily disabled');
      });
    } catch (err) {
      threw = true;
    }
    check('serves stale data when the upstream fails', () => {
      assert.strictEqual(threw, false, 'should not throw while stale data exists');
      assert.deepStrictEqual(served, ['good']);
      assert.ok(cacheLib.stats().staleServes > 0);
    });

    cacheLib.clear();
    let bubbled = false;
    try {
      await cacheLib.wrap('cold', 60, async () => {
        throw new Error('boom');
      });
    } catch (err) {
      bubbled = true;
    }
    check('still reports failure when nothing is cached', () => assert.strictEqual(bubbled, true));
  }

  check('classifies a site-wide 403 as an outage, not an IP block', () => {
    const detail = 'The AniList API has been temporarily disabled due to severe stability issues.';
    const kind = /\bIP\b|blocked/i.test(detail) ? 'ip-blocked' : 'api-disabled';
    assert.strictEqual(kind, 'api-disabled');
  });
  check('classifies an IP-block 403 correctly', () => {
    const detail = 'Your IP address has been blocked due to excessive requests.';
    const kind = /\bIP\b|blocked/i.test(detail) ? 'ip-blocked' : 'api-disabled';
    assert.strictEqual(kind, 'ip-blocked');
  });

  console.log('\nmapping resilience');
  check('loads from the bundled file, not the network', () => {
    assert.strictEqual(mapper.status().origin, 'bundled');
    assert.ok(mapper.status().usable);
  });

  // The production outage in v1.1.0: a failed load marked itself ready with an
  // empty index, so hideUnmapped silently emptied all eleven catalogues for 24
  // hours. Both halves of that failure are now pinned down.
  check('a failed load never reports itself usable', () => {
    const probe = { ready: false, entries: 0 };
    // isUsable must depend on the index actually holding entries, not on a flag.
    assert.strictEqual(typeof mapper.isUsable, 'function');
    assert.strictEqual(mapper.isUsable(), true);
    assert.ok(mapper.status().anilistIds > 1000, 'usable implies a populated index');
    return probe;
  });

  check('hideUnmapped is ignored when the mapping is unusable', () => {
    const metaLib = require('../src/anime/meta');
    const original = mapper.isUsable;
    mapper.isUsable = () => false;
    try {
      const kept = metaLib.filterPreviews(
        [{ id: 'anilist:1', type: 'series', name: 'Unmapped', _mapped: false }],
        { hideUnmapped: true }
      );
      assert.strictEqual(kept.length, 1, 'an unusable mapping must not blank the catalogue');
    } finally {
      mapper.isUsable = original;
    }
  });

  const diagnosis = await get(server, '/diagnose');
  check('diagnose reports every check', () => {
    assert.strictEqual(diagnosis.status, 200);
    assert.ok(diagnosis.body.checks.length >= 3);
  });
  check('diagnose passes on a healthy instance', () =>
    assert.strictEqual(diagnosis.body.ok, true));

  console.log('\nplugins');
  const repos = await get(server, '/plugins.json');
  check('reports both repositories', () => assert.strictEqual(repos.body.repositories.length, 2));
  check('separates anime scrapers from the rest', () =>
    assert.strictEqual(repos.body.repositories[0].anime.length, 2));

  const health = await get(server, '/health');
  check('health reports the mapping', () => assert.ok(health.body.mapping.entries > 1000));

  const configure = await get(server, '/configure');
  check('configure page renders', () => assert.ok(configure.raw.includes('Manifest URL')));

  server.close();

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(`stubbed calls: ${JSON.stringify(calls)}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
