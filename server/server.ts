import { db, getActiveTemplateId, getTemplateByName, getTemplateById, getSetting, setSetting, listSettings, parseTemplateExports } from './db';
import { buildM3U, buildXMLTV } from './output';
import { refreshAll, refreshSourceByName, refreshSourceRow } from './refresh';
import { handleStreamByKey, handleRawStream, handleVoucher, rawProxyUrlFor, streamUrlFor, voucherUrlFor, getActiveConnections, getCacheStats } from './proxy';
import { resolveImdb, type VersionSelector } from './imdb';
import {
  searchCatalog, popularCatalog, titleDetailByImdb, titleDetailByTmdb,
  episodes as catalogEpisodes, listSourceOptions, flattenVersions, getPins, setPins, type Pin,
} from './catalog';
import { loadEpisodes } from './series';
import {
  listSources, getSourceById, getSourceByName, createSource, updateSource, deleteSource, testSource,
  type SourceType,
} from './sources';
import { startScheduler } from './scheduler';
import { handleTubiMaster, handleTubiVariant, handleTubiSegment, handlePlutoMaster, handlePlutoVariant, handlePlutoRaw } from './drm';

const PORT = Number(Bun.env.PORT ?? 3000);

type ChannelListRow = {
  key: string;
  source: string;
  channel_id: string;
  name: string;
  icon: string | null;
  group: string | null;
  stream_url: string | null;
  stream_type: string;
  last_seen: number;
  enabled: number;
  override_name: string | null;
  override_icon: string | null;
  override_group: string | null;
  override_imdb_id: string | null;
};

const channelSelectClause = `
  SELECT
    c.key, c.source, c.channel_id, c.name, c.icon, c."group", c.stream_url, c.stream_type, c.last_seen,
    COALESCE(o.enabled, 1) AS enabled,
    o.name    AS override_name,
    o.icon    AS override_icon,
    o."group" AS override_group,
    o.imdb_id AS override_imdb_id
  FROM channels c
  LEFT JOIN overrides o ON o.key = c.key AND o.template_id = ?
`;

type ChannelFilters = {
  q?: string | null;
  source?: string | null;
  type?: string | null;
  group?: string | null;
};

function buildChannelQuery(filters: ChannelFilters): { where: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filters.source) { conds.push('c.source = ?');      params.push(filters.source); }
  if (filters.type)   { conds.push('c.stream_type = ?'); params.push(filters.type); }
  if (filters.group)  { conds.push('c."group" = ?');     params.push(filters.group); }
  if (filters.q) {
    const like = '%' + filters.q.toLowerCase() + '%';
    conds.push('(lower(c.name) LIKE ? OR lower(c.channel_id) LIKE ?)');
    params.push(like, like);
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

function parseFilters(url: URL): ChannelFilters {
  return {
    q: url.searchParams.get('q'),
    source: url.searchParams.get('source'),
    type: url.searchParams.get('type'),
    group: url.searchParams.get('group'),
  };
}

// Version selector for the /imdb resolver: first present param wins.
function parseVersionSelector(url: URL): VersionSelector | undefined {
  const hash = url.searchParams.get('hash');
  if (hash) return { kind: 'torrentio', infoHash: hash };
  const channel = url.searchParams.get('channel');
  if (channel) return { kind: 'channel', channelKey: channel };
  const series = url.searchParams.get('series');
  if (series) return { kind: 'episode', seriesKey: series };
  const tubi = url.searchParams.get('tubi');
  if (tubi) return { kind: 'tubi', tubiId: tubi, manifestUrl: url.searchParams.get('manifest') ?? undefined };
  return undefined;
}

const upsertOverride = db.prepare(`
  INSERT INTO overrides (template_id, key, enabled, name, icon, "group", imdb_id)
  VALUES ($template_id, $key, $enabled, $name, $icon, $group, $imdb_id)
  ON CONFLICT(template_id, key) DO UPDATE SET
    enabled = excluded.enabled,
    name    = excluded.name,
    icon    = excluded.icon,
    "group" = excluded."group",
    imdb_id = excluded.imdb_id
`);

const selectOverride = db.query<
  { enabled: number; name: string | null; icon: string | null; group: string | null; imdb_id: string | null },
  [number, string]
>(`SELECT enabled, name, icon, "group", imdb_id FROM overrides WHERE template_id = ? AND key = ?`);

const deleteOverride = db.prepare(`DELETE FROM overrides WHERE template_id = $template_id AND key = $key`);

type TemplateRow = { id: number; name: string; created_at: number; proxy_mode: number; exports_json: string | null };
const listTemplates = db.query<TemplateRow, []>(
  `SELECT id, name, created_at, proxy_mode, exports_json FROM templates ORDER BY id`
);
const getTemplateRowById = db.query<TemplateRow, [number]>(
  `SELECT id, name, created_at, proxy_mode, exports_json FROM templates WHERE id = ?`
);
const insertTemplate = db.prepare(`INSERT INTO templates (name, created_at) VALUES (?, ?)`);
const deleteTemplate = db.prepare(`DELETE FROM templates WHERE id = ?`);
const renameTemplate = db.prepare(`UPDATE templates SET name = ? WHERE id = ?`);
const setTemplateProxyMode = db.prepare(`UPDATE templates SET proxy_mode = ? WHERE id = ?`);
const setTemplateExports = db.prepare(`UPDATE templates SET exports_json = ? WHERE id = ?`);
const setActiveTemplate = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('active_template', ?)`);

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function text(body: string, contentType: string) {
  return new Response(body, { headers: { 'content-type': contentType } });
}

function err(status: number, message: string) {
  return json({ error: message }, { status });
}

function resolveTemplate(param: string | null): { id: number; name: string } | null {
  if (!param) {
    const id = getActiveTemplateId();
    return getTemplateById(id);
  }
  const asNum = Number(param);
  if (!Number.isNaN(asNum) && param.trim() !== '') {
    const t = getTemplateById(asNum);
    if (t) return t;
  }
  return getTemplateByName(param);
}

type OverridePatch = {
  enabled?: boolean;
  name?: string | null;
  icon?: string | null;
  group?: string | null;
  imdbId?: string | null;
};

function applyPatch(templateId: number, key: string, body: OverridePatch) {
  const current = selectOverride.get(templateId, key);
  const merged = {
    enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : (current?.enabled ?? 1),
    name:    'name'   in body ? body.name   ?? null : (current?.name    ?? null),
    icon:    'icon'   in body ? body.icon   ?? null : (current?.icon    ?? null),
    group:   'group'  in body ? body.group  ?? null : (current?.group   ?? null),
    imdb_id: 'imdbId' in body ? body.imdbId ?? null : (current?.imdb_id ?? null),
  };
  upsertOverride.run({
    $template_id: templateId,
    $key: key,
    $enabled: merged.enabled,
    $name: merged.name,
    $icon: merged.icon,
    $group: merged.group,
    $imdb_id: merged.imdb_id,
  });
  return merged;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240, // seconds; some refresh/proxy ops are slow
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // --- Static UI ---
    // Prefer the new Svelte build in ui/dist/, fall back to the legacy single-file UI.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const dist = Bun.file('ui/dist/index.html');
      if (await dist.exists()) return new Response(dist);
      return new Response(Bun.file('web/index.html'));
    }
    if (req.method === 'GET' && (pathname.startsWith('/assets/') || pathname === '/favicon.svg' || pathname === '/favicon.ico')) {
      const f = Bun.file('ui/dist' + pathname);
      if (await f.exists()) return new Response(f);
    }

    const typeParam = url.searchParams.get('type');
    const baseUrl = `${url.protocol}//${url.host}`;

    // --- DRM VOD proxy (Widevine → clear HLS) ---
    const drmTubi = pathname.match(/^\/drm\/tubi\/([^/]+)\/(master\.m3u8|v\.m3u8|s\.mp4)$/);
    if (req.method === 'GET' && drmTubi) {
      const id = decodeURIComponent(drmTubi[1]);
      try {
        if (drmTubi[2] === 'master.m3u8') return await handleTubiMaster(id, baseUrl);
        if (drmTubi[2] === 'v.m3u8')      return await handleTubiVariant(id, url.searchParams.get('u') ?? '', baseUrl);
        return await handleTubiSegment(id, url.searchParams);
      } catch (e) {
        return err(502, `tubi drm: ${(e as Error).message}`);
      }
    }
    const drmPluto = pathname.match(/^\/drm\/pluto\/([^/]+)\/(master\.m3u8|v\.m3u8|raw)$/);
    if (req.method === 'GET' && drmPluto) {
      const id = decodeURIComponent(drmPluto[1]);
      try {
        if (drmPluto[2] === 'master.m3u8') return await handlePlutoMaster(id, baseUrl);
        if (drmPluto[2] === 'v.m3u8')      return await handlePlutoVariant(id, url.searchParams.get('u') ?? '', baseUrl);
        return await handlePlutoRaw(url.searchParams.get('u') ?? '');
      } catch (e) {
        return err(502, `pluto drm: ${(e as Error).message}`);
      }
    }

    // --- Proxy endpoints ---
    const streamMatch = pathname.match(/^\/stream\/(.+)$/);
    if (req.method === 'GET' && streamMatch) {
      const key = decodeURIComponent(streamMatch[1]);
      const token = url.searchParams.get('t') ?? '';
      return await handleStreamByKey(key, token, req, baseUrl);
    }
    if (req.method === 'GET' && pathname === '/stream-raw') {
      const target = url.searchParams.get('u') ?? '';
      const token = url.searchParams.get('t') ?? '';
      const kid = url.searchParams.get('kid') ?? null;
      return await handleRawStream(target, token, req, baseUrl, kid);
    }
    const voucherMatch = pathname.match(/^\/v\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && voucherMatch) {
      return await handleVoucher(voucherMatch[1], req, baseUrl);
    }

    // --- Series episode loader (lazy, cached in series_episodes) ---
    const seriesEpMatch = pathname.match(/^\/api\/series\/(.+)\/episodes$/);
    if (req.method === 'GET' && seriesEpMatch) {
      try {
        const seriesKey = decodeURIComponent(seriesEpMatch[1]);
        const forceFresh = url.searchParams.get('fresh') === '1';
        const eps = await loadEpisodes(seriesKey, { forceFresh });
        return json({ seriesKey, episodes: eps });
      } catch (e) { return err(502, (e as Error).message); }
    }

    // --- Catalog (TMDB-backed) ---
    if (req.method === 'GET' && pathname === '/api/catalog/search') {
      try {
        const q = url.searchParams.get('q') ?? '';
        const kind = (url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        if (!q.trim()) return json({ results: [], page: 1, totalPages: 0, totalResults: 0 });
        return json(await searchCatalog(q.trim(), kind, page));
      } catch (e) { return err(502, (e as Error).message); }
    }
    if (req.method === 'GET' && pathname === '/api/catalog/popular') {
      try {
        const kind = (url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const listParam = url.searchParams.get('list');
        const list = (listParam === 'trending' || listParam === 'top_rated') ? listParam : 'popular';
        return json(await popularCatalog(kind, page, list));
      } catch (e) { return err(502, (e as Error).message); }
    }
    const titleTmdbMatch = pathname.match(/^\/api\/catalog\/tmdb\/(movie|tv)\/(\d+)$/);
    if (req.method === 'GET' && titleTmdbMatch) {
      try {
        const t = await titleDetailByTmdb(titleTmdbMatch[1] as 'movie' | 'tv', Number(titleTmdbMatch[2]));
        return json(t);
      } catch (e) { return err(502, (e as Error).message); }
    }
    const titleImdbMatch = pathname.match(/^\/api\/catalog\/title\/(tt\d+)(?:\/(\d+)\/(\d+))?$/);
    if (req.method === 'GET' && titleImdbMatch) {
      try {
        const t = await titleDetailByImdb(titleImdbMatch[1]);
        return json(t);
      } catch (e) { return err(502, (e as Error).message); }
    }
    const episodesMatch = pathname.match(/^\/api\/catalog\/tmdb\/tv\/(\d+)\/season\/(\d+)$/);
    if (req.method === 'GET' && episodesMatch) {
      try {
        return json(await catalogEpisodes(Number(episodesMatch[1]), Number(episodesMatch[2])));
      } catch (e) { return err(502, (e as Error).message); }
    }
    const sourcesMatch = pathname.match(/^\/api\/catalog\/title\/(tt\d+)(?:\/(\d+)\/(\d+))?\/sources$/);
    if (req.method === 'GET' && sourcesMatch) {
      try {
        const imdbId = sourcesMatch[1];
        const season = sourcesMatch[2] ? Number(sourcesMatch[2]) : undefined;
        const episode = sourcesMatch[3] ? Number(sourcesMatch[3]) : undefined;
        const titleHint = url.searchParams.get('title') ?? undefined;
        const kind = (url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie') as 'movie' | 'tv';
        const opts = await listSourceOptions(imdbId, kind, season, episode, titleHint);
        const versions = flattenVersions(baseUrl, imdbId, season, episode, opts);
        return json({ ...opts, versions });
      } catch (e) { return err(502, (e as Error).message); }
    }
    const pinsMatch = pathname.match(/^\/api\/catalog\/title\/(tt\d+)(?:\/(\d+)\/(\d+))?\/pins$/);
    if (pinsMatch) {
      const imdbId = pinsMatch[1];
      const season = pinsMatch[2] ? Number(pinsMatch[2]) : undefined;
      const episode = pinsMatch[3] ? Number(pinsMatch[3]) : undefined;
      if (req.method === 'GET') {
        return json({ pins: getPins(imdbId, season, episode) });
      }
      if (req.method === 'PUT') {
        const body = (await req.json()) as { pins?: Pin[] };
        const pins = Array.isArray(body.pins) ? body.pins : [];
        setPins(imdbId, season, episode, pins);
        return json({ ok: true, pins });
      }
      if (req.method === 'DELETE') {
        setPins(imdbId, season, episode, []);
        return json({ ok: true });
      }
    }

    // --- All pinned IMDB ids (cross-catalog view for the Pins page) ---
    if (req.method === 'GET' && pathname === '/api/pins') {
      const rows = db.query<{ imdb_id: string; season: number; episode: number; pins_json: string; updated_at: number }, []>(
        `SELECT imdb_id, season, episode, pins_json, updated_at FROM imdb_pins ORDER BY updated_at DESC`
      ).all();
      const items = rows.map(r => ({
        imdbId: r.imdb_id,
        season: r.season < 0 ? null : r.season,
        episode: r.episode < 0 ? null : r.episode,
        updatedAt: r.updated_at,
        pins: (() => { try { return JSON.parse(r.pins_json) as Pin[]; } catch { return [] as Pin[]; } })(),
      })).filter(i => i.pins.length > 0);
      return json({ pins: items, total: items.length });
    }

    // --- IMDB resolver ---
    // /imdb/tt12345           -> 302 redirect to playable URL (proxied through Snagger by default)
    // /imdb/tt12345.strm      -> text/plain .strm body
    // /imdb/tt12345/1/2       -> series S01E02
    // /imdb/tt12345?proxy=0   -> skip proxy (return upstream URL directly; exposes credentials)
    const imdbMatch = pathname.match(/^\/imdb\/(tt\d+)(?:\/(\d+)\/(\d+))?(\.strm)?$/);
    if (req.method === 'GET' && imdbMatch) {
      const imdbId = imdbMatch[1];
      const season = imdbMatch[2] ? Number(imdbMatch[2]) : undefined;
      const episode = imdbMatch[3] ? Number(imdbMatch[3]) : undefined;
      const asStrm = !!imdbMatch[4];

      // .strm should be a stable pointer to Snagger itself — the player opens it on every
      // play, Snagger resolves fresh, and the file never goes stale.
      if (asStrm) {
        const segs = season != null && episode != null ? `/${season}/${episode}` : '';
        // Preserve any version selector (?hash=/?channel=/…) so the pointer
        // re-resolves the same version; empty for a bare request.
        return text(`${baseUrl}/imdb/${imdbId}${segs}${url.search}\n`, 'text/plain');
      }

      const forceFresh = url.searchParams.get('fresh') === '1';
      const proxyParam = url.searchParams.get('proxy');
      const selector = parseVersionSelector(url);
      const strict = url.searchParams.get('strict') === '1';
      try {
        const result = await resolveImdb(imdbId, season, episode, { forceFresh, selector, strict });
        if (!result) return err(404, 'no streams found for ' + imdbId);

        // Decide whether to proxy:
        //   - explicit ?proxy=0 / ?proxy=1 always wins
        //   - else, channel/episode pins follow source.proxyMode ('off' = direct, else proxy)
        //   - else (torrentio), follow global setting imdb_proxy_torrentio (default ON)
        let useProxy: boolean;
        if (proxyParam === '0')      useProxy = false;
        else if (proxyParam === '1') useProxy = true;
        else if (result.sourceName === 'Tubi') {
          // Tubi's manifest/segment URLs are signed for the session that
          // fetched them — always proxy so the player never hits the CDN
          // directly with a foreign IP / expired token.
          useProxy = true;
        } else if (result.sourceName) {
          const owner = getSourceByName(result.sourceName);
          const cfg = owner ? JSON.parse(owner.config_json) as Record<string, unknown> : {};
          useProxy = cfg.proxyMode !== 'off';
        } else {
          useProxy = (getSetting('imdb_proxy_torrentio') ?? 'true') !== 'false';
        }

        let finalUrl: string;
        const drmSentinel = result.url.match(/^drm-(pluto|tubi):(.+)$/);
        if (drmSentinel) {
          // Pluto/Tubi DRM proxy already emits a self-contained playlist with
          // absolute, token-bearing URLs — never double-proxy through a voucher.
          finalUrl = `${baseUrl}/drm/${drmSentinel[1]}/${encodeURIComponent(drmSentinel[2])}/master.m3u8`;
        } else if (useProxy) {
          finalUrl = result.channelKey
            ? streamUrlFor(baseUrl, result.channelKey)
            : voucherUrlFor(baseUrl, result.url);
        } else {
          finalUrl = result.url;
        }
        return new Response(null, { status: 302, headers: { location: finalUrl } });
      } catch (e) {
        return err(502, `resolve failed: ${(e as Error).message}`);
      }
    }

    // --- Active-template output ---
    if (req.method === 'GET' && pathname === '/playlist.m3u') {
      const row = getTemplateRowById.get(getActiveTemplateId());
      if (!row || !parseTemplateExports(row.exports_json).m3u) return err(404, 'm3u export is disabled for the active template');
      return text(buildM3U(row.id, typeParam, baseUrl), 'application/vnd.apple.mpegurl');
    }
    if (req.method === 'GET' && pathname === '/epg.xml') {
      const row = getTemplateRowById.get(getActiveTemplateId());
      if (!row || !parseTemplateExports(row.exports_json).epg) return err(404, 'epg export is disabled for the active template');
      return text(buildXMLTV(row.id, typeParam), 'application/xml');
    }

    // --- Per-template output: /playlists/<name>.m3u, /epg/<name>.xml (optional ?type=live|movie) ---
    const m3uMatch = pathname.match(/^\/playlists\/(.+)\.m3u$/);
    if (req.method === 'GET' && m3uMatch) {
      const t = resolveTemplate(decodeURIComponent(m3uMatch[1]));
      if (!t) return err(404, 'template not found');
      const row = getTemplateRowById.get(t.id);
      if (!row || !parseTemplateExports(row.exports_json).m3u) return err(404, 'm3u export is disabled for this template');
      return text(buildM3U(t.id, typeParam, baseUrl), 'application/vnd.apple.mpegurl');
    }
    const epgMatch = pathname.match(/^\/epg\/(.+)\.xml$/);
    if (req.method === 'GET' && epgMatch) {
      const t = resolveTemplate(decodeURIComponent(epgMatch[1]));
      if (!t) return err(404, 'template not found');
      const row = getTemplateRowById.get(t.id);
      if (!row || !parseTemplateExports(row.exports_json).epg) return err(404, 'epg export is disabled for this template');
      return text(buildXMLTV(t.id, typeParam), 'application/xml');
    }

    // --- API: sources ---
    if (req.method === 'GET' && pathname === '/api/sources') {
      const sources = listSources().map(s => ({ ...s, active: getActiveConnections(s.name) }));
      return json({ sources, cache: getCacheStats() });
    }
    if (req.method === 'POST' && pathname === '/api/sources') {
      const body = (await req.json()) as { name?: string; type?: SourceType; config?: Record<string, unknown>; enabled?: boolean; refreshIntervalMs?: number };
      if (!body.name || !body.type) return err(400, 'name and type are required');
      try {
        const row = createSource({ name: body.name, type: body.type, config: body.config ?? {}, enabled: body.enabled, refreshIntervalMs: body.refreshIntervalMs });
        return json({ source: row });
      } catch (e) {
        return err(400, (e as Error).message);
      }
    }
    const sourceIdMatch = pathname.match(/^\/api\/sources\/(\d+)(?:\/(test|refresh))?$/);
    if (sourceIdMatch) {
      const id = Number(sourceIdMatch[1]);
      const action = sourceIdMatch[2];
      const row = getSourceById(id);
      if (!row) return err(404, 'source not found');
      if (req.method === 'PUT' && !action) {
        const body = (await req.json()) as { name?: string; config?: Record<string, unknown>; enabled?: boolean; refreshIntervalMs?: number };
        try {
          updateSource(id, body);
          return json({ ok: true });
        } catch (e) {
          return err(400, (e as Error).message);
        }
      }
      if (req.method === 'DELETE' && !action) {
        const res = deleteSource(id);
        return json({ ok: true, deletedChannels: res.deletedChannels });
      }
      if (req.method === 'POST' && action === 'test') {
        const r = await testSource(row);
        return json(r);
      }
      if (req.method === 'POST' && action === 'refresh') {
        const r = await refreshSourceRow(row);
        return json(r);
      }
    }

    // --- API: settings (key-value, stored in meta:'setting:<key>') ---
    if (req.method === 'GET' && pathname === '/api/settings') {
      return json({ settings: listSettings() });
    }
    if (req.method === 'PUT' && pathname === '/api/settings') {
      const body = (await req.json()) as Record<string, string | null>;
      for (const [k, v] of Object.entries(body)) setSetting(k, v);
      return json({ ok: true });
    }

    // --- API: templates ---
    if (req.method === 'GET' && pathname === '/api/templates') {
      const activeId = getActiveTemplateId();
      return json({ templates: listTemplates.all(), activeId });
    }
    if (req.method === 'POST' && pathname === '/api/templates') {
      const body = (await req.json()) as { name?: string };
      const name = (body.name ?? '').trim();
      if (!name) return err(400, 'name required');
      try {
        insertTemplate.run(name, Date.now());
      } catch (e) {
        return err(409, 'template name already exists');
      }
      const t = getTemplateByName(name)!;
      return json({ template: t });
    }
    const templateMatch = pathname.match(/^\/api\/templates\/(\d+)$/);
    if (templateMatch) {
      const id = Number(templateMatch[1]);
      const existing = getTemplateById(id);
      if (!existing) return err(404, 'template not found');
      if (req.method === 'PUT') {
        const body = (await req.json()) as { proxyMode?: boolean; name?: string; exports?: { m3u?: boolean; epg?: boolean } };
        if (typeof body.proxyMode === 'boolean') {
          setTemplateProxyMode.run(body.proxyMode ? 1 : 0, id);
        }
        if (typeof body.name === 'string') {
          const newName = body.name.trim();
          if (!newName) return err(400, 'name cannot be empty');
          try { renameTemplate.run(newName, id); }
          catch { return err(409, 'template name already exists'); }
        }
        if (body.exports && typeof body.exports === 'object') {
          const current = parseTemplateExports(getTemplateRowById.get(id)?.exports_json ?? null);
          const next = {
            m3u: body.exports.m3u === undefined ? current.m3u : !!body.exports.m3u,
            epg: body.exports.epg === undefined ? current.epg : !!body.exports.epg,
          };
          setTemplateExports.run(JSON.stringify(next), id);
        }
        return json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const all = listTemplates.all();
        if (all.length <= 1) return err(400, 'cannot delete the last template');
        deleteTemplate.run(id);
        if (getActiveTemplateId() === id) {
          const remaining = listTemplates.all();
          setActiveTemplate.run(String(remaining[0].id));
        }
        return json({ ok: true });
      }
    }
    if (req.method === 'POST' && pathname === '/api/active-template') {
      const body = (await req.json()) as { id?: number };
      if (!body.id || !getTemplateById(body.id)) return err(400, 'invalid template id');
      setActiveTemplate.run(String(body.id));
      return json({ ok: true, activeId: body.id });
    }

    // --- API: channels (paginated, server-filtered) ---
    if (req.method === 'GET' && pathname === '/api/channels') {
      const t = resolveTemplate(url.searchParams.get('template'));
      if (!t) return err(404, 'template not found');
      const filters = parseFilters(url);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const pageSize = Math.min(500, Math.max(10, Number(url.searchParams.get('pageSize') ?? 100)));
      const offset = (page - 1) * pageSize;
      const { where, params } = buildChannelQuery(filters);

      const countSql = `SELECT count(*) AS n FROM channels c ${where}`;
      const total = (db.query<{ n: number }, unknown[]>(countSql).get(...params) ?? { n: 0 }).n;

      const listSql = `${channelSelectClause} ${where} ORDER BY c.source, c.name LIMIT ? OFFSET ?`;
      const rows = db.query<ChannelListRow, unknown[]>(listSql).all(t.id, ...params, pageSize, offset);

      return json({
        templateId: t.id,
        page, pageSize, total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        channels: rows.map(r => ({
          key: r.key,
          source: r.source,
          channelId: r.channel_id,
          name: r.name,
          icon: r.icon,
          group: r.group,
          streamUrl: r.stream_url,
          streamType: r.stream_type,
          lastSeen: r.last_seen,
          enabled: r.enabled === 1,
          override: { name: r.override_name, icon: r.override_icon, group: r.override_group, imdbId: r.override_imdb_id },
        })),
      });
    }

    // --- API: channel keys (filter -> all matching keys) ---
    if (req.method === 'GET' && pathname === '/api/channels/keys') {
      const filters = parseFilters(url);
      const { where, params } = buildChannelQuery(filters);
      const rows = db.query<{ key: string }, unknown[]>(
        `SELECT c.key FROM channels c ${where} ORDER BY c.source, c.name`
      ).all(...params);
      return json({ keys: rows.map(r => r.key), total: rows.length });
    }

    // --- API: stats (counts per source / type / group, scoped by current filter) ---
    if (req.method === 'GET' && pathname === '/api/stats') {
      const filters = parseFilters(url);
      // Sources: always all sources (filter by everything except source itself)
      const sourceScope = buildChannelQuery({ ...filters, source: null });
      const sources = db.query<{ source: string; n: number }, unknown[]>(
        `SELECT source, count(*) AS n FROM channels c ${sourceScope.where} GROUP BY source ORDER BY source`
      ).all(...sourceScope.params);
      // Types: scoped by source, ignoring type
      const typeScope = buildChannelQuery({ ...filters, type: null });
      const types = db.query<{ stream_type: string; n: number }, unknown[]>(
        `SELECT stream_type, count(*) AS n FROM channels c ${typeScope.where} GROUP BY stream_type ORDER BY stream_type`
      ).all(...typeScope.params);
      // Groups: scoped by source+type, ignoring group itself
      const groupScope = buildChannelQuery({ ...filters, group: null });
      const groups = db.query<{ group: string | null; n: number }, unknown[]>(
        `SELECT "group" AS "group", count(*) AS n FROM channels c ${groupScope.where} GROUP BY "group" ORDER BY n DESC LIMIT 1000`
      ).all(...groupScope.params);
      const total = (db.query<{ n: number }, unknown[]>(
        `SELECT count(*) AS n FROM channels c ${buildChannelQuery(filters).where}`
      ).get(...buildChannelQuery(filters).params) ?? { n: 0 }).n;
      return json({ sources, types, groups, total });
    }

    // --- API: refresh (all sources, or one by name) ---
    if (req.method === 'POST' && pathname === '/api/refresh') {
      let body: { source?: string } = {};
      try { body = await req.json(); } catch {}
      const results = body.source ? [await refreshSourceByName(body.source)] : await refreshAll();
      return json({ results });
    }

    // --- API: bulk overrides by filter (single-SQL, doesn't need a key list) ---
    if (req.method === 'POST' && pathname === '/api/overrides/bulk-by-filter') {
      const t = resolveTemplate(url.searchParams.get('template'));
      if (!t) return err(404, 'template not found');
      const body = (await req.json()) as { filter?: ChannelFilters; patch?: OverridePatch };
      const patch = body.patch ?? {};
      if (
        patch.enabled === undefined &&
        !('name' in patch) && !('icon' in patch) && !('group' in patch)
      ) {
        return err(400, 'patch must include at least one field');
      }
      const { where, params } = buildChannelQuery(body.filter ?? {});
      // For fields not in patch, we want to preserve existing override values.
      // Easier: INSERT ... SELECT picking from existing overrides where present, else from patch.
      const enabledExpr  = patch.enabled !== undefined ? String(patch.enabled ? 1 : 0) : 'COALESCE(o.enabled, 1)';
      const nameExpr     = 'name'  in patch ? (patch.name  === null ? 'NULL' : '?') : 'o.name';
      const iconExpr     = 'icon'  in patch ? (patch.icon  === null ? 'NULL' : '?') : 'o.icon';
      const groupExpr    = 'group' in patch ? (patch.group === null ? 'NULL' : '?') : 'o."group"';
      const literals: string[] = [];
      if ('name'  in patch && patch.name  !== null) literals.push(patch.name as string);
      if ('icon'  in patch && patch.icon  !== null) literals.push(patch.icon as string);
      if ('group' in patch && patch.group !== null) literals.push(patch.group as string);

      const sql = `
        INSERT INTO overrides (template_id, key, enabled, name, icon, "group")
        SELECT ?, c.key, ${enabledExpr}, ${nameExpr}, ${iconExpr}, ${groupExpr}
        FROM channels c
        LEFT JOIN overrides o ON o.key = c.key AND o.template_id = ?
        ${where}
        ON CONFLICT(template_id, key) DO UPDATE SET
          enabled = excluded.enabled,
          name    = excluded.name,
          icon    = excluded.icon,
          "group" = excluded."group"
      `;
      const allParams: (string | number)[] = [t.id, ...literals, t.id, ...params];
      const res = db.run(sql, allParams);
      return json({ ok: true, updated: res.changes });
    }

    // --- API: bulk overrides (by key list) ---
    if (req.method === 'POST' && pathname === '/api/overrides/bulk') {
      const t = resolveTemplate(url.searchParams.get('template'));
      if (!t) return err(404, 'template not found');
      const body = (await req.json()) as { keys?: string[]; patch?: OverridePatch };
      if (!Array.isArray(body.keys) || body.keys.length === 0) return err(400, 'keys required');
      const patch = body.patch ?? {};
      let updated = 0;
      const tx = db.transaction(() => {
        for (const key of body.keys!) {
          applyPatch(t.id, key, patch);
          updated++;
        }
      });
      tx();
      return json({ ok: true, updated });
    }

    // --- API: bulk reset ---
    if (req.method === 'POST' && pathname === '/api/overrides/bulk-reset') {
      const t = resolveTemplate(url.searchParams.get('template'));
      if (!t) return err(404, 'template not found');
      const body = (await req.json()) as { keys?: string[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) return err(400, 'keys required');
      let cleared = 0;
      const tx = db.transaction(() => {
        for (const key of body.keys!) {
          deleteOverride.run({ $template_id: t.id, $key: key });
          cleared++;
        }
      });
      tx();
      return json({ ok: true, cleared });
    }

    // --- API: single override ---
    const overrideMatch = pathname.match(/^\/api\/overrides\/(.+)$/);
    if (overrideMatch && !pathname.includes('/bulk')) {
      const t = resolveTemplate(url.searchParams.get('template'));
      if (!t) return err(404, 'template not found');
      const key = decodeURIComponent(overrideMatch[1]);
      if (req.method === 'PUT') {
        const body = (await req.json()) as OverridePatch;
        const merged = applyPatch(t.id, key, body);
        return json({ ok: true, key, override: merged });
      }
      if (req.method === 'DELETE') {
        deleteOverride.run({ $template_id: t.id, $key: key });
        return json({ ok: true, key });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
});

startScheduler();
console.log(`Snagger serving on http://localhost:${server.port}`);
console.log(`  UI:    http://localhost:${server.port}/`);
console.log(`  M3U:   http://localhost:${server.port}/playlist.m3u   (active template)`);
console.log(`  EPG:   http://localhost:${server.port}/epg.xml        (active template)`);
console.log(`  IMDB:  http://localhost:${server.port}/imdb/tt12345           (movie, 302)`);
console.log(`         http://localhost:${server.port}/imdb/tt12345.strm      (movie, .strm file)`);
console.log(`         http://localhost:${server.port}/imdb/tt12345/1/2       (series S01E02)`);
