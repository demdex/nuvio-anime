# Nuvio Anime & Kids

A single merged Nuvio/Stremio catalogue addon: everything `nuvio-anime-addon` did,
plus everything `nuvio-jr-addon` did, under **one manifest and one install URL**.

- **Anime** — eleven catalogues built from the AniList airing schedule (recently
  aired, latest episodes, airing today, released in the last hour, trending, top
  rated, seasonal, movies) plus three personal rows (Continue Watching, New
  Episode Available, Recommended For You) driven by an AniList or MyAnimeList
  username. Fully configurable via `/configure`, exactly as before — the config
  segment in the URL still carries your settings.
- **Kids** — four always-on catalogues (PBS Kids, Disney Junior, Nick Jr.,
  CBeebies), each with a series row and a movie row, built from TMDB. No
  per-user configuration; they simply appear for every install of this addon.

Both halves keep their original internal logic untouched — this is a merge of
two working codebases, not a rewrite. See **What changed to merge them** below
if you're diffing against the two source projects.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env — set TMDB_API_KEY at minimum
npm start
```

Then open `http://127.0.0.1:7000/configure`, set your AniList/MAL username if
you want the personal anime rows, copy the manifest URL, and add it in Nuvio
(Settings → Addons → Add Addon).

## The one environment variable that matters: `TMDB_API_KEY`

- **Required** for the four kids catalogues. Without it they return an empty
  row (server logs the reason; nothing crashes).
- **Also used** as the anime side's default TMDB fallback key — the thing that
  rescues brand-new anime titles the offline AniList↔TMDB mapping hasn't
  caught up with yet, and adds episode stills/titles to anime meta pages. A
  user's own config segment (set via `/configure`) can still override this
  per-install with their own key; the env var is only the default.

So: set it once in your deployment's environment, and it quietly does both
jobs. Get a free key at <https://www.themoviedb.org/settings/api>.

Everything else in `.env.example` is optional — see that file for the anime
side's tuning knobs (`ANILIST_USER`, `MAL_CLIENT_ID`, `LIST_SOURCE`, etc.) and
the kids side's TMDB network/company ID overrides, in case TMDB ever
renumbers one of the four brands.

## Project layout

```
server.js               combined Express app — manifest, catalog, meta, configure, diagnose, health
src/
  anime/                 unchanged internals from nuvio-anime-addon
    config.js             per-user config segment (base64url in the URL)
    catalogs.js            the eleven catalogue definitions + handlers
    anilist.js, jikan.js, kitsu.js, mal.js   the three data sources + standby chain
    source.js               picks AniList → MyAnimeList → Kitsu, tracks outages
    lists.js                Continue Watching / New Episode / Recommended, from AniList or MAL
    mapper.js               offline AniList↔IMDb/TMDB id mapping (data/mapping.json)
    meta.js                 catalogue-row shaping + full meta pages for anilist:/mal:/kitsu: ids
    tmdb.js                 optional per-request TMDB fallback lookups
    cache.js                in-memory TTL cache with stale-while-revalidate + single-flight
    plugins.js              scraper-repo status, also used by the kids side (see below)
  kids/                   unchanged internals from nuvio-jr-addon
    config.js               the four brands (PBS Kids, Disney Junior, Nick Jr., CBeebies) + their TMDB ids
    catalogs.js              catalogue definitions + handler
    tmdb.js                  TMDB discover/detail calls, English-origin filtering
    meta.js                  full meta pages (with episode lists) for tmdb: ids
    cache.js                 node-cache based TTL cache
data/mapping.json        anime side's bundled AniList↔TMDB/IMDb mapping (unchanged)
scripts/build-mapping.js  rebuilds data/mapping.json from the upstream source (unchanged)
public/                  the /configure page (anime's page, extended with a Kids section) + logo/background
test/selftest.js         anime side's test suite, updated to point at src/anime/ and to expect
                          the merged manifest's catalogue count (see below)
```

## How the merge actually works

**One manifest.** `buildManifest()` in `server.js` concatenates the (optionally
filtered, per-user) anime catalogue list with the kids brand list. Kids
catalogues ignore `enabledCatalogs` entirely — they're not part of that
config's scope, by design (per your call: keep anime's config system as-is,
kids just always show).

**Catalog routing.** `catalogHandler()` checks the anime `BY_ID` map first
(matching on id *and* type), then the kids `BRAND_BY_ID` map. No id
collisions exist between the two catalogue sets, so this is unambiguous.

**Meta routing.** This is the one place that needed a real decision, not just
concatenation:

- `anilist:` / `mal:` / `kitsu:` ids always go to the anime meta builder —
  unchanged.
- `tmdb:` ids first try the anime side's *reverse* mapping (`mapper.byTmdb`,
  a local lookup against the bundled mapping, no network call) — this covers
  anime titles that also happen to carry a TMDB id. If that hits, you get the
  richer AniList-driven meta (studio, correctly offset season/episode
  numbers, the AniList link) instead of a generic shape.
- If that reverse-mapping misses, the request falls through to the kids
  side's plain TMDB meta builder (full episode list, season/episode straight
  from TMDB — this is what every `tmdb:` id from a kids catalogue resolves
  through).

The standalone Jr addon already claimed the `tmdb:` id prefix for meta on its
own, so this isn't new exposure introduced by merging — it's the same claim,
just smarter about anime-sourced tmdb ids now.

**Plugins/scraper-repo status.** Both original addons pointed at the exact
same two scraper repos (Yoru's Repo, All-in-One-Nuvio) and both had a
`plugins.js` reporting on them. The merge keeps one — the anime side's
version, since it additionally flags which scrapers look anime-capable, a
strict superset of what the kids side's version reported. Reused for
`/plugins.json` regardless of which catalogue family the visitor came from.

**Everything else** (source-outage fallback chain, stale-cache serving,
`/diagnose`, `/health`) is the anime side's existing machinery, extended with
one extra check: whether `TMDB_API_KEY` is set (which the kids catalogues
depend on entirely).

## What changed to merge them (if you're diffing)

- Both `src/` trees moved under `src/anime/` and `src/kids/` respectively, to
  avoid the many identical filenames (`config.js`, `catalogs.js`, `meta.js`,
  `tmdb.js`, `cache.js`) colliding.
- `src/anime/mapper.js`: the bundled-mapping file path grew one more `..`
  to account for the extra directory nesting (`data/mapping.json` is still at
  the project root).
- The kids side's own `plugins.js` and `configure-page.js` were dropped in
  favor of the anime side's `plugins.js` and the shared `public/index.html`
  configure page (extended with a Kids section) — see above for why.
- `server.js` is a new file combining both original `server.js` files as
  described above; neither original is used directly.
- `test/selftest.js` (the anime side's suite) had its `require('../src/...')`
  paths updated to `require('../src/anime/...')`, two hardcoded
  `src/anilist.js` / `src/catalogs.js` read paths updated the same way, and
  its "declares eleven catalogues" assertion split into two — one for the
  eleven anime catalogues specifically, one for the eight kids brand/type
  entries — since the merged manifest now declares nineteen catalogues
  total. All 106 checks pass against the merged server.
- `package.json` / `.env.example` / `.gitignore` merged to the union of both
  originals' dependencies and variables. `TMDB_API_KEY` is shared, as
  described above — no other names collided.
- Manifest `id` changed from the anime addon's `community.nuvio.anime` to
  `community.nuvio.animekids`, and `name` from `Nuvio Anime` to
  `Nuvio Anime & Kids`, since this is now a distinct, combined product. If you
  want existing anime-addon installs to silently pick up the kids catalogues
  on next refresh instead of needing a fresh add, change the `id` back to
  `community.nuvio.anime` in `server.js` before deploying — Nuvio matches
  installed addons by manifest `id`, not by URL.

## Deploying

Same as either original addon — this is still one Express app.

- **Vercel**: `vercel.json` is unchanged (routes everything to `server.js`).
  Set `TMDB_API_KEY` (and any anime env vars you want as server-wide
  defaults) in the Vercel project's environment variables.
- **Docker**: `Dockerfile` is unchanged. `docker build -t nuvio-anime-kids .`
  then `docker run -p 7000:7000 --env-file .env nuvio-anime-kids`.
- **Bare Node**: `npm start` (Node ≥18).

## Testing

```bash
npm run selftest
```

Runs the full suite against an in-process server with all three anime data
sources stubbed (AniList, Jikan, Kitsu, GitHub mapping) — no live network
calls, no API keys needed. Covers catalogue shape, source failover, the
personal rows, meta pages, season/episode mapping, `/diagnose`, `/health`,
and the configure page. It does not separately stub TMDB for the kids
catalogues, so those rows report an empty result under selftest (same as
they would with no `TMDB_API_KEY` set) — that's expected, not a failure.

```bash
npm run build:mapping
```

Rebuilds `data/mapping.json` from the upstream AniList↔TMDB/IMDb source.
Unchanged from the original anime addon.
