# Nuvio Anime

Eleven anime catalogues for Nuvio, built from the AniList broadcast schedule and mapped to IMDb/TMDB IDs so the anime scrapers in your plugin repositories can actually resolve streams.

Nuvio speaks the Stremio addon protocol, so this is a normal addon: a small Node server you host, installed by pasting a manifest URL.

---

## The catalogues

| Row | What it holds |
|---|---|
| 🆕 Recently Aired | One row per show with an episode out in the last 7 days |
| 📼 Latest Episodes | An episode feed — every episode aired in the last 48 hours, newest first |
| 📅 Airing Today | The whole UTC day, including episodes still to come, with air times |
| ⏰ Released in the Last Hour | Just aired; widens to 6 hours when the last hour is quiet, so the row is never empty for no reason |
| 🔥 Trending | AniList trending, and the row that handles search |
| ⭐ Top Rated | Highest community scores with a popularity floor |
| 📺 Continue Watching | Your AniList *Watching* list, badged with the episode you're up to |
| 📢 New Episode Available | Shows you follow that are waiting with an unwatched episode |
| 🎬 Anime Movies | Feature films, searchable |
| 📆 Seasonal Anime | This season, with next and previous behind the genre filter |
| ❤️ Recommended For You | What other members recommend alongside the titles you rated highest |

Three of them — Continue Watching, New Episode Available, Recommended For You — need a tracker. **AniList or MyAnimeList** both work; a public profile on either is enough.

---

## Install

### 1. Run the server

```bash
npm install
cp .env.example .env      # optional, everything has a default
npm start
```

It prints two URLs. Open the configure one, fill in anything you want, copy the manifest URL.

Docker:

```bash
docker build -t nuvio-anime .
docker run -d -p 7000:7000 --name nuvio-anime nuvio-anime
```

Vercel: `vercel deploy` — `vercel.json` is already set up. The ID mapping lives in `/tmp` there and rebuilds on cold start.

### 2. Add it to Nuvio

**Settings → Addons → Add Addon**, paste the manifest URL, install.

Order matters in Nuvio: keep metadata addons (Cinemeta, this one) above source addons.

### 3. Add the scraper repositories

Catalogues and streams are separate systems in Nuvio. This addon lists anime; local scrapers play it. Go to **Settings → Plugins**, turn on **Enable local scrapers** (off by default), then add both repositories:

```
https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json
https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json
```

Then enable the anime scrapers. As of writing, the anime-capable ones are:

- **All-in-One-Nuvio** — AllAnime, HiAnime, AnimePahe, AnimeKai, Animetsu, AnikotoTV, AnimeSalt, AnimeWorld, Anime-Sama, AniDB, Kurage, All-Wish, OneTouchTV, FibWatch
- **Yoru's Repo** — AnimePahe, AnimeKai, VidnestAnime, MyCima

The addon reads both repositories live and reports what it finds at `/plugins.json`, which is also what fills the cards on the configure page. That list is authoritative; the one above will drift.

---

## Trackers

The personal rows read your list from one of two places.

**AniList** needs only a username for a public profile. A token is required just for private lists.

**MyAnimeList** needs a username, and preferably a client ID:

1. Go to [myanimelist.net/apiconfig](https://myanimelist.net/apiconfig) → **Create ID**, fill in the form (any app name and a homepage URL will do).
2. Copy the **Client ID** into configure. There is no OAuth step and no secret needed — MAL allows public list reads with the client ID alone.

Without a client ID, MAL lists are read through [Jikan](https://docs.api.jikan.moe/), which needs no signup but scrapes MAL's own pages, is rate-limited to 60 requests a minute, and has changed response shape more than once. The parser tolerates the variants it is known to return, but the client ID is the path that stays working.

Either way, only *progress* comes from the tracker. Artwork, synopses and airing schedules still come from AniList, so a MAL user and an AniList user see identical rows. MAL entries are matched to AniList through the same offline mapping used for stream IDs, with a capped number of individual lookups for anything unmapped.

---

## Why the IDs matter

Nuvio's local scrapers are handed a **TMDB or IMDb ID plus a season and episode number**. AniList numbers episodes absolutely and treats every sequel as a separate entry, so a naive AniList addon hands the scrapers "episode 13" of a 12-episode season and nothing plays.

This addon resolves each AniList entry through [Fribb/anime-lists](https://github.com/Fribb/anime-lists), which carries the IMDb ID, the TMDB ID, **the TMDB season number** and an episode offset. Catalogue items are published as:

1. `tt…` — an IMDb ID, when one exists. Widest scraper support.
2. `tmdb:…` — when there is no IMDb match.
3. `anilist:…` — last resort. Browses fine, streams rarely.

`Hide titles with no IMDb or TMDB match` is on by default so the third case does not clutter your rows. Turn it off in configure if you would rather see everything.

The mapping rebuilds daily but still lags a week or two behind brand-new shows — which is most of what the schedule rows contain. If you supply a TMDB key, anything the mapping missed gets one title search before the row is filtered, so it arrives with a real ID instead of being hidden. That is capped at eight lookups per row and cached for a day, so a cold row costs a moment and a warm one costs nothing.

Metadata for `tt` and `tmdb:` IDs is deliberately left to Cinemeta and Nuvio's own TMDB integration, which already model seasons correctly. This addon only serves `meta` for `anilist:`, `mal:` and `kitsu:` IDs.

---

## Configuration

Settings travel inside the manifest URL, so one server can serve many people with different profiles. The configure page builds the URL for you; there is nothing to save server-side.

| Setting | Default | Notes |
|---|---|---|
| AniList username | — | Enables the three personal rows |
| AniList token | — | Only for private lists |
| MyAnimeList username | — | Alternative to AniList for those rows |
| MAL client ID | — | Recommended; without it MAL is read through Jikan |
| Track progress with | auto | `auto` / `anilist` / `mal`, only matters if you fill in both |
| TMDB API key | — | Episode titles, stills, and ID lookups for very new shows |
| Title language | Romaji | Romaji / English / Japanese |
| Hide unmapped titles | on | Hides entries with no IMDb or TMDB match |
| Include adult titles | off | |

Environment variables in `.env` set the defaults for the bare `/manifest.json` URL. See `.env.example`.

---

## Endpoints

| Path | Purpose |
|---|---|
| `/manifest.json`, `/<config>/manifest.json` | Addon manifest |
| `/catalog/:type/:id.json` | Catalogue rows |
| `/meta/:type/:id.json` | Metadata for AniList-native IDs |
| `/configure` | Settings page and install URL builder |
| `/plugins.json` | Live report on both scraper repositories |
| `/health` | Mapping size, cache stats, uptime |

---

## Testing

```bash
npm run selftest
```

Runs the whole request path with AniList, TMDB and GitHub stubbed — routing, extra-argument parsing, ID mapping, season conversion, response shapes, and a static check that no GraphQL document declares an unused variable or an enum value AniList does not have. Both of those failures look identical from the outside (an empty catalogue), which is why they are tested rather than eyeballed.

The test needs the ID mapping cached at `/tmp/nuvio-anime-list-full.json`. Starting the server once fetches it, or:

```bash
curl -sL -o /tmp/nuvio-anime-list-full.json \
  https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json
```

---

## Troubleshooting

**A show I know exists is missing.** It is probably unmapped and hidden. Add a TMDB key, or switch off `Hide titles with no IMDb or TMDB match` to see it.

**Rows are empty.** Check `/health` — if `mapping.entries` is 0 the addon could not reach GitHub. Also check whether `hideUnmapped` is filtering everything out; try `?hideUnmapped=false` via the configure page.

**Personal rows are empty.** They need an AniList or MAL username, and the profile must be public unless you supplied an AniList token. If you pinned *Track progress with* to one tracker, only that one's username counts.

**MAL rows are slow or intermittent.** That is Jikan, the no-signup fallback: it scrapes MAL and its rate limit is tight. Add a MAL client ID and the rows come from MAL's own API instead.

**Catalogues load but nothing plays.** That is the scraper side, not this addon. Confirm **Enable local scrapers** is on, both repositories are added, and at least one anime scraper is enabled. Scrapers also come and go as sites move.

**Wrong season plays.** The mapping puts each AniList entry on a TMDB season; a brand-new sequel may not be mapped yet. It usually fixes itself within a week or two, since the source rebuilds daily.

**AniList rate limits.** Responses are cached (2–5 minutes for schedule rows, hours for static ones) and identical concurrent requests are de-duplicated. If you still hit limits, you are probably running many clients against one instance.

---

## Notes

Listings come from AniList; ID mapping from Fribb/anime-lists. This addon supplies catalogues and metadata only — it hosts no media and resolves no streams. Playback comes from whatever scrapers and addons you install yourself.
