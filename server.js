const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); setTimeout(() => process.exit(1), 1000); });
process.on('unhandledRejection', (err) => { console.error('Unhandled Rejection:', err); setTimeout(() => process.exit(1), 1000); });

const API_PORT = process.env.API_PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_FILES = new Set([
    '/index.html', '/app.js', '/styles.css', '/favicon.png',
    '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png', '/site.webmanifest',
    '/robots.txt', '/sitemap.xml',
    '/7e7c007e5148f7d5a2953120e8410d70.txt' // IndexNow key (lets Bing/Yandex accept our URL submissions)
]);
const FILE_ALIASES = { '/favicon.ico': '/favicon-32.png' };
// Every visitor polls /api/lobbies; build it at most once per LOBBIES_CACHE_MS and share the result
const LOBBIES_CACHE_MS = 4000;
let lobbiesCache = { at: 0, body: null };
const profileCache = new Map(); // Cache profile_id -> { alias, rating }
const activeMatches = new Map(); // Keep track of matches to simulate "Playing" state

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', err => reject(err));
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

// Lobby relay regions are Azure region names; show them the way players think of them
const REGION_NAMES = {
    brazilsouth: "Brazil", australiasoutheast: "Australia", ukwest: "UK", southeastasia: "Southeast Asia",
    westeurope: "West Europe", westus3: "US West", koreacentral: "Korea", centralindia: "India",
    eastus: "US East", chilecentral: "Chile", southcentralus: "US South Central"
};
function regionName(region) {
    if (!region || region === "Unknown" || region === "Global") return null;
    return REGION_NAMES[region] || region;
}

// Relic lobby options: zlib -> JSON string holding base64 -> 1-byte entry count, then entries of
// [uint32 LE length]["key:value"]. Returns { key: value }.
function parseRelicOptions(optionsBase64) {
    const inner = JSON.parse(zlib.inflateSync(Buffer.from(optionsBase64, 'base64')).toString('utf-8'));
    const buf = Buffer.from(inner, 'base64');
    const options = {};
    let i = 1;
    for (let n = 0; n < buf[0] && i + 4 <= buf.length; n++) {
        const len = buf.readUInt32LE(i);
        i += 4;
        const entry = buf.subarray(i, i + len).toString('utf-8');
        i += len;
        const colon = entry.indexOf(':');
        if (colon > 0) options[entry.slice(0, colon)] = entry.slice(colon + 1);
    }
    return options;
}

// Leaderboard ids are the same on Relic and aoe2lobby.com: 0 Unranked, 3/4 RM 1v1/team, 13/14 EW 1v1/team
function ladderFor(matchType, mapName, slotsTotal) {
    const is1v1 = slotsTotal === 2;
    if (matchType === "Random Map" && mapName !== "Custom Scenario" && !String(mapName || "").toLowerCase().includes("cba")) {
        return is1v1 ? "3" : "4";
    }
    if (matchType === "Empire Wars") return is1v1 ? "13" : "14";
    return "0";
}

// The lobby's own ladder, else the ladder the player has played most
function pickStat(stats, ladder) {
    if (!stats) return null;
    if (stats[ladder]) return stats[ladder];
    let best = null;
    for (const key in stats) {
        if (!best || stats[key].games > best.games) best = stats[key];
    }
    return best;
}

function applyStat(player, stats, ladder) {
    player.allStats = stats || undefined;
    const stat = pickStat(stats, ladder);
    if (!stat) return;
    player.elo = stat.rating;
    player.totalGames = stat.games;
    player.totalWins = stat.wins;
    player.winRate = stat.winp + "%";
}

async function fetchProfilesBatch(ids) {
    if (ids.length === 0) return;
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const url = `https://aoe-api.reliclink.com/community/leaderboard/GetPersonalStat?title=age2&profile_ids=[${chunk.join(',')}]`;
        try {
            const data = await httpsGet(url);
            const parsed = JSON.parse(data);
            if (parsed.statGroups) {
                parsed.statGroups.forEach(sg => {
                    if (sg.members && sg.members.length > 0) {
                        const member = sg.members[0];
                        const profileId = member.profile_id;
                        let alias = member.alias || 'Unknown';
                        const steamId = /^\/steam\/(\d+)$/.exec(member.name || '');
                        const steamProfile = steamId ? `https://steamcommunity.com/profiles/${steamId[1]}` : null;
                        
                        let currentRating = null;
                        const ladderStats = {};
                        let totalWins = 0;
                        let totalGames = 0;
                        let winRate = "0.0";
                        
                        if (parsed.leaderboardStats) {
                            const stats = parsed.leaderboardStats.filter(ls => ls.statgroup_id === sg.id);
                            if (stats && stats.length > 0) {
                                stats.forEach(ls => {
                                    const games = (ls.wins || 0) + (ls.losses || 0);
                                    ladderStats[String(ls.leaderboard_id)] = {
                                        rating: ls.rating, games, wins: ls.wins || 0,
                                        winp: games > 0 ? Math.round((ls.wins || 0) / games * 100) : 0,
                                        highest: ls.highestrating, streak: ls.streak
                                    };
                                });
                                // Prioritize Team RM (4) and 1v1 RM (3) over other leaderboards like Unranked (0)
                                const sorted = [...stats].sort((a, b) => {
                                    const rankA = a.leaderboard_id === 3 ? 2 : (a.leaderboard_id === 4 ? 1 : 0);
                                    const rankB = b.leaderboard_id === 3 ? 2 : (b.leaderboard_id === 4 ? 1 : 0);
                                    if (rankA !== rankB) return rankB - rankA;
                                    return b.last_match_time - a.last_match_time;
                                });
                                currentRating = sorted[0].rating;
                                
                                // Calculate total games and wins across all leaderboards
                                totalGames = stats.reduce((sum, s) => sum + ((s.wins || 0) + (s.losses || 0)), 0);
                                totalWins = stats.reduce((sum, s) => sum + (s.wins || 0), 0);
                                
                                if (totalGames > 0) {
                                    winRate = ((totalWins / totalGames) * 100).toFixed(1);
                                }
                            }
                        }
                        profileCache.set(profileId, { alias, rating: currentRating, totalGames, totalWins, winRate, stats: ladderStats, steamProfile });
                    }
                });
            }
        } catch(e) {
            console.error("Error fetching profile batch", e);
        }
    }
}

function parseSlotInfoIds(slotinfoBase64) {
    try {
        const buffer = Buffer.from(slotinfoBase64, 'base64');
        const decompressed = zlib.inflateSync(buffer).toString('utf-8');
        const bracketIndex = decompressed.indexOf('[');
        const lastBracketIndex = decompressed.lastIndexOf(']');
        if (bracketIndex !== -1 && lastBracketIndex !== -1) {
            const jsonStr = decompressed.substring(bracketIndex, lastBracketIndex + 1);
            const arr = JSON.parse(jsonStr);
            return arr.filter(p => p['profileInfo.id'] !== -1).map(p => ({
                id: p['profileInfo.id'],
                team: p.teamID
            }));
        }
    } catch(e) {}
    return [];
}

// --- Spectate: games in progress, from aoe2lobby.com's spectate feed ---------------------------------
// The feed is ~3 MB, so it is fetched at most once per SPECTATE_REFRESH_MS and only while someone is
// using the Spectate view (each /api/spectate request may trigger a refresh; nothing polls on its own).
const SPECTATE_REFRESH_MS = 60000;
const SPECTATE_ELO_TYPES = ['0', '3', '4', '13', '14'];
let spectateCache = { at: 0, body: null, loading: null };

function fetchSpectateSnapshot() {
    return new Promise((resolve, reject) => {
        let schema = null, matches = null, elo = {};
        let ws;
        const finish = (err) => {
            clearTimeout(timer);
            try { ws.close(); } catch (e) { }
            if (matches) resolve({ schema: schema || {}, matches, elo });
            else reject(err || new Error('no spectate data'));
        };
        const timer = setTimeout(() => finish(new Error('spectate snapshot timed out')), 20000);
        try {
            ws = new WebSocket('wss://aoe2lobby.com/ws/spectate/');
        } catch (e) {
            return finish(e);
        }
        ws.onopen = () => ws.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'spectate', ids: SPECTATE_ELO_TYPES }));
        ws.onerror = () => finish(new Error('spectate websocket error'));
        ws.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                if (data.schema) schema = data.schema;
                if (data.spectate_match_all) matches = data.spectate_match_all;
                if (data.spectate_elo_update) {
                    for (const type in data.spectate_elo_update) elo[type] = Object.assign(elo[type] || {}, data.spectate_elo_update[type]);
                }
                if (matches && Object.keys(elo).length) finish();
            } catch (e) { }
        };
    });
}

// Map-pool and some custom maps arrive from aoe2lobby.com as a bare id (e.g. "10979"). Their names are looked up
// once per id from aoe2companion's public match API (via one player's current match) and kept in map_names.json.
const MAP_NAMES_PATH = path.join(__dirname, 'map_names.json');
let mapNames = {};
try { mapNames = JSON.parse(fs.readFileSync(MAP_NAMES_PATH, 'utf8')); } catch (e) { mapNames = {}; }
const mapLookupFailedAt = {};
const MAP_LOOKUP_RETRY_MS = 10 * 60 * 1000;
let mapLookupRunning = false;

function mapDisplayName(mapName, mapId, schema) {
    if (!/^\d+$/.test(String(mapName))) return mapName || 'Unknown Map';
    return mapNames[mapName] || schema?.mapid?.[String(mapId)] || `Map #${mapName}`;
}

// samples: { mapId: { matchId, profileId } } — one game in progress per unknown map id
async function resolveMapNames(samples) {
    if (mapLookupRunning) return false;
    mapLookupRunning = true;
    let added = false;
    try {
        for (const [mapId, sample] of Object.entries(samples).slice(0, 15)) {
            if (mapNames[mapId] || Date.now() - (mapLookupFailedAt[mapId] || 0) < MAP_LOOKUP_RETRY_MS) continue;
            try {
                const r = await fetch(`https://data.aoe2companion.com/api/matches?profile_ids=${sample.profileId}&page=1`, {
                    headers: { 'User-Agent': 'aoe2lobby.online (map name lookup)' }
                });
                const data = await r.json();
                const match = (data.matches || []).find(x => String(x.matchId) === String(sample.matchId));
                if (match && typeof match.mapName === 'string' && match.mapName) {
                    mapNames[mapId] = match.mapName;
                    added = true;
                } else {
                    mapLookupFailedAt[mapId] = Date.now();
                }
            } catch (e) {
                mapLookupFailedAt[mapId] = Date.now();
            }
            await new Promise(r => setTimeout(r, 1000)); // be gentle with aoe2companion
        }
        if (added) fs.writeFileSync(MAP_NAMES_PATH, JSON.stringify(mapNames, null, 2));
    } finally {
        mapLookupRunning = false;
    }
    return added;
}

function buildSpectateGames({ schema, matches, elo }) {
    const label = (field, value) => (value === null || value === undefined) ? null : (schema[field]?.[String(value)] ?? null);
    const games = [];
    const unknownMaps = {};
    for (const m of Object.values(matches)) {
        if (m.observable === false) continue;
        const players = [];
        for (const slot of Object.values(m.slots || {})) {
            if (!slot.profileid && !slot.name) continue;
            const id = slot.profileid || 0;
            const ratings = {};
            for (const type of SPECTATE_ELO_TYPES) {
                const st = id && elo[type]?.[id];
                if (st) ratings[type] = st.rating;
            }
            players.push({
                id, name: slot.name || 'AI', team: slot.team, color: slot.color,
                civ: label('civilization', slot.civilization), country: slot.country || null,
                steamProfile: slot.steam_profile || null, ratings
            });
        }
        if (!players.length) continue;
        if (/^\d+$/.test(String(m.map_name)) && !mapNames[m.map_name] && !unknownMaps[m.map_name]) {
            const withId = players.find(p => p.id);
            if (withId) unknownMaps[m.map_name] = { matchId: m.matchid, profileId: withId.id };
        }
        const mode = label('mode', m.mode);
        const isRanked = m.description === 'AUTOMATCH';
        const ladder = ladderFor(mode, m.map_name, players.length === 2 ? 2 : 8);
        for (const p of players) {
            p.rating = p.ratings[ladder] ?? null; // the lobby's own ladder, like Auto on the lobby list
        }
        games.push({
            id: m.matchid,
            title: isRanked ? 'Ranked match' : (m.description || 'Age of Empires II Game'),
            isRanked,
            map: mapDisplayName(m.map_name, m.mapid, schema),
            matchType: mode,
            mapSize: label('size', m.size),
            speed: label('speed', m.speed),
            population: m.population || null,
            server: regionName(label('server', m.server)),
            modInfo: m.data_mod || 'No Mods',
            startTime: m.start_time,
            observerDelay: m.observer_delay || 0,
            observers: m.observers || 0,
            ladder,
            players
        });
    }
    games.sort((a, b) => b.startTime - a.startTime);
    return { games, unknownMaps };
}

function spectateBody(snapshot) {
    const { games, unknownMaps } = buildSpectateGames(snapshot);
    return { body: JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), games }), unknownMaps };
}

async function refreshSpectate() {
    const snapshot = await fetchSpectateSnapshot();
    const { body, unknownMaps } = spectateBody(snapshot);
    spectateCache = { at: Date.now(), body, loading: null };
    // Look up unknown map names in the background, then rebuild this snapshot with them
    if (Object.keys(unknownMaps).length) {
        resolveMapNames(unknownMaps).then(added => {
            if (added) spectateCache.body = spectateBody(snapshot).body;
        }).catch(() => { });
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }



    if (req.url.startsWith('/api/spectate')) {
        try {
            if (Date.now() - spectateCache.at > SPECTATE_REFRESH_MS && !spectateCache.loading) {
                spectateCache.loading = refreshSpectate().catch(e => {
                    console.error('Spectate refresh failed:', e.message);
                    spectateCache.loading = null;
                });
            }
            if (!spectateCache.body && spectateCache.loading) await spectateCache.loading;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(spectateCache.body || JSON.stringify({ updatedAt: null, games: [] }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ updatedAt: null, games: [] }));
        }
        return;
    }

    if (req.url.startsWith('/api/lobbies')) {
        if (lobbiesCache.body && Date.now() - lobbiesCache.at < LOBBIES_CACHE_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(lobbiesCache.body);
            return;
        }
        try {
            let allMatches = [];
            
            let start = 0;
            let pageCount = 0;
            try {
                while (pageCount < 10) {
                    console.log('Fetching start=' + start);
                    const targetUrl = `https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=${start}`;
                    try {
                        const data = await httpsGet(targetUrl);
                        const parsed = JSON.parse(data);
                        
                        if (parsed.matches && parsed.matches.length > 0) {
                            allMatches.push(...parsed.matches);
                            console.log('Got matches: ' + parsed.matches.length);
                            start += 100;
                            pageCount++;
                        } else {
                            console.log('No matches, breaking');
                            break;
                        }
                    } catch (e) {
                        console.error("Error fetching page:", start, e.message);
                        break; 
                    }
                }
            } finally {
                // Done fetching
            }
            
            if (allMatches.length > 0) {
                const now = Date.now();
                const currentMatchIds = new Set();
                const missingIds = new Set();
                
                allMatches.forEach(m => {
                    currentMatchIds.add(m.id);
                    m.lastSeen = now;
                    m.isPlaying = false;
                    m.rawPlayers = [];
                    
                    let trueMapName = m.mapname || "Unknown Map";
                    
                    // Deep decode the options payload to find the hidden map hash!
                    try {
                        if (m.options) {
                            const options = parseRelicOptions(m.options);

                            // 52 = map/mod hash. Only options verified against aoe2lobby.com are read here
                            // (63 data mod, 28 population, 41 speed); Relic's mode and size codes don't map
                            // to aoe2lobby.com's, so those come from the scraper only.
                            const modHash = options['52'];
                            if (modHash) {
                                m.modHash = modHash;
                                
                                if (options['63']) m.modInfo = options['63'].replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
                                if (/^\d+$/.test(options['28'] || '')) m.relicPopulation = parseInt(options['28'], 10);
                                const speedVal = options['41'];
                                if (speedVal === '0') m.relicSpeed = 'Slow';
                                else if (speedVal === '1') m.relicSpeed = 'Casual';
                                else if (speedVal === '2') m.relicSpeed = 'Normal';
                                else if (speedVal === '3') m.relicSpeed = 'Fast';

                                // Global Self-Learning Map Hash Dictionary
                                if (!global.mapDictionary) {
                                    global.mapDictionary = {
                                        "Lsj6bUkZ6EiI9Y2V5Ij0tQ==": "Michi",
                                        "FoROiR43t0eZEYV7FOkYbQ==": "Michi",
                                        "EADuRc1n8RGUSLQK2Cdqww==": "Michi", // Kirjan
                                        "oONDBtBn8RGo0Jj6LpGC+g==": "Michi", // winsome_then11
                                        "n6DJEMkYA0CHxiIkiV+MrA==": "Michi", // MICHI CREATIVE 2v2
                                        "musSdesBPUSaSr+wMCeHkQ==": "Michi", // Diplomacyy
                                        "goSpJWWw60OWIP44/VOUnA==": "Michi", // FVD
                                        "q0mdRRCcJ0213yr+n01hDA==": "Michi", // ai
                                        "uR3kYxV8D0w71TqJzM9B4A==": "CBA"
                                    };
                                }
                                
                                // Auto-learning: if the title strongly implies a map, learn its hash!
                                const tLower = (m.description || "").toLowerCase();
                                if (tLower.includes('michi') || tLower.includes('mici')) {
                                    global.mapDictionary[modHash] = "Michi";
                                } else if (tLower.includes('cba')) {
                                    global.mapDictionary[modHash] = "CBA";
                                }
                                
                                if (global.mapDictionary[modHash]) {
                                    trueMapName = global.mapDictionary[modHash];
                                }
                            }
                        }
                    } catch(e) {
                        // Silently fail if decoding options fails
                    }
                    m.mapname = trueMapName;

                    if (m.slotinfo) {
                        m.rawPlayers = parseSlotInfoIds(m.slotinfo);
                        m.rawPlayers.forEach(p => {
                            if (!profileCache.has(p.id)) missingIds.add(p.id);
                        });
                    }
                    activeMatches.set(m.id, m);
                });
                
                if (missingIds.size > 0) {
                    // Fetch ALL host profiles synchronously so hostnames are guaranteed
                    const hostIdsToFetch = new Set();
                    for (let i = 0; i < allMatches.length; i++) {
                        const m = allMatches[i];
                        if (m.rawPlayers && m.rawPlayers.length > 0) {
                            const hostId = m.rawPlayers[0].id;
                            if (missingIds.has(hostId)) {
                                hostIdsToFetch.add(hostId);
                            }
                        }
                    }
                    
                    if (hostIdsToFetch.size > 0) {
                        const hostIdsArray = Array.from(hostIdsToFetch);
                        const promises = [];
                        for (let i = 0; i < hostIdsArray.length; i += 200) {
                            promises.push(fetchProfilesBatch(hostIdsArray.slice(i, i + 200)));
                        }
                        await Promise.all(promises);
                    }
                    
                    // Fetch remaining player profiles asynchronously so we don't block
                    const remainingIds = Array.from(missingIds).filter(id => !hostIdsToFetch.has(id));
                    if (remainingIds.length > 0) {
                        for (let i = 0; i < remainingIds.length; i += 200) {
                            fetchProfilesBatch(remainingIds.slice(i, i + 200)).catch(e => console.error(e));
                        }
                    }
                }
                
                // Remove matches that drop off the Relic API feed
                for (const [id, m] of activeMatches.entries()) {
                    if (!currentMatchIds.has(id)) {
                        activeMatches.delete(id);
                    }
                }
                
                let scrapedData = {};
                try {
                    const fs = require('fs');
                    if (fs.existsSync(path.join(__dirname, 'scraped_maps.json'))) {
                        scrapedData = JSON.parse(fs.readFileSync(path.join(__dirname, 'scraped_maps.json'), 'utf-8'));
                    }
                } catch (e) {}

                let scrapedPlayersStats = {};
                try {
                    const fs = require('fs');
                    if (fs.existsSync(path.join(__dirname, 'scraped_players_v2.json'))) {
                        scrapedPlayersStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'scraped_players_v2.json'), 'utf-8'));
                    }
                } catch (e) {}

                const scrapedStatsById = {};
                const scrapedSteamById = {};
                const scrapedCivById = {};
                for (const name in scrapedPlayersStats) {
                    const sp = scrapedPlayersStats[name];
                    if (sp && sp.profileId && sp.stats) scrapedStatsById[String(sp.profileId)] = sp.stats;
                    if (sp && sp.profileId && sp.steamProfile) scrapedSteamById[String(sp.profileId)] = sp.steamProfile;
                }

                let scrapedMatchesStats = {};
                let scrapedMatchesByTitle = {};
                try {
                    const fs = require('fs');
                    const scrapedLobbiesPath = path.join(__dirname, 'scraped_lobbies_v2.json');
                    if (fs.existsSync(scrapedLobbiesPath)) {
                        const rawData = JSON.parse(fs.readFileSync(scrapedLobbiesPath, 'utf-8'));
                        const processPlayer = (p) => {
                            if (p && p.name) {
                                scrapedPlayersStats[p.name.toLowerCase()] = p;
                            }
                            if (p && p.profileId && typeof p.civ === 'string' && p.civ) scrapedCivById[String(p.profileId)] = p.civ;
                        };
                        const processMatch = (item) => {
                            if (item.players && Array.isArray(item.players)) {
                                item.players.forEach(processPlayer);
                            } else if (item.name) {
                                processPlayer(item);
                            }
                            
                            let hostName = "";
                            if (item.host) {
                                hostName = item.host.toLowerCase();
                            } else if (item.players && item.players.length > 0 && item.players[0].name) {
                                hostName = item.players[0].name.toLowerCase();
                            }
                            
                            let finalModInfo = item.settings?.['Data Mod'] || item.settings?.['Dataset'] || item.modInfo;
                            if (finalModInfo === "None" || !finalModInfo) finalModInfo = "No Mods";

                            if (hostName) {
                                scrapedMatchesStats[hostName] = {
                                    mapName: item.map,
                                    isPlaying: item.isPlaying,
                                    slotsTotal: item.slotsTotal,
                                    aiSlots: item.aiSlots,
                                    matchType: item.settings?.Mode,
                                    mapSize: item.settings?.Size,
                                    modInfo: finalModInfo,
                                    population: item.settings?.Population,
                                    speed: item.settings?.Speed,
                                    startingAge: item.settings?.['Starting Age'],
                                    resources: item.settings?.Resources,
                                    treaty: item.settings?.Treaty,
                                    server: item.settings?.Server
                                };
                            }
                            if (item.title) {
                                scrapedMatchesByTitle[item.title.toLowerCase().replace(/\s+/g, '')] = {
                                    realHost: hostName,
                                    mapName: item.map,
                                    isPlaying: item.isPlaying,
                                    slotsTotal: item.slotsTotal,
                                    aiSlots: item.aiSlots,
                                    matchType: item.settings?.Mode,
                                    mapSize: item.settings?.Size,
                                    modInfo: finalModInfo,
                                    population: item.settings?.Population,
                                    speed: item.settings?.Speed,
                                    startingAge: item.settings?.['Starting Age'],
                                    resources: item.settings?.Resources,
                                    treaty: item.settings?.Treaty,
                                    server: item.settings?.Server
                                };
                            }
                        };
                        if (Array.isArray(rawData)) {
                            rawData.forEach(processMatch);
                        } else if (typeof rawData === 'object' && rawData !== null) {
                            if (rawData.matches && Array.isArray(rawData.matches)) {
                                rawData.matches.forEach(processMatch);
                            } else {
                                for (const key of Object.keys(rawData)) {
                                    const val = rawData[key];
                                    if (val && typeof val === 'object') {
                                        if (!val.host) val.host = key;
                                        processMatch(val);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error reading scraped lobbies:", e);
                }
                
                // Prune expired or finished playing matches
                const hasScrapedData = Object.keys(scrapedMatchesStats).length > 20;
                for (const [id, m] of activeMatches.entries()) {
                    let hostName = m.players && m.players.length > 0 ? m.players[0].name.toLowerCase() : "";
                    
                    // If a match is playing, but the host is completely gone from aoe2lobby's live data, it's over!
                    if (m.isPlaying && hasScrapedData && hostName && !scrapedMatchesStats[hostName] && !scrapedMatchesStats[hostName.replace(/^player_/, '')]) {
                        // Allow a 2 minute grace period just in case of transient websocket drops
                        if (now - m.lastSeen > 2 * 60 * 1000) {
                            activeMatches.delete(id);
                        }
                    }
                }
                
                const allMatchesArray = Array.from(activeMatches.values()).map(m => {
                    const parsedPlayers = m.rawPlayers ? m.rawPlayers.map(p => {
                        const cached = profileCache.get(p.id) || { alias: 'Player_' + p.id, rating: null, totalGames: 0, totalWins: 0, winRate: "0.0" };
                        
                        let finalElo = cached.rating;
                        let finalTotalGames = cached.totalGames || 0;
                        let finalTotalWins = cached.totalWins || 0;
                        let finalWinRate = cached.winRate || "0.0";
                        
                        const scrapedPlayer = scrapedPlayersStats[cached.alias.toLowerCase()];
                        if (scrapedPlayer) {
                            if (scrapedPlayer.elo !== undefined && scrapedPlayer.elo !== "") finalElo = scrapedPlayer.elo;
                            if (scrapedPlayer.totalGames !== undefined && scrapedPlayer.totalGames !== "") finalTotalGames = scrapedPlayer.totalGames;
                            else if (scrapedPlayer.games !== undefined && scrapedPlayer.games !== "") finalTotalGames = scrapedPlayer.games;
                            if (scrapedPlayer.totalWins !== undefined && scrapedPlayer.totalWins !== "") finalTotalWins = scrapedPlayer.totalWins;
                            else if (scrapedPlayer.wins !== undefined && scrapedPlayer.wins !== "") finalTotalWins = scrapedPlayer.wins;
                            if (scrapedPlayer.winRate !== undefined && scrapedPlayer.winRate !== "") finalWinRate = scrapedPlayer.winRate;
                        }

                        const steamProfile = scrapedSteamById[String(p.id)] || cached.steamProfile || null;
                        const civ = scrapedCivById[String(p.id)] || null;
                        return { id: p.id, name: cached.alias, team: p.team, elo: finalElo, totalGames: finalTotalGames, totalWins: finalTotalWins, winRate: finalWinRate, steamProfile, civ };
                    }) : [];
                    
                    let finalMapName = m.mapname || "Unknown Map";
                    if (finalMapName === "Unknown Map" && m.modname) finalMapName = m.modname;
                    if (m.matchup && m.matchup.matchinfo && m.matchup.matchinfo.mapname) {
                        const trueName = global.mapDictionary ? global.mapDictionary[m.matchup.matchinfo.mapname] : null;
                        if (trueName) finalMapName = trueName;
                    }
                    
                    let hostName = parsedPlayers.length > 0 ? parsedPlayers[0].name.toLowerCase() : "";
                    
                    let matchType = undefined;
                    let mapSize = undefined;
                    let modInfo = undefined;
                    let population = undefined;
                    let speed = undefined;
                    let startingAge = undefined;
                    let resources = undefined;
                    let treaty = undefined;
                    let serverRegion = regionName(m.relayserver_region);

                    let sm = scrapedMatchesStats[hostName];

                    if ((!sm || hostName === "unknown" || hostName === "player_0" || hostName === "") && m.description) {
                        const mTitleLower = m.description.toLowerCase().replace(/\s+/g, '');
                        if (scrapedMatchesByTitle[mTitleLower]) {
                            sm = scrapedMatchesByTitle[mTitleLower];
                            hostName = sm.realHost;
                            if (parsedPlayers.length > 0 && (parsedPlayers[0].name === "Unknown" || parsedPlayers[0].name.startsWith("Player_")) && hostName) {
                                parsedPlayers[0].name = hostName;
                                const scrapedPlayer = scrapedPlayersStats[hostName.toLowerCase()];
                                if (scrapedPlayer) {
                                    if (scrapedPlayer.elo !== undefined && scrapedPlayer.elo !== "") parsedPlayers[0].elo = scrapedPlayer.elo;
                                    if (scrapedPlayer.totalGames !== undefined && scrapedPlayer.totalGames !== "") parsedPlayers[0].totalGames = scrapedPlayer.totalGames;
                                    else if (scrapedPlayer.games !== undefined && scrapedPlayer.games !== "") parsedPlayers[0].totalGames = scrapedPlayer.games;
                                    if (scrapedPlayer.totalWins !== undefined && scrapedPlayer.totalWins !== "") parsedPlayers[0].totalWins = scrapedPlayer.totalWins;
                                    else if (scrapedPlayer.wins !== undefined && scrapedPlayer.wins !== "") parsedPlayers[0].totalWins = scrapedPlayer.wins;
                                    if (scrapedPlayer.winRate !== undefined && scrapedPlayer.winRate !== "") parsedPlayers[0].winRate = scrapedPlayer.winRate;
                                }
                            } else if (parsedPlayers.length === 0 && hostName) {
                                let fallbackP = { id: 0, name: hostName, team: 0, elo: null, totalGames: 0, totalWins: 0, winRate: "0.0" };
                                const scrapedPlayer = scrapedPlayersStats[hostName.toLowerCase()];
                                if (scrapedPlayer) {
                                    if (scrapedPlayer.elo !== undefined && scrapedPlayer.elo !== "") fallbackP.elo = scrapedPlayer.elo;
                                    if (scrapedPlayer.totalGames !== undefined && scrapedPlayer.totalGames !== "") fallbackP.totalGames = scrapedPlayer.totalGames;
                                    else if (scrapedPlayer.games !== undefined && scrapedPlayer.games !== "") fallbackP.totalGames = scrapedPlayer.games;
                                    if (scrapedPlayer.totalWins !== undefined && scrapedPlayer.totalWins !== "") fallbackP.totalWins = scrapedPlayer.totalWins;
                                    else if (scrapedPlayer.wins !== undefined && scrapedPlayer.wins !== "") fallbackP.totalWins = scrapedPlayer.wins;
                                    if (scrapedPlayer.winRate !== undefined && scrapedPlayer.winRate !== "") fallbackP.winRate = scrapedPlayer.winRate;
                                }
                                parsedPlayers.push(fallbackP);
                            }
                        }
                    }

                    if (m.modInfo) {
                        modInfo = m.modInfo;
                    } else if (!modInfo || modInfo === "None") {
                        modInfo = "No Mods";
                    }
                    
                    if (m.relicPopulation) population = m.relicPopulation;
                    if (m.relicSpeed) speed = m.relicSpeed;

                    if (sm) {
                        const genericMaps = ["unknown map", "my map", "custom map", ""];
                        if (sm.mapName && !genericMaps.includes(sm.mapName.toLowerCase())) {
                            finalMapName = sm.mapName;
                        }
                        if (sm.isPlaying !== undefined) {
                            m.isPlaying = sm.isPlaying;
                        }
                        if (sm.matchType !== undefined) matchType = sm.matchType;
                        if (sm.mapSize !== undefined) mapSize = sm.mapSize;
                        if (sm.modInfo !== undefined) modInfo = sm.modInfo;
                        if (sm.population !== undefined) population = sm.population;
                        if (sm.speed !== undefined) speed = sm.speed;
                        if (sm.startingAge !== undefined) startingAge = sm.startingAge;
                        if (sm.resources !== undefined) resources = sm.resources;
                        if (sm.treaty !== undefined) treaty = sm.treaty;
                        if (!serverRegion && regionName(sm.server)) serverRegion = regionName(sm.server);
                    }
                    


                    const genericMapsCheck = ["unknown map", "my map", "custom map", ""];
                    if (!sm || (!sm.mapName || genericMapsCheck.includes(sm.mapName.toLowerCase()))) {
                        if (scrapedData[hostName]) {
                            finalMapName = scrapedData[hostName];
                        } else if (m.description) {
                            const allKnownMaps = new Set([
                                ...Object.values(scrapedData),
                                ...(global.mapDictionary ? Object.values(global.mapDictionary) : [])
                            ]);
                            const uniqueMaps = [...allKnownMaps].filter(n => typeof n === 'string' && n.length > 2).sort((a, b) => b.length - a.length);
                            const descLower = m.description.toLowerCase();
                            for (const mapName of uniqueMaps) {
                                if (descLower.includes(mapName.toLowerCase())) {
                                    finalMapName = mapName;
                                    break;
                                }
                            }
                        }
                    }

                    finalMapName = mapDisplayName(finalMapName);
                    const slotsTotal = (sm && sm.slotsTotal) || m.maxplayers;
                    const targetMode = ladderFor(matchType, finalMapName, slotsTotal);

                    parsedPlayers.forEach(p => {
                        const stats = scrapedStatsById[String(p.id)]
                            || scrapedPlayersStats[p.name.toLowerCase()]?.stats
                            || profileCache.get(p.id)?.stats;
                        applyStat(p, stats && Object.keys(stats).length ? stats : null, targetMode);
                    });

                    return {
                        id: m.id,
                        steamLobbyId: m.steamlobbyid,
                        title: m.description || "Age of Empires II Game",
                        map: finalMapName,
                        matchType: matchType,
                        mapSize: mapSize,
                        modInfo: modInfo,
                        population: population,
                        speed: speed,
                        startingAge: startingAge,
                        resources: resources,
                        treaty: treaty,
                        server: serverRegion,
                        serverRegion: m.relayserver_region || undefined,
                        isPasswordProtected: m.passwordprotected === 1,
                        maxPlayers: (sm && sm.slotsTotal) || m.maxplayers,
                        aiSlots: (sm && sm.aiSlots) || 0,
                        isPlaying: m.isPlaying,
                        lastSeen: m.lastSeen,
                        players: parsedPlayers
                    };
                });
                let scrapedLobbiesObj = {};
                try {
                    const fs = require('fs');
                    const scrapedLobbiesPath = path.join(__dirname, 'scraped_lobbies_v2.json');
                    if (fs.existsSync(scrapedLobbiesPath)) {
                        scrapedLobbiesObj = JSON.parse(fs.readFileSync(scrapedLobbiesPath, 'utf-8'));
                    }
                } catch(e) {
                    console.error("Error reading scraped lobbies for append:", e);
                }

                const knownHosts = new Set();
                allMatchesArray.forEach(m => {
                    if (m.players && m.players.length > 0 && m.players[0].name) {
                        knownHosts.add(m.players[0].name.toLowerCase());
                    }
                });

                for (const host of Object.keys(scrapedLobbiesObj)) {
                    if (!knownHosts.has(host.toLowerCase())) {
                        const lobby = scrapedLobbiesObj[host];
                        lobby.map = mapDisplayName(lobby.map);
                        const ladder = ladderFor(lobby.settings?.Mode, lobby.map, lobby.slotsTotal);
                        const parsedPlayers = (lobby.players || []).map(p => {
                            const player = { id: p.profileId || 0, name: p.name, team: 0, elo: null, totalGames: 0, totalWins: 0, winRate: "0.0%", steamProfile: p.steamProfile || null, civ: typeof p.civ === 'string' && p.civ ? p.civ : null };
                            const stats = (p.profileId && scrapedStatsById[String(p.profileId)]) || p.stats;
                            applyStat(player, stats && Object.keys(stats).length ? stats : null, ladder);
                            return player;
                        });
                        
                        allMatchesArray.push({
                            id: `scraped_${host}`,
                            steamLobbyId: null,
                            title: lobby.title || "Age of Empires II Game",
                            map: lobby.map || "Unknown Map",
                            matchType: lobby.settings?.Mode || "Unknown",
                            mapSize: lobby.settings?.Size || "Unknown",
                            modInfo: lobby.settings?.['Data Mod'] || lobby.settings?.Dataset || "No Mods",
                            population: lobby.settings?.Population || undefined,
                            speed: lobby.settings?.Speed || undefined,
                            startingAge: lobby.settings?.['Starting Age'],
                            resources: lobby.settings?.Resources,
                            treaty: lobby.settings?.Treaty,
                            server: regionName(lobby.settings?.Server),
                            serverRegion: lobby.settings?.Server,
                            isPasswordProtected: false,
                            maxPlayers: lobby.slotsTotal || 8,
                            aiSlots: lobby.aiSlots || 0,
                            isPlaying: lobby.isPlaying || false,
                            lastSeen: Date.now(),
                            players: parsedPlayers
                        });
                    }
                }

                const responseData = JSON.stringify({ matches: allMatchesArray });
                lobbiesCache = { at: Date.now(), body: responseData };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(responseData);
                return;
            }
        } catch(e) {
            console.error("Error handling request:", e);
        }
        
        // Fallback
        const fallback = JSON.stringify({ matches: Array.from(activeMatches.values()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fallback);
    } else {
        // Serve static files
        let filePath = req.url === '/' ? '/index.html' : req.url;
        // Strip query params for file matching
        const isVersioned = /[?&]v=/.test(filePath);
        filePath = filePath.split('?')[0];
        filePath = FILE_ALIASES[filePath] || filePath;
        
        const extname = String(path.extname(filePath)).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.txt': 'text/plain; charset=utf-8',
            '.xml': 'application/xml; charset=utf-8',
            '.webmanifest': 'application/manifest+json',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.wav': 'audio/wav',
            '.mp4': 'video/mp4',
            '.woff': 'application/font-woff',
            '.ttf': 'application/font-ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.otf': 'application/font-otf',
            '.wasm': 'application/wasm'
        };

        const contentType = mimeTypes[extname] || 'application/octet-stream';
        
        // Only serve the public frontend assets (never source, logs or scraped dumps)
        if (!PUBLIC_FILES.has(filePath)) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }

        // Prevent directory traversal
        const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
        const absolutePath = path.join(__dirname, safePath);

        fs.readFile(absolutePath, (error, content) => {
            if (error) {
                if (error.code === 'ENOENT') {
                    res.writeHead(404);
                    res.end('File not found');
                } else {
                    res.writeHead(500);
                    res.end('Server error: ' + error.code);
                }
            } else {
                // HTML revalidates every time; ?v= assets never change; everything else for a day
                const cacheControl = extname === '.html' ? 'no-cache'
                    : isVersioned ? 'public, max-age=31536000, immutable'
                    : 'public, max-age=86400';
                res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
                res.end(content);
            }
        });
    }
});

server.listen(API_PORT, HOST, () => {
    console.log(`API Server listening on ${HOST}:${API_PORT}`);
});

// Heartbeat to prevent task from being killed
setInterval(() => {
    console.log(`[HEARTBEAT] Server is alive at ${new Date().toISOString()}`);
}, 10000);
