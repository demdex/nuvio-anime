'use strict';

const cache = require('./cache');

const ENDPOINT = 'https://graphql.anilist.co';

/** Everything a catalogue row or a meta page needs, in one fragment. */
const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large color }
  bannerImage
  format
  status
  episodes
  duration
  genres
  averageScore
  popularity
  favourites
  season
  seasonYear
  countryOfOrigin
  isAdult
  siteUrl
  startDate { year month day }
  endDate { year month day }
  studios(isMain: true) { nodes { name } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
`;

async function request(query, variables, { token } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'nuvio-anime-addon',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      // AniList publishes how long to wait; honour it once, then give up so a
      // slow row never blocks the rest of the home screen.
      const wait = Math.min(Number(res.headers.get('retry-after') || 2), 5);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error('AniList rate limit reached');
    }

    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`AniList HTTP ${res.status}`);
    if (body.errors && body.errors.length) {
      throw new Error(`AniList: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    return body.data;
  }
  throw new Error('AniList request failed');
}

/* ------------------------------------------------------------------ *
 * Airing schedule                                                     *
 * ------------------------------------------------------------------ */

const SCHEDULE_QUERY = `
query ($page: Int, $perPage: Int, $from: Int, $to: Int, $sort: [AiringSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: $sort) {
      id
      episode
      airingAt
      media { ${MEDIA_FIELDS} }
    }
  }
}`;

/**
 * Episodes that aired inside a time window, newest first.
 * `from`/`to` are unix seconds.
 */
async function airingSchedule({ from, to, page = 1, perPage = 50, sort = 'TIME_DESC', ttl = 300 }) {
  const key = `schedule:${from}:${to}:${page}:${perPage}:${sort}`;
  return cache.wrap(key, ttl, async () => {
    const data = await request(SCHEDULE_QUERY, { page, perPage, from, to, sort: [sort] });
    return data.Page.airingSchedules || [];
  });
}

/* ------------------------------------------------------------------ *
 * Media lists                                                         *
 * ------------------------------------------------------------------ */

const MEDIA_QUERY = `
query (
  $page: Int, $perPage: Int, $sort: [MediaSort], $format_in: [MediaFormat],
  $season: MediaSeason, $seasonYear: Int, $status_in: [MediaStatus],
  $genre: String, $search: String, $isAdult: Boolean, $countryOfOrigin: CountryCode,
  $minScore: Int
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(
      type: ANIME
      sort: $sort
      format_in: $format_in
      season: $season
      seasonYear: $seasonYear
      status_in: $status_in
      genre: $genre
      search: $search
      isAdult: $isAdult
      countryOfOrigin: $countryOfOrigin
      averageScore_greater: $minScore
    ) { ${MEDIA_FIELDS} }
  }
}`;

async function media(vars, ttl = 900) {
  const key = `media:${JSON.stringify(vars)}`;
  return cache.wrap(key, ttl, async () => {
    const data = await request(MEDIA_QUERY, vars);
    return data.Page.media || [];
  });
}

const BY_ID_QUERY = `
query ($id: Int, $malId: Int) {
  Media(id: $id, idMal: $malId, type: ANIME) {
    ${MEDIA_FIELDS}
    relations { edges { relationType node { id title { romaji english } format } } }
    airingSchedule(notYetAired: false, perPage: 50, page: 1) {
      nodes { episode airingAt }
    }
  }
}`;

async function mediaById({ id, malId }, ttl = 3600) {
  const key = `media-by-id:${id || ''}:${malId || ''}`;
  return cache.wrap(key, ttl, async () => {
    const data = await request(BY_ID_QUERY, { id: id || null, malId: malId || null });
    return data.Media || null;
  });
}

const BY_IDS_QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} }
  }
}`;

/** Batch fetch by AniList ID — used to dress up a tracker list with metadata. */
async function mediaByIds(ids, ttl = 900) {
  if (!ids.length) return [];
  const key = `media-by-ids:${ids.slice().sort().join(',')}`;
  return cache.wrap(key, ttl, async () => {
    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    const results = [];
    for (const chunk of chunks) {
      const data = await request(BY_IDS_QUERY, { ids: chunk });
      results.push(...(data.Page.media || []));
    }
    return results;
  });
}

/* ------------------------------------------------------------------ *
 * User lists — Continue Watching, New Episode Available, Recommended  *
 * ------------------------------------------------------------------ */

const LIST_QUERY = `
query ($userName: String, $status_in: [MediaListStatus]) {
  MediaListCollection(userName: $userName, type: ANIME, status_in: $status_in, sort: UPDATED_TIME_DESC) {
    lists {
      status
      entries {
        id
        progress
        updatedAt
        score(format: POINT_10)
        status
        media { ${MEDIA_FIELDS} }
      }
    }
  }
}`;

// Only used to turn a token into the username the list query needs.
const VIEWER_QUERY = `query { Viewer { id name } }`;

/**
 * A user's list. Public AniList profiles need nothing but the username;
 * a token is only required when the profile is private.
 */
async function userList({ userName, token, statuses = ['CURRENT', 'REPEATING'], ttl = 120 }) {
  const key = `list:${userName || 'viewer'}:${statuses.join(',')}:${token ? 'auth' : 'anon'}`;
  return cache.wrap(key, ttl, async () => {
    let name = userName;
    if (!name && token) {
      const viewer = await request(VIEWER_QUERY, {}, { token });
      name = viewer && viewer.Viewer ? viewer.Viewer.name : null;
    }
    if (!name) return [];

    const data = await request(LIST_QUERY, { userName: name, status_in: statuses }, { token });
    const lists = (data.MediaListCollection && data.MediaListCollection.lists) || [];
    const entries = [];
    for (const list of lists) for (const entry of list.entries || []) entries.push(entry);
    // Most recently touched first — that is what "continue watching" means.
    entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return entries;
  });
}

const RECOMMENDATIONS_QUERY = `
query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      recommendations(sort: RATING_DESC, perPage: 8) {
        nodes {
          rating
          mediaRecommendation { ${MEDIA_FIELDS} }
        }
      }
    }
  }
}`;

/** Recommendations AniList users voted for, seeded from titles the user rated highly. */
async function recommendationsFor(seedIds, ttl = 1800) {
  if (!seedIds.length) return [];
  const key = `recs:${seedIds.slice().sort().join(',')}`;
  return cache.wrap(key, ttl, async () => {
    const data = await request(RECOMMENDATIONS_QUERY, { ids: seedIds.slice(0, 25) });
    const scored = new Map();
    for (const parent of data.Page.media || []) {
      for (const node of (parent.recommendations && parent.recommendations.nodes) || []) {
        const rec = node.mediaRecommendation;
        if (!rec) continue;
        const current = scored.get(rec.id);
        const weight = Math.max(1, node.rating || 1);
        if (current) current.weight += weight;
        else scored.set(rec.id, { media: rec, weight });
      }
    }
    return [...scored.values()].sort((a, b) => b.weight - a.weight).map((x) => x.media);
  });
}

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

function currentSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1;
  const season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear: date.getUTCFullYear() };
}

module.exports = {
  request,
  airingSchedule,
  media,
  mediaById,
  mediaByIds,
  userList,
  recommendationsFor,
  currentSeason,
  MEDIA_FIELDS,
};
