'use strict';

const anilist = require('./anilist');
const lists = require('./lists');
const meta = require('./meta');
const mapper = require('./mapper');

const HOUR = 3600;
const DAY = 86400;

const GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo',
  'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
  'Sports', 'Supernatural', 'Thriller',
];

const SEASON_OPTIONS = ['This season', 'Next season', 'Previous season'];

const SERIES_FORMATS = ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'];

function now() {
  return Math.floor(Date.now() / 1000);
}

function pageFor(skip, pageSize) {
  return Math.floor((Number(skip) || 0) / pageSize) + 1;
}

/**
 * Pull enough of the airing schedule to satisfy one catalogue page.
 * The schedule is episode-shaped, so a single show can occupy several rows
 * before de-duplication trims it back.
 */
async function schedule({ from, to, sort, pages = 2, ttl }) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await anilist.airingSchedule({ from, to, page, perPage: 50, sort, ttl });
    results.push(...batch);
    if (batch.length < 50) break;
  }
  return results;
}

function allowed(media, cfg) {
  if (!media) return false;
  if (media.isAdult && !cfg.includeAdult) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Handlers                                                            *
 * ------------------------------------------------------------------ */

/** 🆕 Recently Aired — one row per show, newest episode first. */
async function recentlyAired({ cfg, skip }) {
  const to = now();
  const from = to - cfg.recentWindowHours * HOUR;
  const entries = await schedule({ from, to, sort: 'TIME_DESC', pages: 3, ttl: 600 });

  const seen = new Set();
  const previews = [];
  for (const entry of entries) {
    if (!allowed(entry.media, cfg) || seen.has(entry.media.id)) continue;
    seen.add(entry.media.id);
    previews.push(
      meta.toPreview(entry.media, cfg, {
        badge: `Ep ${entry.episode} · ${meta.timeAgo(entry.airingAt)}`,
        episode: entry.episode,
        airingAt: entry.airingAt,
      })
    );
  }
  return paginate(previews, skip, cfg);
}

/** 📼 Latest Episodes — an episode feed rather than a show feed. */
async function latestEpisodes({ cfg, skip }) {
  const to = now();
  const from = to - 2 * DAY;
  const entries = await schedule({ from, to, sort: 'TIME_DESC', pages: 2, ttl: 300 });

  const previews = entries
    .filter((entry) => allowed(entry.media, cfg))
    .map((entry) =>
      meta.toPreview(entry.media, cfg, {
        badge: `Ep ${entry.episode} · ${meta.timeAgo(entry.airingAt)}`,
        episode: entry.episode,
        airingAt: entry.airingAt,
      })
    );
  return paginate(previews, skip, cfg);
}

/** 📅 Airing Today — everything scheduled for the current UTC day. */
async function airingToday({ cfg, skip }) {
  const midnight = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const entries = await schedule({
    from: midnight,
    to: midnight + DAY,
    // AniList's ascending airing sort is called TIME; there is no TIME_ASC.
    sort: 'TIME',
    pages: 3,
    ttl: 900,
  });

  const seen = new Set();
  const previews = [];
  for (const entry of entries) {
    if (!allowed(entry.media, cfg) || seen.has(entry.media.id)) continue;
    seen.add(entry.media.id);
    const future = entry.airingAt > now();
    previews.push(
      meta.toPreview(entry.media, cfg, {
        badge: future
          ? `Ep ${entry.episode} · ${meta.formatClock(entry.airingAt)}`
          : `Ep ${entry.episode} · out now`,
        episode: future ? undefined : entry.episode,
        airingAt: entry.airingAt,
      })
    );
  }
  return paginate(previews, skip, cfg);
}

/**
 * ⏰ Released in the Last Hour.
 * Anime airs in bursts, so a strict 60-minute window is empty most of the day.
 * When it is, the window opens to six hours rather than showing an empty row.
 */
async function lastHour({ cfg, skip }) {
  const to = now();
  let entries = await schedule({ from: to - HOUR, to, sort: 'TIME_DESC', pages: 1, ttl: 180 });
  if (entries.filter((e) => allowed(e.media, cfg)).length < 5) {
    entries = await schedule({ from: to - 6 * HOUR, to, sort: 'TIME_DESC', pages: 2, ttl: 300 });
  }

  const seen = new Set();
  const previews = [];
  for (const entry of entries) {
    if (!allowed(entry.media, cfg) || seen.has(entry.media.id)) continue;
    seen.add(entry.media.id);
    previews.push(
      meta.toPreview(entry.media, cfg, {
        badge: `Ep ${entry.episode} · ${meta.timeAgo(entry.airingAt)}`,
        episode: entry.episode,
        airingAt: entry.airingAt,
      })
    );
  }
  return paginate(previews, skip, cfg);
}

/** 🔥 Trending — also serves the search box. */
async function trending({ cfg, skip, genre, search }) {
  const list = await anilist.media(
    {
      page: pageFor(skip, cfg.pageSize),
      perPage: cfg.pageSize,
      sort: search ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : ['TRENDING_DESC'],
      format_in: SERIES_FORMATS,
      genre: genre || undefined,
      search: search || undefined,
      isAdult: cfg.includeAdult ? undefined : false,
    },
    search ? 3600 : 600
  );
  return list.filter((m) => allowed(m, cfg)).map((m) => meta.toPreview(m, cfg));
}

/** ⭐ Top Rated — community score, with a popularity floor to keep out flukes. */
async function topRated({ cfg, skip, genre }) {
  const list = await anilist.media(
    {
      page: pageFor(skip, cfg.pageSize),
      perPage: cfg.pageSize,
      sort: ['SCORE_DESC'],
      format_in: SERIES_FORMATS,
      genre: genre || undefined,
      minScore: 70,
      isAdult: cfg.includeAdult ? undefined : false,
    },
    6 * HOUR
  );
  return list
    .filter((m) => allowed(m, cfg) && (m.popularity || 0) > 5000)
    .map((m) => meta.toPreview(m, cfg, { badge: m.averageScore ? `${m.averageScore}%` : undefined }));
}

/** 📺 Continue Watching — the viewer's AniList "Watching" list. */
async function continueWatching({ cfg, skip }) {
  if (!cfg.hasUser) return [];
  const entries = await lists.watchlist(cfg, ['CURRENT', 'REPEATING'], 120);

  const previews = entries
    .filter((entry) => allowed(entry.media, cfg))
    .map((entry) => {
      const next = (entry.progress || 0) + 1;
      const total = entry.media.episodes;
      return meta.toPreview(entry.media, cfg, {
        badge: total ? `Ep ${next} of ${total}` : `Ep ${next}`,
        episode: next,
      });
    });
  return paginate(previews, skip, cfg);
}

/**
 * 📢 New Episode Available — shows on the viewer's list where an episode has
 * aired that they have not watched yet.
 */
async function newEpisode({ cfg, skip }) {
  if (!cfg.hasUser) return [];
  const entries = await lists.watchlist(cfg, ['CURRENT', 'REPEATING', 'PAUSED'], 120);

  const previews = [];
  for (const entry of entries) {
    if (!allowed(entry.media, cfg)) continue;
    const media = entry.media;
    const lastAired = media.nextAiringEpisode
      ? media.nextAiringEpisode.episode - 1
      : media.episodes || 0;
    const progress = entry.progress || 0;
    const behind = lastAired - progress;
    if (behind <= 0) continue;

    previews.push(
      meta.toPreview(media, cfg, {
        badge: behind === 1 ? `Ep ${lastAired} is out` : `${behind} episodes behind`,
        episode: progress + 1,
      })
    );
  }
  // Freshest airings first.
  previews.sort((a, b) => (b._anilistId || 0) - (a._anilistId || 0));
  return paginate(previews, skip, cfg);
}

/** 🎬 Anime Movies. */
async function movies({ cfg, skip, genre, search }) {
  const list = await anilist.media(
    {
      page: pageFor(skip, cfg.pageSize),
      perPage: cfg.pageSize,
      sort: search ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : ['POPULARITY_DESC'],
      format_in: ['MOVIE'],
      genre: genre || undefined,
      search: search || undefined,
      isAdult: cfg.includeAdult ? undefined : false,
    },
    6 * HOUR
  );
  return list.filter((m) => allowed(m, cfg)).map((m) => meta.toPreview(m, cfg));
}

/** 📆 Seasonal Anime — this season by default, with neighbours behind the filter. */
async function seasonal({ cfg, skip, genre }) {
  const { season, seasonYear } = resolveSeason(genre);
  const isGenre = GENRES.includes(genre);

  const list = await anilist.media(
    {
      page: pageFor(skip, cfg.pageSize),
      perPage: cfg.pageSize,
      sort: ['POPULARITY_DESC'],
      format_in: SERIES_FORMATS,
      season,
      seasonYear,
      genre: isGenre ? genre : undefined,
      isAdult: cfg.includeAdult ? undefined : false,
    },
    2 * HOUR
  );
  const label = `${season[0]}${season.slice(1).toLowerCase()} ${seasonYear}`;
  return list.filter((m) => allowed(m, cfg)).map((m) => meta.toPreview(m, cfg, { badge: label }));
}

function resolveSeason(choice) {
  const base = anilist.currentSeason();
  const order = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  let shift = 0;
  if (choice === 'Next season') shift = 1;
  if (choice === 'Previous season') shift = -1;
  if (!shift) return base;

  const index = order.indexOf(base.season) + shift;
  const wrapped = ((index % 4) + 4) % 4;
  const yearShift = index < 0 ? -1 : index > 3 ? 1 : 0;
  return { season: order[wrapped], seasonYear: base.seasonYear + yearShift };
}

/**
 * ❤️ Recommended For You.
 * With an AniList profile this is what other viewers recommended alongside the
 * titles the viewer scored highest. Without one it falls back to well-reviewed
 * recent shows, which is the best a stranger can do.
 */
async function recommended({ cfg, skip }) {
  if (cfg.hasUser) {
    const [finished, watching] = await Promise.all([
      lists.watchlist(cfg, ['COMPLETED'], 1800),
      lists.watchlist(cfg, ['CURRENT', 'REPEATING'], 1800),
    ]);

    const owned = new Set([...finished, ...watching].map((e) => e.media.id));
    const seeds = [...finished]
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 20)
      .map((e) => e.media.id);

    if (seeds.length) {
      const recs = await anilist.recommendationsFor(seeds);
      const previews = recs
        .filter((m) => allowed(m, cfg) && !owned.has(m.id))
        .map((m) => meta.toPreview(m, cfg, { badge: 'Because of your list' }));
      if (previews.length) return paginate(previews, skip, cfg);
    }
  }

  const list = await anilist.media(
    {
      page: pageFor(skip, cfg.pageSize),
      perPage: cfg.pageSize,
      sort: ['SCORE_DESC'],
      format_in: SERIES_FORMATS,
      status_in: ['RELEASING', 'FINISHED'],
      seasonYear: new Date().getUTCFullYear(),
      minScore: 65,
      isAdult: cfg.includeAdult ? undefined : false,
    },
    3 * HOUR
  );
  return list.filter((m) => allowed(m, cfg)).map((m) => meta.toPreview(m, cfg, { badge: 'Well reviewed' }));
}

function paginate(previews, skip, cfg) {
  const start = Number(skip) || 0;
  return previews.slice(start, start + cfg.pageSize);
}

/* ------------------------------------------------------------------ *
 * Definitions — order here is the order Nuvio shows the rows          *
 * ------------------------------------------------------------------ */

const CATALOGS = [
  {
    id: 'recently-aired',
    name: '🆕 Recently Aired',
    type: 'series',
    handler: recentlyAired,
    extra: [{ name: 'skip' }],
    description: 'Shows with an episode out in the last seven days.',
  },
  {
    id: 'latest-episodes',
    name: '📼 Latest Episodes',
    type: 'series',
    handler: latestEpisodes,
    extra: [{ name: 'skip' }],
    description: 'Every episode that aired in the last 48 hours, newest first.',
  },
  {
    id: 'airing-today',
    name: '📅 Airing Today',
    type: 'series',
    handler: airingToday,
    extra: [{ name: 'skip' }],
    description: "Today's schedule, including episodes still to come.",
  },
  {
    id: 'last-hour',
    name: '⏰ Released in the Last Hour',
    type: 'series',
    handler: lastHour,
    extra: [{ name: 'skip' }],
    description: 'Just aired. Opens to six hours when the last hour is quiet.',
  },
  {
    id: 'trending',
    name: '🔥 Trending',
    type: 'series',
    handler: trending,
    extra: [{ name: 'search' }, { name: 'genre', options: GENRES }, { name: 'skip' }],
    description: 'What AniList members are watching right now.',
  },
  {
    id: 'top-rated',
    name: '⭐ Top Rated',
    type: 'series',
    handler: topRated,
    extra: [{ name: 'genre', options: GENRES }, { name: 'skip' }],
    description: 'Highest community scores, popularity floor applied.',
  },
  {
    id: 'continue-watching',
    name: '📺 Continue Watching',
    type: 'series',
    handler: continueWatching,
    extra: [{ name: 'skip' }],
    requiresUser: true,
    description: 'Your AniList "Watching" list, most recent first.',
  },
  {
    id: 'new-episode',
    name: '📢 New Episode Available',
    type: 'series',
    handler: newEpisode,
    extra: [{ name: 'skip' }],
    requiresUser: true,
    description: 'Shows you follow that are waiting with an unwatched episode.',
  },
  {
    id: 'movies',
    name: '🎬 Anime Movies',
    type: 'movie',
    handler: movies,
    extra: [{ name: 'search' }, { name: 'genre', options: GENRES }, { name: 'skip' }],
    description: 'Feature films, most popular first.',
  },
  {
    id: 'seasonal',
    name: '📆 Seasonal Anime',
    type: 'series',
    handler: seasonal,
    extra: [{ name: 'genre', options: [...SEASON_OPTIONS, ...GENRES] }, { name: 'skip' }],
    description: 'This season, with next and previous behind the filter.',
  },
  {
    id: 'recommended',
    name: '❤️ Recommended For You',
    type: 'series',
    handler: recommended,
    extra: [{ name: 'skip' }],
    description: 'Built from your AniList ratings when a profile is set.',
  },
];

const BY_ID = new Map(CATALOGS.map((c) => [c.id, c]));

/** Run one catalogue and hand back Stremio-shaped metas. */
async function fetchCatalog(catalogId, args) {
  const definition = BY_ID.get(catalogId);
  if (!definition) return null;

  await mapper.load();
  const previews = await definition.handler(args);
  // Order matters: retry the missing IDs before hideUnmapped throws them away.
  await meta.resolveMissingIds(previews, args.cfg);
  return meta.filterPreviews(previews, args.cfg);
}

module.exports = { CATALOGS, BY_ID, fetchCatalog, GENRES, SEASON_OPTIONS };
