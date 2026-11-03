const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); setTimeout(() => process.exit(1), 1000); });
process.on('unhandledRejection', (err) => { console.error('Unhandled Rejection:', err); setTimeout(() => process.exit(1), 1000); });

// The spectate feed is read over Node's global WebSocket
if (typeof WebSocket === 'undefined') { console.error('Node >=22.12 required (no global WebSocket)'); process.exit(1); }

const API_PORT = process.env.API_PORT || 3002;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_FILES = new Set([
    '/index.html', '/app.js', '/styles.css', '/favicon.png',
    '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png', '/site.webmanifest',
    '/robots.txt', '/sitemap.xml',
    '/fonts/cinzel-variable.woff2', '/fonts/outfit-variable.woff2', '/fonts/cinzel-ext.woff2', '/fonts/outfit-ext.woff2', '/fonts/OFL.txt', // self-hosted fonts
    '/7e7c007e5148f7d5a2953120e8410d70.txt' // IndexNow key (lets Bing/Yandex accept our URL submissions)
]);
const FILE_ALIASES = { '/favicon.ico': '/favicon-32.png' };
const RELIC_API = 'https://aoe-api.worldsedgelink.com/community'; // aoe-api.reliclink.com is a CNAME of this host
// Every visitor polls /api/lobbies; build it at most once per LOBBIES_CACHE_MS and share the result
const LOBBIES_CACHE_MS = 4000;
const LOBBIES_MAX_STALE_MS = 60000; // older than this, a request waits for the rebuild instead of getting the old body
let lobbiesCache = { at: 0, body: null };
let lobbiesLoading = null, lobbiesFailUntil = 0, lobbiesFailures = 0;
const profileCache = new Map(); // profile_id -> { alias, rating, totalGames, totalWins, winRate, stats, steamProfile, fetchedAt, lastSeen }
const PROFILE_REFRESH_MS = 6 * 60 * 60 * 1000; // cached profiles this old are refetched, in the background only
const PROFILE_FORGET_MS = 24 * 60 * 60 * 1000; // profiles not seen in any lobby for this long are dropped
const pendingProfileIds = new Set(); // profile ids with a GetPersonalStat request in flight
const activeMatches = new Map(); // Keep track of matches to simulate "Playing" state

// Scraped files (written by scraper.js) older than this are ignored: the scraper rewrites them every ~15 s while it has live data
const SCRAPED_LOBBIES_PATH = path.join(__dirname, 'scraped_lobbies_v2.json');
const SCRAPED_PLAYERS_PATH = path.join(__dirname, 'scraped_players_v2.json');
const SCRAPED_MAX_AGE_MS = 90000;
let scrapedStaleLoggedAt = 0;

// Own-property lookup: keys that come from the feeds must never resolve to Object.prototype ("__proto__", "constructor")
const own = (o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k)) ? o[k] : undefined;
const isProfileId = (id) => Number.isSafeInteger(id) && id > 0;
const str = (v) => (typeof v === 'string' && v) ? v : null;
// Scraped labels are strings or numbers; anything else (an object from a "__proto__" key, an array) is dropped
const scalar = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) ? v : undefined;
function num(v, fallback = null) {
    const n = (typeof v === 'string' && v.trim() !== '') ? Number(v) : v;
    return (typeof n === 'number' && Number.isFinite(n)) ? n : fallback;
}
function profileIdOf(v) {
    const n = (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : v;
    return isProfileId(n) ? n : 0;
}

const MAX_UPSTREAM_BODY = 8 * 1024 * 1024;
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 5000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); clearTimeout(deadline); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_UPSTREAM_BODY) req.destroy(new Error('upstream body too large'));
                else chunks.push(chunk);
            });
            // Decode once at the end, so a multi-byte character split across chunks stays intact. An already
            // buffered end can still arrive after destroy(), so an oversized body is rejected here too.
            res.on('end', () => {
                clearTimeout(deadline);
                if (size > MAX_UPSTREAM_BODY) reject(new Error('upstream body too large'));
                else resolve(Buffer.concat(chunks).toString('utf8'));
            });
            res.on('error', err => { clearTimeout(deadline); reject(err); });
        });
        const deadline = setTimeout(() => req.destroy(new Error('upstream deadline')), 15000);
        req.on('error', (err) => { clearTimeout(deadline); reject(err); });
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

// Lobby relay regions are Azure region names; show them the way players think of them
const REGION_NAMES = {
    brazilsouth: "Brazil", australiasoutheast: "Australia", ukwest: "UK", southeastasia: "Southeast Asia",
    westeurope: "West Europe", westus3: "US West", koreacentral: "Korea", centralindia: "India",
    eastus: "US East", chilecentral: "Chile", southcentralus: "US South Central"
};
const REGION_LABELS = new Set(Object.values(REGION_NAMES));
// Only known labels or plain region names pass through (the value is shown in the page)
function regionName(region) {
    if (typeof region !== 'string' || !region || region === "Unknown" || region === "Global") return null;
    if (Object.hasOwn(REGION_NAMES, region)) return REGION_NAMES[region];
    return (REGION_LABELS.has(region) || /^[a-z0-9]{2,40}$/.test(region)) ? region : null;
}

// Relic lobby options: zlib -> JSON string holding base64 -> 1-byte entry count, then entries of
// [uint32 LE length]["key:value"]. Returns { key: value }.
function parseRelicOptions(optionsBase64) {
    const inner = JSON.parse(zlib.inflateSync(Buffer.from(optionsBase64, 'base64'), { maxOutputLength: 256 * 1024 }).toString('utf-8'));
    const buf = Buffer.from(inner, 'base64');
    const options = Object.create(null);
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
    if (own(stats, ladder)) return stats[ladder];
    let best = null;
    for (const key of Object.keys(stats)) {
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

// Ladder stats from the scraped files, reduced to { "<ladder id>": { numeric fields } }; null when there are none
function cleanStats(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const out = {};
    for (const ladder of Object.keys(stats)) {
        const s = stats[ladder];
        if (!/^\d+$/.test(ladder) || !s || typeof s !== 'object') continue;
        out[ladder] = {
            rating: num(s.rating), games: num(s.games, 0), wins: num(s.wins, 0), winp: num(s.winp, 0),
            highest: num(s.highest), streak: num(s.streak)
        };
    }
    return Object.keys(out).length ? out : null;
}

async function fetchProfilesBatch(ids) {
    ids = ids.filter(id => isProfileId(id) && !pendingProfileIds.has(id));
    if (ids.length === 0) return;
    ids.forEach(id => pendingProfileIds.add(id));
    try {
        const chunkSize = 50;
        for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const url = `${RELIC_API}/leaderboard/GetPersonalStat?title=age2&profile_ids=[${chunk.join(',')}]`;
            try {
                const data = await httpsGet(url);
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed.statGroups)) {
                    parsed.statGroups.forEach(sg => {
                        if (sg && Array.isArray(sg.members) && sg.members.length > 0) {
                            const member = sg.members[0];
                            const profileId = member.profile_id;
                            if (!isProfileId(profileId)) return;
                            let alias = str(member.alias) || 'Unknown';
                            const steamId = /^\/steam\/(\d+)$/.exec(typeof member.name === 'string' ? member.name : '');
                            const steamProfile = steamId ? `https://steamcommunity.com/profiles/${steamId[1]}` : null;

                            let currentRating = null;
                            const ladderStats = {};
                            let totalWins = 0;
                            let totalGames = 0;
                            let winRate = "0.0";

                            if (Array.isArray(parsed.leaderboardStats)) {
                                const stats = parsed.leaderboardStats.filter(ls => ls && ls.statgroup_id === sg.id);
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
                            const now = Date.now();
                            profileCache.set(profileId, { alias, rating: currentRating, totalGames, totalWins, winRate, stats: ladderStats, steamProfile, fetchedAt: now, lastSeen: now });
                        }
                    });
                    // Ids Relic answered for but returned nothing about: cache an empty entry so they stop showing as
                    // pending and aren't re-requested on every build (the 6 h refresh retries them)
                    const now = Date.now();
                    for (const id of chunk) {
                        if (!profileCache.has(id)) {
                            profileCache.set(id, { alias: 'Unknown', rating: null, totalGames: 0, totalWins: 0, winRate: "0.0", stats: {}, steamProfile: null, fetchedAt: now, lastSeen: now });
                        }
                    }
                }
            } catch(e) {
                console.error("Error fetching profile batch:", e.message);
            }
        }
    } finally {
        ids.forEach(id => pendingProfileIds.delete(id));
    }
}

function parseSlotInfoIds(slotinfoBase64) {
    try {
        const buffer = Buffer.from(slotinfoBase64, 'base64');
        const decompressed = zlib.inflateSync(buffer, { maxOutputLength: 256 * 1024 }).toString('utf-8');
        const bracketIndex = decompressed.indexOf('[');
        const lastBracketIndex = decompressed.lastIndexOf(']');
        if (bracketIndex !== -1 && lastBracketIndex !== -1) {
            const jsonStr = decompressed.substring(bracketIndex, lastBracketIndex + 1);
            const arr = JSON.parse(jsonStr);
            return arr.filter(p => p && p['profileInfo.id'] !== -1).map(p => ({
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
const SPECTATE_STALE_MS = 10 * 60 * 1000; // a snapshot older than this is reported as stale, with no games
const SPECTATE_ELO_TYPES = ['0', '3', '4', '13', '14'];
let spectateCache = { at: 0, snapAt: 0, body: null };
let spectateLoading = null, spectateFailedAt = 0;

function fetchSpectateSnapshot() {
    return new Promise((resolve, reject) => {
        let schema = null, matches = null;
        const elo = Object.create(null);
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
                if (data.schema && typeof data.schema === 'object') schema = data.schema;
                if (data.spectate_match_all && typeof data.spectate_match_all === 'object') matches = data.spectate_match_all;
                const upd = data.spectate_elo_update;
                if (upd && typeof upd === 'object') {
                    // Only the ladders we asked for, merged into null-prototype objects (feed keys are profile ids)
                    for (const type of SPECTATE_ELO_TYPES) {
                        if (Object.hasOwn(upd, type) && upd[type] && typeof upd[type] === 'object') elo[type] = Object.assign(elo[type] || Object.create(null), upd[type]);
                    }
                }
                if (matches && Object.keys(elo).length) finish();
            } catch (e) { }
        };
    });
}

// Map-pool and some custom maps arrive from aoe2lobby.com as a bare id (e.g. "10979"). Their names are looked up
// once per id from aoe2companion's public match API (via one player's current match) and kept in map_names.json.
const MAP_NAMES_PATH = path.join(__dirname, 'map_names.json');
let mapNames = Object.create(null);
try {
    const saved = JSON.parse(fs.readFileSync(MAP_NAMES_PATH, 'utf8'));
    if (saved && typeof saved === 'object') Object.assign(mapNames, saved);
} catch (e) { if (e.code !== 'ENOENT') console.error('Error reading map_names.json:', e.message); }
const mapLookupFailedAt = Object.create(null);
const MAP_LOOKUP_RETRY_MS = 10 * 60 * 1000;
let mapLookupRunning = false;

function mapDisplayName(mapName, mapId, schema) {
    if (typeof mapName === 'number' && Number.isFinite(mapName)) mapName = String(mapName);
    if (typeof mapName !== 'string') return 'Unknown Map';
    if (!/^\d+$/.test(mapName)) return mapName || 'Unknown Map';
    const name = own(mapNames, mapName) ?? own(own(schema, 'mapid'), String(mapId));
    return (typeof name === 'string' && name) ? name : `Map #${mapName}`;
}

// Write to a temp file and rename it over the target, so a reader never sees a half-written file
function writeJsonAtomic(file, obj) {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
        fs.renameSync(tmp, file);
    } catch (e) {
        console.error('Failed to write ' + file + ':', e.message);
        try { fs.unlinkSync(tmp); } catch (_) { }
    }
}

// samples: { mapId: { matchId, profileId } } — one game in progress per unknown map id
async function resolveMapNames(samples) {
    if (mapLookupRunning) return false;
    mapLookupRunning = true;
    let added = false;
    try {
        for (const [mapId, sample] of Object.entries(samples).slice(0, 15)) {
            if (own(mapNames, mapId) || Date.now() - (mapLookupFailedAt[mapId] || 0) < MAP_LOOKUP_RETRY_MS) continue;
            if (!/^\d+$/.test(mapId) || !isProfileId(sample.profileId)) continue;
            try {
                const r = await fetch(`https://data.aoe2companion.com/api/matches?profile_ids=${sample.profileId}&page=1`, {
                    headers: { 'User-Agent': 'aoe2lobby.online (map name lookup)' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                const match = (Array.isArray(data?.matches) ? data.matches : []).find(x => x && String(x.matchId) === String(sample.matchId));
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
        if (added) writeJsonAtomic(MAP_NAMES_PATH, mapNames);
    } finally {
        mapLookupRunning = false;
    }
    return added;
}

function buildSpectateGames({ schema, matches, elo }) {
    const label = (field, value) => {
        if (value === null || value === undefined) return null;
        return scalar(own(own(schema, field), String(value))) ?? null;
    };
    const games = [];
    const unknownMaps = Object.create(null);
    for (const m of Object.values(matches)) {
        if (!m || typeof m !== 'object' || m.observable === false) continue;
        const gameId = Number(m.matchid);
        if (!Number.isSafeInteger(gameId) || gameId <= 0) continue;
        const players = [];
        for (const slot of Object.values(m.slots || {})) {
            if (!slot || typeof slot !== 'object') continue;
            if (!slot.profileid && !slot.name) continue;
            const id = profileIdOf(slot.profileid);
            const ratings = {};
            for (const type of SPECTATE_ELO_TYPES) {
                const st = id && own(elo[type], String(id));
                if (st && Number.isFinite(st.rating)) ratings[type] = st.rating;
            }
            players.push({
                id, name: str(slot.name) || 'AI', team: num(slot.team), color: num(slot.color),
                civ: label('civilization', slot.civilization), country: str(slot.country),
                steamProfile: str(slot.steam_profile), ratings
            });
        }
        if (!players.length) continue;
        const mapId = (typeof m.map_name === 'number' || typeof m.map_name === 'string') ? String(m.map_name) : '';
        if (/^\d+$/.test(mapId) && !own(mapNames, mapId) && !unknownMaps[mapId]) {
            const withId = players.find(p => p.id);
            if (withId) unknownMaps[mapId] = { matchId: gameId, profileId: withId.id };
        }
        const mode = label('mode', m.mode);
        const isRanked = m.description === 'AUTOMATCH';
        const ladder = ladderFor(mode, m.map_name, players.length === 2 ? 2 : 8);
        for (const p of players) {
            p.rating = p.ratings[ladder] ?? null; // the lobby's own ladder, like Auto on the lobby list
        }
        games.push({
            id: gameId,
            title: isRanked ? 'Ranked match' : (str(m.description) || 'Age of Empires II Game'),
            isRanked,
            map: mapDisplayName(m.map_name, m.mapid, schema),
            matchType: mode,
            mapSize: label('size', m.size),
            speed: label('speed', m.speed),
            population: num(m.population) || null,
            server: regionName(label('server', m.server)),
            modInfo: str(m.data_mod) || 'No Mods',
            startTime: num(m.start_time, 0),
            observerDelay: num(m.observer_delay, 0),
            observers: num(m.observers, 0),
            ladder,
            players
        });
    }
    games.sort((a, b) => b.startTime - a.startTime);
    return { games, unknownMaps };
}

// updatedAt is when the snapshot was taken, not when the body was (re)built
function spectateBody(snapshot, snapAt) {
    const { games, unknownMaps } = buildSpectateGames(snapshot);
    return { body: JSON.stringify({ updatedAt: Math.floor(snapAt / 1000), stale: false, games }), unknownMaps };
}

async function refreshSpectate() {
    const snapAt = Date.now();
    const snapshot = await fetchSpectateSnapshot();
    const { body, unknownMaps } = spectateBody(snapshot, snapAt);
    const entry = { at: Date.now(), snapAt, body };
    spectateCache = entry;
    // Look up unknown map names in the background, then rebuild this snapshot with them (unless a newer one replaced it)
    if (Object.keys(unknownMaps).length) {
        resolveMapNames(unknownMaps).then(added => {
            if (added && spectateCache === entry) entry.body = spectateBody(snapshot, snapAt).body;
        }).catch(e => console.error('Map name lookup failed:', e.message));
    }
}

// --- Lobbies: Relic's advertisement list, joined with aoe2lobby.com's data (scraper.js) by match id -------
// Self-learning map hash dictionary (Relic option 52), for lobbies whose map neither source names
const mapDictionary = Object.assign(Object.create(null), {
    "Lsj6bUkZ6EiI9Y2V5Ij0tQ==": "Michi",
    "FoROiR43t0eZEYV7FOkYbQ==": "Michi",
    "EADuRc1n8RGUSLQK2Cdqww==": "Michi", // Kirjan
    "oONDBtBn8RGo0Jj6LpGC+g==": "Michi", // winsome_then11
    "n6DJEMkYA0CHxiIkiV+MrA==": "Michi", // MICHI CREATIVE 2v2
    "musSdesBPUSaSr+wMCeHkQ==": "Michi", // Diplomacyy
    "goSpJWWw60OWIP44/VOUnA==": "Michi", // FVD
    "q0mdRRCcJ0213yr+n01hDA==": "Michi", // ai
    "uR3kYxV8D0w71TqJzM9B4A==": "CBA"
});
const GENERIC_MAPS = ["unknown map", "my map", "custom map", ""];

// Reads one scraped file, or returns null when it is missing, stale or unreadable
function readScrapedJson(file) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { return null; }
    const age = Date.now() - mtimeMs;
    if (age > SCRAPED_MAX_AGE_MS) {
        if (Date.now() - scrapedStaleLoggedAt > 60000) {
            scrapedStaleLoggedAt = Date.now();
            console.error(`Ignoring ${path.basename(file)}: ${Math.round(age / 1000)} s old (is the scraper running?)`);
        }
        return null;
    }
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
    } catch (e) {
        console.error(`Error reading ${path.basename(file)}:`, e.message);
        return null;
    }
}

// One player of a scraped lobby (scraper.js format), with every field type-checked
function scrapedLobbyPlayer(p) {
    return { name: str(p.name), profileId: profileIdOf(p.profileId), civ: str(p.civ), steamProfile: str(p.steamProfile), stats: cleanStats(p.stats) };
}

// scraped_lobbies_v2.json is keyed by aoe2lobby.com's match id, the same id Relic uses. Parsed once per build;
// the records built here are new objects, so nothing below mutates the parsed file.
function loadScrapedLobbies(raw) {
    const byId = new Map();
    if (!raw) return byId;
    for (const key of Object.keys(raw)) {
        const val = raw[key];
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        const matchId = String(scalar(val.matchId) ?? key);
        if (byId.has(matchId)) continue;
        const settings = (val.settings && typeof val.settings === 'object') ? val.settings : {};
        const s = {};
        for (const field of ['Mode', 'Size', 'Population', 'Speed', 'Starting Age', 'Resources', 'Treaty', 'Data Mod', 'Server']) {
            s[field] = scalar(own(settings, field));
        }
        const players = (Array.isArray(val.players) ? val.players : []).filter(p => p && typeof p === 'object').map(scrapedLobbyPlayer);
        byId.set(matchId, {
            matchId,
            host: str(val.host) || players[0]?.name || '',
            hostProfileId: profileIdOf(val.hostProfileId),
            title: str(val.title),
            map: scalar(val.map),
            isPlaying: typeof val.isPlaying === 'boolean' ? val.isPlaying : undefined,
            slotsTotal: num(val.slotsTotal),
            aiSlots: num(val.aiSlots, 0),
            password: val.password === true,
            players,
            playersById: new Map(players.filter(p => p.profileId).map(p => [p.profileId, p])),
            settings: s
        });
    }
    return byId;
}

// scraped_players_v2.json is keyed by profile id; players seen in the scraped lobbies fill any gaps
function loadScrapedPlayers(raw, scrapedById) {
    const byId = new Map();
    for (const key of Object.keys(raw || {})) {
        const sp = raw[key];
        if (!sp || typeof sp !== 'object') continue;
        const id = profileIdOf(sp.profileId ?? key);
        if (id && !byId.has(id)) byId.set(id, scrapedLobbyPlayer({ ...sp, profileId: id }));
    }
    for (const lobby of scrapedById.values()) {
        for (const p of lobby.players) if (p.profileId && !byId.has(p.profileId)) byId.set(p.profileId, p);
    }
    return byId;
}

// Map names to look for in lobby titles when neither Relic nor aoe2lobby.com names the map
function knownTitleMaps() {
    let legacy = [];
    try {
        const legacyPath = path.join(__dirname, 'scraped_maps.json');
        if (fs.existsSync(legacyPath)) {
            const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
            if (data && typeof data === 'object') legacy = Object.values(data);
        }
    } catch (e) {
        console.error('Error reading scraped_maps.json:', e.message);
    }
    return [...new Set([...legacy, ...Object.values(mapDictionary)])]
        .filter(n => typeof n === 'string' && n.length > 2).sort((a, b) => b.length - a.length);
}

// The host is Relic's host_profile_id, else the first slot
function hostIdOf(m) {
    if (isProfileId(m.host_profile_id)) return m.host_profile_id;
    return m.rawPlayers.length > 0 ? m.rawPlayers[0].id : null;
}

// Puts the host first: players[0] is the host for the frontend
function hostFirst(players, hostId) {
    const i = hostId ? players.findIndex(p => p.id === hostId) : -1;
    if (i > 0) players.unshift(...players.splice(i, 1));
    return players;
}

// A player known only from aoe2lobby.com (scraped-only lobby, or a Relic lobby without slot info)
function playerFromScraped(p, scrapedPlayers, ladder) {
    const sp = p.profileId ? scrapedPlayers.get(p.profileId) : undefined;
    const player = { id: p.profileId || 0, name: p.name || 'Unknown', team: 0, elo: null, totalGames: 0, totalWins: 0, winRate: "0.0%", steamProfile: p.steamProfile || sp?.steamProfile || null, civ: p.civ || null, statsPending: false };
    applyStat(player, sp?.stats || p.stats, ladder);
    return player;
}

// Relic's lobby list, every page. Throws when page 0 fails or there are no lobbies at all; complete is false
// when a later page failed (so lobbies missing from this crawl may still exist).
async function fetchRelicLobbies() {
    const matches = [];
    let complete = true;
    for (let pageCount = 0, start = 0; pageCount < 10; pageCount++, start += 100) {
        let parsed;
        try {
            parsed = JSON.parse(await httpsGet(`${RELIC_API}/advertisement/findAdvertisements?title=age2&start=${start}`));
        } catch (e) {
            if (start === 0) throw new Error('Relic lobby list: ' + e.message);
            console.error("Error fetching page:", start, e.message);
            complete = false;
            break;
        }
        if (!parsed || !Array.isArray(parsed.matches) || parsed.matches.length === 0) break;
        matches.push(...parsed.matches.filter(m => m && typeof m === 'object' && Number.isSafeInteger(m.id) && m.id > 0));
    }
    if (matches.length === 0) throw new Error('Relic returned no lobbies');
    return { matches, complete };
}

// Builds the /api/lobbies body (a JSON string). Never touches a response; throws when Relic gives nothing usable.
async function buildLobbiesBody() {
    const { matches: allMatches, complete } = await fetchRelicLobbies();
    const now = Date.now();
    const currentMatchIds = new Set();
    const missingIds = new Set(); // not cached yet
    const staleIds = new Set(); // cached, but due for a refresh

    allMatches.forEach(m => {
        currentMatchIds.add(m.id);
        m.lastSeen = now;
        m.isPlaying = false;
        m.rawPlayers = [];

        let trueMapName = str(m.mapname) || "Unknown Map";

        // Deep decode the options payload to find the hidden map hash!
        try {
            if (typeof m.options === 'string' && m.options) {
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

                    // Auto-learning: if the title strongly implies a map, learn its hash!
                    const tLower = (str(m.description) || "").toLowerCase();
                    if (tLower.includes('michi') || tLower.includes('mici')) {
                        mapDictionary[modHash] = "Michi";
                    } else if (tLower.includes('cba')) {
                        mapDictionary[modHash] = "CBA";
                    }

                    if (mapDictionary[modHash]) {
                        trueMapName = mapDictionary[modHash];
                    }
                }
            }
        } catch(e) {
            // Silently fail if decoding options fails
        }
        m.mapname = trueMapName;

        if (typeof m.slotinfo === 'string' && m.slotinfo) {
            m.rawPlayers = parseSlotInfoIds(m.slotinfo);
            m.rawPlayers.forEach(p => {
                if (!isProfileId(p.id)) return;
                const cached = profileCache.get(p.id);
                if (!cached) { missingIds.add(p.id); return; }
                cached.lastSeen = now;
                if (now - cached.fetchedAt > PROFILE_REFRESH_MS) staleIds.add(p.id);
            });
        }
        activeMatches.set(m.id, m);
    });

    if (missingIds.size > 0 || staleIds.size > 0) {
        // Fetch ALL missing host profiles before answering so hostnames are guaranteed
        const hostIdsToFetch = new Set();
        for (const m of allMatches) {
            const hostId = hostIdOf(m);
            if (missingIds.has(hostId)) hostIdsToFetch.add(hostId);
        }

        if (hostIdsToFetch.size > 0) {
            const hostIdsArray = Array.from(hostIdsToFetch);
            const promises = [];
            for (let i = 0; i < hostIdsArray.length; i += 200) {
                promises.push(fetchProfilesBatch(hostIdsArray.slice(i, i + 200)));
            }
            await Promise.all(promises);
        }

        // Fetch remaining player profiles, and refresh old ones, asynchronously so we don't block
        const remainingIds = [...missingIds, ...staleIds].filter(id => !hostIdsToFetch.has(id));
        for (let i = 0; i < remainingIds.length; i += 200) {
            fetchProfilesBatch(remainingIds.slice(i, i + 200)).catch(e => console.error(e));
        }
    }

    // Remove matches that drop off the Relic API feed (unless a later page failed, so they may still be listed)
    if (complete) {
        for (const id of activeMatches.keys()) {
            if (!currentMatchIds.has(id)) activeMatches.delete(id);
        }
    }
    // Forget profiles that no lobby has shown for a day
    for (const [id, p] of profileCache) {
        if (now - p.lastSeen > PROFILE_FORGET_MS) profileCache.delete(id);
    }

    // aoe2lobby.com data; both files are skipped together when the lobbies file is stale
    const scrapedLobbiesRaw = readScrapedJson(SCRAPED_LOBBIES_PATH);
    const scrapedById = loadScrapedLobbies(scrapedLobbiesRaw);
    const scrapedPlayers = loadScrapedPlayers(scrapedLobbiesRaw ? readScrapedJson(SCRAPED_PLAYERS_PATH) : null, scrapedById);
    let titleMaps = null;

    const allMatchesArray = Array.from(activeMatches.values()).map(m => {
        const sm = scrapedById.get(String(m.id));
        const hostId = hostIdOf(m);

        const parsedPlayers = m.rawPlayers.map(p => {
            const cached = profileCache.get(p.id);
            if (cached) cached.lastSeen = now;
            const sp = isProfileId(p.id) ? scrapedPlayers.get(p.id) : undefined;
            const lp = sm && isProfileId(p.id) ? sm.playersById.get(p.id) : undefined; // this player's slot in the same lobby on aoe2lobby.com
            const alias = cached && cached.alias !== 'Unknown' ? cached.alias : null;
            const name = alias || lp?.name || sp?.name || (cached ? cached.alias : 'Player_' + p.id);
            const steamProfile = sp?.steamProfile || lp?.steamProfile || cached?.steamProfile || null;
            const civ = lp?.civ || sp?.civ || null;
            return {
                id: p.id, name, team: p.team, elo: cached ? cached.rating : null,
                totalGames: cached?.totalGames || 0, totalWins: cached?.totalWins || 0, winRate: cached?.winRate || "0.0",
                steamProfile, civ, statsPending: isProfileId(p.id) && !cached
            };
        });
        hostFirst(parsedPlayers, hostId);

        let finalMapName = m.mapname || "Unknown Map";
        if (finalMapName === "Unknown Map" && str(m.modname)) finalMapName = m.modname;
        const matchupMap = own(own(m.matchup, 'matchinfo'), 'mapname');
        if (typeof matchupMap === 'string') {
            const trueName = own(mapDictionary, matchupMap);
            if (trueName) finalMapName = trueName;
        }

        let matchType = undefined;
        let mapSize = undefined;
        let modInfo = m.modInfo || "No Mods";
        let population = undefined;
        let speed = undefined;
        let startingAge = undefined;
        let resources = undefined;
        let treaty = undefined;
        let serverRegion = regionName(m.relayserver_region);

        if (m.relicPopulation) population = m.relicPopulation;
        if (m.relicSpeed) speed = m.relicSpeed;

        const smMapUsable = sm && sm.map !== undefined && !GENERIC_MAPS.includes(String(sm.map).toLowerCase());
        if (sm) {
            const s = sm.settings;
            if (smMapUsable) finalMapName = sm.map;
            if (sm.isPlaying !== undefined) m.isPlaying = sm.isPlaying;
            if (s.Mode !== undefined) matchType = s.Mode;
            if (s.Size !== undefined) mapSize = s.Size;
            modInfo = (s['Data Mod'] && s['Data Mod'] !== "None") ? s['Data Mod'] : "No Mods";
            if (s.Population !== undefined) population = s.Population;
            if (s.Speed !== undefined) speed = s.Speed;
            if (s['Starting Age'] !== undefined) startingAge = s['Starting Age'];
            if (s.Resources !== undefined) resources = s.Resources;
            if (s.Treaty !== undefined) treaty = s.Treaty;
            if (!serverRegion && regionName(s.Server)) serverRegion = regionName(s.Server);
        }

        // No usable map name from aoe2lobby.com: look for a known map name in the title
        const title = str(m.description);
        if (!smMapUsable && title) {
            if (!titleMaps) titleMaps = knownTitleMaps();
            const descLower = title.toLowerCase();
            for (const mapName of titleMaps) {
                if (descLower.includes(mapName.toLowerCase())) {
                    finalMapName = mapName;
                    break;
                }
            }
        }

        finalMapName = mapDisplayName(finalMapName);
        const slotsTotal = (sm && sm.slotsTotal) || num(m.maxplayers);
        const targetMode = ladderFor(matchType, finalMapName, slotsTotal);

        parsedPlayers.forEach(p => {
            const s = isProfileId(p.id) ? scrapedPlayers.get(p.id)?.stats : null;
            const cachedStats = profileCache.get(p.id)?.stats;
            applyStat(p, s || (cachedStats && Object.keys(cachedStats).length ? cachedStats : null), targetMode);
        });
        // Relic gave no slot info: show aoe2lobby.com's players for this lobby instead
        if (parsedPlayers.length === 0 && sm) {
            parsedPlayers.push(...hostFirst(sm.players.map(p => playerFromScraped(p, scrapedPlayers, targetMode)), sm.hostProfileId));
        }

        return {
            id: m.id,
            steamLobbyId: (typeof m.steamlobbyid === 'number' || typeof m.steamlobbyid === 'string') ? m.steamlobbyid : null,
            title: title || "Age of Empires II Game",
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
            isPasswordProtected: m.passwordprotected === 1 || m.passwordprotected === true || (sm ? sm.password : false),
            maxPlayers: slotsTotal,
            aiSlots: (sm && sm.aiSlots) || 0,
            isPlaying: m.isPlaying === true,
            lastSeen: m.lastSeen,
            players: parsedPlayers
        };
    });

    // aoe2lobby.com lobbies missing from Relic's list. A numeric match id is Relic's id too, so the lobby stays
    // joinable; deduped by id because the cards are keyed as lobby-<id>.
    const seenIds = new Set(allMatchesArray.map(l => String(l.id)));
    const relicPlayerIds = new Set();
    for (const l of allMatchesArray) for (const p of l.players) if (isProfileId(p.id)) relicPlayerIds.add(p.id);
    for (const lobby of scrapedById.values()) {
        const numericId = /^\d+$/.test(lobby.matchId) && Number.isSafeInteger(Number(lobby.matchId)) ? Number(lobby.matchId) : null;
        // Non-Latin host names sanitize to underscores, so add the host's profile id to keep different lobbies apart
        const id = numericId ?? 'scraped_' + lobby.host.toLowerCase().replace(/[^a-z0-9_-]/g, '_') +
            (isProfileId(lobby.hostProfileId) ? '_' + lobby.hostProfileId : '');
        if (seenIds.has(String(id))) continue;
        // Without a match id (an older file keyed by host name) the lobby can't be matched to Relic's; skip it
        // when its players are already in a Relic lobby, so it isn't listed twice
        if (numericId === null && lobby.players.some(p => relicPlayerIds.has(p.profileId))) continue;
        seenIds.add(String(id));

        const s = lobby.settings;
        const map = mapDisplayName(lobby.map);
        const ladder = ladderFor(s.Mode, map, lobby.slotsTotal);
        const parsedPlayers = hostFirst(lobby.players.map(p => playerFromScraped(p, scrapedPlayers, ladder)), lobby.hostProfileId);

        allMatchesArray.push({
            id,
            steamLobbyId: null,
            title: lobby.title || "Age of Empires II Game",
            map,
            matchType: s.Mode || "Unknown",
            mapSize: s.Size || "Unknown",
            modInfo: s['Data Mod'] || "No Mods",
            population: s.Population || undefined,
            speed: s.Speed || undefined,
            startingAge: s['Starting Age'],
            resources: s.Resources,
            treaty: s.Treaty,
            server: regionName(s.Server),
            isPasswordProtected: lobby.password,
            maxPlayers: lobby.slotsTotal || 8,
            aiSlots: lobby.aiSlots || 0,
            isPlaying: lobby.isPlaying === true,
            lastSeen: now,
            players: parsedPlayers
        });
    }

    return JSON.stringify({ matches: allMatchesArray });
}

// One build at a time, shared by every waiting request; after a failure, wait (15 s doubling to 60 s) before retrying
function refreshLobbies() {
    if (!lobbiesLoading && Date.now() >= lobbiesFailUntil) {
        lobbiesLoading = buildLobbiesBody()
            .then(body => { lobbiesCache = { at: Date.now(), body }; lobbiesFailures = 0; })
            .catch(e => {
                lobbiesFailures++;
                lobbiesFailUntil = Date.now() + Math.min(60000, 15000 * 2 ** (lobbiesFailures - 1));
                console.error('Lobbies refresh failed:', e.message);
            })
            .finally(() => { lobbiesLoading = null; });
    }
    return lobbiesLoading;
}

async function handleRequest(req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Read-only site: anything but GET/HEAD is refused before routing (so it can't trigger a rebuild)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
    }

    if (req.url.startsWith('/api/spectate')) {
        try {
            const now = Date.now();
            if (now - spectateCache.at > SPECTATE_REFRESH_MS && !spectateLoading && now - spectateFailedAt > SPECTATE_REFRESH_MS) {
                spectateLoading = refreshSpectate()
                    .catch(e => {
                        spectateFailedAt = Date.now();
                        console.error('Spectate refresh failed:', e.message);
                    })
                    .finally(() => { spectateLoading = null; });
            }
            // Wait for the refresh when there is nothing usable yet: no snapshot, or one too old to show
            if (spectateLoading && (!spectateCache.body || Date.now() - spectateCache.snapAt > SPECTATE_STALE_MS)) await spectateLoading;
            let body = spectateCache.body;
            if (!body) body = JSON.stringify({ updatedAt: null, stale: true, games: [] });
            else if (Date.now() - spectateCache.snapAt > SPECTATE_STALE_MS) {
                body = JSON.stringify({ updatedAt: Math.floor(spectateCache.snapAt / 1000), stale: true, games: [] });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ updatedAt: null, stale: true, games: [] }));
        }
        return;
    }

    if (req.url.startsWith('/api/lobbies')) {
        // Serve the cached body; past LOBBIES_CACHE_MS refresh it in the background, and wait only when there is
        // no body yet or it is older than LOBBIES_MAX_STALE_MS
        const age = Date.now() - lobbiesCache.at;
        if (!lobbiesCache.body || age >= LOBBIES_CACHE_MS) {
            const pending = refreshLobbies();
            if (pending && (!lobbiesCache.body || age > LOBBIES_MAX_STALE_MS)) await pending;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(lobbiesCache.body || '{"matches":[]}');
        return;
    }

    // Serve static files (the query string is dropped first, so "/?fbclid=..." is the home page)
    const pathname = req.url.split('?')[0];
    const isVersioned = /[?&]v=/.test(req.url);
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = own(FILE_ALIASES, filePath) || filePath;

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
        '.woff2': 'font/woff2',
        '.woff': 'application/font-woff',
        '.ttf': 'application/font-ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'application/font-otf',
        '.wasm': 'application/wasm'
    };

    const contentType = own(mimeTypes, extname) || 'application/octet-stream';

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
            // HTML revalidates every time; ?v= assets never change; everything else (fonts too) for a day
            const cacheControl = extname === '.html' ? 'no-cache'
                : isVersioned ? 'public, max-age=31536000, immutable'
                : 'public, max-age=86400';
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
            res.end(content);
        }
    });
}

const server = http.createServer((req, res) => {
    // A failed request answers 500 instead of reaching the unhandledRejection handler (which exits)
    handleRequest(req, res).catch(e => {
        console.error('Request failed:', req.url, e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
    });
});

server.listen(API_PORT, HOST, () => {
    console.log(`API Server listening on ${HOST}:${API_PORT}`);
});

// pm2 stop/reload sends SIGINT: finish in-flight requests, then exit (force it after 8 s)
function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
