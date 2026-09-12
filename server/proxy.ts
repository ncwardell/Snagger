import { createHmac, randomBytes } from 'node:crypto';
import { db, getProxySecret } from './db';
import { getSourceByName, getXtreamCredentials, type SourceRow } from './sources';

const TOKEN_LEN = 16;

export function sign(payload: string, secret: string = getProxySecret()): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, TOKEN_LEN);
}

export function verify(payload: string, token: string): boolean {
  if (!token || token.length !== TOKEN_LEN) return false;
  const expected = sign(payload);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function streamUrlFor(baseUrl: string, key: string): string {
  return `${baseUrl}/stream/${encodeURIComponent(key)}?t=${sign(key)}`;
}

export function rawProxyUrlFor(baseUrl: string, target: string): string {
  return `${baseUrl}/stream-raw?u=${encodeURIComponent(target)}&t=${sign(target)}`;
}

// --- Opaque-token vouchers ------------------------------------------------
// Used for URLs that end up in .strm files / Copy URL output, so the upstream
// URL never appears in the proxy URL itself. The HLS proxy chain stays on
// /stream-raw (signed URL) since vouchers per segment would be wasteful.

const VOUCHER_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const selectVoucherByTarget = db.query<{ token: string; expires_at: number }, [string]>(
  `SELECT token, expires_at FROM stream_vouchers WHERE target_url = ? ORDER BY expires_at DESC LIMIT 1`
);
const selectVoucher = db.query<{ target_url: string; expires_at: number }, [string]>(
  `SELECT target_url, expires_at FROM stream_vouchers WHERE token = ?`
);
const insertVoucher = db.prepare(
  `INSERT INTO stream_vouchers (token, target_url, created_at, expires_at) VALUES (?, ?, ?, ?)`
);
const deleteExpiredVouchers = db.prepare(`DELETE FROM stream_vouchers WHERE expires_at < ?`);

/**
 * Issues (or reuses) an opaque voucher for a given upstream URL. Same URL
 * gets the same token until expiry, which keeps .strm files idempotent
 * and lets the cache stay warm.
 */
export function issueVoucher(target: string, ttlMs: number = VOUCHER_DEFAULT_TTL_MS): string {
  const now = Date.now();
  // Opportunistic cleanup
  if (Math.random() < 0.01) deleteExpiredVouchers.run(now);

  const existing = selectVoucherByTarget.get(target);
  if (existing && existing.expires_at > now + 60_000) return existing.token;

  const token = randomBytes(12).toString('base64url'); // 16 chars, opaque
  insertVoucher.run(token, target, now, now + ttlMs);
  return token;
}

export function redeemVoucher(token: string): string | null {
  const row = selectVoucher.get(token);
  if (!row) return null;
  if (row.expires_at <= Date.now()) return null;
  return row.target_url;
}

export function voucherUrlFor(baseUrl: string, target: string): string {
  return `${baseUrl}/v/${issueVoucher(target)}`;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

function filterHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v); });
  return out;
}

// --- HLS detection ---

function isPlaylistResponse(url: string, contentType: string | null): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('m3u')) return true;
  }
  return /\.m3u8(\?|$)/i.test(url);
}

function isPlaylistUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

function isSegmentUrl(url: string): boolean {
  return /\.(ts|m4s|aac|vtt)(\?|$)/i.test(url);
}

// --- HLS playlist rewrite ---

export function rewritePlaylist(playlist: string, upstreamUrl: string, baseUrl: string): string {
  const base = new URL(upstreamUrl);
  const lines = playlist.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (!line) { out.push(line); continue; }
    if (line.startsWith('#')) {
      out.push(line.replace(/URI="([^"]+)"/g, (_, u) => {
        if (u.startsWith('data:')) return `URI="${u}"`; // keep data: URIs as-is
        const abs = new URL(u, base).toString();
        return `URI="${rawProxyUrlFor(baseUrl, abs)}"`;
      }));
      continue;
    }
    const abs = new URL(line.trim(), base).toString();
    out.push(rawProxyUrlFor(baseUrl, abs));
  }
  return out.join('\n');
}

// --- LRU + single-flight cache (HLS only) ---

interface CacheEntry {
  body: Uint8Array;
  contentType: string;
  status: number;
  expiresAt: number;
  insertedAt: number;
  size: number;
}

const PLAYLIST_TTL_MS = 3_000;
const SEGMENT_TTL_MS  = 30_000;
const CACHE_MAX_BYTES = 500 * 1024 * 1024;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
let cacheBytes = 0;

let cacheHits = 0;
let cacheMisses = 0;
let inflightShares = 0;

function ttlFor(url: string): number {
  if (isPlaylistUrl(url)) return PLAYLIST_TTL_MS;
  if (isSegmentUrl(url))  return SEGMENT_TTL_MS;
  return 0;
}

function evictLRU(): void {
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value as string;
    const entry = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    cacheBytes -= entry.size;
  }
}

function getCached(url: string): CacheEntry | null {
  const e = cache.get(url);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    cache.delete(url);
    cacheBytes -= e.size;
    return null;
  }
  // Move to MRU position (delete + re-insert keeps insertion order = LRU order)
  cache.delete(url);
  cache.set(url, e);
  return e;
}

function putCached(url: string, entry: CacheEntry): void {
  const existing = cache.get(url);
  if (existing) cacheBytes -= existing.size;
  cache.set(url, entry);
  cacheBytes += entry.size;
  evictLRU();
}

const PLUTO_STITCHER_RE = /pluto\.tv/i;
const PLUTO_REQUIRED_HEADERS: Record<string, string> = {
  'plutotv-device-dnt': '0',
  'plutotv-device-model': 'web',
  'plutotv-device-make': 'firefox',
  'plutotv-device-type': 'web',
  'plutotv-app-name': 'web',
  'plutotv-app-version': '5.16.0',
};

async function doFetchAndBuild(upstreamUrl: string, req: Request, baseUrl: string): Promise<CacheEntry> {
  const headers: HeadersInit = {};
  const ua = req.headers.get('user-agent');
  if (ua) headers['user-agent'] = ua;
  const range = req.headers.get('range');
  if (range) headers['range'] = range;
  if (PLUTO_STITCHER_RE.test(upstreamUrl)) {
    Object.assign(headers, PLUTO_REQUIRED_HEADERS);
  }

  const upstream = await fetch(upstreamUrl, { redirect: 'follow', headers });
  const ct = upstream.headers.get('content-type') ?? 'application/octet-stream';

  let body: Uint8Array;
  if (isPlaylistResponse(upstreamUrl, ct)) {
    const text = await upstream.text();
    body = new TextEncoder().encode(rewritePlaylist(text, upstreamUrl, baseUrl));
  } else {
    body = new Uint8Array(await upstream.arrayBuffer());
  }

  const ttl = ttlFor(upstreamUrl);
  const now = Date.now();
  return {
    body,
    contentType: ct,
    status: upstream.status,
    expiresAt: now + ttl,
    insertedAt: now,
    size: body.length,
  };
}

async function streamPipe(upstreamUrl: string, req: Request): Promise<Response> {
  // Uncached pass-through for VOD / unknown / range requests
  const headers: HeadersInit = {};
  const ua = req.headers.get('user-agent');
  if (ua) headers['user-agent'] = ua;
  const range = req.headers.get('range');
  if (range) headers['range'] = range;
  if (PLUTO_STITCHER_RE.test(upstreamUrl)) {
    Object.assign(headers, PLUTO_REQUIRED_HEADERS);
  }
  const upstream = await fetch(upstreamUrl, { redirect: 'follow', headers });
  return new Response(upstream.body, { status: upstream.status, headers: filterHeaders(upstream.headers) });
}

async function cachedFetch(upstreamUrl: string, req: Request, baseUrl: string): Promise<Response> {
  const ttl = ttlFor(upstreamUrl);
  const hasRange = req.headers.has('range');
  if (ttl === 0 || hasRange) {
    cacheMisses++;
    return streamPipe(upstreamUrl, req);
  }

  const respond = (e: CacheEntry) =>
    new Response(new Blob([e.body]), { status: e.status, headers: { 'content-type': e.contentType } });

  const hit = getCached(upstreamUrl);
  if (hit) {
    cacheHits++;
    return respond(hit);
  }

  let promise = inflight.get(upstreamUrl);
  if (promise) {
    inflightShares++;
    return respond(await promise);
  }

  cacheMisses++;
  promise = doFetchAndBuild(upstreamUrl, req, baseUrl);
  inflight.set(upstreamUrl, promise);
  try {
    const entry = await promise;
    putCached(upstreamUrl, entry);
    return respond(entry);
  } finally {
    inflight.delete(upstreamUrl);
  }
}

// --- Active connection tracking (per source / per credential) ---

const activePerCred = new Map<string, number>(); // `${source}#${username}` -> count

function credKey(source: string, username: string): string {
  return `${source}#${username}`;
}
function incrCred(source: string, username: string): void {
  const k = credKey(source, username);
  activePerCred.set(k, (activePerCred.get(k) ?? 0) + 1);
}
function decrCred(source: string, username: string): void {
  const k = credKey(source, username);
  const n = (activePerCred.get(k) ?? 0) - 1;
  if (n <= 0) activePerCred.delete(k); else activePerCred.set(k, n);
}
export function getActiveConnections(source: string): number {
  let total = 0;
  const prefix = source + '#';
  for (const [k, v] of activePerCred) if (k.startsWith(prefix)) total += v;
  return total;
}
export function getCredentialActives(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  const prefix = source + '#';
  for (const [k, v] of activePerCred) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

// --- Credential picking + URL rewrite ---

interface MaxByUsername { [username: string]: number; }

function getMaxConnectionsByUsername(source: SourceRow): MaxByUsername {
  const info = source.info_json ? JSON.parse(source.info_json) as { credentials?: Array<Record<string, unknown>> } : null;
  const out: MaxByUsername = {};
  if (info?.credentials) {
    for (const c of info.credentials) {
      if (typeof c.username === 'string' && typeof c.maxConnections === 'number') {
        out[c.username] = c.maxConnections;
      }
    }
  }
  return out;
}

function pickCredential(source: SourceRow): { username: string; password: string } | null {
  const creds = getXtreamCredentials(source);
  if (creds.length === 0) return null;
  const maxByUser = getMaxConnectionsByUsername(source);
  // Score each credential: prefer one with most spare (max - active). Unknown max -> assume 1.
  let best: { cred: { username: string; password: string }; active: number; spare: number } | null = null;
  for (const c of creds) {
    const active = activePerCred.get(credKey(source.name, c.username)) ?? 0;
    const max = maxByUser[c.username] ?? 1;
    const spare = max - active;
    if (!best || spare > best.spare || (spare === best.spare && active < best.active)) {
      best = { cred: c, active, spare };
    }
  }
  return best?.cred ?? null;
}

const XTREAM_URL_RE = /^(https?:\/\/[^/]+)\/(live|movie|series)\/([^/]+)\/([^/]+)\/(.+)$/i;

function rewriteXtreamUrl(originalUrl: string, username: string, password: string): string {
  const m = originalUrl.match(XTREAM_URL_RE);
  if (!m) return originalUrl;
  return `${m[1]}/${m[2]}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${m[5]}`;
}

// --- Handlers ---

export async function handleStreamByKey(key: string, token: string, req: Request, baseUrl: string): Promise<Response> {
  if (!verify(key, token)) return new Response('forbidden', { status: 403 });
  const row = db.query<{ stream_url: string | null }, [string]>(`SELECT stream_url FROM channels WHERE key = ?`).get(key);
  if (!row || !row.stream_url) return new Response('not found', { status: 404 });

  const sourceName = key.split(':')[0];
  const source = getSourceByName(sourceName);

  // Pluto VOD (movies) — route to the AES-128 DRM proxy which mints an entitled
  // token and propagates it. channel_id is "vod-<contentId>".
  if (sourceName === 'PlutoTV') {
    const chId = key.slice('PlutoTV:'.length);
    if (chId.startsWith('vod-')) {
      const contentId = chId.slice('vod-'.length);
      return new Response(null, { status: 302, headers: { location: `${baseUrl}/drm/pluto/${encodeURIComponent(contentId)}/master.m3u8` } });
    }
  }

  let upstreamUrl = row.stream_url;
  let chosenUsername: string | null = null;

  // Lazy resolution for Tubi VOD — stream_url is "tubi-vod:<id>", actual HLS
  // URL needs a page scrape. DRM titles are redirected to the DRM proxy
  // (/drm/tubi/<id>) which decrypts server-side; clear titles stream directly.
  if (upstreamUrl.startsWith('tubi-vod:') || upstreamUrl.startsWith('tubi-episode:')) {
    const isEpisode = upstreamUrl.startsWith('tubi-episode:');
    const id = upstreamUrl.slice((isEpisode ? 'tubi-episode:' : 'tubi-vod:').length);
    const { resolveTubiVodFull } = await import('../sources/Tubi');
    const info = await resolveTubiVodFull(isEpisode ? 'tv-shows' : 'movies', id);
    if (!info) return new Response('Tubi VOD stream unresolvable', { status: 404 });
    if (info.isDrm) {
      return new Response(null, { status: 302, headers: { location: `${baseUrl}/drm/tubi/${encodeURIComponent(id)}/master.m3u8` } });
    }
    upstreamUrl = info.manifestUrl;
  }

  if (source && source.type === 'xtream') {
    const cred = pickCredential(source);
    if (cred) {
      upstreamUrl = rewriteXtreamUrl(row.stream_url, cred.username, cred.password);
      chosenUsername = cred.username;
    }
  }

  if (chosenUsername) incrCred(sourceName, chosenUsername);
  try {
    return await cachedFetch(upstreamUrl, req, baseUrl);
  } finally {
    if (chosenUsername) decrCred(sourceName, chosenUsername);
  }
}

function identifyCredentialFromUrl(target: string): { sourceName: string; username: string } | null {
  const m = target.match(XTREAM_URL_RE);
  if (!m) return null;
  const host = m[1];
  const username = decodeURIComponent(m[3]);
  // Walk Xtream sources looking for one whose host + username matches.
  const rows = db.query<{ name: string; config_json: string }, []>(
    `SELECT name, config_json FROM sources WHERE type = 'xtream'`
  ).all();
  for (const r of rows) {
    const cfg = JSON.parse(r.config_json) as Record<string, unknown>;
    if (String(cfg.host ?? '') !== host) continue;
    const creds = Array.isArray(cfg.credentials) ? cfg.credentials as Array<Record<string, unknown>> : [];
    if (creds.some(c => c.username === username)) {
      return { sourceName: r.name, username };
    }
  }
  return null;
}

export async function handleVoucher(token: string, req: Request, baseUrl: string): Promise<Response> {
  const target = redeemVoucher(token);
  if (!target) return new Response('voucher invalid or expired', { status: 404 });
  if (!/^https?:\/\//i.test(target)) return new Response('invalid url', { status: 400 });
  const cred = identifyCredentialFromUrl(target);
  if (cred) incrCred(cred.sourceName, cred.username);
  try {
    return await cachedFetch(target, req, baseUrl);
  } finally {
    if (cred) decrCred(cred.sourceName, cred.username);
  }
}

export async function handleRawStream(target: string, token: string, req: Request, baseUrl: string): Promise<Response> {
  if (!verify(target, token)) return new Response('forbidden', { status: 403 });
  if (!/^https?:\/\//i.test(target)) return new Response('invalid url', { status: 400 });

  const cred = identifyCredentialFromUrl(target);
  if (cred) incrCred(cred.sourceName, cred.username);
  try {
    return await cachedFetch(target, req, baseUrl);
  } finally {
    if (cred) decrCred(cred.sourceName, cred.username);
  }
}

export function getCacheStats(): {
  entries: number; bytes: number; maxBytes: number; hits: number; misses: number; inflightShares: number;
} {
  return {
    entries: cache.size,
    bytes: cacheBytes,
    maxBytes: CACHE_MAX_BYTES,
    hits: cacheHits,
    misses: cacheMisses,
    inflightShares,
  };
}
