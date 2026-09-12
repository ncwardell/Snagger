// ============================================================================
// Tubi source — all Tubi-specific logic lives here.
//   - Anonymous auth via PKCE + TUBI-HMAC-SHA256 request-signing
//   - Live linear channels + EPG schedule (free, with guide data)
//   - On-demand search (used by catalog as an IMDB resolver, not bulk-ingested)
// ============================================================================

import { createHmac, createHash } from 'node:crypto';
import type { EPGChannel, EPGProgram, M3USegment, SnagResponse, StreamType } from '../helpers/Interfaces';
import { M3USegmentArrayToString, toXMLTV } from '../helpers/Transformers';

const ALGO = 'TUBI-HMAC-SHA256';
const SIGNED_HEADER = 'content-type';
const ACCOUNT_BASE = 'https://account.production-public.tubi.io';

const TUBI_HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0',
  'Origin': 'https://tubitv.com',
  'Referer': 'https://tubitv.com/',
};

// ─── Anonymous auth (PKCE + signed token request) ─────────────────────────

interface TubiSession { accessToken: string; refreshToken: string; deviceId: string; expiresAt: number; }
let _session: TubiSession | null = null;

function signTubiRequest(data: unknown, keyBase64: string, path: string): { date: string; signature: string } {
  const body = JSON.stringify(data);
  const bodyHash = createHash('sha256').update(body).digest('hex').toLowerCase();
  const canonicalRequest = `POST\n${path}\n\ncontent-type:application/json\n\n${SIGNED_HEADER}\n${bodyHash}`;
  const canonicalHash = createHash('sha256').update(canonicalRequest).digest('hex').toLowerCase();
  const iso = new Date().toISOString().split('.')[0] + 'Z';
  const date = iso.replace(/[^A-Za-z0-9]/g, '');
  const stringToSign = `${ALGO}\n${date}\n${canonicalHash}`;
  const tubiBytes = Buffer.from('TUBI', 'utf8');
  const keyBytes = Buffer.from(keyBase64, 'base64');
  const seed = new Uint8Array(tubiBytes.length + keyBytes.length);
  seed.set(tubiBytes, 0);
  seed.set(keyBytes, tubiBytes.length);
  const kDate = createHmac('sha256', seed).update(date.split('T')[0]).digest();
  const kRequest = createHmac('sha256', new Uint8Array(kDate)).update('tubi_request').digest();
  const signature = createHmac('sha256', new Uint8Array(kRequest)).update(stringToSign).digest('hex');
  return { date, signature };
}

async function fetchFreshSession(): Promise<TubiSession> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64');
  const deviceId = crypto.randomUUID();

  const skRes = await fetch(`${ACCOUNT_BASE}/device/anonymous/signing_key`, {
    method: 'POST',
    headers: { ...TUBI_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, version: '1.0.0', platform: 'web', device_id: deviceId }),
  });
  if (!skRes.ok) throw new Error(`Tubi signing_key failed: ${skRes.status}`);
  const sk = (await skRes.json()) as { id: string; key: string };

  const tokenBody = { verifier, id: sk.id, platform: 'web', device_id: deviceId };
  const { date, signature } = signTubiRequest(tokenBody, sk.key, '/device/anonymous/token');
  const params = new URLSearchParams({
    'X-Tubi-Algorithm': ALGO,
    'X-Tubi-Date': date,
    'X-Tubi-Expires': '30',
    'X-Tubi-SignedHeaders': SIGNED_HEADER,
    'X-Tubi-Signature': signature,
  });
  const tr = await fetch(`${ACCOUNT_BASE}/device/anonymous/token?${params.toString()}`, {
    method: 'POST',
    headers: { ...TUBI_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(tokenBody),
  });
  if (!tr.ok) throw new Error(`Tubi token failed: ${tr.status} ${await tr.text()}`);
  const t = (await tr.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    deviceId,
    expiresAt: Date.now() + Math.max(60, t.expires_in - 60) * 1000,
  };
}

export async function getTubiSession(): Promise<TubiSession> {
  if (_session && _session.expiresAt > Date.now()) return _session;
  _session = await fetchFreshSession();
  return _session;
}

// Tubi uses two different auth-header conventions across endpoints:
//   /oz/* on tubitv.com         → x-token: <access_token>
//   tensor-cdn / epg-cdn / search → Authorization: Bearer <access_token>
async function tubiGet<T = unknown>(url: string, useBearer = false): Promise<T> {
  const session = await getTubiSession();
  const headers: Record<string, string> = { ...(TUBI_HEADERS as Record<string, string>) };
  if (useBearer) {
    headers['authorization'] = `Bearer ${session.accessToken}`;
    headers['x-tubi-mode'] = 'all';
    headers['x-tubi-platform'] = 'web';
  } else {
    headers['x-token'] = session.accessToken;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Tubi GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

// ─── Live linear channels ─────────────────────────────────────────────────

interface TubiLinearChannel {
  id: string;
  title: string;
  description?: string;
  logo?: string;
  manifestUrl: string;
  group?: string;
}

interface TensorImages {
  // Tubi returns each image kind as an array of URLs. Some channels also have
  // a "logo" field; many only ship thumbnail/poster/landscape/hero/background.
  logo?: string | string[];
  thumbnail?: string[];
  poster?: string[];
  landscape?: string[];
  hero?: string[];
  background?: string[];
  square_logo?: string[];
}

interface TensorEpgResponse {
  containers?: Array<{ id?: string; slug?: string; container_slug?: string; title?: string; contents?: string[] }>;
  contents?: Record<string, {
    id: string | number;
    title: string;
    description?: string;
    images?: TensorImages;
    posterarts?: string[];
    thumbnails?: string[];
    video_resources?: Array<{ manifest?: { url?: string } }>;
  }>;
}

const SKIP_CONTAINER_SLUGS = new Set(['favorite_linear_channels', 'recommended_linear_channels', 'featured_channels', 'recently_added_channels']);

// Map Tubi's per-container slugs to canonical Snagger groups — see same
// scheme used by PlutoTV. Unmapped slugs pass through with title-casing.
function normalizeTubiCategory(slugOrTitle: string | undefined): string {
  const c = (slugOrTitle ?? '').trim();
  if (!c) return 'Live';
  const lc = c.toLowerCase();
  if (/news/.test(lc))                              return 'News';
  if (/sport|nfl|nba|mlb|nhl|wnba|fifa/.test(lc))   return 'Sports';
  if (/true[\s_-]?crime|crime/.test(lc))            return 'True Crime';
  if (/kids|children|cartoon|family/.test(lc))      return 'Kids';
  if (/comed|laugh/.test(lc))                       return 'Comedy';
  if (/drama/.test(lc))                              return 'Drama';
  if (/reality|game[\s_-]?show/.test(lc))           return 'Reality';
  if (/document|nature|history|science/.test(lc))   return 'Documentary';
  if (/music|mtv|vh1/.test(lc))                     return 'Music';
  if (/lifestyle|food|home|travel|cooking/.test(lc))return 'Lifestyle';
  if (/anime|asian|spanish|latino|black|en[\s_-]?espa|hispan/.test(lc)) return 'International';
  if (/movie|cinema|film/.test(lc))                 return 'Movies';
  if (/tv[\s_-]?show|series/.test(lc))              return 'Series';
  // Fallback: prettify the slug ("true_crime_channels" → "True Crime Channels")
  return c.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
}

function pickFirstUrl(...candidates: Array<string | string[] | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
    if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'string' && c[0]) return c[0];
  }
  return undefined;
}

async function fetchLinearChannels(): Promise<TubiLinearChannel[]> {
  const session = await getTubiSession();
  const url = `https://tensor-cdn.production-public.tubi.io/api/v2/epg?mode=tubitv_us_linear&platform=web&device_id=${session.deviceId}`;
  const data = await tubiGet<TensorEpgResponse>(url, true);

  const out = new Map<string, TubiLinearChannel>();
  for (const cnt of data.containers ?? []) {
    const slug = cnt.container_slug ?? cnt.slug ?? '';
    if (SKIP_CONTAINER_SLUGS.has(slug)) continue;
    const groupTitle = normalizeTubiCategory(slug || cnt.title);
    for (const id of cnt.contents ?? []) {
      if (out.has(id)) continue;
      const item = data.contents?.[id];
      if (!item) continue;
      const manifest = item.video_resources?.[0]?.manifest?.url;
      if (!manifest) continue;
      const logo = pickFirstUrl(
        item.images?.logo,
        item.images?.square_logo,
        item.images?.thumbnail,
        item.images?.poster,
        item.images?.landscape,
        item.posterarts,
        item.thumbnails,
      );
      out.set(id, {
        id,
        title: item.title,
        description: item.description,
        logo,
        manifestUrl: manifest.includes('content_id=') ? manifest : `${manifest}${manifest.includes('?') ? '&' : '?'}content_id=${id}`,
        group: groupTitle,
      });
    }
  }
  return [...out.values()];
}

// ─── EPG schedule ─────────────────────────────────────────────────────────

interface EpgRow {
  content_id: string | number;
  programs?: Array<{
    start_time: string;
    end_time: string;
    title: string;
    description?: string;
    ratings?: Array<{ value?: string }>;
    images?: { thumbnail?: string[] | string };
  }>;
}

interface TubiEpgProgram {
  channelId: string;
  startTime: string;
  endTime: string;
  title: string;
  description?: string;
  rating?: string;
  imageUrl?: string;
}

async function fetchEpg(channelIds: string[]): Promise<TubiEpgProgram[]> {
  if (channelIds.length === 0) return [];
  const BATCH = 100;
  const out: TubiEpgProgram[] = [];
  for (let i = 0; i < channelIds.length; i += BATCH) {
    const slice = channelIds.slice(i, i + BATCH);
    const url = `https://epg-cdn.production-public.tubi.io/content/epg/programming?content_id=${slice.join(',')}&lookahead=1&platform=web`;
    try {
      const data = await tubiGet<{ rows?: EpgRow[] }>(url, true);
      for (const row of data.rows ?? []) {
        const channelId = String(row.content_id);
        for (const p of row.programs ?? []) {
          const thumb = Array.isArray(p.images?.thumbnail) ? p.images.thumbnail[0] : p.images?.thumbnail;
          out.push({
            channelId,
            startTime: p.start_time,
            endTime: p.end_time,
            title: p.title,
            description: p.description,
            rating: p.ratings?.[0]?.value,
            imageUrl: thumb,
          });
        }
      }
    } catch (e) {
      console.warn(`[Tubi] EPG batch ${i} failed:`, (e as Error).message);
    }
  }
  return out;
}

// ─── Search (used by catalog as an IMDB resolver) ─────────────────────────

export interface TubiSearchHit {
  id: string;
  title: string;
  type: 'movie' | 'series' | 'unknown';
  year?: number;
  description?: string;
  posterUrl?: string;
  manifestUrl?: string;
  actors?: string[];     // for cross-source (TMDB↔Tubi) metadata matching
  directors?: string[];
}

interface SearchContent {
  id: string | number;
  title?: string;
  type?: string;            // "v" = video/movie, "s" = series
  year?: number;
  description?: string;
  posterarts?: string[];
  images?: TensorImages;
  video_resources?: Array<{ manifest?: { url?: string } }>;
  actors?: string[];
  directors?: string[];
}

export async function searchTubi(query: string, limit = 20): Promise<TubiSearchHit[]> {
  if (!query.trim()) return [];
  const params = new URLSearchParams({
    search: query,
    include_channels: 'true',
    include_linear: 'true',
    is_kids_mode: 'false',
    include_apps: 'true',
  });
  const url = `https://search.production-public.tubi.io/api/v3/search?${params.toString()}`;
  const data = await tubiGet<{
    contents?: Record<string, SearchContent>;
    containers?: Array<{ id?: string; items?: Array<{ id: string; type?: string }> }>;
  }>(url, true);

  // Relevance order lives in containers[0].items[]; contents hash holds metadata.
  const searchContainer = data.containers?.find(c => c.id === 'search') ?? data.containers?.[0];
  const orderedIds = (searchContainer?.items ?? []).map(i => String(i.id)).slice(0, limit);

  const out: TubiSearchHit[] = [];
  for (const id of orderedIds) {
    const c = data.contents?.[id];
    if (!c) continue;
    const type: TubiSearchHit['type'] = c.type === 's' ? 'series' : c.type === 'v' ? 'movie' : 'unknown';
    out.push({
      id: String(c.id ?? id),
      title: c.title ?? '',
      type,
      year: typeof c.year === 'number' ? c.year : undefined,
      description: c.description,
      posterUrl: pickFirstUrl(c.posterarts, c.images?.poster, c.images?.thumbnail),
      manifestUrl: c.video_resources?.[0]?.manifest?.url,
      actors: Array.isArray(c.actors) ? c.actors.map(String) : undefined,
      directors: Array.isArray(c.directors) ? c.directors.map(String) : undefined,
    });
  }
  return out;
}

// ─── VOD stream-URL resolution (per-item, scrape SSR page) ───────────────
//
// Tubi doesn't return playable URLs in the JSON catalog. The web client
// fetches the movie/series page (tubitv.com/movies/<id> or /tv-shows/<id>)
// and the SSR'd HTML embeds video_resources[].manifest.url. We do the same.
//
// We prefer 'hlsv3' (no DRM) — 'hlsv6_widevine_nonclearlead' requires Widevine.

// Note: [\s\S]*? (not [^}]*?) — Tubi now embeds an audio_tracks":[{…}] array
// between "type" and "manifest", so we must allow '}' in the gap.
const MANIFEST_RE = /"type":"(hlsv\d[a-z_]*)"[\s\S]*?"manifest":\{"url":"([^"]+)"/g;
const LICENSE_URL_RE = /"url":"(https:\/\/license\.adrise\.tv\/[^"]+)"/;

function decodeJsonString(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export interface TubiVodInfo {
  manifestUrl: string;
  licenseUrl: string | null; // null when hlsv3 (no DRM)
  isDrm: boolean;
}

/** Resolve a Tubi VOD to its HLS manifest URL plus DRM info (if protected). */
export async function resolveTubiVodFull(kind: 'movies' | 'tv-shows', id: string): Promise<TubiVodInfo | null> {
  const url = `https://tubitv.com/${kind}/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: TUBI_HEADERS, redirect: 'follow' });
  if (!res.ok) return null;
  const html = await res.text();

  const idMarker = `"id":"${id}"`;
  const candidates: Array<{ type: string; url: string; nearOurId: boolean }> = [];
  let m: RegExpExecArray | null;
  MANIFEST_RE.lastIndex = 0;
  while ((m = MANIFEST_RE.exec(html)) !== null) {
    const type = m[1];
    const u = decodeJsonString(m[2]);
    const back = html.slice(Math.max(0, m.index - 3000), m.index);
    candidates.push({ type, url: u, nearOurId: back.includes(idMarker) });
  }
  if (candidates.length === 0) return null;

  // Pick the manifest we can actually play. Tubi A/Bs several DRM formats for
  // the same title: clear (hlsv3, no DRM), Widevine (we have the CDM), and
  // FairPlay/PlayReady (skd:// / unusable here — often HEVC-only too). Prefer
  // clear, then Widevine; never FairPlay/PlayReady. nearOurId dominates so we
  // don't grab a "related titles" manifest elsewhere on the page.
  const score = (c: { type: string; nearOurId: boolean }): number => {
    let s = c.nearOurId ? 1000 : 0;
    if (/fairplay|playready/i.test(c.type)) s -= 500; // can't use these
    if (c.type === 'hlsv3' || /(^|_)hlsv3($|_)/.test(c.type)) s += 100; // clear — best
    else if (/widevine/i.test(c.type)) s += 50;       // Widevine — we decrypt it
    return s;
  };
  const ranked = candidates.slice().sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  if (!best) return null;

  const isDrm = best.type.includes('widevine') || best.type.includes('playready') || best.type.includes('fairplay');
  let licenseUrl: string | null = null;
  if (isDrm) {
    // Grab every license_server.url (values are JSON-escaped, e.g. https:/…)
    // and prefer the Widevine one (type=widevine…). decodeJsonString unescapes.
    const urls: string[] = [];
    const re = /"license_server":\{"url":"([^"]+)"/g;
    let lm: RegExpExecArray | null;
    while ((lm = re.exec(html)) !== null) urls.push(decodeJsonString(lm[1]));
    licenseUrl = urls.find(u => /widevine/i.test(u)) ?? urls[0] ?? null;
  }

  return { manifestUrl: best.url, licenseUrl, isDrm };
}

/** Resolve a Tubi VOD movie or series episode to its HLS manifest URL.
 *  Returns the manifest URL only (no DRM info). Use resolveTubiVodFull for DRM. */
export async function resolveTubiStream(kind: 'movies' | 'tv-shows', id: string): Promise<string | null> {
  const info = await resolveTubiVodFull(kind, id);
  return info?.manifestUrl ?? null;
}

/**
 * Harvest every episode of a Tubi series in a single page fetch.
 * Tubi's series page embeds the full season/episode tree with HLS manifest
 * URLs in SSR'd HTML. One round-trip per series gives us everything.
 */
export interface TubiEpisodeRecord {
  episodeId: string;
  season: number;
  episode: number;
  title: string;
  description?: string;
  duration?: number;
  manifestUrl: string;
  imdbId?: string;
}

// Walk balanced { } pairs starting at openIdx (must point at '{').
// Returns the index AFTER the matching '}', or s.length if unbalanced.
function balancedEnd(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return s.length;
}

export async function fetchTubiSeriesEpisodes(seriesId: string): Promise<TubiEpisodeRecord[]> {
  const url = `https://tubitv.com/tv-shows/${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: TUBI_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`Tubi series ${seriesId} failed: ${res.status}`);
  const html = await res.text();

  const out: TubiEpisodeRecord[] = [];
  const seen = new Set<string>();  // dedupe by season:episode (page may repeat seasons block)

  // Iterate through each `"seasons":[…]` block (there may be a couple due to
  // page widgets), walking balanced braces to get each season object.
  for (let sIdx = html.indexOf('"seasons":['); sIdx >= 0; sIdx = html.indexOf('"seasons":[', sIdx + 1)) {
    let p = sIdx + '"seasons":'.length;  // points at '['
    if (html[p] !== '[') continue;
    p++;  // past '['

    // Walk season objects until ']' at depth 0 of the seasons array.
    while (p < html.length) {
      // Skip whitespace + commas
      while (p < html.length && (html[p] === ',' || html[p] === ' ' || html[p] === '\n')) p++;
      if (html[p] === ']' || p >= html.length) break;
      if (html[p] !== '{') { p++; continue; }
      const sEnd = balancedEnd(html, p);
      const seasonObj = html.slice(p, sEnd);
      p = sEnd;

      const seasonNum = Number(seasonObj.match(/"number":"?(\d+)"?/)?.[1] ?? '0');
      const epsStart = seasonObj.indexOf('"episodes":[');
      if (epsStart < 0) continue;
      let q = epsStart + '"episodes":'.length;
      if (seasonObj[q] !== '[') continue;
      q++;

      while (q < seasonObj.length) {
        while (q < seasonObj.length && (seasonObj[q] === ',' || seasonObj[q] === ' ' || seasonObj[q] === '\n')) q++;
        if (seasonObj[q] === ']' || q >= seasonObj.length) break;
        if (seasonObj[q] !== '{') { q++; continue; }
        const eEnd = balancedEnd(seasonObj, q);
        const ep = seasonObj.slice(q, eEnd);
        q = eEnd;

        const id          = ep.match(/"id":"(\d+)"/)?.[1];
        const epNum       = Number(ep.match(/"display_episode_number":"?(\d+)"?/)?.[1] ?? ep.match(/"episode_number":"?(\d+)"?/)?.[1] ?? '0');
        const title       = ep.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1];
        const description = ep.match(/"description":"((?:[^"\\]|\\.)*)"/)?.[1];
        const duration    = Number(ep.match(/"duration":(\d+)/)?.[1] ?? '0') || undefined;
        const imdbId      = ep.match(/"imdb_id":"(tt\d+)"/)?.[1];

        // Pick the HLS URL from video_resources, preferring hlsv3 (no DRM).
        // Walk every "manifest":{"url":"..."} preceded by a "type":"hlsv..." marker.
        let manifest: string | undefined;
        const vrIdx = ep.indexOf('"video_resources":[');
        if (vrIdx >= 0) {
          const vrEnd = balancedEnd(ep, ep.indexOf('[', vrIdx) - 0) || ep.length;
          const vr = ep.slice(vrIdx, vrEnd);
          const re = /"type":"(hlsv\d[a-z_]*)"[\s\S]*?"manifest":\{"url":"([^"]+)"/g;
          const hits: Array<{ type: string; url: string }> = [];
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(vr)) !== null) hits.push({ type: mm[1], url: mm[2] });
          // Prefer hlsv3, fall back to any
          const best = hits.find(h => h.type === 'hlsv3') ?? hits[0];
          manifest = best?.url ? decodeJsonString(best.url) : undefined;
        }

        if (!id || !manifest) continue;
        const key = `${seasonNum}:${epNum}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          episodeId: id,
          season: seasonNum,
          episode: epNum,
          title: decodeJsonString(title ?? ''),
          description: description ? decodeJsonString(description) : undefined,
          duration,
          manifestUrl: manifest,
          imdbId,
        });
      }
    }
  }
  return out;
}

// ─── VOD bulk catalog (movies + series) ──────────────────────────────────
// Keyed by Tubi content id. Stream URLs aren't in this catalog response —
// they need a per-item resolve at play time (see resolveTubiStream).

interface TubiBrowseContainer { id: string; slug?: string; title?: string; tags?: string[] }

interface TubiContainerItem {
  id: string | number;
  title?: string;
  type?: string;
  year?: number;
  description?: string;
  duration?: number;
  posterarts?: string[];
  images?: TensorImages;
  thumbnails?: string[];
}

interface ContainerResponse {
  container?: { children?: string[]; cursor?: number | null };
  contents?: Record<string, TubiContainerItem>;
}

const TUBI_VOD_SKIP_SLUGS = new Set([
  'recommended_linear_channels', 'recommended_for_you', 'watch_it_again',
  'recommended_tv', 'your_next_watch', 'favorite_linear_channels',
  'featured_channels', 'recently_added_channels',
]);

type VODItem = { title: string; type: 'movie' | 'series'; year?: number; poster?: string; description?: string; categories: Set<string> };

async function walkContainer(slug: string, session: { accessToken: string }, maxPages: number): Promise<Array<[string, VODItem]>> {
  const HDR_B = { 'authorization': `Bearer ${session.accessToken}`, 'x-tubi-mode': 'all', 'x-tubi-platform': 'web', 'Origin': 'https://tubitv.com' };
  const out: Array<[string, VODItem]> = [];
  const canonical = normalizeTubiCategory(slug);
  let cursor: number | null = 0;
  for (let i = 0; i < maxPages && cursor !== null; i++) {
    const url = `https://tensor-cdn.production-public.tubi.io/api/v1/containers/${slug}?is_kids_mode=false${cursor ? `&cursor=${cursor}` : ''}`;
    try {
      const r = await fetch(url, { headers: HDR_B });
      if (!r.ok) break;
      const data = (await r.json()) as ContainerResponse;
      for (const id of data.container?.children ?? []) {
        const it = data.contents?.[id];
        if (!it || !it.title) continue;
        const type: 'movie' | 'series' = it.type === 's' ? 'series' : 'movie';
        const poster = pickFirstUrl(it.images?.poster, it.posterarts, it.images?.thumbnail, it.thumbnails);
        out.push([String(it.id), {
          title: it.title, type,
          year: typeof it.year === 'number' ? it.year : undefined,
          poster, description: it.description,
          categories: new Set([canonical]),
        }]);
      }
      cursor = data.container?.cursor ?? null;
    } catch { break; }
  }
  return out;
}

async function fetchVODCatalog(): Promise<Map<string, VODItem>> {
  const session = await getTubiSession();
  const HDR_B = { 'authorization': `Bearer ${session.accessToken}`, 'x-tubi-mode': 'all', 'x-tubi-platform': 'web', 'Origin': 'https://tubitv.com' };

  // 1) Discover containers
  const blRes = await fetch('https://tensor-cdn.production-public.tubi.io/api/v1/browse_list?is_kids_mode=false', { headers: HDR_B });
  if (!blRes.ok) throw new Error(`browse_list failed: ${blRes.status}`);
  const bl = (await blRes.json()) as { containers?: TubiBrowseContainer[] };

  // Skip personalized/empty containers; cap to first 40 by browse_list order so
  // refresh stays bounded (Tubi has ~120 containers and walking them all would
  // take minutes; the popular ones cover the bulk of the catalog).
  const slugs = (bl.containers ?? [])
    .map(c => c.slug ?? c.id)
    .filter((s): s is string => !!s && !TUBI_VOD_SKIP_SLUGS.has(s))
    .slice(0, 40);

  // 2) Parallelize the walk (8 concurrent containers), cap pages per container.
  const MAX_PAGES = 5;
  const CONCURRENCY = 8;
  const out = new Map<string, VODItem>();
  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => walkContainer(s, session, MAX_PAGES).catch(() => [] as Array<[string, VODItem]>)));
    for (const list of results) {
      for (const [id, item] of list) {
        const existing = out.get(id);
        if (existing) for (const cat of item.categories) existing.categories.add(cat);
        else out.set(id, item);
      }
    }
  }
  return out;
}

// ─── Top-level snag (live + EPG + VOD metadata) ──────────────────────────

function formatXmltvTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

export async function snag(): Promise<SnagResponse> {
  const channels = await fetchLinearChannels();
  const programmes = await fetchEpg(channels.map(c => c.id)).catch(e => {
    console.warn('[Tubi] EPG fetch failed:', (e as Error).message);
    return [] as TubiEpgProgram[];
  });

  const m3u: M3USegment[] = [];
  const epgChannels: EPGChannel[] = [];
  const epgProgrammes: EPGProgram[] = [];
  const streamTypes: Record<string, StreamType> = {};

  for (const c of channels) {
    m3u.push({
      '#EXTINF': -1,
      'tvg-id': c.id,
      'tvg-logo': c.logo,
      'group-title': c.group ?? 'Tubi Live',
      name: c.title,
      streamUrl: c.manifestUrl,
    });
    streamTypes[c.id] = 'live';
    epgChannels.push({
      'channel-id': c.id,
      'display-name': c.title,
      icon: c.logo,
      category: c.group,
      description: c.description,
      language: 'en',
      country: 'US',
    });
  }

  // VOD (best-effort; stream URL TBD — emitted with empty streamUrl so titles
  // are browseable today and become playable once we wire the play API).
  try {
    const vod = await fetchVODCatalog();
    for (const [id, it] of vod) {
      const channelId = it.type === 'series' ? `series-${id}` : `vod-${id}`;
      const group = [...it.categories][0] ?? (it.type === 'series' ? 'Series' : 'Movies');
      m3u.push({
        '#EXTINF': -1,
        'tvg-id': channelId,
        'tvg-logo': it.poster,
        'group-title': group,
        name: it.title,
        // Custom scheme — proxy.handleStreamByKey detects this and lazy-resolves
        // to the real HLS manifest URL by scraping the Tubi page.
        streamUrl: it.type === 'series' ? '' : `tubi-vod:${id}`,
      });
      streamTypes[channelId] = it.type;
      epgChannels.push({
        'channel-id': channelId,
        'display-name': it.title,
        icon: it.poster,
        category: group,
        description: it.description,
      });
    }
    console.log(`[Tubi] ingested ${vod.size} VOD items`);
  } catch (vodErr) {
    console.warn('[Tubi] VOD catalog fetch failed:', (vodErr as Error).message);
  }

  for (const p of programmes) {
    epgProgrammes.push({
      channel: p.channelId,
      start: formatXmltvTime(p.startTime),
      stop: formatXmltvTime(p.endTime),
      title: p.title,
      desc: p.description,
      rating: p.rating,
      icon: p.imageUrl,
    });
  }

  const epg = { channels: epgChannels, programmes: epgProgrammes };
  return {
    source: 'Tubi',
    components: { m3u, epg },
    m3u: M3USegmentArrayToString(m3u),
    epg: toXMLTV(epg),
    streamTypes,
  };
}
