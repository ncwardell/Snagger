const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

export interface TMDBTitle {
  tmdbId: number;
  kind: 'movie' | 'tv';
  title: string;
  year: string | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  voteAverage: number;
  popularity: number;
}

export interface TMDBTitleDetail extends TMDBTitle {
  imdbId: string | null;
  runtime: number | null;
  genres: string[];
  cast: string[];       // top billed actor names (for cross-source matching)
  directors: string[];  // director names
  seasons?: Array<{ seasonNumber: number; episodeCount: number; name: string; airDate: string | null }>;
}

export interface TMDBEpisode {
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  still: string | null;
}

function imgUrl(path: string | null | undefined, size = 'w342'): string | null {
  return path ? `${IMG_BASE}/${size}${path}` : null;
}

function mapMovie(r: Record<string, unknown>): TMDBTitle {
  return {
    tmdbId: Number(r.id),
    kind: 'movie',
    title: String(r.title ?? r.name ?? ''),
    year: typeof r.release_date === 'string' && r.release_date.length >= 4 ? r.release_date.slice(0, 4) : null,
    overview: String(r.overview ?? ''),
    poster: imgUrl(r.poster_path as string | null),
    backdrop: imgUrl(r.backdrop_path as string | null, 'w780'),
    voteAverage: Number(r.vote_average ?? 0),
    popularity: Number(r.popularity ?? 0),
  };
}

function mapTV(r: Record<string, unknown>): TMDBTitle {
  return {
    tmdbId: Number(r.id),
    kind: 'tv',
    title: String(r.name ?? r.title ?? ''),
    year: typeof r.first_air_date === 'string' && r.first_air_date.length >= 4 ? r.first_air_date.slice(0, 4) : null,
    overview: String(r.overview ?? ''),
    poster: imgUrl(r.poster_path as string | null),
    backdrop: imgUrl(r.backdrop_path as string | null, 'w780'),
    voteAverage: Number(r.vote_average ?? 0),
    popularity: Number(r.popularity ?? 0),
  };
}

async function tmdbFetch(apiKey: string, path: string, params: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
  if (!apiKey) throw new Error('TMDB API key not configured');
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TMDB ${path} failed: ${res.status} ${res.statusText}`);
  return await res.json() as Record<string, unknown>;
}

export async function tmdbSearch(apiKey: string, q: string, kind: 'movie' | 'tv', page = 1): Promise<{ results: TMDBTitle[]; page: number; totalPages: number; totalResults: number }> {
  const data = await tmdbFetch(apiKey, `/search/${kind}`, { query: q, page });
  const results = (data.results as Array<Record<string, unknown>> ?? []).map(kind === 'movie' ? mapMovie : mapTV);
  return {
    results,
    page: Number(data.page ?? 1),
    totalPages: Number(data.total_pages ?? 1),
    totalResults: Number(data.total_results ?? results.length),
  };
}

export async function tmdbPopular(apiKey: string, kind: 'movie' | 'tv', page = 1): Promise<{ results: TMDBTitle[]; page: number; totalPages: number; totalResults: number }> {
  const data = await tmdbFetch(apiKey, `/${kind}/popular`, { page });
  const results = (data.results as Array<Record<string, unknown>> ?? []).map(kind === 'movie' ? mapMovie : mapTV);
  return {
    results,
    page: Number(data.page ?? 1),
    totalPages: Number(data.total_pages ?? 1),
    totalResults: Number(data.total_results ?? results.length),
  };
}

/** TMDB's curated lists. `trending` is the week's risers, `top_rated` the
 *  all-time best — both give the channel something better to browse than a
 *  single "popular" page. */
export async function tmdbList(
  apiKey: string, list: 'popular' | 'trending' | 'top_rated', kind: 'movie' | 'tv', page = 1
): Promise<{ results: TMDBTitle[]; page: number; totalPages: number; totalResults: number }> {
  // Trending lives at a different path shape than the per-kind lists.
  const path = list === 'trending' ? `/trending/${kind}/week` : `/${kind}/${list}`;
  const data = await tmdbFetch(apiKey, path, { page });
  const results = (data.results as Array<Record<string, unknown>> ?? []).map(kind === 'movie' ? mapMovie : mapTV);
  return {
    results,
    page: Number(data.page ?? 1),
    totalPages: Number(data.total_pages ?? 1),
    totalResults: Number(data.total_results ?? results.length),
  };
}

export async function tmdbDetail(apiKey: string, kind: 'movie' | 'tv', tmdbId: number): Promise<TMDBTitleDetail> {
  const data = await tmdbFetch(apiKey, `/${kind}/${tmdbId}`, { append_to_response: 'external_ids,credits' });
  const base = kind === 'movie' ? mapMovie(data) : mapTV(data);
  const ext = (data.external_ids as Record<string, unknown>) ?? {};
  const credits = (data.credits as { cast?: Array<Record<string, unknown>>; crew?: Array<Record<string, unknown>> }) ?? {};
  const cast = (credits.cast ?? []).slice(0, 12).map(c => String(c.name ?? '')).filter(Boolean);
  const directors = (credits.crew ?? [])
    .filter(c => c.job === 'Director' || c.department === 'Directing')
    .map(c => String(c.name ?? '')).filter(Boolean);
  const seasons = kind === 'tv'
    ? (data.seasons as Array<Record<string, unknown>> ?? [])
        .filter(s => Number(s.season_number) > 0) // skip specials
        .map(s => ({
          seasonNumber: Number(s.season_number),
          episodeCount: Number(s.episode_count ?? 0),
          name: String(s.name ?? `Season ${s.season_number}`),
          airDate: typeof s.air_date === 'string' ? s.air_date : null,
        }))
    : undefined;
  return {
    ...base,
    imdbId: typeof ext.imdb_id === 'string' && ext.imdb_id.length > 0 ? ext.imdb_id : null,
    runtime: typeof data.runtime === 'number' ? data.runtime : null,
    genres: (data.genres as Array<{ name: string }> ?? []).map(g => g.name),
    cast,
    directors,
    seasons,
  };
}

export async function tmdbFindByImdb(apiKey: string, imdbId: string): Promise<TMDBTitleDetail | null> {
  const data = await tmdbFetch(apiKey, `/find/${imdbId}`, { external_source: 'imdb_id' });
  const movies = data.movie_results as Array<Record<string, unknown>> ?? [];
  const series = data.tv_results as Array<Record<string, unknown>> ?? [];
  if (movies.length) {
    return tmdbDetail(apiKey, 'movie', Number(movies[0].id));
  }
  if (series.length) {
    return tmdbDetail(apiKey, 'tv', Number(series[0].id));
  }
  return null;
}

export async function tmdbEpisodes(apiKey: string, tmdbId: number, season: number): Promise<TMDBEpisode[]> {
  const data = await tmdbFetch(apiKey, `/tv/${tmdbId}/season/${season}`);
  const eps = (data.episodes as Array<Record<string, unknown>> ?? []);
  return eps.map(e => ({
    episodeNumber: Number(e.episode_number),
    name: String(e.name ?? ''),
    overview: String(e.overview ?? ''),
    airDate: typeof e.air_date === 'string' ? e.air_date : null,
    still: imgUrl(e.still_path as string | null, 'w300'),
  }));
}
