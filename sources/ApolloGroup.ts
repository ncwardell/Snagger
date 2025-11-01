import type { EPGChannel, EPGProgram, EPGGuide, SnagResponse, M3USegment } from "../helpers/Interfaces";
import { M3USegmentArrayToString, toXMLTV } from "../helpers/Transformers";


const generateUrlList = () => {

    const urls = [`https://tvnow.best/api/list/${Bun.env.USERNAME}/${Bun.env.PASSWORD}/m3u8/movies`, `https://tvnow.best/api/list/${Bun.env.USERNAME}/${Bun.env.PASSWORD}/m3u8/events`, `https://tvnow.best/api/list/${Bun.env.USERNAME}/${Bun.env.PASSWORD}/m3u8/events/2`, `https://tvnow.best/api/list/${Bun.env.USERNAME}/${Bun.env.PASSWORD}/m3u8/events/3`];
    const numUrls = 100; // Replace with the desired number of URLs

    for (let i = 1; i <= numUrls; i++) {
        const url = `https://tvnow.best/api/list/${Bun.env.USERNAME}/${Bun.env.PASSWORD}/m3u8/tvshows/${i}`;
        urls.push(url);
    }
    return urls;

}

//Data Snagging
export const snag = async () => {
    const urls = generateUrlList();

    let responses = [];

    try {
        for (const url of urls) {
            const response = await fetch(url);
            if (response.status == 404) {
                break;
            }

            // 1. Get the Blob from the response
            const blob = await response.blob();

            // 2. Convert Blob to text
            const text = await blob.text();

            // 3. Push the text content into the array
            responses.push(text);
        }

    } catch (error) {
        console.error(error);
    }

    console.log(parseM3U(responses[0]))
    //console.log(responses); // This will now log an array of strings
}



export const parseM3U = (m3uContent: string): M3USegment[] => {
    const segments: M3USegment[] = [];
    const lines = m3uContent.split('\n');
    let currentSegment: Partial<M3USegment> = {};
  
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF:')) {
        currentSegment = {};
        // Extract duration
        const durationMatch = line.match(/#EXTINF:(-?\d+)/);
        if (durationMatch) {
          currentSegment["#EXTINF"] = parseFloat(durationMatch[1]);
  
          // Extract other tags from the same line (handling spaces in values)
          const tags = line.substring(durationMatch[0].length).trim();
          const tagRegex = /(\S+)=("[^"]+"|\S+)/g; // Match key="value" or key=value
          let tagMatch;
          while ((tagMatch = tagRegex.exec(tags)) !== null) {
            const key = tagMatch[1];
            const value = tagMatch[2].replace(/"/g, ''); // Remove quotes if present
            (currentSegment as any)[key] = value;
          }
        }
      } else if (line.trim() !== '' && !line.startsWith('#')) {
        // Stream URL
        currentSegment.streamUrl = line.trim();
        currentSegment.name = lines[i - 1].split(',').pop()?.trim() || '';
        segments.push(currentSegment as M3USegment);
      }
    }
  
    return segments;
  };