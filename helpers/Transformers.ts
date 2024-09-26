import type { EPGChannel, EPGProgram, EPGGuide, M3USegment } from "./Interfaces";

//Make it good - Yes I am a crackhead for doing it manually
export function toXMLTV(guide: EPGGuide, prettyPrint: boolean = true) {
    const escapeXML = (str: string): string => {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };

    const generateDynamicXML = (obj: Record<string, any>, rootElement: string, attributes: Record<string, string> = {}, indentLevel: number = 2): string => {
        const indent = ' '.repeat(indentLevel);
        let xml = `${indent}<${rootElement}`;

        // Add attributes to the opening tag if any
        for (let [key, value] of Object.entries(attributes)) {
            xml += ` ${key}="${escapeXML(value)}"`;
        }
        xml += '>\n';

        // Add only non-attribute elements as children
        for (let [key, value] of Object.entries(obj)) {
            if (!(key in attributes) && value !== undefined && value !== null && value !== '') {
                xml += `${indent}  <${key}>${escapeXML(String(value))}</${key}>\n`;
            }
        }

        xml += `${indent}</${rootElement}>\n`;
        return xml;
    };

    const generateChannelXML = (channel: EPGChannel, indentLevel: number = 2): string => {
        const attributes = { id: channel['channel-id'] };  // Use only the id attribute
        const { 'channel-id': _, ...channelWithoutId } = channel;  // Destructure to remove channel-id

        let channelXML = generateDynamicXML(channelWithoutId, 'channel', attributes, indentLevel);
        
        // Modify the icon to use src attribute
        channelXML = channelXML.replace(/<icon>(.*?)<\/icon>/, `<icon src="$1"/>`);
        
        return channelXML;
    };

    const generateProgramXML = (program: EPGProgram, indentLevel: number = 2): string => {
        const attributes = {
            start: program.start || '',
            stop: program.stop || '',
            channel: program.channel || '',
        };

        let xml = generateDynamicXML(program, 'programme', attributes, indentLevel);
        xml = xml.replace(/<icon>(.*?)<\/icon>/, `<icon src="$1"/>`);  // Modify the icon to use src attribute

        return xml;
    };

    // Start building the XML
    let xml = `<?xml version="1.0" encoding="utf-8"?>\n<tv>\n`;

    // Add all channels
    guide.channels.forEach(channel => {
        xml += generateChannelXML(channel, prettyPrint ? 2 : 0);
    });

    // Add all programmes
    guide.programmes.forEach(program => {
        xml += generateProgramXML(program, prettyPrint ? 2 : 0);
    });

    xml += '</tv>';
    return xml;
}

export function M3USegmentArrayToString(_segment: M3USegment[]): string {
    let m3u8 = '#EXTM3U\n';
    for (const segment of _segment) {
        m3u8 = m3u8 + M3USegmentToString(segment);
    }
    return m3u8;
}

function M3USegmentToString(_segment: M3USegment): string {
    let segment = '';
    for (const [key, value] of Object.entries(_segment)) {
        if (key === 'name') {
            segment = segment.substring(0, segment.length - 1);
            segment = segment + `,${value}\n`;
        } else if (key === 'streamUrl') {
            segment = segment + `${value}\n`;
        } else {
            segment = segment + `${key}="${value}" `;
        }
    }
    return segment;
}