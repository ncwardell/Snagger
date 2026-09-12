import { db } from './db';
import { streamUrlFor } from './proxy';
import { M3USegmentArrayToString, toXMLTV } from '../helpers/Transformers';
import type { EPGChannel, EPGGuide, EPGProgram, M3USegment } from '../helpers/Interfaces';

type EnabledChannelRow = {
  key: string;
  source: string;
  channel_id: string;
  name: string;
  icon: string | null;
  group: string | null;
  m3u_json: string | null;
  epg_json: string | null;
  override_name: string | null;
  override_icon: string | null;
  override_group: string | null;
};

const selectEnabledAll = db.query<EnabledChannelRow, [number]>(`
  SELECT
    c.key, c.source, c.channel_id, c.name, c.icon, c."group",
    c.m3u_json, c.epg_json,
    o.name    AS override_name,
    o.icon    AS override_icon,
    o."group" AS override_group
  FROM channels c
  LEFT JOIN overrides o ON o.key = c.key AND o.template_id = ?
  WHERE COALESCE(o.enabled, 1) = 1
  ORDER BY c.source, c.name
`);

const selectEnabledByType = db.query<EnabledChannelRow, [number, string]>(`
  SELECT
    c.key, c.source, c.channel_id, c.name, c.icon, c."group",
    c.m3u_json, c.epg_json,
    o.name    AS override_name,
    o.icon    AS override_icon,
    o."group" AS override_group
  FROM channels c
  LEFT JOIN overrides o ON o.key = c.key AND o.template_id = ?
  WHERE COALESCE(o.enabled, 1) = 1 AND c.stream_type = ?
  ORDER BY c.source, c.name
`);

const selectProgrammes = db.query<{ data: string }, [string]>(`
  SELECT data FROM programmes WHERE channel_key = ? ORDER BY start
`);

function applyOverrides(row: EnabledChannelRow) {
  const name = row.override_name ?? row.name;
  const icon = row.override_icon ?? row.icon;
  const group = row.override_group ?? row.group;
  return { name, icon, group };
}

export function buildM3U(templateId: number, type: string | null = null, baseUrl?: string): string {
  const rows = type ? selectEnabledByType.all(templateId, type) : selectEnabledAll.all(templateId);
  const tpl = db.query<{ proxy_mode: number }, [number]>(`SELECT proxy_mode FROM templates WHERE id = ?`).get(templateId);
  const templateProxyOn = !!(tpl?.proxy_mode);

  // Pre-load per-source proxy override
  const sources = db.query<{ name: string; config_json: string }, []>(
    `SELECT name, config_json FROM sources`
  ).all();
  const sourceProxyMode = new Map<string, 'auto' | 'on' | 'off'>();
  for (const s of sources) {
    const cfg = JSON.parse(s.config_json) as Record<string, unknown>;
    const m = cfg.proxyMode === 'on' || cfg.proxyMode === 'off' ? cfg.proxyMode : 'auto';
    sourceProxyMode.set(s.name, m);
  }

  const segments: M3USegment[] = [];
  for (const row of rows) {
    if (!row.m3u_json) continue;
    const base = JSON.parse(row.m3u_json) as M3USegment;
    // Series rows have no playable stream URL — they group episodes which are emitted separately.
    if (!base.streamUrl) continue;
    const ov = applyOverrides(row);
    const mode = sourceProxyMode.get(row.source) ?? 'auto';
    // Custom placeholder schemes (e.g. tubi-vod:<id>) MUST be proxied because
    // the value isn't a real URL — the proxy resolves it lazily at request time.
    const needsResolve = /^[a-z]+-[a-z]+:/i.test(base.streamUrl);
    const useProxy = baseUrl && (needsResolve || mode === 'on' || (mode === 'auto' && templateProxyOn));
    segments.push({
      ...base,
      name: ov.name,
      'tvg-logo': ov.icon ?? base['tvg-logo'],
      'group-title': ov.group ?? base['group-title'],
      streamUrl: useProxy ? streamUrlFor(baseUrl!, row.key) : base.streamUrl,
    });
  }
  return M3USegmentArrayToString(segments);
}

export function buildXMLTV(templateId: number, type: string | null = null): string {
  const rows = type ? selectEnabledByType.all(templateId, type) : selectEnabledAll.all(templateId);
  const channels: EPGChannel[] = [];
  const programmes: EPGProgram[] = [];
  for (const row of rows) {
    if (row.epg_json) {
      const base = JSON.parse(row.epg_json) as EPGChannel;
      const ov = applyOverrides(row);
      channels.push({
        ...base,
        'display-name': ov.name,
        icon: ov.icon ?? base.icon,
        category: ov.group ?? base.category,
      });
    }
    for (const p of selectProgrammes.all(row.key)) {
      programmes.push(JSON.parse(p.data) as EPGProgram);
    }
  }
  const guide: EPGGuide = { channels, programmes };
  return toXMLTV(guide);
}
