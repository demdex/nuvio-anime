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

const MAPPING_CACHE = path.join(os.tmpdir(), 'nuvio-anime-list-full.json');

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */

if (!fs.existsSync(MAPPING_CACHE)) {
  console.error(`Missing mapping cache at ${MAPPING_CACHE}.`);
  console.error('Start the server once with network access, or download:');
  console.error('  curl -sL -o "' + MAPPING_CACHE + '" \\');
  console.error('    https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json');
  process.exit(1);
}

const mappingRows = JSON.parse(fs.readFileSync(MAPPING_CACHE, 'utf8'));

/** Three real entries: one plain series, one later season, one film. */
const seriesRow = mappingRows.find(
  (r) => r.anilist_id && r.mal_id && r.imdb_id && r.themoviedb_id && r.themoviedb_id.tv &&
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

const calls = { anilist: 0, tmdb: 0, github: 0, mal: 0, jikan: 0 };

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
    // The mapping must come from the on-disk cache, never from a stub —
    // a wrong payload here would be written to that cache for a day.
    throw new Error('mapping cache missing; download anime-list-full.json first');
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
const configLib = require('../src/config');
const mapper = require('../src/mapper');

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
  check('declares eleven catalogues', () => assert.strictEqual(manifest.body.catalogs.length, 11));
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

  const listsLib = require('../src/lists');
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
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'anilist.js'), 'utf8');
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
    const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'catalogs.js'), 'utf8');
    for (const match of catalogSource.match(/sort: '([A-Z_]+)'/g) || []) {
      const value = match.split("'")[1];
      assert.ok(AIRING_SORTS.includes(value), `${value} is not an AiringSort`);
    }
  });

  console.log('\nmapping cache');
  check('rejects a payload that is not the mapping', () => {
    const fresh = require('../src/mapper');
    assert.ok(fresh.status().entries > 1000);
  });

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
