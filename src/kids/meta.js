'use strict';

const tmdb = require('./tmdb');

function toPreview(item, type) {
  const title = type === 'series' ? item.name : item.title;
  if (!title) return null;
  const releaseDate = type === 'series' ? item.first_air_date : item.release_date;
  return {
    id: `tmdb:${item.id}`,
    type,
    name: title,
    poster: tmdb.imageUrl(item.poster_path),
    posterShape: 'poster',
    background: tmdb.imageUrl(item.backdrop_path, 'w1280'),
    description: item.overview || undefined,
    releaseInfo: releaseDate ? releaseDate.slice(0, 4) : undefined,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined
  };
}

function filterPreviews(items, type) {
  return items.map(item => toPreview(item, type)).filter(Boolean);
}

/** Full meta for a series, including a flattened episode list (videos). */
async function seriesMeta(tmdbId) {
  const details = await tmdb.getSeriesDetails(tmdbId);
  const seasons = (details.seasons || []).filter(s => s.season_number > 0);

  const videos = [];
  for (const s of seasons) {
    try {
      const season = await tmdb.getSeason(tmdbId, s.season_number);
      for (const ep of season.episodes || []) {
        videos.push({
          id: `tmdb:${tmdbId}:${s.season_number}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: s.season_number,
          episode: ep.episode_number,
          released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
          overview: ep.overview || undefined,
          thumbnail: tmdb.imageUrl(ep.still_path, 'w300')
        });
      }
    } catch (err) {
      console.warn(`[meta] season ${s.season_number} of tv/${tmdbId} failed to load: ${err.message}`);
    }
  }

  return {
    id: `tmdb:${tmdbId}`,
    type: 'series',
    name: details.name,
    poster: tmdb.imageUrl(details.poster_path),
    background: tmdb.imageUrl(details.backdrop_path, 'w1280'),
    description: details.overview || undefined,
    releaseInfo: details.first_air_date ? details.first_air_date.slice(0, 4) : undefined,
    imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
    genres: (details.genres || []).map(g => g.name),
    imdb_id: details.external_ids && details.external_ids.imdb_id ? details.external_ids.imdb_id : undefined,
    videos
  };
}

async function movieMeta(tmdbId) {
  const details = await tmdb.getMovieDetails(tmdbId);
  return {
    id: `tmdb:${tmdbId}`,
    type: 'movie',
    name: details.title,
    poster: tmdb.imageUrl(details.poster_path),
    background: tmdb.imageUrl(details.backdrop_path, 'w1280'),
    description: details.overview || undefined,
    releaseInfo: details.release_date ? details.release_date.slice(0, 4) : undefined,
    imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
    genres: (details.genres || []).map(g => g.name),
    imdb_id: details.external_ids && details.external_ids.imdb_id ? details.external_ids.imdb_id : undefined,
    runtime: details.runtime ? `${details.runtime} min` : undefined
  };
}

module.exports = { filterPreviews, seriesMeta, movieMeta };
