import type {
  Channel, ChannelFilters, ChannelPage, PinSet, Settings, Source, SourceType,
  StatsResponse, Template,
  TmdbKind, TmdbPage, TmdbTitleDetail, TmdbEpisode, SourceOptionsResponse, Pin,
} from './types';

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { query?: Record<string, string | number | boolean | null | undefined> },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(rest?.headers ?? {}),
    },
  });
  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (isJson && body && typeof body === 'object' && 'error' in body && typeof (body as Record<string, unknown>).error === 'string')
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

const put = (data: unknown)  => ({ method: 'PUT',    body: JSON.stringify(data) });
const post = (data?: unknown) => ({ method: 'POST',  body: data === undefined ? undefined : JSON.stringify(data) });
const del = () => ({ method: 'DELETE' });

export const api = {
  // --- Templates ---
  listTemplates: () =>
    request<{ templates: Template[]; activeId: number }>('/api/templates'),
  createTemplate: (name: string) =>
    request<{ template: Template }>('/api/templates', post({ name })),
  updateTemplate: (id: number, patch: { proxyMode?: boolean; name?: string; exports?: { m3u?: boolean; epg?: boolean } }) =>
    request<{ ok: true }>(`/api/templates/${id}`, put(patch)),
  deleteTemplate: (id: number) =>
    request<{ ok: true }>(`/api/templates/${id}`, del()),
  setActiveTemplate: (id: number) =>
    request<{ ok: true; activeId: number }>('/api/active-template', post({ id })),

  // --- Channels ---
  listChannels: (params: ChannelFilters & {
    template?: string | number;
    page?: number;
    pageSize?: number;
  }) =>
    request<ChannelPage>('/api/channels', { query: params }),

  listChannelKeys: (filters: ChannelFilters) =>
    request<{ keys: string[]; total: number }>('/api/channels/keys', { query: filters }),

  stats: (filters: ChannelFilters) =>
    request<StatsResponse>('/api/stats', { query: filters }),

  // --- Overrides ---
  updateOverride: (
    template: string | number,
    key: string,
    patch: Partial<{ enabled: boolean; name: string | null; icon: string | null; group: string | null; imdbId: string | null }>,
  ) =>
    request<{ ok: true; key: string; override: Channel['override'] }>(
      `/api/overrides/${encodeURIComponent(key)}`,
      { ...put(patch), query: { template } },
    ),
  resetOverride: (template: string | number, key: string) =>
    request<{ ok: true; key: string }>(`/api/overrides/${encodeURIComponent(key)}`, { ...del(), query: { template } }),
  bulkOverride: (
    template: string | number,
    keys: string[],
    patch: Partial<{ enabled: boolean; name: string | null; icon: string | null; group: string | null }>,
  ) =>
    request<{ ok: true; updated: number }>('/api/overrides/bulk', { ...post({ keys, patch }), query: { template } }),
  bulkOverrideByFilter: (
    template: string | number,
    filter: ChannelFilters,
    patch: Partial<{ enabled: boolean; name: string | null; icon: string | null; group: string | null }>,
  ) =>
    request<{ ok: true; updated: number }>('/api/overrides/bulk-by-filter', { ...post({ filter, patch }), query: { template } }),
  bulkReset: (template: string | number, keys: string[]) =>
    request<{ ok: true; cleared: number }>('/api/overrides/bulk-reset', { ...post({ keys }), query: { template } }),

  // --- Sources ---
  listSources: () => request<{ sources: Source[] }>('/api/sources'),
  createSource: (input: { name: string; type: SourceType; config?: Record<string, unknown>; enabled?: boolean; refreshIntervalMs?: number }) =>
    request<{ source: unknown }>('/api/sources', post(input)),
  updateSource: (id: number, input: { name?: string; config?: Record<string, unknown>; enabled?: boolean; refreshIntervalMs?: number }) =>
    request<{ ok: true }>(`/api/sources/${id}`, put(input)),
  deleteSource: (id: number) =>
    request<{ ok: true; deletedChannels: number }>(`/api/sources/${id}`, del()),
  testSource: (id: number) =>
    request<{ ok: boolean; message: string }>(`/api/sources/${id}/test`, post()),
  refreshSource: (id: number) =>
    request<{ source: string; channels: number; programmes: number; ok: boolean; error?: string }>(`/api/sources/${id}/refresh`, post()),
  refreshAll: () => request<{ results: unknown[] }>('/api/refresh', post()),
  refreshSourceByName: (source: string) => request<{ results: unknown[] }>('/api/refresh', post({ source })),

  // --- Settings ---
  getSettings: () => request<{ settings: Settings }>('/api/settings'),
  updateSettings: (patch: Settings) =>
    request<{ ok: true }>('/api/settings', put(patch)),

  // --- Catalog (TMDB browse + resolver) ---
  catalogPopular: (kind: TmdbKind, page = 1) =>
    request<TmdbPage>('/api/catalog/popular', { query: { kind, page } }),
  catalogSearch: (q: string, kind: TmdbKind, page = 1) =>
    request<TmdbPage>('/api/catalog/search', { query: { q, kind, page } }),
  catalogTitle: (kind: TmdbKind, tmdbId: number) =>
    request<TmdbTitleDetail>(`/api/catalog/tmdb/${kind}/${tmdbId}`),
  catalogSeason: (tmdbId: number, season: number) =>
    request<TmdbEpisode[]>(`/api/catalog/tmdb/tv/${tmdbId}/season/${season}`),
  catalogSources: (imdbId: string, opts: { kind: TmdbKind; title?: string; season?: number; episode?: number }) => {
    const seg = opts.season != null && opts.episode != null ? `/${opts.season}/${opts.episode}` : '';
    return request<SourceOptionsResponse>(`/api/catalog/title/${imdbId}${seg}/sources`, {
      query: { kind: opts.kind, title: opts.title },
    });
  },
  getPins: (imdbId: string, season?: number | null, episode?: number | null) => {
    const seg = season != null && episode != null ? `/${season}/${episode}` : '';
    return request<{ pins: Pin[] }>(`/api/catalog/title/${imdbId}${seg}/pins`);
  },
  setPins: (imdbId: string, season: number | null | undefined, episode: number | null | undefined, pins: Pin[]) => {
    const seg = season != null && episode != null ? `/${season}/${episode}` : '';
    return request<{ ok: true; pins: Pin[] }>(`/api/catalog/title/${imdbId}${seg}/pins`, put({ pins }));
  },

  // --- Pins ---
  listPins: () => request<{ pins: PinSet[]; total: number }>('/api/pins'),
  removePins: (imdbId: string, season?: number | null, episode?: number | null) => {
    const path = season != null && episode != null
      ? `/api/catalog/title/${imdbId}/${season}/${episode}/pins`
      : `/api/catalog/title/${imdbId}/pins`;
    return request<{ ok: true }>(path, del());
  },
};

export type Api = typeof api;
