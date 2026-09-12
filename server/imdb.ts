import { db, getSetting } from './db';
import { queryTorrentio, pickBestPlayable, qualityScore, infoHashFromStream, type TorrentioStream } from '../helpers/torrentio';
import { getPins, type Pin } from './catalog';
import { buildEpisodeUrl, loadEpisodes } from './series';

function loadConfig(): { rdApiKey?: string; endpoint?: string } {
  return {
    rdApiKey: getSetting('rd_api_key') ?? undefined,
    endpoint: getSetting('torrentio_endpoint') ?? undefined,
  };
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const selectCached = db.query<
  { url: string; title: string | null; quality: string | null; expires_at: number },
  [string, string]
>(`SELECT url, title, quality, expires_at FROM imdb_resolutions WHERE imdb_id = ? AND episode = ?`);

const insertCached = db.prepare(`
  INSERT OR REPLACE INTO imdb_resolutions (imdb_id, episode, url, info_hash, title, quality, resolved_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export interface ResolvedStream {
  url: string;
  title: string;
  quality: string;
  source: 'pin-channel' | 'pin-torrentio' | 'pin-episode' | 'pin-tubi' | 'torrentio-auto';
  cached: boolean;
  // Set when source === 'pin-channel'. Lets the caller route via /stream/<key>.
  channelKey?: string;
  // Owning source name for channel + episode resolutions, used to look up per-source proxyMode.
  sourceName?: string;
}

async function torrentioBestForPin(
  imdbId: string, season: number | undefined, episode: number | undefined, pinHash?: string
): Promise<TorrentioStream | null> {
  const cfg = loadConfig();
  const endpoint = cfg.endpoint ?? 'https://torrentio.strem.fun';
  const streams = await queryTorrentio({
    endpoint, rdApiKey: cfg.rdApiKey,
    kind: season != null ? 'series' : 'movie',
    imdbId, season, episode,
  });
  if (pinHash) {
    const want = pinHash.toLowerCase();
    const match = streams.find(s => infoHashFromStream(s)?.toLowerCase() === want);
    if (match) return match;
    return null; // pin requested specific hash but it isn't available
  }
  return pickBestPlayable(streams);
}

async function resolvePin(
  pin: Pin, imdbId: string, season: number | undefined, episode: number | undefined
): Promise<ResolvedStream | null> {
  if (pin.type === 'channel') {
    const row = db.query<{ stream_url: string | null; name: string }, [string]>(
      `SELECT stream_url, name FROM channels WHERE key = ?`
    ).get(pin.channelKey);
    if (!row?.stream_url) return null;
    return {
      url: row.stream_url,
      title: row.name,
      quality: '',
      source: 'pin-channel',
      cached: false,
      channelKey: pin.channelKey,
      sourceName: pin.channelKey.split(':')[0],
    };
  }
  if (pin.type === 'episode') {
    // Ensure episodes are loaded for the series
    try { await loadEpisodes(pin.seriesKey); } catch { /* fall through; buildEpisodeUrl will return null */ }
    const url = await buildEpisodeUrl(pin.seriesKey, pin.season, pin.episode);
    if (!url) return null;
    return {
      url,
      title: pin.title ?? `S${pin.season}E${pin.episode}`,
      quality: '',
      source: 'pin-episode',
      cached: false,
      sourceName: pin.seriesKey.split(':')[0],
    };
  }
  if (pin.type === 'tubi') {
    // Route to the stable, self-refreshing Tubi endpoint (/drm/tubi/<id>/
    // master.m3u8) — it re-resolves Tubi's short-lived signed token on every
    // open and proxies everything server-side (DRM decrypted, clear passed
    // through). Same shape as Pluto; never a frozen direct link or voucher.
    // DB stores IDs with a "vod-" prefix (e.g. "vod-639561"); strip it.
    const rawTubiId = pin.tubiId.replace(/^vod-/, '');
    return {
      url: `drm-tubi:${rawTubiId}`,
      title: pin.title ?? `Tubi ${pin.tubiId}`,
      quality: '',
      source: 'pin-tubi',
      cached: false,
      sourceName: 'Tubi',
    };
  }
  if (pin.type === 'torrentio') {
    const stream = await torrentioBestForPin(imdbId, season, episode, pin.infoHash);
    if (!stream?.url) return null;
    return {
      url: stream.url,
      title: stream.title ?? '',
      quality: String(qualityScore(stream)),
      source: 'pin-torrentio',
      cached: false,
    };
  }
  return null;
}

// A version selector targets one specific source for a title, instead of
// letting the resolver collapse the pin→channel→auto chain to a single best.
export type VersionSelector =
  | { kind: 'torrentio'; infoHash: string }
  | { kind: 'channel'; channelKey: string }
  | { kind: 'episode'; seriesKey: string }
  | { kind: 'tubi'; tubiId: string; manifestUrl?: string };

function selectorToPin(sel: VersionSelector, season?: number, episode?: number): Pin | null {
  switch (sel.kind) {
    case 'torrentio': return { type: 'torrentio', infoHash: sel.infoHash };
    case 'channel':   return { type: 'channel', channelKey: sel.channelKey };
    case 'episode':
      if (season == null || episode == null) return null;
      return { type: 'episode', seriesKey: sel.seriesKey, season, episode };
    case 'tubi':      return { type: 'tubi', tubiId: sel.tubiId, manifestUrl: sel.manifestUrl };
  }
}

export async function resolveImdb(
  imdbId: string,
  season?: number,
  episode?: number,
  opts: { forceFresh?: boolean; selector?: VersionSelector; strict?: boolean } = {}
): Promise<ResolvedStream | null> {
  const ep = season != null && episode != null ? `${season}:${episode}` : '';
  const now = Date.now();

  // Version-addressed resolve: target one specific source, bypassing the
  // imdb_resolutions cache (keyed only by imdb+episode, so it would collide
  // with the "best" auto result). On miss, fall back to the normal chain
  // unless strict.
  if (opts.selector) {
    const pin = selectorToPin(opts.selector, season, episode);
    if (pin) {
      try {
        const r = await resolvePin(pin, imdbId, season, episode);
        if (r) return r;
      } catch { /* fall through */ }
    }
    // A specific source was requested — never silently fall through to
    // Torrentio on failure. Return null (404) so the user sees an honest
    // "not found" rather than a random different source playing.
    return null;
  }

  if (!opts.forceFresh) {
    const cached = selectCached.get(imdbId, ep);
    if (cached && cached.expires_at > now) {
      return { url: cached.url, title: cached.title ?? '', quality: cached.quality ?? '', source: 'torrentio-auto', cached: true };
    }
  }

  // Pin chain first
  const pins = getPins(imdbId, season, episode);
  for (const pin of pins) {
    try {
      const r = await resolvePin(pin, imdbId, season, episode);
      if (r) {
        // Channel/episode pins are cheap to re-resolve; only cache torrentio results.
        if (r.source !== 'pin-channel' && r.source !== 'pin-episode') {
          insertCached.run(imdbId, ep, r.url, null, r.title || null, r.quality || null, now, now + CACHE_TTL_MS);
        }
        return r;
      }
    } catch (e) {
      // try next pin
    }
  }

  // Auto-fallback: best Torrentio result
  try {
    const stream = await torrentioBestForPin(imdbId, season, episode);
    if (stream?.url) {
      const title = stream.title ?? '';
      const quality = String(qualityScore(stream));
      insertCached.run(imdbId, ep, stream.url, infoHashFromStream(stream) ?? null, title || null, quality, now, now + CACHE_TTL_MS);
      return { url: stream.url, title, quality, source: 'torrentio-auto', cached: false };
    }
  } catch (e) {
    // fall through
  }

  return null;
}

export function cleanupExpiredResolutions(): void {
  db.run(`DELETE FROM imdb_resolutions WHERE expires_at < ?`, [Date.now()]);
}
