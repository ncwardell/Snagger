import { db } from './db';
import { snagXtream, fetchXtreamUserInfo, type XtreamProvider } from '../helpers/xtream';
import { snagM3U, type M3USourceConfig } from '../helpers/m3u-source';
import type { SnagResponse } from '../helpers/Interfaces';

export type SourceType = 'plutotv' | 'xtream' | 'm3u' | 'tubi';

export interface SourceRow {
  id: number;
  name: string;
  type: SourceType;
  config_json: string;
  enabled: number;
  created_at: number;
  last_refreshed: number | null;
  last_status: string | null;
  info_json: string | null;
  refresh_interval_ms: number;
}

export interface SourceView {
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
}

function maskConfig(type: SourceType, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  if (type === 'xtream' && Array.isArray(out.credentials)) {
    out.credentials = (out.credentials as Array<Record<string, unknown>>).map(c => ({
      ...c,
      password: typeof c.password === 'string' ? '••••••••' : c.password,
    }));
  }
  // Pluto (and any source) with an optional account password
  if (typeof out.password === 'string' && out.password) out.password = '••••••••';
  return out;
}

export interface XtreamCredential { username: string; password: string; }

function readCredentials(cfg: Record<string, unknown>): XtreamCredential[] {
  if (Array.isArray(cfg.credentials)) {
    return (cfg.credentials as Array<Record<string, unknown>>)
      .filter(c => typeof c.username === 'string' && typeof c.password === 'string')
      .map(c => ({ username: c.username as string, password: c.password as string }));
  }
  if (typeof cfg.username === 'string' && typeof cfg.password === 'string') {
    return [{ username: cfg.username, password: cfg.password }];
  }
  return [];
}

export function getXtreamCredentials(source: SourceRow): XtreamCredential[] {
  const cfg = JSON.parse(source.config_json) as Record<string, unknown>;
  return readCredentials(cfg);
}

export function getXtreamHost(source: SourceRow): string {
  const cfg = JSON.parse(source.config_json) as Record<string, unknown>;
  return String(cfg.host ?? '');
}

export function rowToView(r: SourceRow, mask = true): SourceView {
  const parsed = JSON.parse(r.config_json) as Record<string, unknown>;
  const nextRefreshAt = (r.enabled === 1 && r.refresh_interval_ms > 0)
    ? ((r.last_refreshed ?? 0) + r.refresh_interval_ms)
    : null;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    config: mask ? maskConfig(r.type, parsed) : parsed,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastRefreshed: r.last_refreshed,
    lastStatus: r.last_status,
    info: r.info_json ? JSON.parse(r.info_json) : null,
    refreshIntervalMs: r.refresh_interval_ms,
    nextRefreshAt,
  };
}

export function listSources(mask = true): SourceView[] {
  const rows = db.query<SourceRow, []>(
    `SELECT * FROM sources ORDER BY id`
  ).all();
  return rows.map(r => rowToView(r, mask));
}

export function listEnabledSourceNames(): string[] {
  const rows = db.query<{ name: string }, []>(
    `SELECT name FROM sources WHERE enabled = 1 ORDER BY id`
  ).all();
  return rows.map(r => r.name);
}

export function getSourceByName(name: string): SourceRow | null {
  return db.query<SourceRow, [string]>(`SELECT * FROM sources WHERE name = ?`).get(name);
}

export function getSourceById(id: number): SourceRow | null {
  return db.query<SourceRow, [number]>(`SELECT * FROM sources WHERE id = ?`).get(id);
}

export function createSource(input: {
  name: string;
  type: SourceType;
  config: Record<string, unknown>;
  enabled?: boolean;
  refreshIntervalMs?: number;
}): SourceRow {
  validateConfig(input.type, input.config);
  const defaultInterval = (input.type === 'plutotv' || input.type === 'tubi') ? 3_600_000 : input.type === 'm3u' ? 43_200_000 : 21_600_000;
  const interval = input.refreshIntervalMs !== undefined ? Math.max(0, input.refreshIntervalMs) : defaultInterval;
  db.run(
    `INSERT INTO sources (name, type, config_json, enabled, created_at, refresh_interval_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.name, input.type, JSON.stringify(input.config), input.enabled === false ? 0 : 1, Date.now(), interval]
  );
  return getSourceByName(input.name)!;
}

export function updateSource(id: number, input: {
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  refreshIntervalMs?: number;
}): SourceRow {
  const existing = getSourceById(id);
  if (!existing) throw new Error('source not found');

  const newConfig = input.config !== undefined
    ? mergeConfig(existing.type, JSON.parse(existing.config_json), input.config)
    : JSON.parse(existing.config_json) as Record<string, unknown>;
  validateConfig(existing.type, newConfig);

  db.run(
    `UPDATE sources SET name = ?, config_json = ?, enabled = ?, refresh_interval_ms = ? WHERE id = ?`,
    [
      input.name ?? existing.name,
      JSON.stringify(newConfig),
      input.enabled === undefined ? existing.enabled : (input.enabled ? 1 : 0),
      input.refreshIntervalMs !== undefined ? Math.max(0, input.refreshIntervalMs) : existing.refresh_interval_ms,
      id,
    ]
  );

  // If renamed, cascade to channels table so existing snapshot keeps working
  if (input.name && input.name !== existing.name) {
    db.run(
      `UPDATE channels SET key = ? || ':' || channel_id, source = ? WHERE source = ?`,
      [input.name, input.name, existing.name]
    );
  }

  return getSourceById(id)!;
}

export function deleteSource(id: number): { deletedChannels: number } {
  const existing = getSourceById(id);
  if (!existing) throw new Error('source not found');
  const before = db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM channels WHERE source = ?`).get(existing.name)!.n;
  db.run(`DELETE FROM channels WHERE source = ?`, [existing.name]);
  db.run(`DELETE FROM sources WHERE id = ?`, [id]);
  return { deletedChannels: before };
}

function mergeConfig(type: SourceType, existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...existing, ...patch };
  // Keep the stored password when the incoming one is masked/empty (top-level, e.g. Pluto account)
  if (typeof merged.password === 'string' && (merged.password === '' || merged.password === '••••••••') && typeof existing.password === 'string') {
    merged.password = existing.password;
  }
  if (type === 'xtream' && Array.isArray(merged.credentials)) {
    const existingCreds = Array.isArray(existing.credentials) ? existing.credentials as Array<Record<string, unknown>> : [];
    merged.credentials = (merged.credentials as Array<Record<string, unknown>>).map((c, i) => {
      // If a password is masked or empty, keep the existing one (if any) for the same username
      if (typeof c.password === 'string' && (c.password === '' || c.password === '••••••••')) {
        const matchByUsername = existingCreds.find(e => e.username === c.username);
        const fallback = matchByUsername ?? existingCreds[i];
        if (fallback?.password) return { ...c, password: fallback.password };
      }
      return c;
    });
  }
  return merged;
}

function validateConfig(type: SourceType, config: Record<string, unknown>): void {
  switch (type) {
    case 'plutotv':
    case 'tubi':
      return;
    case 'xtream': {
      if (!config.host) throw new Error('xtream requires host');
      const creds = readCredentials(config);
      if (creds.length === 0) throw new Error('xtream requires at least one credential (username + password)');
      // Normalize: ensure config.credentials is set
      config.credentials = creds;
      delete config.username;
      delete config.password;
      return;
    }
    case 'm3u':
      if (!config.m3uUrl) throw new Error('m3u requires m3uUrl');
      return;
    default:
      throw new Error('unknown source type: ' + type);
  }
}

export async function snagFromSource(source: SourceRow): Promise<SnagResponse> {
  const config = JSON.parse(source.config_json) as Record<string, unknown>;
  switch (source.type) {
    case 'plutotv': {
      const mod = await import('../sources/PlutoTV');
      const email = typeof config.email === 'string' ? config.email : undefined;
      const password = typeof config.password === 'string' ? config.password : undefined;
      const resp = await mod.snag({ email, password });
      if (!resp) throw new Error('PlutoTV snag returned no response');
      return resp;
    }
    case 'tubi': {
      const mod = await import('../sources/Tubi');
      return await mod.snag();
    }
    case 'xtream': {
      const creds = readCredentials(config);
      if (creds.length === 0) throw new Error('no credentials configured');
      // Pick first credential for the catalogue fetch; URL credentials get rewritten at proxy time.
      const cred = creds[0];
      const provider: XtreamProvider = {
        name: source.name,
        host: String(config.host),
        username: cred.username,
        password: cred.password,
        output: config.output === 'm3u8' ? 'm3u8' : 'ts',
        includeMovies: config.includeMovies !== false,
      };
      return await snagXtream(provider);
    }
    case 'm3u': {
      const cfg: M3USourceConfig = {
        m3uUrl: String(config.m3uUrl),
        epgUrl: typeof config.epgUrl === 'string' ? config.epgUrl : undefined,
        userAgent: typeof config.userAgent === 'string' ? config.userAgent : undefined,
      };
      return await snagM3U(source.name, cfg);
    }
    default:
      throw new Error('unknown source type: ' + (source as SourceRow).type);
  }
}

export function markRefreshed(id: number, status: string): void {
  db.run(
    `UPDATE sources SET last_refreshed = ?, last_status = ? WHERE id = ?`,
    [Date.now(), status, id]
  );
}

export function setSourceInfo(id: number, info: Record<string, unknown> | null): void {
  db.run(`UPDATE sources SET info_json = ? WHERE id = ?`, [info ? JSON.stringify(info) : null, id]);
}

// Persist a status string (without touching last_refreshed — a test is not a refresh).
export function setSourceStatus(id: number, status: string): void {
  db.run(`UPDATE sources SET last_status = ? WHERE id = ?`, [status, id]);
}

export async function refreshSourceInfo(source: SourceRow): Promise<void> {
  if (source.type !== 'xtream') return;
  const cfg = JSON.parse(source.config_json) as Record<string, unknown>;
  const creds = readCredentials(cfg);
  if (creds.length === 0) return;
  const host = String(cfg.host);
  const perCred = await Promise.all(creds.map(async (cred) => {
    try {
      const ui = await fetchXtreamUserInfo({ name: source.name, host, username: cred.username, password: cred.password });
      return { ok: true, ...ui };
    } catch (e) {
      return { username: cred.username, ok: false, error: (e as Error).message };
    }
  }));
  const totalMax    = perCred.reduce((a, p) => a + ('maxConnections' in p ? (p.maxConnections as number) : 0), 0);
  const totalActive = perCred.reduce((a, p) => a + ('activeConnections' in p ? (p.activeConnections as number) : 0), 0);
  setSourceInfo(source.id, {
    totalMaxConnections: totalMax,
    totalActiveConnections: totalActive,
    credentials: perCred,
  });
}

export async function testSource(source: SourceRow): Promise<{ ok: boolean; message: string }> {
  let result: { ok: boolean; message: string };
  try {
    await refreshSourceInfo(source);
    if (source.type === 'xtream') {
      const info = db.query<{ info_json: string | null }, [number]>(
        `SELECT info_json FROM sources WHERE id = ?`
      ).get(source.id)!;
      const parsed = info.info_json ? JSON.parse(info.info_json) as { credentials?: Array<Record<string, unknown>> } : null;
      const creds = parsed?.credentials ?? [];
      const ok = creds.length > 0 && creds.every(c => c.ok);
      const summary = creds.map(c => c.ok
        ? `${c.username}: ${c.maxConnections}/conn`
        : `${c.username}: ${c.error}`).join(', ');
      result = { ok, message: summary || 'no credentials' };
    } else {
      // Light test for non-xtream: just do a snag (these are fast)
      const resp = await snagFromSource(source);
      result = { ok: true, message: `${resp.components.m3u.length} channels, ${resp.components.epg.programmes.length} programmes` };
    }
  } catch (e) {
    result = { ok: false, message: (e as Error).message };
  }
  // Reflect the probe result on the source badge so a dead credential is visible.
  setSourceStatus(source.id, result.ok ? `ok: ${result.message}` : `error: ${result.message}`);
  return result;
}
