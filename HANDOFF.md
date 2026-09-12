# Snagger — Session Handoff

## What Snagger Is

Self-hosted IPTV aggregator + on-demand resolver. Bun/TypeScript server, SQLite DB, Svelte 5 UI.

Sources: PlutoTV (scraper), Tubi (scraper), Xtream Codes, M3U/XMLTV  
Resolves on-demand via: TMDB catalog → pins → Torrentio/Real-Debrid → playable URL  
Serves: `/playlist.m3u`, `/epg.xml`, `/imdb/tt…` (resolver), Svelte UI at `localhost:3000`

## What Was Built This Session

### Core resolver features
- **`GET /imdb/{ttid}?hash=|channel=|series=|tubi=`** — version-addressed resolve. Selector targets a specific source; missing = normal chain. `?strict=1` returns 404 on miss instead of falling through.
- **`GET /api/catalog/title/{ttid}/sources`** — now returns a `versions[]` array (flat, sorted best-first). Each entry has `{ id, kind, label, source, quality, playUrl, pin }`. The `playUrl` is a stable re-resolvable Snagger URL; `pin` is ready to PUT to `imdb_pins`.
- **`infoHashFromStream()`** in `helpers/torrentio.ts` — fixes RD mode where Torrentio omits `infoHash` from the stream object (it's embedded in the resolve URL). Critical for hash-addressed resolve and torrentio pins to work with Real-Debrid.

### Sources UI (was a phase-2 stub)
`ui/src/routes/Sources.svelte` now has:
- **Add source** — panel with type picker (Pluto/Tubi/Xtream/M3U), type-specific fields
- **Edit source** — pre-fills current config, masked password preserved on blank
- **Test** — probes credentials, persists result to `last_status` badge
- **Enable/Disable toggle**
- **Delete** (with confirm)
- Fixed field-name bug: API returns `lastStatus`/`lastRefreshed` (camelCase) but old UI read `last_status`/`last_refreshed` (snake_case) — badge and refresh time were always blank

### Catalog UI (was a phase-3 stub)
`ui/src/routes/Catalog.svelte` — real page now:
- TMDB popular/search grid with poster cards
- Click → detail modal (poster, overview, genres, IMDB id)
- Versions list from `versions[]` endpoint — Play, Pin, Copy .strm URL buttons
- TV: season dropdown → episode buttons → per-episode versions

### Refresh accuracy
`server/refresh.ts` — after a successful pull, prunes channels the source no longer lists (`DELETE WHERE source=? AND last_seen < runStart`). Guarded: empty pull never prunes. Proven live: Tubi 2,516 → 1,256 channels, 1,291 stale pruned.

### Pluto TV auth (VOD gate)
`sources/PlutoTV.ts` — optional `email`/`password` in Pluto source config. Flow:
1. Anonymous boot → anonymous session token
2. `POST service-users.clusters.pluto.tv/v4/auth?sync=true` with `{ userIdentity, password }` + `Authorization: Bearer <anonToken>` → `idToken`
3. Use `idToken` as `?jwt=` on VOD stitch URLs

Login endpoint confirmed via DevTools capture. VOD stitch also needs `plutotv-device-*` headers (added to `PLUTO_HEADERS` and `server/proxy.ts`). Whether the idToken actually unlocks the stitcher needs testing from the user's home IP (couldn't verify from sandbox — sandbox IP was throttled from heavy probing during debugging).

### Pluto source config
Add to existing PlutoTV source via Sources UI → Edit:
```json
{ "email": "your@email.com", "password": "yourpass" }
```
Server logs `[Pluto] authenticated successfully` on refresh if it works.

### Widevine DRM decryption — DONE ✅ (Tubi VOD plays in any player)

The `device.wvd` extracted from the Pixel 5 is now wired into a working DRM
decryption pipeline. **Tubi VOD (both clear and Widevine-DRM titles) plays in
any player through Snagger.**

Pipeline:
- `helpers/wvcdm.py` — pywidevine CDM: PSSH + license URL → content keys. Runs
  in `.venv` (created by the flake shellHook). **Proven** to pull real keys from
  Tubi's `license.adrise.tv`.
- `helpers/widevine.ts` — TS wrapper + in-process key cache (`getContentKeys`).
  (A native-TS Widevine impl was attempted but the license server rejected its
  challenges; pywidevine is the reliable path.)
- `helpers/cenc.ts` — `mp4decrypt` (Bento4) transmuxes encrypted fMP4 → clear
  fMP4, split at the `moof` boundary into clear init + media fragments.
- `server/drm.ts` — the DRM HLS proxy:
  - `GET /drm/tubi/<id>/master.m3u8` → resolve DRM + rewrite master
  - `GET /drm/tubi/<id>/v.m3u8?u=…` → rewrite variant (strip EXT-X-KEY, route
    init + segments through the decryptor, fold byte-ranges into seg URLs)
  - `GET /drm/tubi/<id>/s.mp4?kind=init|seg&…` → decrypt + serve clear fMP4
- `server/proxy.ts` — `handleStreamByKey` for a `tubi-vod:`/`tubi-episode:` key
  now **302-redirects DRM titles** to `/drm/tubi/<id>/master.m3u8` (clear titles
  stream directly). So playing a Tubi movie from the Library Just Works.

Flake now provides `python3` + `bento4`; the shellHook auto-creates `.venv` with
`pywidevine`. Requires `device.wvd` in the project root.

Perf: ~62 ms per segment decrypt (Bento4 subprocess) — fine for playback.

### Pluto VOD — DONE ✅ (AES-128 HLS, NOT Widevine)

Turns out Pluto's *HLS* VOD path is plain **AES-128 clear-key** (the web player
chose DASH+Widevine, but the HLS endpoint serves standard AES-128 with a
*public* keyfile). So Pluto VOD needs **no CDM at all** — Snagger proxies the
HLS and propagates the entitled jwt; any player decrypts AES-128 natively.

The hard part was auth: Pluto's modern web app is **cookie-based** (login via a
`SignIn` GraphQL mutation to `pluto.tv/api/tn/signup/graphql/`), and mints a
**session-wide entitled JWT** (has `userID`, ~24h, works for all titles). That
JWT isn't obtainable via plain HTTP, so we mint it by driving a real logged-in
Chrome and scraping it from the playout request:
- `helpers/pluto_token.py` — Playwright logs in (persistent profile at
  `~/.cache/snagger/pluto-profile`), plays any VOD, captures the `jwt` from the
  `/playout` request. `sources/PlutoTV.ts:getPlutoVodToken()` caches it ~24h.
- Stream: `ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/episode/<id>/master.m3u8?jwt=<jwt>`
- `server/drm.ts` — `/drm/pluto/<id>/{master.m3u8,v.m3u8,raw}` proxies the HLS,
  rewrites variant/segment/key URLs through Snagger with the jwt appended
  (relative URLs drop it → 401 without this).
- `server/proxy.ts` handleStreamByKey — Pluto movie keys (`PlutoTV:vod-<id>`)
  302-redirect to `/drm/pluto/<contentId>/master.m3u8`.

Proven end-to-end: token minted via browser, HLS proxied, AES-128 segment
decrypts to 2673/2673 valid TS packets.

**Flake additions for this:** `nodejs_22` (Playwright driver), `LD_LIBRARY_PATH`
(libstdc++ for native wheels), `SNAGGER_CHROME` (system Chrome), venv gets
`playwright`, and the shellHook symlinks nix node over Playwright's bundled node.
First mint launches a **headful** Chrome window (~18s); it's session-wide so ~1×/day.

**Still TODO for Pluto VOD:** series *episodes* (movies work via the redirect;
episodes resolve through `buildEpisodeUrl`/the imdb resolver and would need the
same `/drm/pluto/<episodeId>/master.m3u8` routing — the DRM engine already
handles any Pluto contentId). Consider headless mode for the token minter.

### (Historical) Tubi Widevine note

### Tubi VOD situation (historical — now solved above)
Tubi removed clear HLS (`hlsv3`) for all VOD in mid-2026. All variants are now:
- `hlsv6_widevine_nonclearlead` (Widevine, no clear-lead)
- `hlsv6_playready_psshv0`
- `hlsv6_fairplay`

**Tubi VOD is currently removed from `versions[]`** — it was showing false positives that played nothing or the wrong content. Tubi live TV still works fine (separate clear HLS path, untouched).

**WVD file extracted** — see next section.

### Bug fixes
- Tubi selector resolve now strips `vod-` prefix from channel keys before calling `resolveTubiStream` (DB stores `vod-639561`, URL needs `639561`)
- Selector misses no longer fall through to Torrentio — explicit source selection returns 404 on failure, not a surprise RD stream

## The WVD File — Key Next Step

**`/home/arnold/Work/Personal/Snagger/device.wvd`**

Extracted from a Google Pixel 5 (GrapheneOS) using KeyDive + Magisk + Firefox/Tubi as DRM trigger. L3 software CDM, unique to that device — won't be revoked by Google since it's not publicly shared.

### What this unlocks: Tubi VOD decryption

Tubi's DRM chain:
- HLS with `METHOD=SAMPLE-AES-CTR` (CENC/CTR mode in fMP4 segments)
- PSSH embedded as `data:` URI in `#EXT-X-KEY`
- License server: `https://license.adrise.tv/challenge?platform=web&type=widevine_nonclearlead&external_id=...&drm_token=<JWT>`
- `auth_header_key: "customData"`, `auth_header_value: ""` — no extra auth header needed beyond the drm_token in the URL

### What needs to be built

**Three pieces:**

1. **pywidevine integration** (`helpers/widevine.ts`)
   - Add `python3` + `pywidevine` to `flake.nix`
   - Subprocess wrapper: `(pssh, licenseUrl) → hexKey`
   - Cache by `kid` (key ID from the manifest `KEYID=0x...`)
   - PSSH and license URL come from parsing the Tubi variant playlist

2. **Tubi manifest parser update** (`sources/Tubi.ts` / `resolveTubiStream`)
   - Current: returns just the manifest URL
   - Needed: also return `{ manifestUrl, pssh, licenseUrl, drmToken }`
   - These come from parsing the JSON in the Tubi page HTML (already done earlier in session, just needs to be wired in)

3. **fMP4 CENC decryptor in the proxy** (`server/proxy.ts`)
   - Detect Tubi segment URLs (`tubi.video` domain)
   - Look up decryption key by content UUID (extracted from URL path)
   - Decrypt CENC samples in-process using `node:crypto` AES-128-CTR
   - This is the complex piece — ~150-200 lines of fMP4 box parser

### fMP4 CENC decryption overview
Segments are byte-ranged from a single `.mp4` file. Each segment is a `moof`+`mdat` pair. The `senc` box inside `moof` contains per-sample IVs. Decryption: for each sample, AES-128-CTR with the content key and that sample's IV. The boxes/headers are NOT encrypted — only the sample payloads.

Packages that might help: `@webm/mp4box.js` for parsing, or implement the minimal box reader from scratch (only need `moof/traf/senc` and `mdat`).

## Current State

```
server: running at localhost:3000 (background process)
db: snagger.db (Pluto 12,301 channels, Tubi 1,256)
sources: PlutoTV + Tubi (dead Xtream sources deleted)
ui/dist: built, served at /
device.wvd: present at project root
```

## Files Changed This Session

```
server/server.ts       — version selector params, sources[] augmented
server/imdb.ts         — VersionSelector type, selector resolve, tubi fix
server/catalog.ts      — flattenVersions(), versions[] on /sources
server/refresh.ts      — stale channel pruning
server/sources.ts      — setSourceStatus(), Pluto email/password config
server/proxy.ts        — plutotv-device-* headers injected for Pluto URLs
server/series.ts       — Pluto creds threaded through episode loader
sources/PlutoTV.ts     — 3-step auth flow (anon boot → login → idToken)
helpers/torrentio.ts   — infoHashFromStream() for RD mode
ui/src/routes/Sources.svelte  — full add/edit/test/delete UI
ui/src/routes/Catalog.svelte  — real catalog page (was stub)
ui/src/lib/api.ts      — catalog API methods
ui/src/lib/types.ts    — TmdbTitle, CatalogVersion, etc.
ui/dist/               — rebuilt
```

## To Start the Server

```bash
nix develop
bun run server/server.ts
# UI at http://localhost:3000
```

## Immediate Next Steps

1. **Test Pluto auth** — add email/password to PlutoTV source via UI → Sources → Edit, trigger refresh, check server log for `[Pluto] authenticated successfully`, try playing a series episode
2. **Build Tubi WVD/CENC layer** — the three pieces above (pywidevine + manifest parser + fMP4 decryptor)
3. **After Tubi works** — build the Emby `IChannel` plugin (C# project) against the `versions[]` API
