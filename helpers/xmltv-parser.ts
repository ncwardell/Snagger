import type { EPGChannel, EPGGuide, EPGProgram } from './Interfaces';

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function extractAttrs(openTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(openTag)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function firstText(block: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1].trim()) : undefined;
}

function firstIconSrc(block: string): string | undefined {
  const m = block.match(/<icon\b[^>]*\bsrc\s*=\s*"([^"]*)"[^>]*\/?>/);
  return m ? decodeEntities(m[1]) : undefined;
}

export function parseXMLTV(xml: string): EPGGuide {
  const channels: EPGChannel[] = [];
  const programmes: EPGProgram[] = [];

  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let cm;
  while ((cm = channelRe.exec(xml)) !== null) {
    const attrs = extractAttrs(cm[1]);
    const inner = cm[2];
    const id = attrs.id;
    if (!id) continue;
    channels.push({
      'channel-id': id,
      'display-name': firstText(inner, 'display-name') ?? id,
      icon: firstIconSrc(inner),
      url: firstText(inner, 'url'),
      category: firstText(inner, 'category'),
      language: firstText(inner, 'language'),
      country: firstText(inner, 'country'),
    });
  }

  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let pm;
  while ((pm = progRe.exec(xml)) !== null) {
    const attrs = extractAttrs(pm[1]);
    const inner = pm[2];
    if (!attrs.channel) continue;
    programmes.push({
      channel: attrs.channel,
      start: attrs.start,
      stop: attrs.stop,
      title: firstText(inner, 'title'),
      'sub-title': firstText(inner, 'sub-title'),
      desc: firstText(inner, 'desc'),
      date: firstText(inner, 'date'),
      category: firstText(inner, 'category'),
      'episode-num': firstText(inner, 'episode-num'),
      icon: firstIconSrc(inner),
      language: firstText(inner, 'language'),
    });
  }

  return { channels, programmes };
}
