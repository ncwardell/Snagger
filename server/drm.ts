// DRM VOD proxy — serves Widevine-protected Tubi (and later Pluto) VOD as clear
// HLS to any player. The player fetches a normal-looking playlist; Snagger
// fetches the content keys (helpers/widevine.ts), decrypts each fMP4 segment
// (helpers/cenc.ts), and streams clear video. Nothing DRM ever reaches the
// client.
//
// Routes (all GET):
//   /drm/tubi/<id>/master.m3u8              resolve + rewrite master
//   /drm/tubi/<id>/v.m3u8?u=<b64url>        rewrite a variant/audio playlist
//   /drm/tubi/<id>/s.mp4?kind=init|seg&...  decrypt an init or media segment

import { resolveTubiVodFull, type TubiVodInfo } from '../sources/Tubi';
import { getPlutoVodToken, plutoVodMasterUrl } from '../sources/PlutoTV';
import { getSourceByName } from './sources';
import { rewritePlaylist } from './proxy';
import { getContentKeys, type ContentKeys } from '../helpers/widevine';
import { decryptAndSplit } from '../helpers/cenc';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0';
const FETCH_HDR = { 'User-Agent': UA, 'Origin': 'https://tubitv.com', 'Referer': 'https://tubitv.com/' };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

// Per-content DRM context so init/seg handlers can (re)derive keys.
interface DrmCtx { manifestUrl: string; licenseUrl: string; pssh: string; }
const ctx = new Map<string, DrmCtx>();

function txt(body: string) {
  return new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
}
function mp4(body: Uint8Array) {
  return new Response(new Blob([body]), { headers: { 'content-type': 'video/mp4' } });
}

async function fetchRange(url: string, range: string | null): Promise<Uint8Array> {
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (range) {
    // HLS byterange is "length@offset"
    const [lenStr, offStr] = range.split('@');
    const off = offStr ? Number(offStr) : 0;
    headers['Range'] = `bytes=${off}-${off + Number(lenStr) - 1}`;
  }
  const r = await fetch(url, { headers });
  return new Uint8Array(await r.arrayBuffer());
}

// Extract the Widevine PSSH from a variant playlist's #EXT-X-KEY data URI.
function psshFromVariant(variant: string): string | null {
  const line = variant.split(/\r?\n/).find(l => l.startsWith('#EXT-X-KEY') && l.includes('URI='));
  if (!line) return null;
  const m = line.match(/URI="data:text\/plain;base64,([^"]+)"/);
  return m ? m[1] : null;
}

// Ensure we have DRM context + keys warmed for a content id. Returns the keys.
// `pre` lets the caller pass an already-resolved manifest to avoid re-scraping.
async function ensureKeys(id: string, pre?: TubiVodInfo): Promise<{ c: DrmCtx; keys: ContentKeys }> {
  let c = ctx.get(id);
  if (!c) {
    // Tubi ids are numeric; try movies first then tv-shows.
    const info = pre ?? (await resolveTubiVodFull('movies', id)) ?? (await resolveTubiVodFull('tv-shows', id));
    if (!info || !info.isDrm || !info.licenseUrl) throw new Error('tubi DRM: could not resolve DRM manifest');
    const master = await (await fetch(info.manifestUrl, { headers: { 'User-Agent': UA } })).text();
    const firstVariant = master.split(/\r?\n/).find(l => l && !l.startsWith('#'));
    if (!firstVariant) throw new Error('tubi DRM: empty master');
    const variant = await (await fetch(new URL(firstVariant, info.manifestUrl).toString(), { headers: { 'User-Agent': UA } })).text();
    const pssh = psshFromVariant(variant);
    if (!pssh) throw new Error('tubi DRM: no PSSH in variant');
    c = { manifestUrl: info.manifestUrl, licenseUrl: info.licenseUrl, pssh };
    ctx.set(id, c);
  }
  const keys = await getContentKeys({ cacheKey: id, pssh: c.pssh, licenseUrl: c.licenseUrl, headers: { 'User-Agent': UA } });
  return { c, keys };
}

export async function handleTubiMaster(id: string, baseUrl: string): Promise<Response> {
  // Re-resolve on every open so Tubi's short-lived signed token is always
  // fresh — this is why the URL is stable and self-refreshing (like Pluto),
  // rather than a frozen voucher that dies when the token expires.
  const info = (await resolveTubiVodFull('movies', id)) ?? (await resolveTubiVodFull('tv-shows', id));
  if (!info) return new Response('tubi: unresolvable', { status: 404 });

  // Clear (non-DRM) Tubi: proxy through the standard HLS rewriter, which
  // rewrites variants/segments to /stream-raw and forwards byte-range requests.
  // No CDM/decrypt needed.
  if (!info.isDrm) {
    const master = await (await fetch(info.manifestUrl, { headers: { 'User-Agent': UA } })).text();
    return txt(rewritePlaylist(master, info.manifestUrl, baseUrl));
  }

  // DRM (Widevine): decrypt server-side.
  const { c } = await ensureKeys(id, info);
  const master = await (await fetch(c.manifestUrl, { headers: { 'User-Agent': UA } })).text();
  const prefix = `${baseUrl}/drm/tubi/${id}`;
  const out = master.split(/\r?\n/).map(line => {
    // Rewrite EXT-X-MEDIA (audio) URI="…" to our variant proxy
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (_, u) => `URI="${prefix}/v.m3u8?u=${b64(new URL(u, c.manifestUrl).toString())}"`);
    }
    // Rewrite variant stream URIs (non-comment lines)
    if (line && !line.startsWith('#')) {
      return `${prefix}/v.m3u8?u=${b64(new URL(line, c.manifestUrl).toString())}`;
    }
    return line;
  }).join('\n');
  return txt(out);
}

export async function handleTubiVariant(id: string, variantUrlB64: string, baseUrl: string): Promise<Response> {
  await ensureKeys(id); // ensure ctx exists
  const variantUrl = unb64(variantUrlB64);
  const variant = await (await fetch(variantUrl, { headers: { 'User-Agent': UA } })).text();
  const prefix = `${baseUrl}/drm/tubi/${id}`;

  const lines = variant.split(/\r?\n/);
  const out: string[] = [];
  let mapUrl = '';
  let mapRange = '';
  let firstSeg: { url: string; range: string } | null = null;
  let cursor = 0;          // running byte offset for byteranges without explicit @offset
  let pendingRange: string | null = null;

  // First pass: find the map + first segment (needed to decrypt the init).
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP')) {
      const um = l.match(/URI="([^"]+)"/);
      const bm = l.match(/BYTERANGE="([^"]+)"/);
      if (um) { mapUrl = new URL(um[1], variantUrl).toString(); mapRange = bm ? bm[1] : ''; }
    }
  }
  // resolve the first media segment's absolute range for the init decrypt
  {
    let cur = 0;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-BYTERANGE')) pendingRange = l.split(':')[1];
      else if (l && !l.startsWith('#')) {
        const abs = absRange(pendingRange, cur);
        firstSeg = { url: new URL(l, variantUrl).toString(), range: abs.range };
        break;
      }
    }
    pendingRange = null;
  }

  for (const l of lines) {
    if (l.startsWith('#EXT-X-KEY')) continue; // strip DRM signaling
    if (l.startsWith('#EXT-X-MAP')) {
      const initUrl = `${prefix}/s.mp4?kind=init&map=${b64(mapUrl)}&mr=${encodeURIComponent(mapRange)}`
        + (firstSeg ? `&u=${b64(firstSeg.url)}&r=${encodeURIComponent(firstSeg.range)}` : '');
      out.push(`#EXT-X-MAP:URI="${initUrl}"`);
      continue;
    }
    if (l.startsWith('#EXT-X-BYTERANGE')) { pendingRange = l.split(':')[1]; continue; } // drop, fold into seg url
    if (l && !l.startsWith('#')) {
      const abs = absRange(pendingRange, cursor);
      cursor = abs.next;
      pendingRange = null;
      const segUrl = new URL(l, variantUrl).toString();
      out.push(`${prefix}/s.mp4?kind=seg&map=${b64(mapUrl)}&mr=${encodeURIComponent(mapRange)}&u=${b64(segUrl)}&r=${encodeURIComponent(abs.range)}`);
      continue;
    }
    out.push(l);
  }
  return txt(out.join('\n'));
}

// Resolve an HLS byterange (which may omit @offset) to an absolute "len@off"
// and the next cursor position.
function absRange(range: string | null, cursor: number): { range: string; next: number } {
  if (!range) return { range: '', next: cursor };
  const [lenStr, offStr] = range.split('@');
  const len = Number(lenStr);
  const off = offStr != null ? Number(offStr) : cursor;
  return { range: `${len}@${off}`, next: off + len };
}

export async function handleTubiSegment(id: string, params: URLSearchParams): Promise<Response> {
  const { keys } = await ensureKeys(id);
  const kind = params.get('kind') ?? 'seg';
  const mapUrl = unb64(params.get('map') ?? '');
  const mapRange = params.get('mr') || null;
  const segUrl = unb64(params.get('u') ?? '');
  const segRange = params.get('r') || null;

  const encInit = await fetchRange(mapUrl, mapRange);
  const encSeg = await fetchRange(segUrl, segRange);
  const { init, fragment } = await decryptAndSplit(encInit, encSeg, keys);
  return mp4(kind === 'init' ? init : fragment);
}

// ─── Pluto VOD: authenticated AES-128 HLS proxy ─────────────────────────────
// Unlike Tubi, Pluto VOD is plain AES-128 clear-key HLS (no Widevine). Snagger
// proxies the playlists, propagates the entitled jwt to every sub-request, and
// leaves the EXT-X-KEY intact — the player decrypts AES-128 natively. The key
// file is public (no jwt) but proxied for same-origin cleanliness.

function plutoCreds(): { email?: string; password?: string } {
  const src = getSourceByName('PlutoTV');
  if (!src) return {};
  try { const c = JSON.parse(src.config_json) as Record<string, unknown>; return { email: c.email as string, password: c.password as string }; }
  catch { return {}; }
}

// Append the jwt query param to a URL (segments/variants need it; harmless on keys).
function withJwt(u: string, jwt: string): string {
  return u + (u.includes('?') ? '&' : '?') + 'jwt=' + jwt;
}

export async function handlePlutoMaster(id: string, baseUrl: string): Promise<Response> {
  const jwt = await getPlutoVodToken(plutoCreds());
  const masterUrl = plutoVodMasterUrl(id, jwt);
  const master = await (await fetch(masterUrl, { headers: { 'User-Agent': UA } })).text();
  if (!master.startsWith('#EXTM3U')) throw new Error(`pluto master: ${master.slice(0, 100)}`);
  const prefix = `${baseUrl}/drm/pluto/${id}`;
  const out = master.split(/\r?\n/).map(line => {
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (_, u) => `URI="${prefix}/v.m3u8?u=${b64(withJwt(new URL(u, masterUrl).toString(), jwt))}"`);
    }
    if (line && !line.startsWith('#')) {
      return `${prefix}/v.m3u8?u=${b64(withJwt(new URL(line, masterUrl).toString(), jwt))}`;
    }
    return line;
  }).join('\n');
  return txt(out);
}

export async function handlePlutoVariant(id: string, variantUrlB64: string, baseUrl: string): Promise<Response> {
  const variantUrl = unb64(variantUrlB64);
  const jwt = new URL(variantUrl).searchParams.get('jwt') ?? await getPlutoVodToken(plutoCreds());
  const variant = await (await fetch(variantUrl, { headers: { 'User-Agent': UA } })).text();
  const prefix = `${baseUrl}/drm/pluto/${id}`;
  const out = variant.split(/\r?\n/).map(line => {
    // rewrite the AES-128 key URI through our raw proxy (keep METHOD/IV intact)
    if (line.startsWith('#EXT-X-KEY') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (_, u) => `URI="${prefix}/raw?u=${b64(new URL(u, variantUrl).toString())}"`);
    }
    if (line.startsWith('#') || !line) return line;
    // media segment — proxy through /raw with the jwt attached
    return `${prefix}/raw?u=${b64(withJwt(new URL(line, variantUrl).toString(), jwt))}`;
  }).join('\n');
  return txt(out);
}

export async function handlePlutoRaw(url64: string): Promise<Response> {
  const target = unb64(url64);
  const r = await fetch(target, { headers: { 'User-Agent': UA } });
  const ct = target.includes('.key') ? 'application/octet-stream'
    : target.includes('.m3u8') ? 'application/vnd.apple.mpegurl'
    : 'video/mp2t';
  return new Response(r.body, { status: r.status, headers: { 'content-type': ct } });
}
