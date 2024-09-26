
//--------------------------------

export interface EPGChannel {
    "channel-id": string;       // Unique identifier for the channel
    "display-name": string;    // Display name of the channel
    "channel-number"?: string;  // Channel number (can be numeric or alphanumeric)
    "icon"?: string;           // URL to the channel's logo
    "url"?: string;             // URL to a webpage with more info about the channel
    "description"?: string;    // Description of the channel
    "category"?: string;       // Category of the channel (e.g., "News", "Sports")
    "language"?: string;       // Primary language of the channel
    "country"?: string;        // Country of origin for the channel
    "start"?: string;          // Date and time the channel became available (ISO 8601)
    "stop"?: string;           // Date and time the channel will stop being available (ISO 8601)
    "lcn"?: number;            // Logical Channel Number (for channel ordering)
    "hidden"?: boolean;        // Indicates if the channel should be hidden by default
    "video"?: {
        "format"?: string;       // Video format (e.g., "HDTV", "SD")
        "aspect"?: string;       // Aspect ratio (e.g., "16:9")
    };
    "audio"?: {
        "format"?: string;       // Audio format (e.g., "stereo", "Dolby Digital")
    };
}

export interface EPGProgram {
    "channel"?: string;      // The channel ID this segment belongs to
    "start"?: string;        // Start time of the program (ISO 8601 format)
    "stop"?: string;         // Stop time of the program (ISO 8601 format)
    "title"?: string;        // Title of the program
    "sub-title"?: string;   // Subtitle of the program
    "desc"?: string;         // Description of the program
    "date"?: string;         // Original air date (YYYYMMDD)
    "category"?: string;     // Category of the program (e.g., "Movie," "Sports")
    "episode-num"?: string; // Episode number (e.g., "1" or "S01E03")
    "icon"?: string;        // URL to an icon or image for the program
    "url"?: string;          // URL for more information about the program
    "credits"?: {            // Credits information (optional)
        "actor"?: string[];    // List of actors
        "director"?: string[];  // List of directors
        "writer"?: string[];   // List of writers
    };
    "video"?: {              // Video details (optional)
        "present"?: string;   // Indicates if the program is in HD, widescreen, etc.
        "aspect"?: string;    // Aspect ratio (e.g., "16:9")
        "quality"?: string;   // Video quality (e.g., "HDTV")
        "format"?: string;    // Video format (e.g., "HDTV", "SD") 
    };
    "audio"?: {              // Audio details (optional)
        "present"?: string;   // Indicates if audio is present
        "stereo"?: string;    // Stereo type (e.g., "stereo")
        "format"?: string;    // Audio format (e.g., "stereo", "Dolby Digital")
    };
    "previously-shown"?: {  // Information if the program was shown before (optional)
        "start"?: string;      // Start time of the previous showing
        "channel"?: string;    // Channel ID of the previous showing
    };
    "new"?: boolean;         //  Indicates if the program is new (optional)
    "language"?: string;     // Language of the program's audio
    "country"?: string;      // Country of origin
    "rating"?: string;       // Content rating (e.g., "PG", "TV-14")
    "star-rating"?: number;  // Star rating for the program
    "subtitles"?: boolean;   // Indicates if subtitles are available
    "premiere"?: boolean;    // Indicates if it's a premiere or first-run episode
    "last-chance"?: boolean; // Indicates if it's the last chance to see the program
    "length"?: number;       // Duration of the program in minutes
    "original-air-date"?: string; // Original air date of the program
    "repeat"?: boolean;      // Indicates if it's a repeat broadcast
    "daily"?: boolean;       // Indicates if the program airs daily
    "genre"?: string;        // More specific genre information
    "keywords"?: string[];   // Keywords associated with the program
    "review"?: string;       // A short review or comment about the program
}

export interface EPGGuide {
    channels: EPGChannel[];
    programmes: EPGProgram[];
}

export interface M3USegment {
    "#EXTINF": number; // Duration in seconds (-1 for live streams)
    "tvg-id"?: string; // Channel ID
    "tvg-name"?: string; // Display name of the channel
    "tvg-logo"?: string; // URL to channel logo
    "group-title"?: string; // Category for the channel
    "tvg-shift"?: number; // Time shift for EPG in hours
    "tvg-country"?: string; // Country of origin
    "tvg-language"?: string; // Language of the audio
    "tvg-chno"?: string; // Channel number/name
    "radio"?: boolean; // True if it's an audio-only stream
    "audio-track"?: string; // Preferred audio track
    "subtitle-track"?: string; // Preferred subtitle track
    "catchup"?: boolean; // Indicates catch-up TV support
    "catchup-source"?: string;  // URL for catch-up TV source
    "timeshift"?: boolean; // Indicates timeshift support
    "tvg-url"?: string; // URL to XMLTV EPG for the channel
    name: string; // Channel name
    streamUrl: string; // URL of the stream
}


//--------------------------------

export interface SnagResponse {
    source: string;
    epg: string;
    m3u: string;
    components: { m3u: M3USegment[], epg: { channels: EPGChannel[], programmes: EPGProgram[] } };
}