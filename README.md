# Snagger

**Self-hosted IPTV aggregator, EPG manager, and on-demand resolver.**

Snagger pulls live channels, EPG, and on-demand catalogs from multiple
streaming sources — PlutoTV, Tubi, Xtream providers, and arbitrary M3U /
XMLTV feeds — normalizes them into a single SQLite-backed library, and serves
unified `playlist.m3u` and `epg.xml` endpoints to any media player (Plex,
Jellyfin, Kodi, Threadfin, TiviMate, etc.).

On top of that it offers:

- **Templates** — multiple curated playlists from the same source pool
  (e.g. "Family", "Sports", "Everything"), each with its own enable/disable,
  rename, regroup, and icon overrides.
- **TMDB-backed catalog** — search movies and shows, see what's playable
  across your sources, and **pin** the source you want to use for a given
  title or episode.
- **IMDB resolver** — `GET /imdb/tt1234567` returns a 302 to a playable
  stream. Falls back through pins → channel matches → Torrentio (with
  optional Real-Debrid).
- **Stream proxy** — optional HMAC-signed proxy that hides upstream URLs and
  credentials, rewrites HLS playlists, and serves opaque short-lived
  vouchers for `.strm` files.

---

## Quick start

Requires [Bun](https://bun.sh) (>= 1.0). A Nix flake is provided.

```bash
git clone git@github.com:ncwardell/Snagger.git
cd Snagger
bun install
bun run start          # or: bun run dev   (hot reload)
```

Open <http://localhost:3000>. The UI walks you through adding your first
source. Snagger creates `snagger.db` (SQLite, WAL mode) in the working
directory on first run.

**With Nix:**

```bash
nix develop            # drops you in a shell with bun + sqlite3
bun install
bun run start
```

**Environment:**

| Variable | Default | Purpose                |
|----------|---------|------------------------|
| `PORT`   | `3000`  | HTTP listen port       |

---

## How it works

```
┌───────────────────────────────────────────────────────────────────┐
│  Sources                                                          │
│  ──────────────────────────────────────────────────────────────── │
│  PlutoTV   Tubi   Xtream provider   M3U/XMLTV URL                 │
└───────────────────────────┬───────────────────────────────────────┘
                            │  scheduled / manual refresh
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Snagger (Bun + SQLite)                                           │
│  ──────────────────────────────────────────────────────────────── │
│  • channels, programmes, series_episodes                          │
│  • templates + per-template overrides                             │
│  • imdb_pins  •  stream_vouchers                                  │
│  • catalog (TMDB)  •  resolver (Torrentio + Real-Debrid)          │
└───────┬─────────────────────────────────────────────┬─────────────┘
        │ /playlist.m3u  /epg.xml                     │ /imdb/tt…
        │ /playlists/<name>.m3u  /epg/<name>.xml      │ /v/<voucher>
        ▼                                             ▼
   Media player                                  Stremio / .strm
```

### Sources

A source is anything Snagger can pull channels and/or EPG from. Each
source has a type, a JSON config blob, and a refresh interval. Built-in
types:

| Type    | What it does                                                  |
|---------|---------------------------------------------------------------|
| `pluto` | Scrapes PlutoTV live channels (48h EPG window) + VOD          |
| `tubi`  | Anonymous Tubi auth → live channels + VOD + series episodes   |
| `xtream`| Tvheadend-compatible Xtream Codes API                         |
| `m3u`   | Arbitrary HTTP M3U playlist (+ optional separate XMLTV URL)   |

Pluto and Tubi are scraped, so they may need adjustments if those
services change their APIs. Xtream and M3U sources are stable protocols.

### Templates and overrides

A template is a named view over the channel library. Each template stores
per-channel overrides:

- enabled / disabled
- renamed `name`
- replaced `icon`
- regrouped `group-title`
- pinned `imdb_id` (for the resolver)

The same channel can appear with different names in different templates,
and disabling a channel in one template doesn't hide it in another.
Outputs:

- `GET /playlist.m3u` — active template
- `GET /epg.xml` — active template's EPG
- `GET /playlists/<name>.m3u` — specific template
- `GET /epg/<name>.xml` — specific template's EPG
- Both accept `?type=live|movie|series` to filter

### IMDB resolver

```
GET /imdb/tt1234567               → 302 to playable URL
GET /imdb/tt1234567/1/3           → 302 (series, S01E03)
GET /imdb/tt1234567.strm          → text/x-strm voucher
GET /imdb/tt1234567?proxy=0       → bypass the stream proxy
GET /imdb/tt1234567?fresh=1       → skip pin cache
```

Resolution order:

1. **Pins** for that IMDB ID (and season/episode for series)
2. **Matching channel** in the active template (by `tvg-id` or override)
3. **Torrentio** — optional Real-Debrid prefix for cached, direct URLs
4. 404 if nothing playable

### Stream proxy

Every source can be set to one of:

- **Direct** — output `playlist.m3u` contains the upstream URL. Fastest,
  but exposes provider credentials and your client's IP to upstream.
- **Proxied** — output URL points back to Snagger at `/stream/<key>?t=…`.
  Snagger signs requests with HMAC-SHA256, fetches the upstream, and
  rewrites HLS playlists so segments also flow through the proxy.

`.strm` and resolver outputs use **vouchers**: opaque tokens (7-day TTL)
that map to real upstream URLs in `stream_vouchers`. The token never
leaves Snagger's DB except as a query string the client immediately
redeems via `GET /v/<voucher>`.

---

## Configuration

Most configuration lives in the database and is edited from the UI under
**Settings**. Two example JSON files exist for reference:

- `resolvers.example.json` — Real-Debrid API key + Torrentio endpoint
  (settings now stored in DB, file kept for documentation)
- `xtream-providers.example.json` — Xtream credentials (also DB-backed
  now via the **Sources** UI)

Settings stored in the `meta` table (editable via `GET/PUT /api/settings`):

| Key                      | Purpose                                              |
|--------------------------|------------------------------------------------------|
| `tmdb_api_key`           | TMDB v3 API key (required for catalog)               |
| `rd_api_key`             | Real-Debrid API key (optional)                       |
| `torrentio_endpoint`     | Default: `https://torrentio.strem.fun`               |
| `imdb_proxy_torrentio`   | Proxy Torrentio results through Snagger              |
| `active_template`        | Which template `/playlist.m3u` serves                |

---

## API

The UI talks to the same HTTP API you can use yourself. Full surface:

### Outputs

```
GET  /playlist.m3u                 active template, full M3U
GET  /epg.xml                      active template, full XMLTV
GET  /playlists/<name>.m3u         specific template
GET  /epg/<name>.xml               specific template
GET  /stream/<key>?t=<sig>         signed proxy for a channel
GET  /stream-raw?u=<url>&t=<sig>   signed proxy for an HLS segment
GET  /v/<voucher>                  redeem a stream voucher
GET  /imdb/<ttid>[/<s>/<e>][.strm] resolve IMDB → playable URL
```

### Sources

```
GET    /api/sources                list sources + status
POST   /api/sources                create
GET    /api/sources/<id>           inspect (config masked)
PUT    /api/sources/<id>           update
DELETE /api/sources/<id>           delete
POST   /api/sources/<id>/test      test connection
POST   /api/sources/<id>/refresh   manual refresh
POST   /api/refresh                refresh all enabled (or one by name)
```

### Templates

```
GET    /api/templates              list + activeId
POST   /api/templates              create
PUT    /api/templates/<id>         update (e.g. proxy_mode)
DELETE /api/templates/<id>         delete
POST   /api/active-template        switch active
```

### Channels

```
GET /api/channels                  paginated, filterable
GET /api/channels/keys             just the keys matching a filter
GET /api/stats                     counts by source/type/group
```

Filters (query string): `template`, `q`, `source`, `type` (live|movie|series),
`group`, `page`, `pageSize`.

### Overrides

```
PUT    /api/overrides/<key>?template=…       single override
DELETE /api/overrides/<key>?template=…
POST   /api/overrides/bulk?template=…        many keys at once
POST   /api/overrides/bulk-by-filter?template=…
POST   /api/overrides/bulk-reset?template=…
```

### Catalog (TMDB + pins)

```
GET /api/catalog/search?q=…&kind=movie|tv&page=…
GET /api/catalog/popular?kind=movie|tv&page=…
GET /api/catalog/tmdb/movie/<id>
GET /api/catalog/tmdb/tv/<id>
GET /api/catalog/tmdb/tv/<id>/season/<n>
GET /api/catalog/title/<ttid>[/<s>/<e>]
GET /api/catalog/title/<ttid>/sources
GET /api/catalog/title/<ttid>/pins[/<s>/<e>]
PUT /api/catalog/title/<ttid>/pins[/<s>/<e>]
```

### Series

```
GET /api/series/<key>/episodes?fresh=0|1
```

### Settings

```
GET /api/settings
PUT /api/settings
```

---

## Project layout

```
.
├── server/                 Bun HTTP server + business logic
│   ├── server.ts           routes, top-level handlers
│   ├── db.ts               SQLite schema + migrations
│   ├── sources.ts          source CRUD + test/refresh
│   ├── refresh.ts          source → DB ingestion
│   ├── scheduler.ts        background refresh loop
│   ├── output.ts           M3U + XMLTV builders (apply overrides)
│   ├── catalog.ts          TMDB search + pin management
│   ├── series.ts           lazy episode loading
│   ├── imdb.ts             IMDB → playable URL resolver
│   └── proxy.ts            HMAC signed proxy + HLS rewriting
├── sources/                source adapters (pluggable)
│   ├── PlutoTV.ts
│   ├── Tubi.ts
│   └── ApolloGroup.ts      (incomplete)
├── helpers/                shared parsers + clients
│   ├── Interfaces.ts       core data types
│   ├── Transformers.ts     M3U + XMLTV serializers
│   ├── m3u-parser.ts
│   ├── xmltv-parser.ts
│   ├── m3u-source.ts       generic M3U/XMLTV adapter
│   ├── xtream.ts           Xtream Codes client
│   ├── tmdb.ts             TMDB v3 client
│   └── torrentio.ts        Torrentio client (+ RD prefix)
├── web/                    static frontend (served at /)
├── index.ts                legacy CLI-style Snagger class (unused by server)
└── flake.nix               Nix dev shell
```

`index.ts` predates the server and exposes a `Snagger.snag()` /
`Snagger.save()` API. It is **not** wired into the running server and
exists only for ad-hoc scripting.

---

## Data model

Stored in `snagger.db`:

| Table              | Purpose                                                |
|--------------------|--------------------------------------------------------|
| `sources`          | Configured sources + refresh state                     |
| `channels`         | Normalized channels (live + VOD entries)               |
| `programmes`       | EPG entries (channel × start/stop window)              |
| `series_episodes`  | Lazy-loaded episode lists                              |
| `templates`        | Named curated views                                    |
| `overrides`        | Per-template per-channel customizations                |
| `imdb_pins`        | Preferred source for an IMDB id (and S/E)              |
| `stream_vouchers`  | Opaque tokens → upstream URLs (7-day TTL)              |
| `meta`             | Key/value settings (API keys, active template, etc.)   |

Schema is created and migrated automatically on startup (see
`server/db.ts`).

---

## Adding a source adapter

1. Create `sources/MyService.ts` that exports `async function snag()`
   returning a `SnagResponse` (see `helpers/Interfaces.ts`).
2. The server discovers adapters by filename; no registration step.
3. For services that need user credentials, expose them through the
   Sources UI by extending the form in `web/`.

Look at `sources/PlutoTV.ts` for a complete reference, including how to
return EPG, VOD, and lazy series-episode loaders.

---

## Status

Snagger is a personal project under active development. Known rough
edges:

- The Tubi and PlutoTV adapters scrape internal APIs and may break when
  those services change.
- `sources/ApolloGroup.ts` is a stub.
- The web UI is a single 1.7k-line HTML file pending a redesign.
- There is no built-in authentication — run it behind a trusted network
  or a reverse proxy with auth.

---

## License

No license declared yet.
