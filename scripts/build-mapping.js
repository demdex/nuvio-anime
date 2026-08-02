'use strict';

/**
 * Builds the bundled ID mapping.
 *
 * The upstream anime-list-full.json is ~7 MB and carries a dozen ID systems
 * this addon never uses. Downloading it at runtime was a mistake: on
 * serverless hosts every cold start paid for it, and a slow or failed
 * download left the instance with no mapping at all.
 *
 * So we trim it to the six fields that matter, commit the result, and load it
 * from disk instantly. ~0.9 MB raw, ~250 KB in git after compression.
 *
 * Run with: npm run build:mapping
 */

const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const OUT_FILE = path.join(__dirname, '..', 'data', 'mapping.json');

/** Row layout. Positional to keep the file small; mapper.js mirrors this. */
const FIELDS = ['anilist', 'mal', 'imdb', 'tmdbTv', 'tmdbMovie', 'season', 'offset', 'kitsu'];

function firstOf(value) {
  return Array.isArray(value) ? value[0] : value;
}

function trim(list) {
  const rows = [];
  for (const raw of list) {
    if (!raw.anilist_id) continue;
    const tmdb = raw.themoviedb_id || {};
    const offsets = raw.episode_offset || {};
    rows.push([
      raw.anilist_id,
      raw.mal_id || null,
      firstOf(raw.imdb_id) || null,
      typeof tmdb.tv === 'number' ? tmdb.tv : null,
      firstOf(tmdb.movie) || null,
      raw.season && typeof raw.season.tmdb === 'number' ? raw.season.tmdb : null,
      offsets.tmdb ?? offsets.tvdb ?? 0,
      raw.kitsu_id || null,
    ]);
  }
  return rows;
}

async function main() {
  process.stdout.write(`Downloading ${SOURCE_URL}\n`);
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'nuvio-anime-addon' } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const list = JSON.parse(await res.text());
  if (!Array.isArray(list) || list.length < 1000) {
    throw new Error(`payload does not look like the mapping (${list.length} rows)`);
  }

  const rows = trim(list);
  const mapped = rows.filter((r) => r[2] || r[3] || r[4]).length;

  const payload = {
    builtAt: new Date().toISOString(),
    source: SOURCE_URL,
    fields: FIELDS,
    rows,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));

  const size = (fs.statSync(OUT_FILE).size / 1048576).toFixed(2);
  process.stdout.write(
    `Wrote ${rows.length} rows (${mapped} with an IMDb or TMDB ID) to data/mapping.json — ${size} MB\n`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
