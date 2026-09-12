import type { EPGChannel, EPGProgram, M3USegment, SnagResponse, StreamType } from './Interfaces';
import { M3USegmentArrayToString, toXMLTV } from './Transformers';
import { parseXMLTV } from './xmltv-parser';

export interface XtreamProvider {
  name: string;
  host: string;
  username: string;
  password: string;
  output?: 'ts' | 'm3u8';
  /** If false, skip VOD (movies). Default: true. */
  includeMovies?: boolean;
  /** If false, skip series. Default: true. */
  includeSeries?: boolean;
}

interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

interface XtreamLiveStream {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  epg_channel_id: string | null;
  added: string;
  is_adult: number;
  category_id: string;
  category_ids: number[];
  custom_sid: string | null;
  tv_archive: number;
  direct_source: string;
  tv_archive_duration: number;
}

interface XtreamVODStream {
  num: number;
  name: string;
  stream_type: string;
  stream_id: number;
  stream_icon: string;
  rating: string;
  rating_5based: number;
  added: string;
  is_adult: string;
  category_id: string;
  category_ids: number[];
  container_extension: string;
  custom_sid: string;
  direct_source: string;
}

interface XtreamSeries {
  num: number;
  name: string;
  series_id: number;
  cover: string;
  plot: string;
  cast: string;
  director: string;
  genre: string;
  releaseDate: string;
  last_modified: string;
  rating: string;
  rating_5based: number;
  episode_run_time: string;
  category_id: string;
}

export interface XtreamSeriesInfo {
  info?: {
    name?: string;
    cover?: string;
    plot?: string;
    genre?: string;
    cast?: string;
    director?: string;
    releaseDate?: string;
    rating?: string;
    backdrop_path?: string[];
  };
  seasons?: Array<{ season_number?: number; name?: string; episode_count?: number; cover?: string; air_date?: string }>;
  episodes?: Record<string, Array<{
    id: string;
    episode_num: number | string;
    title: string;
    container_extension: string;
    info?: Record<string, unknown>;
  }>>;
}

export async function fetchXtreamSeriesInfo(
  provider: XtreamProvider,
  seriesId: number
): Promise<XtreamSeriesInfo> {
  const host = normalizeHost(provider.host);
  const u = encodeURIComponent(provider.username);
  const p = encodeURIComponent(provider.password);
  const res = await fetch(`${host}/player_api.php?username=${u}&password=${p}&action=get_series_info&series_id=${seriesId}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`get_series_info ${seriesId} failed: ${res.status}`);
  return (await res.json()) as XtreamSeriesInfo;
}

export function buildXtreamSeriesEpisodeUrl(host: string, username: string, password: string, episodeId: string, containerExt: string): string {
  const h = host.endsWith('/') ? host.slice(0, -1) : host;
  return `${h}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${episodeId}.${containerExt || 'mp4'}`;
}

async function fetchJSON<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function fetchText(url: string, label: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

function normalizeHost(host: string): string {
  return host.endsWith('/') ? host.slice(0, -1) : host;
}

export interface XtreamUserInfo {
  username: string;
  status: string;
  expDate: number | null;
  isTrial: boolean;
  maxConnections: number;
  activeConnections: number;
  allowedFormats: string[];
  message?: string;
}

export async function fetchXtreamUserInfo(provider: XtreamProvider): Promise<XtreamUserInfo> {
  const host = normalizeHost(provider.host);
  const u = encodeURIComponent(provider.username);
  const p = encodeURIComponent(provider.password);
  const res = await fetch(`${host}/player_api.php?username=${u}&password=${p}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`user_info failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { user_info?: Record<string, unknown> };
  const ui = data.user_info ?? {};
  return {
    username: String(ui.username ?? ''),
    status: String(ui.status ?? ''),
    expDate: ui.exp_date ? Number(ui.exp_date) * 1000 : null,
    isTrial: String(ui.is_trial ?? '0') === '1',
    maxConnections: Number(ui.max_connections ?? 0),
    activeConnections: Number(ui.active_cons ?? 0),
    allowedFormats: Array.isArray(ui.allowed_output_formats) ? ui.allowed_output_formats as string[] : [],
    message: typeof ui.message === 'string' ? ui.message : undefined,
  };
}

export async function snagXtream(provider: XtreamProvider): Promise<SnagResponse> {
  const host = normalizeHost(provider.host);
  const u = encodeURIComponent(provider.username);
  const p = encodeURIComponent(provider.password);
  const ext = provider.output ?? 'ts';
  const includeMovies = provider.includeMovies !== false;

  const apiBase = `${host}/player_api.php?username=${u}&password=${p}`;

  const liveRequest = Promise.all([
    fetchJSON<XtreamCategory[]>(`${apiBase}&action=get_live_categories`, `${provider.name} live categories`),
    fetchJSON<XtreamLiveStream[]>(`${apiBase}&action=get_live_streams`, `${provider.name} live streams`),
  ]);

  const vodRequest = includeMovies
    ? Promise.all([
        fetchJSON<XtreamCategory[]>(`${apiBase}&action=get_vod_categories`, `${provider.name} vod categories`).catch(() => [] as XtreamCategory[]),
        fetchJSON<XtreamVODStream[]>(`${apiBase}&action=get_vod_streams`, `${provider.name} vod streams`).catch(() => [] as XtreamVODStream[]),
      ])
    : Promise.resolve([[] as XtreamCategory[], [] as XtreamVODStream[]] as const);

  const includeSeries = provider.includeSeries !== false;
  const seriesRequest = includeSeries
    ? Promise.all([
        fetchJSON<XtreamCategory[]>(`${apiBase}&action=get_series_categories`, `${provider.name} series categories`).catch(() => [] as XtreamCategory[]),
        fetchJSON<XtreamSeries[]>(`${apiBase}&action=get_series`, `${provider.name} series`).catch(() => [] as XtreamSeries[]),
      ])
    : Promise.resolve([[] as XtreamCategory[], [] as XtreamSeries[]] as const);

  const [[liveCats, liveStreams], [vodCats, vodStreams], [seriesCats, seriesList]] = await Promise.all([liveRequest, vodRequest, seriesRequest]);

  const liveCatById = new Map<string, string>();
  for (const c of liveCats) liveCatById.set(String(c.category_id), c.category_name);
  const vodCatById = new Map<string, string>();
  for (const c of vodCats) vodCatById.set(String(c.category_id), c.category_name);
  const seriesCatById = new Map<string, string>();
  for (const c of seriesCats) seriesCatById.set(String(c.category_id), c.category_name);

  const m3u: M3USegment[] = [];
  const streamTypes: Record<string, StreamType> = {};

  for (const s of liveStreams) {
    const id = s.epg_channel_id || String(s.stream_id);
    m3u.push({
      '#EXTINF': -1,
      'tvg-id': id,
      'tvg-logo': s.stream_icon || undefined,
      'group-title': liveCatById.get(String(s.category_id)) ?? undefined,
      name: s.name,
      streamUrl: `${host}/live/${provider.username}/${provider.password}/${s.stream_id}.${ext}`,
    });
    streamTypes[id] = 'live';
  }

  for (const v of vodStreams) {
    const id = `vod-${v.stream_id}`;
    const containerExt = v.container_extension || 'mp4';
    m3u.push({
      '#EXTINF': -1,
      'tvg-id': id,
      'tvg-logo': v.stream_icon || undefined,
      'group-title': vodCatById.get(String(v.category_id)) ?? 'Movies',
      name: v.name,
      streamUrl: `${host}/movie/${provider.username}/${provider.password}/${v.stream_id}.${containerExt}`,
    });
    streamTypes[id] = 'movie';
  }

  for (const s of seriesList) {
    const id = `series-${s.series_id}`;
    m3u.push({
      '#EXTINF': -1,
      'tvg-id': id,
      'tvg-logo': s.cover || undefined,
      'group-title': seriesCatById.get(String(s.category_id)) ?? 'Series',
      name: s.name,
      // Series row has no playable URL — episodes are loaded lazily and have their own URLs.
      streamUrl: '',
    });
    streamTypes[id] = 'series';
  }

  let epgChannels: EPGChannel[] = [];
  let epgProgrammes: EPGProgram[] = [];
  try {
    const epgText = await fetchText(`${host}/xmltv.php?username=${u}&password=${p}`, `${provider.name} EPG`);
    const guide = parseXMLTV(epgText);
    epgChannels = guide.channels;
    epgProgrammes = guide.programmes;
  } catch (e) {
    console.warn(`[${provider.name}] EPG fetch failed:`, e);
  }

  // Backfill EPGChannel entries for any channel/movie that didn't appear in the XMLTV
  const epgIds = new Set(epgChannels.map(c => c['channel-id']));
  for (const s of liveStreams) {
    const id = s.epg_channel_id || String(s.stream_id);
    if (epgIds.has(id)) continue;
    epgChannels.push({
      'channel-id': id,
      'display-name': s.name,
      icon: s.stream_icon || undefined,
      category: liveCatById.get(String(s.category_id)),
    });
    epgIds.add(id);
  }
  for (const v of vodStreams) {
    const id = `vod-${v.stream_id}`;
    if (epgIds.has(id)) continue;
    epgChannels.push({
      'channel-id': id,
      'display-name': v.name,
      icon: v.stream_icon || undefined,
      category: vodCatById.get(String(v.category_id)),
    });
    epgIds.add(id);
  }
  for (const s of seriesList) {
    const id = `series-${s.series_id}`;
    if (epgIds.has(id)) continue;
    epgChannels.push({
      'channel-id': id,
      'display-name': s.name,
      icon: s.cover || undefined,
      category: seriesCatById.get(String(s.category_id)),
      description: s.plot,
    });
    epgIds.add(id);
  }

  const epg = { channels: epgChannels, programmes: epgProgrammes };

  return {
    source: provider.name,
    components: { m3u, epg },
    m3u: M3USegmentArrayToString(m3u),
    epg: toXMLTV(epg),
    streamTypes,
  };
}
