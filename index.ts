import type { EPGGuide, M3USegment, SnagResponse } from './helpers/Interfaces';
import { M3USegmentArrayToString, toXMLTV } from './helpers/Transformers';
import { snagXtream, type XtreamProvider } from './helpers/xtream';
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const PROVIDERS_PATH = './xtream-providers.json';

async function loadProviders(): Promise<XtreamProvider[]> {
    if (!existsSync(PROVIDERS_PATH)) return [];
    try {
        const text = await readFile(PROVIDERS_PATH, 'utf-8');
        const data = JSON.parse(text);
        if (!Array.isArray(data)) return [];
        return data.filter((p: unknown): p is XtreamProvider =>
            !!p && typeof p === 'object' && 'name' in p && 'host' in p && 'username' in p && 'password' in p
        );
    } catch (err) {
        console.error('Failed to load xtream-providers.json:', err);
        return [];
    }
}

class SnaggerObject {

    storage: {
        EPG: EPGGuide,
        M3U: M3USegment[]
    } = {
        EPG: { channels: [], programmes: [] },
        M3U: []
    };

    constructor() {}

    snag = async (source: string) => {
        // File-based source first
        try {
            const module = await import('./sources/' + source);
            return await module.snag();
        } catch {
            // not a file source — fall through
        }

        // Provider config
        const providers = await loadProviders();
        const provider = providers.find(p => p.name === source);
        if (provider) {
            return await snagXtream(provider);
        }

        console.error(`Unknown source: ${source}`);
    }

    getSources = async () => {
        const folderPath = "./sources";
        let sourceList: string[][] = [];
        try {
            const entries = await readdir(folderPath, { withFileTypes: true });
            const fileNames = entries
                .filter(entry => !entry.isDirectory() && entry.name.endsWith('.ts'))
                .map(entry => entry.name.slice(0, -3));

            const providers = await loadProviders();
            sourceList.push([...fileNames, ...providers.map(p => p.name)]);
        } catch (err) {
            console.error("Error reading directory:", err);
        }
        return sourceList;
    }

    add = async (data: SnagResponse | M3USegment[] | EPGGuide, optionalData?: EPGGuide | M3USegment[]) => {
        if ('components' in data) { 
            // Handle SnagResponse
            this.storage.M3U.push(...data.components.m3u);
            this.storage.EPG.channels.push(...data.components.epg.channels);
            this.storage.EPG.programmes.push(...data.components.epg.programmes);
        } else if (Array.isArray(data)) {
            // Handle M3USegment[] with optional EPGGuide
            this.storage.M3U.push(...data);
            if (optionalData && 'channels' in optionalData) {
                this.storage.EPG.channels.push(...optionalData.channels);
                this.storage.EPG.programmes.push(...optionalData.programmes);
            }
        } else if ('channels' in data) {
            // Handle EPGGuide with optional M3USegment[]
            this.storage.EPG.channels.push(...data.channels);
            this.storage.EPG.programmes.push(...data.programmes);
            if (optionalData && Array.isArray(optionalData)) {
                this.storage.M3U.push(...optionalData);
            }
        }
    }

    save = async (data: SnagResponse | M3USegment[] | EPGGuide | {EPG: EPGGuide, M3U: M3USegment[]} = this.storage, path: string = './') => {
        if (data === this.storage) {
            Bun.write(path + 'playlist.m3u', M3USegmentArrayToString(this.storage.M3U));
            Bun.write(path + 'epg.xml', toXMLTV(this.storage.EPG));
        } else if ('components' in data) {
            Bun.write(path + 'playlist.m3u', M3USegmentArrayToString(data.components.m3u));
            Bun.write(path + 'epg.xml', toXMLTV(data.components.epg));
        } else if (Array.isArray(data)) {
            Bun.write(path + 'playlist.m3u', M3USegmentArrayToString(data));
        } else if ('channels' in data) {
            Bun.write(path + 'epg.xml', toXMLTV(data));
        } else {
            console.log('Invalid data type');
        }
    }
}



export const Snagger = new SnaggerObject();


/*
const response = await Snagger.snag('PlutoTV');
await Snagger.save(response)
*/