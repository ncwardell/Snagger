import type { EPGChannel, EPGProgram, EPGGuide, SnagResponse, M3USegment } from "../helpers/Interfaces";
import { M3USegmentArrayToString, toXMLTV } from "../helpers/Transformers";
import moment from "moment";

//Pluto TV's Data Schema
interface PlutoChannel {
    _id: string;
    slug: string;
    name: string;
    hash: string;
    number: number;
    summary: string;
    visibility: string;
    onDemandDescription: string;
    category: string;
    plutoOfficeOnly: boolean;
    directOnly: boolean;
    chatRoomId: number;
    onDemand: boolean;
    cohortMask: number;
    featuredImage: { path: string };
    thumbnail: { path: string };
    tile: { path: string };
    tileGrayScale: { path: string };
    logo: { path: string };
    colorLogoSVG: { path: string };
    colorLogoPNG: { path: string };
    solidLogoSVG: { path: string };
    solidLogoPNG: { path: string };
    featured: boolean;
    featuredOrder: number;
    favorite: boolean;
    isStitched: boolean;
    stitched: { urls: [{ type: string, url: string }]; sessionURL: string };
    timelines: Timeline[];
}

interface Timeline {
    _id: string;
    start: string;
    stop: string;
    title: string;
    episode: Episode;
}

interface Episode {
    _id: string;
    number: number;
    season: number;
    description: string;
    duration: number;
    originalContentDuration: number;
    genre: string;
    subGenre: string;
    distributeAs: { AVOD: boolean };
    clip: { originalReleaseDate: string };
    rating: string;
    name: string;
    slug: string;
    poster: { path: string };
    firstAired: string;
    thumbnail: { path: string };
    liveBroadcast: boolean;
    featuredImage: { path: string };
    series: Series;
    poster16_9: { path: string }
}

interface Series {
    _id: string;
    name: string;
    slug: string;
    type: string;
    tile: { path: string };
    description: string;
    summary: string;
    displayName: string;
    featuredImage: { path: string };
    poster16_9: { path: string };
}

//---------------Credits: https://github.com/evoactivity/PlutoIPTV for URL Generation-----------------//

//URL Grabber
// Time Format = 2020-03-24%2021%3A00%3A00.000%2B0000
const generateUrl = () => {
    const now = new Date();
    let startTime = encodeURIComponent(
        moment().format('YYYY-MM-DD HH:00:00.000ZZ')
    );
    let stopTime = encodeURIComponent(
        moment().add(48, 'hours').format('YYYY-MM-DD HH:00:00.000ZZ')
    );
    return `http://api.pluto.tv/v2/channels?start=${startTime}&stop=${stopTime}`;
}


//Data Snagging
export const snag = async () => { // Make the function async
    const plutoURL = generateUrl();

    try {
        const response = await fetch(plutoURL); 
        const data = await response.json(); 
        return getResponse(data);
    } catch (error) {
        console.error(error);
    }
}

//Response Generator
function getResponse(_plutoData: Record<string, PlutoChannel>) {
    
    //Get Binded Data
    const { epg, m3u } = bindData(_plutoData);

    //Return Snag Response
    const response: SnagResponse = {
        source: 'PlutoTV',
        components: {
            m3u: m3u,
            epg: epg
        },
        epg: toXMLTV(epg),
        m3u: M3USegmentArrayToString(m3u)
    }

    return response;
}


//Data Binder
function bindData(_plutoData: Record<string, PlutoChannel>) {

    let epg = {channels: [] as EPGChannel[], programmes: [] as EPGProgram[]}
    let m3u = [] as M3USegment[];

    for (let channel in _plutoData) {
        
        //Needed For M3U
        const deviceId = crypto.randomUUID();
        const sid = crypto.randomUUID();

        //Pluto Data Is Stiched
        if (_plutoData[channel].isStitched) {

            //Needed For M3U Binding
            const m3uUrl = streamURL(_plutoData[channel].stitched.urls[0].url);
            
            //Bind M3U Data
            let segment: M3USegment = {
                "#EXTINF": -1,
                "tvg-id": _plutoData[channel].slug,
                //"tvg-name": _plutoData[channel].slug,
                //"tvg-chno": channelNumber.toString(),
                "tvg-logo": _plutoData[channel].colorLogoPNG.path,
                "group-title": _plutoData[channel].category,
                "name": _plutoData[channel].name,
                "streamUrl": m3uUrl
            };
            m3u.push(segment);

        } else {
            console.log("[DEBUG] Skipping 'fake' channel: ", _plutoData[channel]);
        }
        
        //Bind Channel Data
        let channelData: EPGChannel = {
            "channel-id": _plutoData[channel].slug, 
            "display-name": _plutoData[channel].name,
            "channel-number": _plutoData[channel].number.toString(),
            "icon": _plutoData[channel].colorLogoPNG.path,
            "url": 'https://pluto.tv',
            "description": _plutoData[channel].summary,
            "category": _plutoData[channel].category,
            "language": 'en',
            "country": 'US',
        };
        epg.channels.push(channelData);

        // Bind Programme Data
        if (_plutoData[channel].timelines) {
            for (let program of _plutoData[channel].timelines) {
                let programData: EPGProgram = {
                    "channel": _plutoData[channel].slug,
                    "start": moment(program.start).format('YYYYMMDDHHmmss Z'),  // Fixed timezone format
                    "stop": moment(program.stop).format('YYYYMMDDHHmmss Z'),    // Fixed timezone format
                    "title": program.title,
                    "sub-title": program.title === program.episode.name ? '' : program.episode.name,
                    "desc": program.episode.description,
                    "date": moment(program.episode.firstAired).format('YYYYMMDD'),
                    "category": program.episode.genre,
                    "genre": program.episode.subGenre,
                    "episode-num": `S${program.episode.season}E${program.episode.number}`, // Changed format for episode number
                    "icon": program.episode.poster.path,
                    "url": 'https://pluto.tv',
                    "length": program.episode.duration,
                    "original-air-date": moment(program.episode.firstAired).format('YYYYMMDD'),
                };
                epg.programmes.push(programData);
            }
        }
    }
    return { epg, m3u };
}


//Mandatory URL Shenanigans
const streamURL = (url: string) => {
    //Random Device ID Crap
    const deviceId = crypto.randomUUID();
    const sid = crypto.randomUUID();

    let m3uUrl = new URL(url);
    let queryString = m3uUrl.search;
    let params = new URLSearchParams(queryString);

    //Set the URL params
    params.set('advertisingId', '');
    params.set('appName', 'web');
    params.set('appVersion', 'unknown');
    params.set('appStoreUrl', '');
    params.set('architecture', '');
    params.set('buildVersion', '');
    params.set('clientTime', '0');
    params.set('deviceDNT', '0');
    params.set('deviceId', deviceId);
    params.set('deviceMake', 'Chrome');
    params.set('deviceModel', 'web');
    params.set('deviceType', 'web');
    params.set('deviceVersion', 'unknown');
    params.set('includeExtendedEvents', 'false');
    params.set('sid', sid);
    params.set('userId', '');
    params.set('serverSideAds', 'true');

    m3uUrl.search = params.toString();
    return m3uUrl.toString();
}


