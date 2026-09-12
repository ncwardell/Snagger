import { db, getSetting, getActiveTemplateId } from './db';
import { queryTorrentio, qualityScore, infoHashFromStream, seedersFromStream, type TorrentioStream } from '../helpers/torrentio';
import { tmdbSearch, tmdbList, tmdbDetail, tmdbFindByImdb, tmdbEpisodes, type TMDBTitleDetail } from '../helpers/tmdb';
import { findSeriesByTitle, loadEpisodes, type Episode } from './series';
import { searchTubi, fetchTubiSeriesEpisodes, type TubiSearchHit } from '../sources/Tubi';

export type Pin =
  | { type: 'channel'; channelKey: string }
  | { type: 'torrentio'; infoHash?: string; title?: string }
  | { type: 'episode'; seriesKey: string; season: number; episode: number; title?: string }
  | { type: 'tubi'; tubiId: string; title?: string; manifestUrl?: string };

function tmdbKey(): string {
  const k = getSetting('tmdb_api_key');
  if (!k) throw new Error('TMDB API key not configured (Settings → Resolvers → TMDB API key)');
  return k;
}

function rdKey(): string | undefined {
  return getSetting('rd_api_key') ?? undefined;
}

function torrentioEndpoint(): string {
  return getSetting('torrentio_endpoint') ?? 'https://torrentio.strem.fun';
}

// ---- TMDB pass-through with IMDB ID enrichment for results ----

async function enrichWithImdb(kind: 'movie' | 'tv', results: Array<{ tmdbId: number }>): Promise<Array<Record<string, unknown>>> {
  // Per-card detail fetch would be N+1 — too slow. Search/popular results omit imdb_id; user clicks
  // a title to view detail, and that's when we fetch the full record + imdb_id.
  return results as unknown as Array<Record<string, unknown>>;
}

export async function searchCatalog(q: string, kind: 'movie' | 'tv', page: number) {
  return await tmdbSearch(tmdbKey(), q, kind, page);
}

export type CatalogList = 'popular' | 'trending' | 'top_rated';

export async function popularCatalog(kind: 'movie' | 'tv', page: number, list: CatalogList = 'popular') {
  return await tmdbList(tmdbKey(), list, kind, page);
}

export async function titleDetailByImdb(imdbId: string): Promise<TMDBTitleDetail | null> {
  return await tmdbFindByImdb(tmdbKey(), imdbId);
}

export async function titleDetailByTmdb(kind: 'movie' | 'tv', tmdbId: number): Promise<TMDBTitleDetail> {
  return await tmdbDetail(tmdbKey(), kind, tmdbId);
}

export async function episodes(tmdbId: number, season: number) {
  return await tmdbEpisodes(tmdbKey(), tmdbId, season);
}

// ---- Pins ----

const selectPins = db.query<{ pins_json: string }, [string, number, number]>(
  `SELECT pins_json FROM imdb_pins WHERE imdb_id = ? AND season = ? AND episode = ?`
);

const upsertPins = db.prepare(`
  INSERT INTO imdb_pins (imdb_id, season, episode, pins_json, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(imdb_id, season, episode) DO UPDATE SET
    pins_json = excluded.pins_json,
    updated_at = excluded.updated_at
`);

const deletePins = db.prepare(`DELETE FROM imdb_pins WHERE imdb_id = ? AND season = ? AND episode = ?`);

export function getPins(imdbId: string, season?: number, episode?: number): Pin[] {
  const row = selectPins.get(imdbId, season ?? -1, episode ?? -1);
  if (!row) return [];
  try { return JSON.parse(row.pins_json) as Pin[]; } catch { return []; }
}

export function setPins(imdbId: string, season: number | undefined, episode: number | undefined, pins: Pin[]): void {
  if (pins.length === 0) {
    deletePins.run(imdbId, season ?? -1, episode ?? -1);
  } else {
    upsertPins.run(imdbId, season ?? -1, episode ?? -1, JSON.stringify(pins), Date.now());
  }
}

// ---- Resolution options: torrentio results + channel matches ----

export interface SourceOption {
  kind: 'channel' | 'torrentio' | 'episode' | 'tubi';
  // channel
  channelKey?: string;
  channelName?: string;
  channelSource?: string;
  channelGroup?: string | null;
  // torrentio
  infoHash?: string;
  title?: string;
  quality?: number;
  seeders?: number;
  url?: string;
  // episode
  seriesKey?: string;
  seriesName?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string | null;
  // tubi
  tubiId?: string;
  tubiType?: 'movie' | 'series' | 'unknown';
  tubiYear?: number;
  tubiPoster?: string;
  tubiManifest?: string;
}

export async function listSourceOptions(imdbId: string, kind: 'movie' | 'tv', season?: number, episode?: number, titleHint?: string): Promise<{ torrentio: SourceOption[]; channels: SourceOption[]; episodes: SourceOption[]; tubi: SourceOption[] }> {
  const torr = await listTorrentio(imdbId, kind, season, episode);

  const channels: SourceOption[] = [];
  const episodes: SourceOption[] = [];
  const tubi: SourceOption[] = [];

  // ── IMDB-anchored channel matches (user-set imdb_id overrides) ──
  // These take precedence over fuzzy title matching since they're explicit.
  const tplId = getActiveTemplateId();
  const anchored = db.query<
    { key: string; name: string; source: string; group: string | null; stream_type: string },
    [number, string]
  >(`
    SELECT c.key, c.name, c.source, c."group", c.stream_type
    FROM channels c
    JOIN overrides o ON o.key = c.key
    WHERE o.template_id = ? AND o.imdb_id = ?
  `).all(tplId, imdbId);
  for (const r of anchored) {
    if (r.stream_type === 'series' && kind === 'tv' && season != null && episode != null) {
      // For series-anchored TV titles, surface the matching episode
      try {
        const eps = await loadEpisodes(r.key);
        const ep = eps.find(e => e.season === season && e.episode === episode);
        if (ep) {
          episodes.push({
            kind: 'episode',
            seriesKey: r.key,
            seriesName: r.name,
            channelSource: r.source,
            season, episode,
            episodeTitle: ep.title,
          });
        }
      } catch { /* fall through */ }
    } else if (r.stream_type === 'movie' && kind === 'movie') {
      channels.push({
        kind: 'channel',
        channelKey: r.key,
        channelName: r.name,
        channelSource: r.source,
        channelGroup: r.group,
      });
    }
  }

  if (titleHint) {
    if (kind === 'movie') {
      const q = '%' + titleHint.toLowerCase() + '%';
      const rows = db.query<{ key: string; name: string; source: string; group: string | null }, [string]>(
        `SELECT key, name, source, "group" FROM channels
         WHERE stream_type = 'movie' AND lower(name) LIKE ?
         LIMIT 50`
      ).all(q);
      for (const r of rows) {
        channels.push({
          kind: 'channel',
          channelKey: r.key,
          channelName: r.name,
          channelSource: r.source,
          channelGroup: r.group,
        });
      }
    } else if (kind === 'tv' && season != null && episode != null) {
      // Find matching series in our Xtream sources; load their episodes lazily.
      const matches = findSeriesByTitle(titleHint, 8);
      const epLoads = await Promise.allSettled(matches.map(m => loadEpisodes(m.seriesKey)));
      matches.forEach((m, i) => {
        const r = epLoads[i];
        if (r.status !== 'fulfilled') return;
        const ep = (r.value as Episode[]).find(e => e.season === season && e.episode === episode);
        if (!ep) return;
        episodes.push({
          kind: 'episode',
          seriesKey: m.seriesKey,
          seriesName: m.seriesName,
          channelSource: m.sourceName,
          season,
          episode,
          episodeTitle: ep.title,
        });
      });
    }
  }

  // ── Tubi VOD match ──────────────────────────────────────────────────────
  // Tubi exposes no imdb_id, so we match by metadata: search by title, require
  // the year to line up, then corroborate with cast/director overlap from TMDB.
  // DRM titles are decrypted server-side via /drm/tubi, so they're playable now.
  try {
    tubi.push(...await matchTubiVod(imdbId, kind, season, episode));
  } catch { /* never let a Tubi miss break the catalog */ }

  return { torrentio: torr, channels, episodes, tubi };
}

// --- Tubi cross-source matching (no shared IDs → title + year + cast/crew) ---

function normTitle(s: string): string {
  return s.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function overlapCount(a: string[] | undefined, b: string[] | undefined): number {
  if (!a?.length || !b?.length) return 0;
  const setB = new Set(b.map(normName));
  let n = 0;
  for (const x of a) if (setB.has(normName(x))) n++;
  return n;
}

/**
 * Find the Tubi VOD title (movie, or the given series episode) that matches a
 * TMDB/IMDB title. Returns 0 or 1 option — only a confident match, to avoid
 * surfacing the wrong film. Confidence: exact normalized title AND year within
 * ±1, backed by an exact year OR at least one shared cast/director name.
 */
async function matchTubiVod(
  imdbId: string, kind: 'movie' | 'tv', season?: number, episode?: number
): Promise<SourceOption[]> {
  const detail = await tmdbFindByImdb(tmdbKey(), imdbId);
  if (!detail?.title) return [];
  const wantTitle = normTitle(detail.title);
  const wantYear = detail.year ? Number(detail.year) : undefined;
  const wantType: 'movie' | 'series' = kind === 'tv' ? 'series' : 'movie';

  const hits = await searchTubi(detail.title, 20);
  let best: { hit: TubiSearchHit; score: number } | null = null;
  for (const hit of hits) {
    if (hit.type !== wantType) continue;
    if (normTitle(hit.title) !== wantTitle) continue;           // exact title only
    const yearDiff = wantYear != null && hit.year != null ? Math.abs(hit.year - wantYear) : null;
    if (yearDiff != null && yearDiff > 1) continue;             // year must line up
    const corrob = overlapCount(hit.actors, detail.cast) + overlapCount(hit.directors, detail.directors);
    // Reject unless we have real evidence this is the same title.
    const confident = yearDiff === 0 || corrob >= 1 || (yearDiff == null && corrob >= 2);
    if (!confident) continue;
    const score = (yearDiff === 0 ? 100 : yearDiff === 1 ? 50 : 0) + corrob * 25;
    if (!best || score > best.score) best = { hit, score };
  }
  if (!best) return [];

  if (wantType === 'movie') {
    return [{
      kind: 'tubi',
      tubiId: best.hit.id,
      tubiType: 'movie',
      tubiYear: best.hit.year,
      tubiPoster: best.hit.posterUrl,
      tubiManifest: best.hit.manifestUrl,
      title: best.hit.title,
    }];
  }

  // Series: resolve the specific episode id from the matched series.
  if (season == null || episode == null) return [];
  try {
    const eps = await fetchTubiSeriesEpisodes(best.hit.id);
    const ep = eps.find(e => e.season === season && e.episode === episode);
    if (!ep) return [];
    return [{
      kind: 'tubi',
      tubiId: ep.episodeId,
      tubiType: 'series',
      tubiYear: best.hit.year,
      tubiPoster: best.hit.posterUrl,
      title: `${best.hit.title} S${season}E${episode}`,
    }];
  } catch { return []; }
}

// ---- Flattened, play-ready version list (consumed by the /sources route) ----
// One entry per addressable source option, each carrying a stable id, a
// re-resolvable Snagger playUrl, and a ready-to-PUT Pin. Sorted best-first so
// versions[0] matches what a bare /imdb/<ttid> resolve would auto-pick.

export interface CatalogVersion {
  id: string;
  kind: 'torrentio' | 'channel' | 'episode' | 'tubi';
  label: string;
  source: string;
  quality: number;
  /** Torrentio seeder count when advertised — health, for ranking. */
  seeders?: number;
  container: string | null;
  playUrl: string;
  pin: Pin;
}

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n')[0].trim();
}

function qualityLabel(score: number): string {
  if (score >= 40) return '2160p';
  if (score >= 30) return '1080p';
  if (score >= 20) return '720p';
  if (score >= 10) return '480p';
  return 'SD';
}

export function flattenVersions(
  baseUrl: string,
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  opts: { torrentio: SourceOption[]; channels: SourceOption[]; episodes: SourceOption[]; tubi: SourceOption[] }
): CatalogVersion[] {
  const epSeg = season != null && episode != null ? `/${season}/${episode}` : '';
  const enc = encodeURIComponent;
  const rdOn = !!rdKey();
  const versions: CatalogVersion[] = [];

  for (const o of opts.torrentio) {
    if (!o.infoHash) continue; // only releases we can re-address by hash
    const line = firstLine(o.title);
    versions.push({
      id: `torrentio:${o.infoHash}`,
      kind: 'torrentio',
      label: line || qualityLabel(o.quality ?? 0),
      source: rdOn ? 'Torrentio/RD' : 'Torrentio',
      quality: o.quality ?? 0,
      seeders: o.seeders,
      container: null,
      playUrl: `${baseUrl}/imdb/${imdbId}${epSeg}?hash=${enc(o.infoHash)}`,
      pin: { type: 'torrentio', infoHash: o.infoHash, title: line || undefined },
    });
  }

  for (const o of opts.channels) {
    if (!o.channelKey) continue;
    versions.push({
      id: `channel:${o.channelKey}`,
      kind: 'channel',
      label: o.channelName ?? o.channelKey,
      source: o.channelSource ?? 'Channel',
      quality: 0,
      container: null,
      playUrl: `${baseUrl}/imdb/${imdbId}?channel=${enc(o.channelKey)}`,
      pin: { type: 'channel', channelKey: o.channelKey },
    });
  }

  for (const o of opts.episodes) {
    if (!o.seriesKey || o.season == null || o.episode == null) continue;
    versions.push({
      id: `episode:${o.seriesKey}:${o.season}:${o.episode}`,
      kind: 'episode',
      label: o.episodeTitle ?? `${o.seriesName ?? 'Series'} S${o.season}E${o.episode}`,
      source: o.channelSource ?? 'Series',
      quality: 0,
      container: null,
      playUrl: `${baseUrl}/imdb/${imdbId}/${o.season}/${o.episode}?series=${enc(o.seriesKey)}`,
      pin: { type: 'episode', seriesKey: o.seriesKey, season: o.season, episode: o.episode, title: o.episodeTitle ?? undefined },
    });
  }

  // Tubi VOD, matched by title+year+cast (no shared IDs with TMDB). Always
  // proxied through Snagger — Tubi's manifest/segment URLs are signed for the
  // session that fetched them, so the player must not hit the CDN directly.
  for (const o of opts.tubi) {
    if (!o.tubiId) continue;
    const isEp = o.tubiType === 'series' && season != null && episode != null;
    const seg = isEp ? `/${season}/${episode}` : '';
    versions.push({
      id: `tubi:${o.tubiId}`,
      kind: 'tubi',
      label: o.title ?? `Tubi ${o.tubiId}`,
      source: 'Tubi',
      quality: 20, // Tubi VOD tops out around 720p; rank alongside 720p releases
      container: null,
      playUrl: `${baseUrl}/imdb/${imdbId}${seg}?tubi=${enc(o.tubiId)}`,
      pin: { type: 'tubi', tubiId: o.tubiId, title: o.title ?? undefined, manifestUrl: o.tubiManifest },
    });
  }

  // Best-first, but playable beats pretty: a dead swarm won't stream no matter
  // how good the encode, so known-zero-seeder releases sink below everything
  // with a live swarm. Within that, highest quality wins, then the healthiest
  // swarm. Unscored local/free sources sit below scored torrentio (cams score
  // negative and land at the bottom).
  const alive = (v: CatalogVersion) => (v.seeders === undefined || v.seeders > 0 ? 1 : 0);
  versions.sort((a, b) =>
    alive(b) - alive(a) || b.quality - a.quality || (b.seeders ?? 0) - (a.seeders ?? 0));
  return versions;
}

async function listTorrentio(imdbId: string, kind: 'movie' | 'tv', season?: number, episode?: number): Promise<SourceOption[]> {
  try {
    const streams = await queryTorrentio({
      endpoint: torrentioEndpoint(),
      rdApiKey: rdKey(),
      kind: kind === 'tv' ? 'series' : 'movie',
      imdbId,
      season,
      episode,
    });
    return streams.map((s: TorrentioStream) => ({
      kind: 'torrentio' as const,
      infoHash: infoHashFromStream(s),
      title: s.title ?? s.name ?? '',
      quality: qualityScore(s),
      seeders: seedersFromStream(s),
      url: s.url,
    })).sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  } catch (e) {
    return [];
  }
}
