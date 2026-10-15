# TMDB Top Today

A [Stremio](https://www.stremio.com) addon that adds two catalogs to your home screen: **Top Movies Today** and
**Top Shows Today**, built from TMDB's daily trending lists. Its defining feature is the artwork. Posters and
backgrounds are generated on the fly with optional liquid-glass tags ("Just Added", "Season Finale", "Coming Oct 14"),
big rank numbers, and streaming-service logos, in the style of Apple TV.

Everything is configured on a small web page the addon serves itself, and the settings travel inside the install URL,
so there is no database and no accounts. One server can host as many different setups as people want.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using the addon](#using-the-addon)
- [Install-URL settings](#install-url-settings)
- [Tags](#tags)
- [Artwork](#artwork)
- [Admin dashboard](#admin-dashboard)
- [HTTP endpoints](#http-endpoints)
- [Deploying](#deploying)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Credits](#credits)

## Features

- **Two catalogs**, ten titles each, refreshed from TMDB's day-trending lists (cached for 15 minutes).
- **Graphic tags** drawn onto the artwork: upcoming releases, new on streaming, new series/season/episode, finales and more.
  The rules are documented in [TAGS.md](TAGS.md) and can be tuned in one place.
- **Rank badges**: a large silver number on each poster or background.
- **Streaming logos**: the app icon of the service a title is on, in the corner.
- **Curated mode** (beta): textless artwork plus the title logo, or the title as text when no logo exists.
- **Portrait posters or landscape cards**, with separate settings for posters and for the background.
- **Language options**: choose which original languages appear in the catalog, and which language the artwork prefers.
- **Presets** (Classic, Clean, Ranked, Everything) and a **live preview** on the configure page.
- **AIOMetadata support**: ready-made URL patterns so the same artwork can be used as an AIOMetadata art override.
- **Fast and frugal**: images are cached in memory and on disk, concurrent requests for the same image share one render,
  and titles that need nothing drawn are simply redirected to TMDB.
- **Optional admin dashboard** with usage statistics, performance numbers, error details and a per-title cache reset.

## Quick start

### What you need

- A free [TMDB API key](https://www.themoviedb.org/settings/api) (the v3 "API Key", not the read access token).
- A public **HTTPS** address for the addon. Stremio only installs plain-HTTP addons from `localhost`. A small VPS with a
  reverse proxy such as [Caddy](https://caddyserver.com) works well; see [Deploying](#deploying).
- Docker with Compose (recommended), or Node.js 18 or newer.

### With Docker (recommended)

```bash
git clone https://github.com/llamayu/tmdb-trending-today.git
cd tmdb-trending-today

cp .env.example .env        # then edit .env: set TMDB_API_KEY and ADDON_URL
mkdir -p data image-cache   # folders for stats and the image cache (Docker would create them as root)

docker compose up -d --build
```

Then open `https://your-addon-address/configure` in a browser, pick your settings, and press **Install**.

The compose file maps port `7000`, caps the container at 3 CPU cores and 30 MB of logs, and mounts two folders:

| Folder | What it holds | Safe to delete? |
|---|---|---|
| `./image-cache` | Rendered images, so they survive rebuilds | Yes, it refills |
| `./data` | Dashboard statistics (only used if the dashboard is on) | History is lost |

### Without Docker

```bash
npm install
TMDB_API_KEY=your_key ADDON_URL=https://your-addon-address node server.js
```

The artwork uses [`sharp`](https://sharp.pixelplumbing.com). Its prebuilt binaries cover common platforms; on a
minimal Linux install you may need `fontconfig` and a sans-serif font so text renders (the Dockerfile shows what it installs).

## Configuration

Settings come from environment variables (a `.env` file next to `docker-compose.yml` works). The addon refuses to start
with a clear message if a required value is missing or invalid.

| Variable | Default | Description |
|---|---|---|
| `TMDB_API_KEY` | required | Your TMDB v3 API key |
| `ADDON_URL` | required | Public base URL of the addon, e.g. `https://addon.example.com`. A trailing slash is removed. Every image and install link is built from it |
| `PORT` | `7000` | Port the server listens on |
| `CACHE_DIR` | `./image-cache` | Where rendered images are stored. Put it on a volume to keep them across deploys |
| `RENDER_CONCURRENCY` | `4` | How many images are drawn at the same time. Lower it on small servers; drawing is CPU and memory bound |
| `IMAGE_FORMAT` | `jpg` | Format of the artwork links the addon hands out: `jpg` (about 8x smaller) or `png`. Both are always served |
| `IMAGE_CACHE_HOURS` | `48` | How long a rendered image stays cached. `0` means "until the next local midnight". See [Caching](#caching) |
| `TZ` | `UTC` | Timezone for "today" in date-based tags and in the dashboard's days. Use an IANA name such as `America/New_York` |
| `STATS_TOKEN` | empty | Turns on the [admin dashboard](#admin-dashboard). At least 16 characters; empty means no dashboard and no statistics |
| `STATS_DIR` | `./data` | Where dashboard statistics are stored |
| `STATS_GEO` | on | `0` turns off the country lookup, which keeps about 100 MB of data in memory |
| `TRUST_PROXY` | private ranges | Which proxies' `X-Forwarded-For` to believe, in Express's [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) syntax. The default trusts loopback and private addresses, which covers a reverse proxy on the same host or Docker network |

## Using the addon

### The configure page

Open `/configure` (the root address shows the same page). It has a live preview built from the real catalog, so what you
see is what Stremio will show.

- **Presets**: *Classic* (tags and ranks on posters), *Clean* (nothing drawn on), *Ranked* (rank numbers only),
  *Everything* (tags, logos and ranks). Every preset uses a plain textless background.
- **Poster artwork** and **Background artwork**: separate switches for tags, ranks and streaming logos, a preferred language,
  and **Curated**.
- **Style**: portrait posters or landscape cards. In either case the background follows the background settings.
- **Catalog**: which original languages to include (any combination, or all, or everything except English), and whether to
  list only movies that are already out digitally.
- **Link type**: *Stremio* gives an install link and a manifest URL. *AIOMetadata* gives the artwork URL patterns instead.

Press **Install** to open Stremio, or **Copy** to paste the manifest URL into Stremio's addon search box.
Opening the configure page from an installed addon shows its current settings.

### Using it with AIOMetadata

Choose **AIOMetadata** as the link type, copy the URL, and paste it into
*AIOMetadata → Art Providers → Art URL Overrides → URL Patterns* as the Poster or Landscape pattern. The patterns use
AIOMetadata's `{type}` and `{tmdb_id}` placeholders, and the addon works out each title's tag and rank itself.

### Language of the catalog

The catalog language filter looks at each title's *original* language. Choosing only **Non-English** also shows the
language's name ("Korean", "Spanish") as the first genre label on each card, so mixed lists stay readable.

## Install-URL settings

Settings live in the first path segment of the install URL as `key=value` pairs separated by `|`:

```
https://addon.example.com/posterTags=true|posterRanked=true|listLang=en/manifest.json
```

The configure page writes every setting explicitly. For keys missing from a URL, these defaults apply, and unknown keys
or invalid values are ignored:

| Key | Default | Meaning |
|---|---|---|
| `posterTags` | `true` | Draw tags on posters |
| `posterRanked` | `true` | Draw rank numbers on posters |
| `posterLogos` | `false` | Draw the streaming-service logo on posters |
| `posterLanguage` | `en` | Preferred artwork language; `null` means textless |
| `textlessArtwork` | `false` | Curated mode for posters |
| `posterShape` | `portrait` | `portrait` or `landscape` |
| `backdropTags` | `true` | Draw tags on backgrounds |
| `backdropRanked` | `false` | Draw rank numbers on backgrounds |
| `backdropLogos` | `false` | Draw the streaming-service logo on backgrounds |
| `backdropLanguage` | `en` | Preferred background language; `null` means textless |
| `backdropTextlessArtwork` | `false` | Curated mode for backgrounds |
| `listLang` | `en` | Catalog languages: comma-separated ISO codes, `all`, or `non-en` (up to 12) |
| `digitalOnly` | `true` | Only list movies already released digitally |

Older URL formats (`landscapeTags`, `portraitPosterLang`, un-prefixed `tags` and so on) are still understood, so installs
from earlier versions keep working.

## Tags

A tag is picked by looking at release dates, episode air dates, and a show's status, and the first matching rule wins.
Examples:

| Movies | Series |
|---|---|
| Coming *Oct 14* / Coming Soon | Coming *Oct 14* / Coming Soon |
| Now on Blu-ray | Finale *Oct 14* |
| Now Streaming / Just Added | Premiere, New Series |
| | New Season, Season Finale, Series Finale |
| | Final Season, New Episode |

The exact conditions and priority order are in [TAGS.md](TAGS.md). Every day-window (14 days for "coming" and "now
streaming", 5 for finales, and so on) is a constant in `WINDOW` at the top of `src/tags.js`, so changing the behaviour is
a one-line edit. Finales are detected from TMDB's explicit `episode_type: "finale"` flag in preference to counting
episodes, because episode counts are unreliable for long-running shows.

## Artwork

### URLs

Generated artwork is served from two routes, and the file extension picks the format:

```
/poster/603.jpg?type=movie&tag=just_added&rank=3&lang=en&logos=1
/backdrop/603.jpg?type=movie&tag=none&rank=none&lang=null&textless=1&titleStyle=gradient-v9
```

| Parameter | Values |
|---|---|
| `type` | `movie` or `series` |
| `tag` | A known tag name (see `TAG_LABELS` in `src/tags.js`), a date tag like `coming_date_Oct_14`, or `none`. Anything else is treated as `none`, so arbitrary text can never be drawn onto an image |
| `rank` | A number, or `none` |
| `lang` | Language code, or `null` for textless |
| `logos` | `1` to draw the streaming logo |
| `textless` | `1` for Curated mode |

Query parameters are validated: a non-numeric id returns `400`, and bad values fall back to defaults instead of reaching
TMDB or the image.

Two more route families exist for compatibility and for AIOMetadata: `/image/:type/:id.jpg` and
`/landscape/:type/:id.jpg` work out the tag and rank for a title and then redirect to the matching `/poster` or `/backdrop`
URL, and the older `/proxy-image-poster/...` shapes redirect permanently.

### What is drawn, and when

- **Nothing to draw** (no tag, rank, logo or title text): the client is redirected straight to TMDB's copy. Posters use
  `w500`; backgrounds use the full-resolution `original`. This costs the addon almost nothing, because the client downloads
  from TMDB's CDN.
- **Something to draw**: the addon renders the image and stores it. Posters are drawn at 500×750 and backgrounds at
  1280×720.
- **No artwork on TMDB**: a locally generated placeholder is served, with a short cache time so a later upload is picked up.

### Language fallback

For each title the artwork language is chosen in this order: the language you asked for, the title's original language,
textless, English (posters only), and finally the first image TMDB lists.

### Curated mode

Curated mode uses textless artwork and adds the title logo with a faint radial shadow, but only where the logo has less
than 3:1 contrast against the picture. If a textless image has no usable logo, the title is drawn as text instead. A
portrait poster falls back to a centred crop of a textless background when no textless poster exists.

### Look and feel

These details are tuned to look right across very different artwork, so change them with care:

- **Tag pill**: a liquid-glass tab along the bottom edge, sitting on a blurred copy of the artwork, with a light edge that
  is brightest in the centre and fades down the sides.
- **Tag color**: the average color of the **bottom half** of the image is measured. A bright area (perceived
  luminance above 140) gets dark text on a light tint; otherwise white text on a deep tint. The whole bottom half is
  sampled rather than just the pill's footprint, because a solid black strip would otherwise produce an invisible black
  pill on black.
- **Pill width**: text is drawn in SF Pro Display Bold, but no font engine is available to measure it, so widths come from
  a per-character scoring table (`estimateTextWidth` in `src/artwork.js`): narrow letters and punctuation count 0.25 of the
  font size, standard lowercase 0.5, wide capitals 0.7, `W M w m @` 0.85, plus padding of 1.8× the font size.
- **Rank number**: a large silver gradient numeral with a soft shadow, top left.
- **Streaming logo**: the service's app icon in the top-right corner, taken from TMDB's watch-provider data. Networks
  that are themselves services (Netflix, Max, Hulu...) and broadcast networks that stream on one (HBO to Max, NBC to
  Peacock) are mapped to the matching service.

### Caching

Rendered images are cached in two places: memory (up to 96 MB) and disk (`CACHE_DIR`, trimmed to about 1 GB, oldest first).
Disk writes are atomic, so a reader never sees a half-written file.

- A cached image is valid for `IMAGE_CACHE_HOURS` (48 by default). The cache key contains every input to the picture (title,
  tag, rank, language, logos, curated mode, format), so a new tag or rank is simply a different entry. The lifetime only
  limits how long a replaced TMDB poster or a changed streaming logo can linger. `0` expires everything at local midnight.
- Concurrent requests for the same image share one render.
- Titles that need nothing drawn are remembered for 6 hours, which skips the lookups on repeat requests.
- TMDB source images (including title and streaming logos) are cached in memory, since the same logos are needed by
  hundreds of renders.
- Clients are told to cache images for a day, so a phone may keep an old image after the server has replaced it.

To force one title to be drawn again, use the dashboard's [Refresh an item](#refresh-an-item).

### Fonts

The Docker image installs `SF-Pro-Display-Bold.otf` for tag and rank text. If it is missing, the renderer falls back
through the system's sans-serif fonts, and tag pills may be a little wider or narrower than intended because the width
table is tuned to SF Pro. SF Pro is Apple's proprietary typeface with its own license terms; if you fork this project,
check that you are allowed to redistribute the file, or replace it with a font you have the rights to use.

## Admin dashboard

An optional, hidden page with usage statistics. It is off by default and costs nothing when off.

**Turn it on** by setting `STATS_TOKEN` (16 or more characters) and mounting `./data` (the compose file already does).
Then open:

```
https://your-addon-address/admin#YOUR_TOKEN
```

The token after `#` is never sent to the server as part of the address. The page moves it into a request header and removes
it from the address bar. The page and its data are marked `noindex`, are not linked from anywhere, and wrong tokens are
rate limited.

### What it shows

A time range selector (Today, 7d, 14d, 30d, 90d, All time) drives every figure on the page.

- **Users, manifest loads, configure-page visits, requests, server errors**, and a daily chart.
- **Performance**: cache hit rate, fresh renders, average render time, how much of that time is waiting on TMDB versus
  local work, concurrency, CPU, event-loop stalls and memory, with plain-language hints about the likely bottleneck.
- **Server errors**: what the 5xx responses actually were, how often, and when.
- **People**: countries, clients (grouped into Nuvio, AIOStreams, AIOMetadata, Odin, browsers and so on), the raw user agents,
  and which presets and settings people use.

### Refresh an item

Enter a TMDB id (the number in the title's TMDB address) and choose Movie, Series or Both. The addon clears that title's
finished images, remembered pass-throughs and cached TMDB lookups, and the next request draws it again from fresh data.
Clients that already hold the image may keep it for up to 24 hours.

### How people are counted

A user is a distinct visitor, estimated from the IP address, so figures are estimates: a household counts once, and
someone moving between mobile data and Wi-Fi can count twice. Servers that fetch the addon for others (such as AIOStreams
or AIOMetadata instances) count as visitors too.

Raw IP addresses are never stored. Each address (IPv6 as its /64) is reduced to a short keyed hash using a random secret that
lives only in `STATS_DIR/stats.json`. Detailed per-day data is kept for 30 days and plain totals for ten years. If you
delete the file, history and "all time" start over. Back it up if it matters to you.

Days follow the `TZ` setting.

## HTTP endpoints

| Route | Purpose |
|---|---|
| `GET /` and `/configure` | The configure page. `/:config/configure` opens it with settings pre-filled |
| `GET /manifest.json` and `/:config/manifest.json` | Stremio manifest, with or without settings |
| `GET /catalog/:type/:id.json` and `/:config/catalog/...` | Catalogs (`top_movies_today`, `top_shows_today`) |
| `GET /poster/:id.(jpg\|png)`, `/backdrop/:id.(jpg\|png)` | Generated artwork |
| `GET /image/:type/:id.(jpg\|png)`, `/landscape/:type/:id.(jpg\|png)` | AIOMetadata patterns; redirect to the artwork |
| `GET /favicon.svg` | Addon icon |
| `GET /healthz` | Returns `ok`, for health checks |
| `GET /admin`, `GET /admin/api/stats`, `POST /admin/api/invalidate` | Dashboard (only when `STATS_TOKEN` is set) |

Catalog responses carry a 15-minute cache header. If TMDB is failing, the last good copy is served for up to 6 hours.
TMDB failures return `502`; unknown catalog ids return `404`.

## Deploying

### Behind a reverse proxy

Run the addon on a port that only the proxy can reach, and let the proxy handle HTTPS. With Caddy:

```
addon.example.com {
    reverse_proxy localhost:7000
}
```

If the proxy runs on the same host, bind the container's port to localhost so nobody can bypass it (otherwise the
dashboard token and every request could travel over plain HTTP). In `docker-compose.yml`:

```yaml
    ports:
      - "127.0.0.1:7000:7000"
```

Set `ADDON_URL` to the public HTTPS address, without a trailing path.

### Resources

Rendering is the expensive part. The defaults suit a small VPS. To protect other services on the same machine, keep
`RENDER_CONCURRENCY` close to your core count and keep the `cpus` limit and log rotation from the compose file. The
dashboard's Performance section shows whether rendering, TMDB or the queue is the limit.

### Operations

- `docker compose logs -f` follows the logs; `GET /healthz` is a liveness check.
- To update: `git pull && docker compose up -d --build`. The image cache survives because it is on a volume.
- Back up `./data` if you use the dashboard. The image cache can be rebuilt.
- The addon needs no database. State is the install URL, the image cache and the optional stats file.

## Troubleshooting

- **Stremio says it can't install the addon.** Check `ADDON_URL`: it must be the public HTTPS address your device can
  reach. Open `ADDON_URL/manifest.json` in a browser and check that its `logo` and `configurationURL` point at that address.
- **Posters don't change after I changed a setting.** Settings are in the install URL, so reinstall from the configure
  page. Clients also cache images for a day.
- **A title shows old artwork.** Use *Refresh an item* in the dashboard, or lower `IMAGE_CACHE_HOURS`.
- **Tags look different from what I expect.** Read the rules in [TAGS.md](TAGS.md); a title's release dates on TMDB decide
  everything, and TMDB data is sometimes incomplete.
- **High CPU after opening the home screen.** Each new combination of tag, rank and language is drawn once. Lower
  `RENDER_CONCURRENCY`, keep the CPU limit, and let the cache fill.
- **Countries show as "Unknown".** The optional `geoip-lite` package may not have installed. Everything else works without
  it; set `STATS_GEO=0` to stop trying.
- **Text on tags looks wrong or shows boxes.** The container has no usable font. Rebuild with the Dockerfile as it is.

## Development

```bash
npm install
npm test          # node --test, runs offline with no API key
```

The tests use a small Express stand-in (`test/helpers/miniExpress.js`) and a fake TMDB (`test/helpers/fakeTmdb.js`), so no
network or credentials are needed. A few image tests render real pictures with `sharp`.

### Handy places to change things

- **Tag timing**: `WINDOW` in `src/tags.js`.
- **A new tag**: add its label to `TAG_LABELS` and its rule in the movie or series function in `src/tags.js`, then document it
  in [TAGS.md](TAGS.md). Only known labels can reach the renderer.
- **Layout of tags, ranks and logos**: the `LAYOUTS` table at the top of `src/artwork.js`.
- **Artwork look**: if you change how images are drawn, bump `ARTWORK_CACHE_VERSION` in `src/http.js` so old cached images
  are not served.
- **Cache lifetimes and sizes**: `src/imageStore.js`, `src/tmdb.js` (`ttlMs`, `staleMs`) and `src/routes/images.js`.

### Contributing

Issues and pull requests are welcome. Please run `npm test` first, keep the install-URL format and the image URL
parameters backward compatible (people have the old URLs installed), and add a test for behaviour you change.

## Credits

- Movie and series data and images are provided by [TMDB](https://www.themoviedb.org). This product uses the TMDB API but
  is not endorsed or certified by TMDB.
- Built on the [Stremio addon SDK](https://github.com/Stremio/stremio-addon-sdk),
  [Express](https://expressjs.com) and [sharp](https://sharp.pixelplumbing.com).
- Not affiliated with Stremio or Apple.
