import { db } from './db';
import type { EPGChannel, EPGProgram, M3USegment, SnagResponse } from '../helpers/Interfaces';
import { getSourceByName, listSources, markRefreshed, refreshSourceInfo, snagFromSource, type SourceRow } from './sources';

const upsertChannel = db.prepare(`
  INSERT INTO channels (key, source, channel_id, name, icon, "group", stream_url, stream_type, last_seen, m3u_json, epg_json)
  VALUES ($key, $source, $channel_id, $name, $icon, $group, $stream_url, $stream_type, $last_seen, $m3u_json, $epg_json)
  ON CONFLICT(key) DO UPDATE SET
    name        = excluded.name,
    icon        = excluded.icon,
    "group"     = excluded."group",
    stream_url  = excluded.stream_url,
    stream_type = excluded.stream_type,
    last_seen   = excluded.last_seen,
    m3u_json    = excluded.m3u_json,
    epg_json    = excluded.epg_json
`);

const deleteProgrammes = db.prepare(`DELETE FROM programmes WHERE channel_key = $key`);
const insertProgramme = db.prepare(`
  INSERT INTO programmes (channel_key, start, stop, data)
  VALUES ($channel_key, $start, $stop, $data)
`);

export type RefreshResult = { source: string; channels: number; programmes: number; pruned?: number; ok: boolean; error?: string };

// Remove channels (and their EPG) that this source stopped listing, i.e. rows
// whose last_seen predates the run that just completed. Guarded by the caller
// so an empty/failed pull can't wipe the library.
const pruneStaleChannels = db.transaction((source: string, seenAfter: number): number => {
  db.run(
    `DELETE FROM programmes WHERE channel_key IN (SELECT key FROM channels WHERE source = ? AND last_seen < ?)`,
    [source, seenAfter],
  );
  const res = db.run(`DELETE FROM channels WHERE source = ? AND last_seen < ?`, [source, seenAfter]);
  return res.changes;
});

function ingestResponse(source: string, resp: SnagResponse): { channels: number; programmes: number; pruned: number } {
  const now = Date.now();
  const m3uByChannelId = new Map<string, M3USegment>();
  for (const seg of resp.components.m3u) {
    const id = seg['tvg-id'];
    if (id) m3uByChannelId.set(id, seg);
  }

  const epgByChannelId = new Map<string, EPGChannel>();
  for (const ch of resp.components.epg.channels) {
    epgByChannelId.set(ch['channel-id'], ch);
  }

  const allChannelIds = new Set<string>([...m3uByChannelId.keys(), ...epgByChannelId.keys()]);
  const streamTypes = resp.streamTypes ?? {};

  const programmesByChannel = new Map<string, EPGProgram[]>();
  for (const prog of resp.components.epg.programmes) {
    const cid = prog.channel;
    if (!cid) continue;
    if (!programmesByChannel.has(cid)) programmesByChannel.set(cid, []);
    programmesByChannel.get(cid)!.push(prog);
  }

  let channelCount = 0;
  let programmeCount = 0;

  const writeAll = db.transaction(() => {
    for (const channelId of allChannelIds) {
      const m3u = m3uByChannelId.get(channelId);
      const epg = epgByChannelId.get(channelId);
      const key = `${source}:${channelId}`;
      const name = m3u?.name ?? epg?.['display-name'] ?? channelId;
      const icon = m3u?.['tvg-logo'] ?? epg?.icon ?? null;
      const group = m3u?.['group-title'] ?? epg?.category ?? null;

      upsertChannel.run({
        $key: key,
        $source: source,
        $channel_id: channelId,
        $name: name,
        $icon: icon,
        $group: group,
        $stream_url: m3u?.streamUrl ?? null,
        $stream_type: streamTypes[channelId] ?? 'live',
        $last_seen: now,
        $m3u_json: m3u ? JSON.stringify(m3u) : null,
        $epg_json: epg ? JSON.stringify(epg) : null,
      });
      channelCount++;

      deleteProgrammes.run({ $key: key });
      const progs = programmesByChannel.get(channelId) ?? [];
      for (const p of progs) {
        insertProgramme.run({
          $channel_key: key,
          $start: p.start ?? '',
          $stop: p.stop ?? '',
          $data: JSON.stringify(p),
        });
        programmeCount++;
      }
    }
  });

  writeAll();

  // Prune vanished channels — but only when this pull actually returned data.
  // An empty response almost always means a transient upstream failure, and
  // pruning against it would delete the whole source.
  const pruned = channelCount > 0 ? pruneStaleChannels(source, now) : 0;

  return { channels: channelCount, programmes: programmeCount, pruned };
}

export async function refreshSourceRow(row: SourceRow): Promise<RefreshResult> {
  try {
    await refreshSourceInfo(row);
    const resp = await snagFromSource(row);
    const counts = ingestResponse(row.name, resp);
    const prunedNote = counts.pruned > 0 ? `, ${counts.pruned} pruned` : '';
    markRefreshed(row.id, `ok: ${counts.channels} channels, ${counts.programmes} programmes${prunedNote}`);
    return { source: row.name, ...counts, ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    markRefreshed(row.id, `error: ${msg}`);
    return { source: row.name, channels: 0, programmes: 0, ok: false, error: msg };
  }
}

export async function refreshSourceByName(name: string): Promise<RefreshResult> {
  const row = getSourceByName(name);
  if (!row) return { source: name, channels: 0, programmes: 0, ok: false, error: 'source not found' };
  return refreshSourceRow(row);
}

export async function refreshAll(): Promise<RefreshResult[]> {
  const sources = listSources(false).filter(s => s.enabled);
  const results: RefreshResult[] = [];
  for (const s of sources) {
    const row = { id: s.id, name: s.name, type: s.type, config_json: JSON.stringify(s.config), enabled: 1, created_at: s.createdAt, last_refreshed: s.lastRefreshed, last_status: s.lastStatus };
    results.push(await refreshSourceRow(row));
  }
  return results;
}
