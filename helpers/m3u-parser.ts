import type { M3USegment } from './Interfaces';

export function parseM3U(content: string): M3USegment[] {
  const segments: M3USegment[] = [];
  const lines = content.split(/\r?\n/);
  let pending: Partial<M3USegment> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      pending = {};
      const colonIdx = line.indexOf(':');
      const commaIdx = line.indexOf(',');
      const before = commaIdx > -1 ? line.substring(colonIdx + 1, commaIdx) : line.substring(colonIdx + 1);
      const name = commaIdx > -1 ? line.substring(commaIdx + 1).trim() : '';

      const beforeTrim = before.trim();
      const durMatch = beforeTrim.match(/^(-?\d+(?:\.\d+)?)/);
      pending['#EXTINF'] = durMatch ? parseFloat(durMatch[1]) : -1;

      const attrsStr = durMatch ? beforeTrim.substring(durMatch[0].length) : beforeTrim;
      const tagRe = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = tagRe.exec(attrsStr)) !== null) {
        (pending as Record<string, unknown>)[m[1]] = m[2];
      }

      pending.name = name;
    } else if (line.startsWith('#')) {
      continue;
    } else if (pending) {
      pending.streamUrl = line;
      segments.push(pending as M3USegment);
      pending = null;
    }
  }

  return segments;
}
