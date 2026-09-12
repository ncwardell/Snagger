import type { EPGChannel, EPGProgram, SnagResponse, M3USegment, StreamType } from "../helpers/Interfaces";
import { M3USegmentArrayToString, toXMLTV } from "../helpers/Transformers";
import moment from "moment";

// ============================================================================
// PlutoTV anonymous session + VOD support (movies, series, lazy episodes).
// All Pluto-specific logic lives in this file. The public exports at the
// bottom (getPlutoSession, buildPlutoStreamUrl, fetchPlutoSeriesEpisodes) are
// what server/series.ts consumes for lazy episode loading.
// ============================================================================

const PLUTO_HEADERS: HeadersInit = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/120.0',
  'Origin': 'https://pluto.tv',
  'Referer': 'https://pluto.tv/',
  // Pluto's stitcher requires these as HTTP headers in addition to query params.
  'plutotv-device-dnt': '0',
  'plutotv-device-model': 'web',
  'plutotv-device-make': 'firefox',
  'plutotv-device-type': 'web',
  'plutotv-app-name': 'web',
  'plutotv-app-version': '5.16.0',
};

interface PlutoBootResponse {
  sessionToken: string;
  servers: { stitcher: string; vod: string };
}

export interface PlutoCreds { email?: string; password?: string }

let _plutoSession: { token: string; apiToken: string; stitcherBase: string; authed: boolean; expiresAt: number } | null = null;

function decodeJWTExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return Number(payload.exp ?? 0) * 1000;
  } catch { return Date.now() + 3_600_000; }
}

const PLUTO_AUTH_URL = 'https://service-users.clusters.pluto.tv/v4/auth?sync=true';

// Login requires the *existing anonymous session token* as Bearer — Pluto uses
// it to bind the authenticated identity to the current device session.
async function plutoLogin(email: string, password: string, anonSessionToken: string): Promise<string> {
  const res = await fetch(PLUTO_AUTH_URL, {
    method: 'POST',
    headers: {
      ...PLUTO_HEADERS as Record<string, string>,
      'content-type': 'application/json',
      'Authorization': `Bearer ${anonSessionToken}`,
    },
    body: JSON.stringify({ userIdentity: email, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Pluto auth ${res.status}: ${text.slice(0, 120)}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  const token = data.idToken as string | undefined;
  if (!token) throw new Error(`Pluto auth: no idToken in response (keys: ${Object.keys(data).join(',')})`);
  console.log('[Pluto] authenticated successfully');
  return token;
}

async function bootPluto(extraParams: Record<string, string> = {}, authHeader?: string): Promise<PlutoBootResponse> {
  const cid = crypto.randomUUID();
  const params = new URLSearchParams({
    appName: 'web', appVersion: '5.16.0', deviceVersion: 'na',
    deviceModel: 'web', deviceMake: 'firefox', deviceType: 'web',
    clientID: cid, clientModelNumber: 'na',
    serverSideAds: 'true', includeExtendedEvents: 'true',
    ...extraParams,
  });
  const headers: Record<string, string> = { ...PLUTO_HEADERS as Record<string, string> };
  if (authHeader) headers['Authorization'] = authHeader;
  const res = await fetch(`https://boot.pluto.tv/v4/start?${params.toString()}`, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Pluto boot failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as PlutoBootResponse;
  if (!data.sessionToken) throw new Error('Pluto boot response missing sessionToken');
  return data;
}

export async function getPlutoSession(creds?: PlutoCreds): Promise<{ token: string; stitcherBase: string; authed: boolean }> {
  const wantAuth = !!(creds?.email && creds?.password);
  if (_plutoSession && _plutoSession.authed === wantAuth && _plutoSession.expiresAt > Date.now() + 5 * 60_000) {
    return { token: _plutoSession.token, stitcherBase: _plutoSession.stitcherBase, authed: _plutoSession.authed };
  }

  // Always boot anonymously first — the anon session token is what the VOD
  // catalog API accepts (series listings, episode paths, etc.).
  const anon = await bootPluto();
  const apiToken = anon.sessionToken;
  const stitcherBase = anon.servers.stitcher;
  let vodJwt: string | undefined;

  if (wantAuth) {
    // Login with the anonymous session as Bearer → idToken (entitlement proof).
    // This goes as ?jwt= on stitch URLs; the catalog API still uses apiToken.
    vodJwt = await plutoLogin(creds!.email!, creds!.password!, apiToken);
  }

  const token = vodJwt ?? apiToken;
  _plutoSession = { token, apiToken, stitcherBase, authed: wantAuth, expiresAt: decodeJWTExp(token) };
  return { token, stitcherBase, authed: wantAuth };
}

interface PlutoVODItem {
  _id: string;
  name: string;
  summary?: string;
  description?: string;
  type: 'movie' | 'series';
  rating?: string;
  duration?: number;
  genre?: string;
  stitched?: { path?: string };
  covers?: Array<{ aspectRatio: string; url: string }>;
  featuredImage?: { path: string };
  seasonsNumbers?: number[];
  seriesID?: string;
  category?: string;
}

async function fetchVODCategoriesPage(token: string, page: number, limit: number) {
  const params = new URLSearchParams({
    deviceType: 'web', appName: 'web', deviceVersion: '1',
    includeItems: 'true', page: String(page), limit: String(limit),
  });
  const res = await fetch(`https://service-vod.clusters.pluto.tv/v4/vod/categories?${params.toString()}`, {
    headers: { ...PLUTO_HEADERS, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Pluto VOD categories page ${page} failed: ${res.status}`);
  return (await res.json()) as { categories: Array<{ name: string; items?: PlutoVODItem[] }>; totalPages: number };
}

async function fetchPlutoVODCatalog(creds?: PlutoCreds): Promise<{ items: PlutoVODItem[]; stitcherBase: string; token: string }> {
  const { token, stitcherBase } = await getPlutoSession(creds);
  // For VOD catalog API calls we always use the anonymous session (apiToken),
  // since the idToken may not be accepted there. The stitch token is separate.
  const apiToken = _plutoSession!.apiToken;
  const seen = new Map<string, PlutoVODItem>();
  const LIMIT = 100;
  let page = 1, totalPages = 1;
  do {
    const data = await fetchVODCategoriesPage(apiToken, page, LIMIT);
    totalPages = data.totalPages;
    for (const cat of data.categories ?? []) {
      for (const item of cat.items ?? []) {
        if (!item._id) continue;
        if (!seen.has(item._id)) seen.set(item._id, { ...item, category: cat.name });
      }
    }
    page++;
  } while (page <= totalPages);
  return { items: [...seen.values()], stitcherBase, token };
}

export interface PlutoEpisodeItem {
  _id: string;
  name: string;
  description?: string;
  number: number;
  season: number;
  duration?: number;
  rating?: string;
  stitched?: { path?: string };
}

export async function fetchPlutoSeriesEpisodes(seriesId: string, creds?: PlutoCreds): Promise<PlutoEpisodeItem[]> {
  await getPlutoSession(creds);
  const token = _plutoSession!.apiToken; // catalog API uses anonymous session
  const out: PlutoEpisodeItem[] = [];
  let page = 1;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(
      `https://service-vod.clusters.pluto.tv/v4/vod/series/${encodeURIComponent(seriesId)}/seasons?deviceType=web&page=${page}`,
      { headers: { ...PLUTO_HEADERS, 'Authorization': `Bearer ${token}` } }
    );
    if (!res.ok) {
      if (page === 1) throw new Error(`Pluto series ${seriesId} failed: ${res.status}`);
      break;
    }
    const data = (await res.json()) as { seasons?: Array<{ episodes?: PlutoEpisodeItem[] }>; totalPages?: number };
    for (const s of data.seasons ?? []) for (const ep of s.episodes ?? []) out.push(ep);
    const total = data.totalPages ?? 1;
    if (page >= total) break;
    page++;
  }
  return out;
}

export function buildPlutoStreamUrl(stitcherBase: string, stitchedPath: string, jwt?: string): string {
  const u = new URL(stitcherBase + stitchedPath);
  if (jwt) u.searchParams.set('jwt', jwt);
  u.searchParams.set('advertisingId', '');
  u.searchParams.set('appName', 'web');
  u.searchParams.set('appVersion', '5.16.0');
  u.searchParams.set('clientTime', '0');
  // deviceDNT must be present — missing it returns a 400 from the stitcher.
  u.searchParams.set('deviceDNT', '0');
  u.searchParams.set('deviceId', crypto.randomUUID());
  u.searchParams.set('deviceMake', 'firefox');
  u.searchParams.set('deviceModel', 'web');
  u.searchParams.set('deviceType', 'web');
  u.searchParams.set('deviceVersion', 'unknown');
  u.searchParams.set('includeExtendedEvents', 'false');
  u.searchParams.set('sid', crypto.randomUUID());
  u.searchParams.set('userId', '');
  u.searchParams.set('serverSideAds', 'true');
  return u.toString();
}

// ============================================================================
// Live channels — original Pluto adapter (api.pluto.tv/v2/channels).
// ============================================================================

// Canonical Snagger groups — kept consistent across free sources so the UI's
// group filter shows coherent buckets instead of provider-specific labels.
// Native source labels not in the map fall through unchanged (we'd rather
// keep an unusual label than misclassify).
function normalizePlutoCategory(native: string | undefined, kind: 'live' | 'movie' | 'series'): string {
  const c = (native ?? '').trim();
  if (!c) return kind === 'movie' ? 'Movies' : kind === 'series' ? 'Series' : 'Live';
  const lc = c.toLowerCase();

  // Order matters — more specific matches first
  if (/\bnews|opinion|politic/.test(lc))          return kind === 'live' ? 'News' : 'News';
  if (/\bsport|nfl|nba|mlb|nhl|soccer|fifa/.test(lc)) return 'Sports';
  if (/\btrue\s*crime|crime/.test(lc))            return 'True Crime';
  if (/\bkids|children|cartoon|nick|family/.test(lc)) return 'Kids';
  if (/\bcomedy|stand[\s-]?up/.test(lc))          return 'Comedy';
  if (/\bdrama/.test(lc))                          return 'Drama';
  if (/\breality|game\s*show/.test(lc))            return 'Reality';
  if (/\bdocument|nature|history|science/.test(lc))return 'Documentary';
  if (/\bmusic|mtv|vh1/.test(lc))                  return 'Music';
  if (/\blifestyle|food|home|travel/.test(lc))     return 'Lifestyle';
  if (/\banime|asian|spanish|latino|en\s*espa|black/.test(lc)) return 'International';
  if (/\bmovie|cinema|film/.test(lc))              return 'Movies';
  if (/\btv\s*show|series/.test(lc))               return 'Series';
  return c;  // keep native if unrecognized
}

//Pluto TV's Data Schema
interface PlutoChannel {
    _id: string;
    slug: string;
    name: string;
    hash: string;
    number: number;
    summary: string;
    visibility: string;
    onDemandDescription: string;
    category: string;
    plutoOfficeOnly: boolean;
    directOnly: boolean;
    chatRoomId: number;
    onDemand: boolean;
    cohortMask: number;
    featuredImage: { path: string };
    thumbnail: { path: string };
    tile: { path: string };
    tileGrayScale: { path: string };
    logo: { path: string };
    colorLogoSVG: { path: string };
    colorLogoPNG: { path: string };
    solidLogoSVG: { path: string };
    solidLogoPNG: { path: string };
    featured: boolean;
    featuredOrder: number;
    favorite: boolean;
    isStitched: boolean;
    stitched: { urls: [{ type: string, url: string }]; sessionURL: string };
    timelines: Timeline[];
}

interface Timeline {
    _id: string;
    start: string;
    stop: string;
    title: string;
    episode: Episode;
}

interface Episode {
    _id: string;
    number: number;
    season: number;
    description: string;
    duration: number;
    originalContentDuration: number;
    genre: string;
    subGenre: string;
    distributeAs: { AVOD: boolean };
    clip: { originalReleaseDate: string };
    rating: string;
    name: string;
    slug: string;
    poster: { path: string };
    firstAired: string;
    thumbnail: { path: string };
    liveBroadcast: boolean;
    featuredImage: { path: string };
    series: Series;
    poster16_9: { path: string }
}

interface Series {
    _id: string;
    name: string;
    slug: string;
    type: string;
    tile: { path: string };
    description: string;
    summary: string;
    displayName: string;
    featuredImage: { path: string };
    poster16_9: { path: string };
}

//---------------Credits: https://github.com/evoactivity/PlutoIPTV for URL Generation-----------------//

//URL Grabber
// Time Format = 2020-03-24%2021%3A00%3A00.000%2B0000
const generateUrl = () => {
    const now = new Date();
    let startTime = encodeURIComponent(
        moment().format('YYYY-MM-DD HH:00:00.000ZZ')
    );
    let stopTime = encodeURIComponent(
        moment().add(48, 'hours').format('YYYY-MM-DD HH:00:00.000ZZ')
    );
    return `http://api.pluto.tv/v2/channels?start=${startTime}&stop=${stopTime}`;
}


//Data Snagging
export const snag = async (creds?: PlutoCreds) => {
    const plutoURL = generateUrl();
    try {
        const liveResp = await fetch(plutoURL);
        const liveData = await liveResp.json();
        const { epg, m3u, streamTypes } = bindData(liveData);

        // Pull free VOD (movies + series) — separate auth flow + endpoint.
        try {
            const { items, stitcherBase, token } = await fetchPlutoVODCatalog(creds);
            for (const it of items) {
                // Movies need a per-item stitched path; series get URLs lazily via the episode loader.
                if (it.type === 'movie' && !it.stitched?.path) continue;
                const id = it.type === 'series' ? `series-${it._id}` : `vod-${it._id}`;
                const icon = it.covers?.find(c => c.aspectRatio === '347:500')?.url
                          ?? it.covers?.[0]?.url
                          ?? it.featuredImage?.path
                          ?? undefined;
                const canonical = normalizePlutoCategory(it.category, it.type);
                m3u.push({
                    '#EXTINF': -1,
                    'tvg-id': id,
                    'tvg-logo': icon,
                    'group-title': canonical,
                    name: it.name,
                    streamUrl: it.type === 'series' ? '' : buildPlutoStreamUrl(stitcherBase, it.stitched!.path!, token),
                });
                streamTypes[id] = it.type === 'series' ? 'series' : 'movie';
                epg.channels.push({
                    'channel-id': id,
                    'display-name': it.name,
                    icon,
                    category: canonical,
                    description: it.summary ?? it.description,
                });
            }
        } catch (vodErr) {
            console.warn('PlutoTV VOD fetch failed (live still loaded):', (vodErr as Error).message);
        }

        const response: SnagResponse = {
            source: 'PlutoTV',
            components: { m3u, epg },
            epg: toXMLTV(epg),
            m3u: M3USegmentArrayToString(m3u),
            streamTypes,
        };
        return response;
    } catch (error) {
        console.error(error);
    }
}


//Data Binder
function bindData(_plutoData: Record<string, PlutoChannel>) {

    let epg = {channels: [] as EPGChannel[], programmes: [] as EPGProgram[]}
    let m3u = [] as M3USegment[];
    const streamTypes: Record<string, StreamType> = {};

    for (let channel in _plutoData) {

        //Pluto Data Is Stiched
        if (_plutoData[channel].isStitched) {

            //Needed For M3U Binding
            const m3uUrl = streamURL(_plutoData[channel].stitched.urls[0].url);

            const canonical = normalizePlutoCategory(_plutoData[channel].category, 'live');

            //Bind M3U Data
            let segment: M3USegment = {
                "#EXTINF": -1,
                "tvg-id": _plutoData[channel].slug,
                "tvg-logo": _plutoData[channel].colorLogoPNG.path,
                "group-title": canonical,
                "name": _plutoData[channel].name,
                "streamUrl": m3uUrl
            };
            m3u.push(segment);
            streamTypes[_plutoData[channel].slug] = 'live';

            //Bind Channel Data — only emit EPG channel rows for real (stitched) channels
            let channelData: EPGChannel = {
                "channel-id": _plutoData[channel].slug,
                "display-name": _plutoData[channel].name,
                "channel-number": _plutoData[channel].number.toString(),
                "icon": _plutoData[channel].colorLogoPNG.path,
                "url": 'https://pluto.tv',
                "description": _plutoData[channel].summary,
                "category": canonical,
                "language": 'en',
                "country": 'US',
            };
            epg.channels.push(channelData);

        } else {
            console.log("[DEBUG] Skipping 'fake' channel: ", _plutoData[channel]);
        }

        // Bind Programme Data
        if (_plutoData[channel].timelines) {
            for (let program of _plutoData[channel].timelines) {
                let programData: EPGProgram = {
                    "channel": _plutoData[channel].slug,
                    "start": moment(program.start).format('YYYYMMDDHHmmss Z'),  // Fixed timezone format
                    "stop": moment(program.stop).format('YYYYMMDDHHmmss Z'),    // Fixed timezone format
                    "title": program.title,
                    "sub-title": program.title === program.episode.name ? '' : program.episode.name,
                    "desc": program.episode.description,
                    "date": moment(program.episode.firstAired).format('YYYYMMDD'),
                    "category": program.episode.genre,
                    "genre": program.episode.subGenre,
                    "episode-num": `S${program.episode.season}E${program.episode.number}`, // Changed format for episode number
                    "icon": program.episode.poster.path,
                    "url": 'https://pluto.tv',
                    "length": program.episode.duration,
                    "original-air-date": moment(program.episode.firstAired).format('YYYYMMDD'),
                };
                epg.programmes.push(programData);
            }
        }
    }
    return { epg, m3u, streamTypes };
}


//Mandatory URL Shenanigans
const streamURL = (url: string) => {
    //Random Device ID Crap
    const deviceId = crypto.randomUUID();
    const sid = crypto.randomUUID();

    let m3uUrl = new URL(url);
    let queryString = m3uUrl.search;
    let params = new URLSearchParams(queryString);

    //Set the URL params
    params.set('advertisingId', '');
    params.set('appName', 'web');
    params.set('appVersion', 'unknown');
    params.set('appStoreUrl', '');
    params.set('architecture', '');
    params.set('buildVersion', '');
    params.set('clientTime', '0');
    params.set('deviceDNT', '0');
    params.set('deviceId', deviceId);
    params.set('deviceMake', 'Chrome');
    params.set('deviceModel', 'web');
    params.set('deviceType', 'web');
    params.set('deviceVersion', 'unknown');
    params.set('includeExtendedEvents', 'false');
    params.set('sid', sid);
    params.set('userId', '');
    params.set('serverSideAds', 'true');

    m3uUrl.search = params.toString();
    return m3uUrl.toString();
}



// ============================================================================
// Pluto VOD (authenticated) — AES-128 clear-key HLS, no Widevine.
//
// Pluto's on-demand HLS endpoint serves standard AES-128-encrypted HLS with a
// publicly-fetchable key, gated by a session-wide entitled JWT. Any player
// decrypts it natively; Snagger just proxies + propagates the jwt (see
// server/drm.ts). The jwt is minted via a logged-in browser (helpers/
// pluto_token.py), is session-wide (works for every title), and lasts ~24h.
// ============================================================================

export interface PlutoVodCreds { email?: string; password?: string }

let _plutoVodToken: { jwt: string; expiresAt: number } | null = null;
let _plutoTokenInflight: Promise<string> | null = null;

// Pure-HTTP token flow (no browser): cookie login via the SignIn mutation, then
// the PtvStart query returns the session-wide entitled JWT. Discovered by
// capturing the web app's own requests.
const PLUTO_WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Origin': 'https://pluto.tv', 'Referer': 'https://pluto.tv/', 'Content-Type': 'application/json',
};
const SIGNIN_MUTATION = 'mutation SignIn($formFields: SignInFormFields!) { signIn(formFields: $formFields) { userId success message } }';
const PTVSTART_QUERY = 'query PtvStart($params: StartParameters!) { ptvStart(params: $params) { deviceId session { id jwt } refreshInSec } }';

/** Entitled Pluto session JWT for VOD (session-wide, ~24h). Cached until ~30m
 *  before expiry. Fully programmatic — no browser. */
export async function getPlutoVodToken(creds: PlutoVodCreds): Promise<string> {
  if (_plutoVodToken && _plutoVodToken.expiresAt > Date.now() + 30 * 60_000) return _plutoVodToken.jwt;
  if (!creds.email || !creds.password) throw new Error('Pluto VOD requires account credentials (Sources → PlutoTV)');
  if (_plutoTokenInflight) return _plutoTokenInflight;

  _plutoTokenInflight = (async () => {
    const deviceId = crypto.randomUUID();

    // 1. SignIn — establishes the authenticated cookie session.
    const r1 = await fetch('https://pluto.tv/api/tn/signup/graphql/', {
      method: 'POST',
      headers: { ...PLUTO_WEB_HEADERS, Cookie: `ptv_device_id=${deviceId}` },
      body: JSON.stringify({ query: SIGNIN_MUTATION, operationName: 'SignIn',
        variables: { formFields: { email: creds.email, password: creds.password, rememberMe: 1 } } }),
    });
    const d1 = await r1.json() as { data?: { signIn?: { success?: boolean; message?: string; userId?: string } }; errors?: unknown };
    if (!d1?.data?.signIn?.success) {
      throw new Error(`Pluto SignIn failed: ${d1?.data?.signIn?.message ?? JSON.stringify(d1).slice(0, 140)}`);
    }
    // Gather cookies from the login response for the PtvStart call.
    const jar: Record<string, string> = { ptv_device_id: deviceId };
    for (const sc of r1.headers.getSetCookie()) {
      const nv = sc.split(';')[0]; const i = nv.indexOf('=');
      if (i > 0) jar[nv.slice(0, i).trim()] = nv.slice(i + 1);
    }
    const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

    // 2. PtvStart — mints the entitled session JWT.
    const r2 = await fetch('https://pluto.tv/api/tn/app-shell/graphql/', {
      method: 'POST',
      headers: { ...PLUTO_WEB_HEADERS, Cookie: cookieHeader },
      body: JSON.stringify({ query: PTVSTART_QUERY, operationName: 'PtvStart',
        variables: { params: { deviceModel: 'web', drmCapabilities: 'widevine:L3', isClientDNT: false,
          usPrivacy: '1YNN', deviceId, ptvAppName: 'web', cmAudienceID: '' } } }),
    });
    const d2 = await r2.json() as { data?: { ptvStart?: { session?: { jwt?: string } } } };
    const jwt = d2?.data?.ptvStart?.session?.jwt;
    if (!jwt) throw new Error(`Pluto PtvStart returned no jwt: ${JSON.stringify(d2).slice(0, 140)}`);

    let expiresAt = Date.now() + 12 * 3600_000;
    try { const c = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()); if (c.exp) expiresAt = c.exp * 1000; } catch {}
    _plutoVodToken = { jwt, expiresAt };
    console.log(`[Pluto] VOD token via HTTP (userID ${d1.data.signIn.userId}, exp ${new Date(expiresAt).toISOString()})`);
    return jwt;
  })();
  try { return await _plutoTokenInflight; }
  finally { _plutoTokenInflight = null; }
}

/** The authenticated AES-128 HLS master URL for a Pluto VOD content id. */
export function plutoVodMasterUrl(contentId: string, jwt: string): string {
  return `https://ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/episode/${encodeURIComponent(contentId)}/master.m3u8?serverSideAds=false&jwt=${jwt}`;
}
