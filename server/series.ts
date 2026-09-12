import { db } from './db';
import { fetchXtreamSeriesInfo, buildXtreamSeriesEpisodeUrl } from '../helpers/xtream';
import { fetchPlutoSeriesEpisodes } from '../sources/PlutoTV';
import { fetchTubiSeriesEpisodes, resolveTubiStream } from '../sources/Tubi';
import { getSourceByName, getXtreamCredentials, getXtreamHost } from './sources';

export interface Episode {
  season: number;
  episode: number;
  episodeId: string;
  title: string | null;
  containerExt: string | null;
  extra: Record<string, unknown> | null;
  fetchedAt: number;
}

const selectEpisodes = db.query<
  { season: number; episode: number; episode_id: string; title: string | null; container_ext: string | null; extra_json: string | null; fetched_at: number },
  [string]
>(`SELECT season, episode, episode_id, title, container_ext, extra_json, fetched_at FROM series_episodes WHERE series_key = ? ORDER BY season, episode`);

const selectOneEpisode = db.query<
  { episode_id: string; container_ext: string | null; extra_json: string | null },
  [string, number, number]
>(`SELECT episode_id, container_ext, extra_json FROM series_episodes WHERE series_key = ? AND season = ? AND episode = ?`);

const insertEpisode = db.prepare(`
  INSERT OR REPLACE INTO series_episodes (series_key, season, episode, episode_id, title, container_ext, extra_json, info_json, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const deleteEpisodesForSeries = db.prepare(`DELETE FROM series_episodes WHERE series_key = ?`);

/** Parses keys like "Lion:series-1234" or "PlutoTV:series-69e25a6841ffb6b4c1fe54a5". */
function parseSeriesKey(seriesKey: string): { sourceName: string; seriesId: string } | null {
  const colon = seriesKey.indexOf(':');
  if (colon < 0) return null;
  const sourceName = seriesKey.slice(0, colon);
  const idPart = seriesKey.slice(colon + 1);
  if (!idPart.startsWith('series-')) return null;
  const seriesId = idPart.slice('series-'.length);
  if (!seriesId) return null;
  return { sourceName, seriesId };
}

export async function loadEpisodes(seriesKey: string, opts: { forceFresh?: boolean } = {}): Promise<Episode[]> {
  if (!opts.forceFresh) {
    const cached = selectEpisodes.all(seriesKey);
    if (cached.length > 0) {
      return cached.map(r => ({
        season: r.season,
        episode: r.episode,
        episodeId: r.episode_id,
        title: r.title,
        containerExt: r.container_ext,
        extra: r.extra_json ? JSON.parse(r.extra_json) as Record<string, unknown> : null,
        fetchedAt: r.fetched_at,
      }));
    }
  }

  const parsed = parseSeriesKey(seriesKey);
  if (!parsed) throw new Error('invalid series key: ' + seriesKey);

  const source = getSourceByName(parsed.sourceName);
  if (!source) throw new Error('series source not found: ' + parsed.sourceName);

  const now = Date.now();
  let collected: Array<{ season: number; episode: number; episodeId: string; title: string | null; containerExt: string | null; extra: Record<string, unknown> | null; info: unknown }> = [];

  if (source.type === 'xtream') {
    const seriesIdNum = Number(parsed.seriesId);
    if (!Number.isFinite(seriesIdNum) || seriesIdNum <= 0) throw new Error('invalid xtream series id');
    const creds = getXtreamCredentials(source);
    if (creds.length === 0) throw new Error('no credentials for ' + source.name);
    const host = getXtreamHost(source);
    const info = await fetchXtreamSeriesInfo(
      { name: source.name, host, username: creds[0].username, password: creds[0].password },
      seriesIdNum
    );
    for (const [seasonStr, eps] of Object.entries(info.episodes ?? {})) {
      const season = Number(seasonStr);
      if (!Number.isFinite(season)) continue;
      for (const e of eps) {
        const episode = Number(e.episode_num);
        if (!Number.isFinite(episode)) continue;
        collected.push({
          season, episode,
          episodeId: String(e.id),
          title: e.title ?? null,
          containerExt: e.container_extension ?? null,
          extra: null,
          info: e.info ?? null,
        });
      }
    }
  } else if (source.type === 'plutotv') {
    const cfg = JSON.parse(source.config_json) as { email?: string; password?: string };
    const eps = await fetchPlutoSeriesEpisodes(parsed.seriesId, { email: cfg.email, password: cfg.password });
    for (const e of eps) {
      collected.push({
        season: e.season,
        episode: e.number,
        episodeId: e._id,
        title: e.name ?? null,
        containerExt: null,
        extra: e.stitched?.path ? { stitchedPath: e.stitched.path } : null,
        info: e,
      });
    }
  } else if (source.type === 'tubi') {
    const eps = await fetchTubiSeriesEpisodes(parsed.seriesId);
    for (const e of eps) {
      collected.push({
        season: e.season,
        episode: e.episode,
        episodeId: e.episodeId,
        title: e.title ?? null,
        containerExt: null,
        // Store the harvested manifest URL — and the imdb_id for future
        // auto-linking when the catalog gets a Tubi-anchored title.
        extra: { manifestUrl: e.manifestUrl, imdbId: e.imdbId, duration: e.duration },
        info: e,
      });
    }
  } else {
    throw new Error('series episodes not supported for source type: ' + source.type);
  }

  const writeAll = db.transaction(() => {
    deleteEpisodesForSeries.run(seriesKey);
    for (const e of collected) {
      insertEpisode.run(
        seriesKey, e.season, e.episode,
        e.episodeId,
        e.title,
        e.containerExt,
        e.extra ? JSON.stringify(e.extra) : null,
        e.info ? JSON.stringify(e.info) : null,
        now
      );
    }
  });
  writeAll();

  const out = collected.map(e => ({
    season: e.season,
    episode: e.episode,
    episodeId: e.episodeId,
    title: e.title,
    containerExt: e.containerExt,
    extra: e.extra,
    fetchedAt: now,
  }));
  out.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return out;
}

export async function buildEpisodeUrl(seriesKey: string, season: number, episode: number): Promise<string | null> {
  const row = selectOneEpisode.get(seriesKey, season, episode);
  if (!row) return null;
  const parsed = parseSeriesKey(seriesKey);
  if (!parsed) return null;
  const source = getSourceByName(parsed.sourceName);
  if (!source) return null;

  if (source.type === 'xtream') {
    const creds = getXtreamCredentials(source);
    if (creds.length === 0) return null;
    return buildXtreamSeriesEpisodeUrl(
      getXtreamHost(source),
      creds[0].username, creds[0].password,
      row.episode_id, row.container_ext ?? 'mp4'
    );
  }
  if (source.type === 'plutotv') {
    // Route through the AES-128 DRM proxy (same as Pluto movies) — the old
    // stitcher path serves a takedown slate for entitled VOD. Pluto's playout
    // endpoint stitches a series episode by its own _id, so the episode id is
    // the clip id. server.ts translates this sentinel to /drm/pluto/<id>/master.m3u8.
    return `drm-pluto:${row.episode_id}`;
  }
  if (source.type === 'tubi') {
    const extra = row.extra_json ? JSON.parse(row.extra_json) as { manifestUrl?: string } : null;
    // Cached manifest URL may have an expired token — re-resolve on demand.
    if (extra?.manifestUrl) return extra.manifestUrl;
    return await resolveTubiStream('tv-shows', row.episode_id);
  }
  return null;
}

export interface SeriesMatch {
  seriesKey: string;
  seriesName: string;
  sourceName: string;
}

/**
 * Find Xtream series in the DB whose name matches a title (substring).
 * Episodes are NOT loaded here — call loadEpisodes(seriesKey) per match.
 */
export function findSeriesByTitle(title: string, limit = 8): SeriesMatch[] {
  const like = '%' + title.toLowerCase() + '%';
  const rows = db.query<{ key: string; name: string; source: string }, unknown[]>(
    `SELECT key, name, source FROM channels
     WHERE stream_type = 'series' AND lower(name) LIKE ?
     ORDER BY length(name)
     LIMIT ?`
  ).all(like, limit);
  return rows.map(r => ({ seriesKey: r.key, seriesName: r.name, sourceName: r.source }));
}
