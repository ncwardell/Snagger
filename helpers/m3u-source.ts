import type { SnagResponse } from './Interfaces';
import { M3USegmentArrayToString, toXMLTV } from './Transformers';
import { parseM3U } from './m3u-parser';
import { parseXMLTV } from './xmltv-parser';

export interface M3USourceConfig {
  m3uUrl: string;
  epgUrl?: string;
  userAgent?: string;
}

async function fetchText(url: string, label: string, userAgent?: string): Promise<string> {
  const headers: HeadersInit = {};
  if (userAgent) headers['user-agent'] = userAgent;
  const res = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

export async function snagM3U(name: string, config: M3USourceConfig): Promise<SnagResponse> {
  const m3uText = await fetchText(config.m3uUrl, `${name} M3U`, config.userAgent);
  const m3u = parseM3U(m3uText);

  let epg = { channels: [] as never[], programmes: [] as never[] } as ReturnType<typeof parseXMLTV>;
  if (config.epgUrl) {
    try {
      const epgText = await fetchText(config.epgUrl, `${name} EPG`, config.userAgent);
      epg = parseXMLTV(epgText);
    } catch (e) {
      console.warn(`[${name}] EPG fetch failed:`, e);
    }
  }

  return {
    source: name,
    components: { m3u, epg },
    m3u: M3USegmentArrayToString(m3u),
    epg: toXMLTV(epg),
  };
}
