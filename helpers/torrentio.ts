export interface TorrentioStream {
  name?: string;
  title?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { bingeGroup?: string; filename?: string };
}

export interface TorrentioQuery {
  endpoint: string;
  rdApiKey?: string;
  kind: 'movie' | 'series';
  imdbId: string;
  season?: number;
  episode?: number;
}

export async function queryTorrentio(opts: TorrentioQuery): Promise<TorrentioStream[]> {
  const auth = opts.rdApiKey ? `realdebrid=${opts.rdApiKey}/` : '';
  const idPart = opts.kind === 'series' && opts.season != null && opts.episode != null
    ? `${opts.imdbId}:${opts.season}:${opts.episode}`
    : opts.imdbId;
  const base = opts.endpoint.endsWith('/') ? opts.endpoint.slice(0, -1) : opts.endpoint;
  const url = `${base}/${auth}stream/${opts.kind}/${idPart}.json`;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Torrentio ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { streams?: TorrentioStream[] };
  return data.streams ?? [];
}

// In Real-Debrid mode Torrentio drops the top-level `infoHash` field and only
// returns a resolve URL of the form
//   https://…/resolve/realdebrid/<KEY>/<40-hex-infohash>/<fileIdx>/<n>/<file>
// The hash is the sole 40-hex path segment (the RD key is base32, non-hex).
// Fall back to parsing it so callers have a stable identifier either way.
const URL_INFOHASH_RE = /\/([0-9a-f]{40})(?:\/|$)/i;

export function infoHashFromStream(s: TorrentioStream): string | undefined {
  if (s.infoHash) return s.infoHash;
  const m = s.url?.match(URL_INFOHASH_RE);
  return m ? m[1].toLowerCase() : undefined;
}

const QUALITY_RE = /(2160p|4k|1080p|720p|480p|hdr|dolby|atmos)/i;

// Torrentio puts health on a later line of the title: "👤 51 💾 1.26 GB ⚙️ ThePirateBay".
const SEEDERS_RE = /👤\s*(\d+)/;

/** Seeder count advertised by Torrentio, if present. A well-seeded release is
 *  far likelier to actually play than a high-quality dead one. */
export function seedersFromStream(s: TorrentioStream): number | undefined {
  const m = `${s.title ?? ''} ${s.name ?? ''}`.match(SEEDERS_RE);
  return m ? Number(m[1]) : undefined;
}

export function qualityScore(s: TorrentioStream): number {
  const text = `${s.title ?? ''} ${s.name ?? ''}`.toLowerCase();
  let score = 0;
  if (text.includes('2160') || text.includes('4k')) score += 40;
  else if (text.includes('1080')) score += 30;
  else if (text.includes('720'))  score += 20;
  else if (text.includes('480'))  score += 10;
  if (text.includes('hdr'))    score += 4;
  if (text.includes('dolby'))  score += 2;
  if (text.includes('atmos'))  score += 2;
  if (text.includes('cam') || text.includes('telesync') || text.includes('ts ')) score -= 50;
  return score;
}

export function pickBestPlayable(streams: TorrentioStream[]): TorrentioStream | null {
  const playable = streams.filter(s => typeof s.url === 'string' && /^https?:\/\//.test(s.url));
  if (!playable.length) return null;
  return [...playable].sort((a, b) => qualityScore(b) - qualityScore(a))[0];
}
