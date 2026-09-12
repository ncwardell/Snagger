export type StreamType = 'live' | 'movie' | 'series';

export type Template = {
  id: number;
  name: string;
  created_at: number;
  proxy_mode: number;
  exports_json: string | null;
};

export type TemplateExports = { m3u: boolean; epg: boolean };

export type Override = {
  name: string | null;
  icon: string | null;
  group: string | null;
  imdbId: string | null;
};

export type Channel = {
  key: string;
  source: string;
  channelId: string;
  name: string;
  icon: string | null;
  group: string | null;
  streamUrl: string | null;
  streamType: StreamType;
  lastSeen: number;
  enabled: boolean;
  override: Override;
};

export type ChannelPage = {
  templateId: number;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  channels: Channel[];
};

export type StatsResponse = {
  sources: { source: string; n: number }[];
  types: { stream_type: StreamType; n: number }[];
  groups: { group: string | null; n: number }[];
  total: number;
};

export type ChannelFilters = {
  q?: string;
  source?: string;
  type?: StreamType | '';
  group?: string;
};

// --- Sources ---

export type SourceType = 'plutotv' | 'tubi' | 'xtream' | 'm3u';

export type XtreamCredentialView = { username: string; password: string };

export type SourceConfig =
  | Record<string, never>                                          // plutotv, tubi
  | { m3uUrl: string; epgUrl?: string; userAgent?: string }        // m3u
  | {                                                              // xtream
      host: string;
      credentials: XtreamCredentialView[];
      output?: 'ts' | 'm3u8';
      includeMovies?: boolean;
      proxyMode?: 'on' | 'off' | 'auto';
    };

export type Source = {
  id: number;
  name: string;
  type: SourceType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  lastRefreshed: number | null;
  lastStatus: string | null;
  info: Record<string, unknown> | null;
  refreshIntervalMs: number;
  nextRefreshAt: number | null;
};

export type Settings = Record<string, string | null>;

// --- Catalog (TMDB + resolver) ---

export type TmdbKind = 'movie' | 'tv';

export type TmdbTitle = {
  tmdbId: number;
  kind: TmdbKind;
  title: string;
  year: string | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  voteAverage: number;
  popularity: number;
};

export type TmdbSeason = { seasonNumber: number; episodeCount: number; name: string; airDate: string | null };

export type TmdbTitleDetail = TmdbTitle & {
  imdbId: string | null;
  runtime: number | null;
  genres: string[];
  seasons?: TmdbSeason[];
};

export type TmdbEpisode = { episodeNumber: number; name: string; overview: string; airDate: string | null; still: string | null };

export type TmdbPage = { results: TmdbTitle[]; page: number; totalPages: number; totalResults: number };

export type CatalogVersion = {
  id: string;
  kind: 'torrentio' | 'channel' | 'episode' | 'tubi';
  label: string;
  source: string;
  quality: number;
  container: string | null;
  playUrl: string;
  pin: Pin;
};

export type SourceOptionsResponse = { versions: CatalogVersion[] };

// --- Pins (Catalog) ---

export type Pin =
  | { type: 'channel'; channelKey: string }
  | { type: 'torrentio'; infoHash?: string; title?: string }
  | { type: 'episode'; seriesKey: string; season: number; episode: number; title?: string }
  | { type: 'tubi'; tubiId: string; title?: string; manifestUrl?: string };

export type PinSet = {
  imdbId: string;
  season: number | null;
  episode: number | null;
  updatedAt: number;
  pins: Pin[];
};
