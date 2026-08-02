'use strict';

const mapper = require('./mapper');
const anilist = require('./anilist');
const tmdb = require('./tmdb');

/* ------------------------------------------------------------------ *
 * Small helpers                                                       *
 * ------------------------------------------------------------------ */

function pickTitle(media, cfg) {
  const t = media.title || {};
  const order =
    cfg.titleLanguage === 'english'
      ? [t.english, t.romaji, t.native]
      : cfg.titleLanguage === 'native'
        ? [t.native, t.romaji, t.english]
        : [t.romaji, t.english, t.native];
  return order.find(Boolean) || 'Untitled';
}

function stripHtml(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMovieFormat(media) {
  return media.format === 'MOVIE';
}

function stremioType(media, cfg) {
  return isMovieFormat(media) ? 'movie' : cfg.seriesType || 'series';
}

function releaseInfo(media) {
  const start = media.startDate && media.startDate.year;
  const end = media.endDate && media.endDate.year;
  if (!start) return '';
  if (isMovieFormat(media)) return String(start);
  if (media.status === 'RELEASING') return `${start}-`;
  if (end && end !== start) return `${start}-${end}`;
  return String(start);
}

function timeAgo(unixSeconds) {
  const diff = Math.floor(Date.now() / 1000) - Number(unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatClock(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(11, 16) + ' UTC';
}

/* ------------------------------------------------------------------ *
 * Catalogue rows                                                      *
 * ------------------------------------------------------------------ */

/**
 * Build the compact meta object a catalogue row shows.
 *
 * `badge` is the one line of context that makes a row worth its name: which
 * episode just aired, how far through the user is, when it airs today.
 */
function toPreview(media, cfg, { badge, episode, airingAt } = {}) {
  const external = mapper.externalId(media);
  const type = stremioType(media, cfg);
  const name = pickTitle(media, cfg);

  const preview = {
    id: external.id,
    type,
    name: badge ? `${name} · ${badge}` : name,
    poster: (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large)) || undefined,
    posterShape: 'poster',
    background: media.bannerImage || undefined,
    description: buildDescription(media, { badge, episode, airingAt }),
    releaseInfo: releaseInfo(media),
    genres: media.genres || [],
    imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined,
  };

  if (external.kind === 'imdb') preview.imdb_id = external.id;

  // Jump straight to the episode this row is about, where the client supports it.
  if (episode && type !== 'movie') {
    const { season, episode: ep } = mapper.toSeasonEpisode(external.entry, episode);
    preview._videoSuffix = `:${season}:${ep}`;
    preview.behaviorHints = { defaultVideoId: `${external.id}${preview._videoSuffix}` };
  }

  preview._mapped = external.mapped;
  preview._anilistId = media.id;
  // Enough to retry the ID through TMDB when the offline mapping missed.
  preview._lookup = {
    titles: [media.title && media.title.romaji, media.title && media.title.english],
    year: media.startDate && media.startDate.year,
    isMovie: isMovieFormat(media),
  };
  return preview;
}

/**
 * Second chance for titles the offline mapping does not know yet.
 *
 * The mapping rebuilds daily but lags a week or two behind brand-new shows —
 * exactly the ones the schedule rows are made of. With a TMDB key configured,
 * unmapped entries get one title search each so they still arrive with a
 * streamable ID. Bounded per request: a row is not worth ten extra round trips.
 */
const MAX_FALLBACK_LOOKUPS = 8;

async function resolveMissingIds(previews, cfg) {
  if (!cfg.tmdbApiKey) return previews;

  const pending = previews.filter((p) => p && p._mapped === false).slice(0, MAX_FALLBACK_LOOKUPS);
  if (!pending.length) return previews;

  await Promise.all(
    pending.map(async (preview) => {
      try {
        const hit = await tmdb.findByTitle({ ...preview._lookup, apiKey: cfg.tmdbApiKey });
        if (!hit) return;
        const external = await tmdb.externalIds({
          tmdbId: hit.tmdbId,
          isMovie: hit.isMovie,
          apiKey: cfg.tmdbApiKey,
        });
        applyResolvedId(preview, external && external.imdbId ? external.imdbId : `tmdb:${hit.tmdbId}`);
      } catch (err) {
        console.error('[meta] TMDB fallback failed:', err.message);
      }
    })
  );
  return previews;
}

function applyResolvedId(preview, id) {
  preview.id = id;
  preview._mapped = true;
  if (id.startsWith('tt')) preview.imdb_id = id;
  // No mapping means no season data either, so the episode keeps its number
  // under season 1 — the same assumption TMDB makes for single-season shows.
  if (preview._videoSuffix) {
    preview.behaviorHints = { defaultVideoId: `${id}${preview._videoSuffix}` };
  }
}

function buildDescription(media, { badge, episode, airingAt } = {}) {
  const parts = [];
  if (badge && episode) {
    parts.push(
      airingAt ? `Episode ${episode} aired ${timeAgo(airingAt)}.` : `Episode ${episode} is out.`
    );
  }
  const studio =
    media.studios && media.studios.nodes && media.studios.nodes.length
      ? media.studios.nodes[0].name
      : null;
  if (studio) parts.push(`Studio: ${studio}`);
  const synopsis = stripHtml(media.description);
  if (synopsis) parts.push(synopsis);
  return parts.join('\n\n');
}

/**
 * Drop rows the viewer asked not to see.
 *
 * `hideUnmapped` is only honoured while the ID mapping is actually usable.
 * If the mapping failed to load, every title looks unmapped, and applying the
 * filter would blank all eleven catalogues — a total outage caused by a
 * setting meant to tidy up the edges. Showing titles that may not play is far
 * better than showing nothing at all.
 */
function filterPreviews(previews, cfg) {
  const canFilter = cfg.hideUnmapped && mapper.isUsable();
  if (cfg.hideUnmapped && !canFilter) {
    console.warn('[meta] mapping unusable — showing unmapped titles rather than an empty catalogue');
  }

  const seen = new Set();
  const out = [];
  for (const item of previews) {
    if (!item) continue;
    if (canFilter && !item._mapped) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const clean = { ...item };
    delete clean._mapped;
    delete clean._anilistId;
    delete clean._lookup;
    delete clean._videoSuffix;
    out.push(clean);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Full meta pages (AniList-only IDs)                                  *
 * ------------------------------------------------------------------ */

/** Turn a catalogue ID back into something we can look up. */
function parseId(id) {
  if (!id) return null;
  if (id.startsWith('anilist:')) return { kind: 'anilist', value: Number(id.slice(8)) };
  if (id.startsWith('mal:')) return { kind: 'mal', value: Number(id.slice(4)) };
  if (id.startsWith('kitsu:')) return { kind: 'kitsu', value: Number(id.slice(6)) };
  if (id.startsWith('tmdb:')) return { kind: 'tmdb', value: Number(id.slice(5)) };
  if (id.startsWith('tt')) return { kind: 'imdb', value: id.split(':')[0] };
  return null;
}

async function resolveMedia(id) {
  const parsed = parseId(id);
  if (!parsed) return null;

  if (parsed.kind === 'anilist') return anilist.mediaById({ id: parsed.value });
  if (parsed.kind === 'mal') return anilist.mediaById({ malId: parsed.value });

  if (parsed.kind === 'kitsu') {
    const entry = mapper.byKitsu(parsed.value);
    if (entry && entry.anilistId) return anilist.mediaById({ id: entry.anilistId });
    return null;
  }
  if (parsed.kind === 'imdb') {
    const entry = mapper.byImdb(parsed.value);
    if (entry && entry.anilistId) return anilist.mediaById({ id: entry.anilistId });
    return null;
  }
  if (parsed.kind === 'tmdb') {
    const entry = mapper.byTmdb(parsed.value, 'tv') || mapper.byTmdb(parsed.value, 'movie');
    if (entry && entry.anilistId) return anilist.mediaById({ id: entry.anilistId });
    return null;
  }
  return null;
}

/** Full meta, including the episode list Nuvio hands to the scrapers. */
async function toFullMeta(media, cfg, requestedId) {
  const external = mapper.externalId(media);
  const id = requestedId || external.id;
  const type = stremioType(media, cfg);
  const name = pickTitle(media, cfg);

  const meta = {
    id,
    type,
    name,
    poster: (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large)) || undefined,
    posterShape: 'poster',
    background: media.bannerImage || undefined,
    logo: undefined,
    description: stripHtml(media.description),
    releaseInfo: releaseInfo(media),
    genres: media.genres || [],
    imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined,
    runtime: media.duration ? `${media.duration} min` : undefined,
    country: media.countryOfOrigin || undefined,
    website: media.siteUrl,
    links: buildLinks(media),
    behaviorHints: { hasScheduledVideos: media.status === 'RELEASING' },
  };

  if (external.entry && external.entry.imdbId) meta.imdb_id = external.entry.imdbId;

  if (type !== 'movie') {
    meta.videos = await buildVideos(media, external, id, cfg);
  }
  return meta;
}

function buildLinks(media) {
  const links = [];
  for (const genre of media.genres || []) {
    links.push({ name: genre, category: 'Genres', url: `stremio:///discover` });
  }
  if (media.siteUrl) links.push({ name: 'AniList', category: 'external', url: media.siteUrl });
  return links;
}

/**
 * Episode list.
 *
 * AniList numbers episodes absolutely; the mapping tells us which TMDB season
 * they belong to and how much to shift the numbers. Getting this right is what
 * lets a scraper find "S02E03" instead of failing on "S01E15".
 */
async function buildVideos(media, external, metaId, cfg) {
  const aired = (media.airingSchedule && media.airingSchedule.nodes) || [];
  const total = media.episodes || (aired.length ? Math.max(...aired.map((n) => n.episode)) : 0);
  const airedByEpisode = new Map(aired.map((node) => [node.episode, node.airingAt]));

  let stills = null;
  if (cfg.tmdbApiKey && external.entry && external.entry.tmdbTvId) {
    stills = await tmdb.season({
      tmdbId: external.entry.tmdbTvId,
      seasonNumber: external.entry.tmdbSeason ?? 1,
      apiKey: cfg.tmdbApiKey,
    });
  }

  const videos = [];
  const count = total || aired.length;
  for (let absolute = 1; absolute <= count; absolute++) {
    const { season, episode } = mapper.toSeasonEpisode(external.entry, absolute);
    const airingAt = airedByEpisode.get(absolute);
    const still = stills ? stills.find((e) => e.episode_number === episode) : null;

    videos.push({
      id: `${metaId}:${season}:${episode}`,
      title: (still && still.name) || `Episode ${absolute}`,
      season,
      episode,
      number: episode,
      released: airingAt
        ? new Date(airingAt * 1000).toISOString()
        : still && still.air_date
          ? new Date(`${still.air_date}T00:00:00Z`).toISOString()
          : undefined,
      overview: (still && still.overview) || undefined,
      thumbnail: still && still.still_path ? `https://image.tmdb.org/t/p/w300${still.still_path}` : undefined,
    });
  }

  // The next episode is worth listing even before it airs — Nuvio shows it as upcoming.
  if (media.nextAiringEpisode) {
    const next = media.nextAiringEpisode;
    const { season, episode } = mapper.toSeasonEpisode(external.entry, next.episode);
    if (!videos.some((v) => v.season === season && v.episode === episode)) {
      videos.push({
        id: `${metaId}:${season}:${episode}`,
        title: `Episode ${next.episode}`,
        season,
        episode,
        number: episode,
        released: new Date(next.airingAt * 1000).toISOString(),
      });
    }
  }

  return videos;
}

module.exports = {
  pickTitle,
  stripHtml,
  isMovieFormat,
  stremioType,
  toPreview,
  resolveMissingIds,
  filterPreviews,
  toFullMeta,
  resolveMedia,
  parseId,
  timeAgo,
  formatClock,
};
