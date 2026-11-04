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
    '/index.html', '/app.js', '/styles.css', '/overlay.js', '/overlay.css', '/civ-info.json', '/favicon.png',
    '/replay.js', '/replay.css', '/replay-parse.js', '/replay-worker.js', '/replay-data.json', // the replay viewer (/replay)
    '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/og-image.png', '/site.webmanifest',
    '/robots.txt', '/sitemap.xml',
    '/fonts/cinzel-variable.woff2', '/fonts/outfit-variable.woff2', '/fonts/cinzel-ext.woff2', '/fonts/outfit-ext.woff2', '/fonts/OFL.txt', // self-hosted fonts
    '/7e7c007e5148f7d5a2953120e8410d70.txt' // IndexNow key (lets Bing/Yandex accept our URL submissions)
]);
const FILE_ALIASES = { '/favicon.ico': '/favicon-32.png' };
const RELIC_API = 'https://aoe-api.worldsedgelink.com/community'; // aoe-api.reliclink.com is a CNAME of this host
// Every visitor polls /api/lobbies; build it at most once per LOBBIES_CACHE_MS and share the result
const LOBBIES_CACHE_MS = 4000;
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
// Feed text going into HTML (the match page's title and meta tags)
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// A match id from a URL: digits only and at most 15 of them (so always a safe integer); anything else is not an id
function isMatchId(s) {
    return typeof s === 'string' && /^\d{1,15}$/.test(s) && Number.isSafeInteger(Number(s));
}

const MAX_UPSTREAM_BODY = 8 * 1024 * 1024;
function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 5000, headers }, (res) => {
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
// using the Spectate view or a match page (each /api/spectate request may trigger a refresh; nothing polls
// on its own).
const SPECTATE_REFRESH_MS = 60000;
const SPECTATE_STALE_MS = 10 * 60 * 1000; // a snapshot older than this is reported as stale, with no games
const SPECTATE_WAIT_MS = 2 * 60 * 1000; // older than this, a request waits for the refresh (app.js flags > 3 min as unavailable)
const SPECTATE_ELO_TYPES = ['0', '3', '4', '13', '14'];
// games: match id -> built game (the detail shape, with country) of the current snapshot
let spectateCache = { at: 0, snapAt: 0, body: null, index: null, games: new Map() };
let spectateLoading = null, spectateFailedAt = 0;

// The schema labels civs up to its own table; newer civs arrive as their raw id negated (like negative mapids).
// Checked against aoe2companion. Never read them as abs(id): the schema's 57 and 61-63 are Return of Rome civs.
// scraper.js labels lobby players with the same table (its FALLBACK_SCHEMA.civilization); keep the two in sync.
const NEW_CIVS = Object.assign(Object.create(null), { '-56': 'Thracians', '-57': 'Puru', '-61': 'Saxons', '-62': 'Varangians', '-63': 'Danes' });
// The schema's 15 is singular, and three Return of Rome civs (58, 62, 66) carry internal names, not display names
const CIV_LABEL_FIXES = Object.assign(Object.create(null), { Aztec: 'Aztecs', OldPersians: 'Persians', OldRomans: 'Romans', LacViet: 'Lac Viet' });
// Those two then share a name with a DE civ, whose details (civ-info.json) don't apply: players get civRor: true
const ROR_SHARED_LABELS = new Set(['OldPersians', 'OldRomans']);
const loggedUnknownCivs = new Set();

// A civ label from either feed (spectate schema, or the lobby labels scraper.js wrote, NEW_CIVS included), as the site shows it
function civLabel(label) {
    return (label && CIV_LABEL_FIXES[label]) || label;
}

function rawCivLabel(civ, schema) {
    const key = (typeof civ === 'number' || typeof civ === 'string') ? String(civ) : '';
    return str(own(own(schema, 'civilization'), key)) || NEW_CIVS[key] || null;
}

function civName(civ, schema) {
    const key = (typeof civ === 'number' || typeof civ === 'string') ? String(civ) : '';
    const label = rawCivLabel(civ, schema);
    if (label) return civLabel(label);
    // Logged once per id, so NEW_CIVS can be updated by hand
    if (!loggedUnknownCivs.has(key) && loggedUnknownCivs.size < 100) {
        loggedUnknownCivs.add(key);
        console.log(`Spectate: civ id ${JSON.stringify(key.slice(0, 20))} has no label, shown as "Unknown civ" (add it to NEW_CIVS)`);
    }
    return 'Unknown civ';
}

// Slots by the schema's status labels (0 Open, 1 Closed, 2 AI, 3 Player). A closed slot carries a dummy civ and an
// open one never occurs in a running game, so both are skipped. Names never decide: some humans are called "D-Computers".
function slotKind(slot) {
    const status = num(slot.status);
    if (status === 3) return profileIdOf(slot.profileid) ? 'human' : null;
    if (status === 2) return 'ai';
    if (status === 0 || status === 1) return null;
    // No (known) status: a profile id means a human, else a team and colour mean an AI, else the slot is closed
    if (profileIdOf(slot.profileid)) return 'human';
    return (num(slot.team) !== null && num(slot.color) !== null) ? 'ai' : null;
}

// Feed team 1 is "no team" (custom games, free-for-all) and 2-5 are Teams 1-4; matchmaking uses 2 and 3
function displayTeam(team) {
    const t = num(team);
    return (Number.isInteger(t) && t >= 2 && t <= 5) ? t - 1 : null;
}

// Feed colours 0-7 are player colours 1-8 (Blue, Red, Green, Yellow, Teal, Pink, Grey, Orange)
function displayColor(color) {
    const c = num(color);
    return (Number.isInteger(c) && c >= 0 && c <= 7) ? c + 1 : null;
}

// ISO-2 codes arrive in mixed case; a few are null or missing
function countryCode(country) {
    const c = typeof country === 'string' ? country.toLowerCase() : '';
    return /^[a-z]{2}$/.test(c) ? c : null;
}

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

// Ranked queues by the feed's match_typeid (the schema's table) and their ladders, for a ranked game whose mode is
// missing: RM 1v1 (5, console 16), RM team (6-8, console 17-19), EW 1v1 (10, console 20), EW team (11-13, console 21-23).
// The console queues get the PC ladders, as they do through ladderFor when the mode is set.
const QUEUE_LADDERS = Object.assign(Object.create(null), {
    5: '3', 16: '3', 6: '4', 7: '4', 8: '4', 17: '4', 18: '4', 19: '4',
    10: '13', 20: '13', 11: '14', 12: '14', 13: '14', 21: '14', 22: '14', 23: '14'
});

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
        // Hidden-civ games still carry the real picks, so they are dropped here or the page would reveal them
        const civsHidden = m.hide_civilizations === true;
        const players = [];
        for (const slot of Object.values(m.slots || {})) {
            if (!slot || typeof slot !== 'object') continue;
            const kind = slotKind(slot);
            if (!kind) continue;
            const team = displayTeam(slot.team), color = displayColor(slot.color);
            const civ = civsHidden ? null : civName(slot.civilization, schema);
            const ror = civ !== null && ROR_SHARED_LABELS.has(rawCivLabel(slot.civilization, schema)) ? { civRor: true } : {};
            if (kind === 'ai') {
                players.push({ id: 0, name: 'AI', kind, team, color, civ, ...ror, rating: null, ratings: {} });
                continue;
            }
            const id = profileIdOf(slot.profileid);
            const ratings = {};
            for (const type of SPECTATE_ELO_TYPES) {
                const st = own(elo[type], String(id));
                if (st && Number.isFinite(st.rating)) ratings[type] = st.rating;
            }
            const player = { id, name: str(slot.name) || `Player ${id}`, kind, team, color, civ, ...ror, country: countryCode(slot.country) };
            const steamProfile = str(slot.steam_profile);
            if (steamProfile) player.steamProfile = steamProfile;
            player.rating = null;
            player.ratings = ratings;
            players.push(player);
        }
        if (!players.length) continue;
        const mapId = (typeof m.map_name === 'number' || typeof m.map_name === 'string') ? String(m.map_name) : '';
        if (/^\d+$/.test(mapId) && !own(mapNames, mapId) && !unknownMaps[mapId]) {
            const human = players.find(p => p.kind === 'human');
            if (human) unknownMaps[mapId] = { matchId: gameId, profileId: human.id };
        }
        const mode = label('mode', m.mode);
        const queue = num(m.match_typeid);
        // Quick Play (and Quick Play vs AI) games are matchmaking games too, with the raw Relic queue id negated as their
        // match_typeid. They change a Quick Play rating, which none of the feed's ladders carry.
        const isQuickPlay = m.description === 'AUTOMATCH' && queue !== null && queue < 0;
        const isRanked = m.description === 'AUTOMATCH' && !isQuickPlay;
        // 1v1 or team counts AI players too (slots_taken and slots_total are unreliable). A ranked game that arrives
        // without its settings (mode null) takes the ladder from its queue instead.
        const ladder = isQuickPlay ? null
            : (isRanked && mode === null) ? (QUEUE_LADDERS[queue] ?? null)
            : ladderFor(mode, m.map_name, players.length === 2 ? 2 : 8);
        for (const p of players) {
            if (p.kind === 'human') p.rating = ladder !== null ? (p.ratings[ladder] ?? null) : null; // the lobby's own ladder, like Auto on the lobby list
        }
        games.push({
            id: gameId,
            title: isRanked ? 'Ranked match' : isQuickPlay ? 'Quick Play' : (str(m.description) || 'Age of Empires II Game'),
            isRanked,
            isQuickPlay,
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
            civsHidden,
            record: m.record !== false,
            endedAt: null,
            players
        });
    }
    games.sort((a, b) => b.startTime - a.startTime);
    return { games, unknownMaps };
}

// updatedAt is when the snapshot was taken, not when the body was (re)built. The list drops country (it doesn't
// show it); the detail API serves the games kept in `games`, which have it. The index is the list cut down to what
// followed-player alerts need (about a tenth of its size), so a browser can match its follows without sending them.
function spectateBody(snapshot, snapAt) {
    const { games, unknownMaps } = buildSpectateGames(snapshot);
    const listGames = games.map(g => ({ ...g, players: g.players.map(({ country, ...p }) => p) }));
    const updatedAt = Math.floor(snapAt / 1000);
    const indexGames = games.map(g => ({ id: g.id, startTime: g.startTime, map: g.map, players: g.players.filter(p => p.kind === 'human').map(p => p.id) }));
    return {
        body: JSON.stringify({ updatedAt, stale: false, games: listGames }),
        index: JSON.stringify({ updatedAt, stale: false, games: indexGames }),
        games: new Map(games.map(g => [g.id, g])),
        unknownMaps
    };
}

// A snapshot is usable for this long: older, the list shows no games and no game counts as live
function spectateFresh(cache) {
    return !!cache.body && Date.now() - cache.snapAt <= SPECTATE_STALE_MS;
}

async function refreshSpectate() {
    const snapAt = Date.now();
    const snapshot = await fetchSpectateSnapshot();
    const { body, index, games, unknownMaps } = spectateBody(snapshot, snapAt);
    // Hundreds of games are always in progress and they don't halve within minutes, so a snapshot with no games, or with
    // under half the games of a recent one, is a feed glitch: it counts as a failed refresh, or every running game it
    // misses would be marked as ended
    const prev = spectateCache;
    if (!games.size || (spectateFresh(prev) && prev.games.size >= 20 && games.size < prev.games.size / 2)) {
        throw new Error(`implausible snapshot: ${games.size} games, after ${prev.games.size}`);
    }
    noteEndedGames(prev.games, games, snapAt);
    const entry = { at: Date.now(), snapAt, body, index, games };
    spectateCache = entry;
    // Look up unknown map names in the background, then rebuild this snapshot with them (unless a newer one replaced it)
    if (Object.keys(unknownMaps).length) {
        resolveMapNames(unknownMaps).then(added => {
            if (!added || spectateCache !== entry) return;
            const rebuilt = spectateBody(snapshot, snapAt);
            entry.body = rebuilt.body;
            entry.index = rebuilt.index;
            entry.games = rebuilt.games;
        }).catch(e => console.error('Map name lookup failed:', e.message));
    }
}

// One freshness rule for the list and the detail API: refresh the snapshot on demand at most once per
// SPECTATE_REFRESH_MS, and wait for the refresh only when there is nothing usable yet (no snapshot, or one too old to show)
async function freshSpectate() {
    const now = Date.now();
    if (now - spectateCache.at > SPECTATE_REFRESH_MS && !spectateLoading && now - spectateFailedAt > SPECTATE_REFRESH_MS) {
        spectateLoading = refreshSpectate()
            .catch(e => {
                spectateFailedAt = Date.now();
                console.error('Spectate refresh failed:', e.message);
            })
            .finally(() => { spectateLoading = null; });
    }
    if (spectateLoading && (!spectateCache.body || Date.now() - spectateCache.snapAt > SPECTATE_WAIT_MS)) await spectateLoading;
    return spectateCache;
}

// --- Spectate: games that left the feed, and their results from World's Edge's match history --------------
// A game missing from a new snapshot has ended; its page then shows the winner, rating changes and replay link.
const ENDED_KEEP_MS = 2 * 60 * 60 * 1000;
const ENDED_MAX = 5000;
const RESULT_GIVE_UP_S = 15 * 60; // after the first lookup (normally right after the game left the feed)
const RESULT_FAST_S = 3 * 60; // retries are >= 20 s apart for this long after the game ended, then >= 60 s
const RESULT_WAIT_MS = 3000; // the longest a detail request waits for a lookup in flight
const endedGames = new Map(); // match id -> { game (with endedAt), result, lookup, firstTryAt, lastTryAt, tries }, oldest first
// World's Edge serves the lobby list too: lookups run one at a time, >= 1 s apart, at most 30 a minute
let resultLookupBusy = false;
const resultLookupStarts = []; // start times (ms) within the last minute

// Called on each refresh. endedAt is the new snapshot's time; a game listed again is live again.
function noteEndedGames(prevGames, games, snapAt) {
    const endedAt = Math.floor(snapAt / 1000);
    for (const [id, game] of prevGames) {
        if (!games.has(id)) endedGames.set(id, { game: { ...game, endedAt }, result: null, lookup: null, firstTryAt: 0, lastTryAt: 0, tries: 0 });
    }
    for (const id of games.keys()) endedGames.delete(id);
    pruneEndedGames();
}

// Map order is insertion order, which is endedAt order: drop expired entries, then the oldest past the cap
function pruneEndedGames() {
    const oldest = Math.floor((Date.now() - ENDED_KEEP_MS) / 1000);
    for (const [id, e] of endedGames) {
        if (e.game.endedAt < oldest || endedGames.size > ENDED_MAX) endedGames.delete(id);
    }
}

// A game by id: live in the given snapshot, or ended within ENDED_KEEP_MS. A snapshot too old to list (the feed is down)
// can't tell whether its games are still running, so they are unknown until a refresh succeeds.
function spectateGameById(cache, id) {
    const live = spectateFresh(cache) ? cache.games.get(id) : undefined;
    if (live) return { status: 'live', game: live, ended: null };
    const ended = endedGames.get(id);
    if (ended && ended.game.endedAt >= Math.floor((Date.now() - ENDED_KEEP_MS) / 1000)) return { status: 'ended', game: ended.game, ended };
    return { status: 'unknown', game: null, ended: null };
}

// A player's game for the overlay that follows them: of the live games and the ended ones still kept, the one they
// started last. The feed keeps listing a player in a team game they have left for as long as it runs, so a live game
// older than one they have since finished isn't theirs any more. A snapshot too old to list can't tell what they're
// playing now (their game may not have reached endedGames): unknown, like every game of it.
function spectateGameByPlayer(cache, profileId) {
    if (!spectateFresh(cache)) return { status: 'unknown', game: null, ended: null };
    const has = g => g.players.some(p => p.kind === 'human' && p.id === profileId);
    let best = null;
    for (const g of cache.games.values()) if (has(g) && (!best || g.startTime > best.startTime)) best = g;
    const keptSince = Math.floor((Date.now() - ENDED_KEEP_MS) / 1000);
    for (const e of endedGames.values()) {
        if (e.game.endedAt >= keptSince && has(e.game) && (!best || e.game.startTime > best.startTime)) best = e.game;
    }
    return best ? spectateGameById(cache, best.id) : { status: 'unknown', game: null, ended: null };
}

function emptyResult(state) {
    return { state, completedAt: null, duration: null, winningTeam: null, noWinner: null, aiWon: null, ratingKind: null, players: null, replay: null };
}

// The result of `game` from one getRecentMatchHistory response, or null while the game isn't in it. The history is
// unsorted and holds older games, so the entry must match both the id and the start time. Only ids, outcomes,
// ratings, times and replay sizes are read: matchurls[].url is a signed blob URL and is never touched.
function parseMatchResult(data, game) {
    const history = own(data, 'matchHistoryStats');
    if (!Array.isArray(history)) return null;
    const entry = history.find(e => num(own(e, 'id')) === game.id && num(own(e, 'startgametime')) === game.startTime);
    if (!entry) return null;
    const members = Array.isArray(entry.matchhistorymember) ? entry.matchhistorymember : [];
    const rowById = new Map();
    for (const m of members) {
        const id = profileIdOf(own(m, 'profile_id'));
        if (id && !rowById.has(id)) rowById.set(id, m);
    }
    const rating = (v) => { const n = num(v); return (Number.isSafeInteger(n) && n > 0 && n < 10000) ? n : null; };
    // Relic's teamid has no fixed offset from the feed's team, so players are joined by profile id and labelled
    // with the feed's teams. AI players have no rows.
    const teamOf = new Map();
    const players = [];
    for (const p of game.players) {
        const row = p.kind === 'human' ? rowById.get(p.id) : undefined;
        if (!row || teamOf.has(p.id)) continue;
        teamOf.set(p.id, p.team);
        players.push({ id: p.id, won: num(own(row, 'outcome')) === 1, oldRating: rating(own(row, 'oldrating')), newRating: rating(own(row, 'newrating')) });
    }
    // A winning team only when every winner has the same feed team and no loser shares it (custom lobbies can have
    // several winning teams, everyone winning, or nobody)
    const winnerTeams = players.filter(p => p.won).map(p => teamOf.get(p.id));
    const loserTeams = players.filter(p => !p.won).map(p => teamOf.get(p.id));
    const team = winnerTeams[0] ?? null;
    let winningTeam = (team !== null && winnerTeams.every(t => t === team) && !loserTeams.includes(team)) ? team : null;
    // AI players have no rows, so when no human won a game with AI opponents (AI not on a human's team), the AI won:
    // their team when they all share one, else just "the AI"
    const humanWon = members.some(m => num(own(m, 'outcome')) === 1);
    const humanTeams = new Set(game.players.filter(p => p.kind === 'human' && p.team !== null).map(p => p.team));
    const aiOpponents = game.players.filter(p => p.kind === 'ai' && (p.team === null || !humanTeams.has(p.team)));
    const aiWon = !humanWon && members.length > 0 && aiOpponents.length > 0;
    if (aiWon) {
        const aiTeam = aiOpponents[0].team;
        winningTeam = (aiTeam !== null && aiOpponents.every(p => p.team === aiTeam)) ? aiTeam : null;
    }
    const completedAt = num(own(entry, 'completiontime'));
    const done = Number.isSafeInteger(completedAt) && completedAt >= game.startTime && game.startTime > 0;
    // The largest upload among the game's humans; size -1 or no row means that player has no replay (not a temporary state).
    // The feed's record: false is the host's own setting: other players still upload theirs, so it doesn't hide them.
    const humanIds = new Set(game.players.filter(p => p.kind === 'human').map(p => p.id));
    let replay = { available: false, profileId: null }, best = 0;
    if (Array.isArray(entry.matchurls)) {
        for (const u of entry.matchurls) {
            const id = profileIdOf(own(u, 'profile_id')), size = num(own(u, 'size'));
            if (humanIds.has(id) && Number.isSafeInteger(size) && size > best) {
                best = size;
                replay = { available: true, profileId: id };
            }
        }
    }
    return {
        state: 'found',
        completedAt: done ? completedAt : null,
        duration: done ? completedAt - game.startTime : null,
        winningTeam,
        noWinner: !humanWon && !aiWon,
        aiWon,
        // Unranked custom lobbies change a separate unranked rating, and Quick Play games their own Quick Play rating
        ratingKind: game.isRanked ? 'ranked' : game.isQuickPlay ? 'quickplay' : 'unranked',
        players,
        replay
    };
}

// Starts a result lookup for an ended game when its own and the global limits allow; otherwise does nothing and the
// result stays pending (the page asks again). Only detail requests call this.
function startResultLookup(ended) {
    if (ended.result || ended.lookup) return;
    const now = Date.now();
    const humans = ended.game.players.filter(p => p.kind === 'human');
    const sinceEnd = now / 1000 - ended.game.endedAt;
    // The window starts at the first lookup, so a game first asked for late (a shared link, a tab that was hidden) is
    // still looked up rather than given up on unasked
    if (!humans.length || (ended.tries > 0 && now - ended.firstTryAt > RESULT_GIVE_UP_S * 1000)) {
        ended.result = emptyResult('unavailable');
        return;
    }
    if (now - ended.lastTryAt < (sinceEnd < RESULT_FAST_S ? 20000 : 60000)) return;
    while (resultLookupStarts.length && now - resultLookupStarts[0] >= 60000) resultLookupStarts.shift();
    if (resultLookupBusy || resultLookupStarts.length >= 30 || now - (resultLookupStarts.at(-1) ?? 0) < 1000) return;
    resultLookupBusy = true;
    resultLookupStarts.push(now);
    if (!ended.tries) ended.firstTryAt = now;
    ended.lastTryAt = now;
    // Each retry asks for a different player's history, in case one player's list is slow to update
    const profileId = humans[ended.tries++ % humans.length].id;
    ended.lookup = httpsGet(`${RELIC_API}/leaderboard/getRecentMatchHistory?title=age2&profile_ids=[${profileId}]`,
        { 'User-Agent': 'aoe2lobby.online (spectate results)' })
        .then(text => {
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('invalid JSON'); } // the parser's message would quote the body
            const result = parseMatchResult(data, ended.game);
            if (result) ended.result = result;
        })
        .catch(e => console.error(`Spectate result lookup for ${ended.game.id} failed:`, e.message))
        .finally(() => {
            resultLookupBusy = false;
            ended.lookup = null;
        });
}

// Waits for a promise that never rejects, but at most ms (it keeps running after that)
function settleWithin(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

// The list ("body") or the index: both are empty and stale while the snapshot is too old to show
async function serveSpectateList(res, which = 'body') {
    let body;
    try {
        const cache = await freshSpectate();
        body = cache[which];
        if (!body) body = JSON.stringify({ updatedAt: null, stale: true, games: [] });
        else if (!spectateFresh(cache)) {
            body = JSON.stringify({ updatedAt: Math.floor(cache.snapAt / 1000), stale: true, games: [] });
        }
    } catch (e) {
        body = JSON.stringify({ updatedAt: null, stale: true, games: [] });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
}

// /api/spectate/<matchId>, or /api/spectate/player/<profileId> for that player's game (same answer)
async function serveSpectateMatch(res, id, byPlayer = false) {
    const cache = await freshSpectate();
    const found = byPlayer ? spectateGameByPlayer(cache, id) : spectateGameById(cache, id);
    let result = null;
    if (found.ended) {
        startResultLookup(found.ended);
        if (found.ended.lookup) await settleWithin(found.ended.lookup, RESULT_WAIT_MS);
        result = found.ended.result || emptyResult('pending');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: found.status,
        updatedAt: cache.body ? Math.floor(cache.snapAt / 1000) : null,
        stale: !spectateFresh(cache),
        game: found.game,
        result
    }));
}

// --- Spectate: /spectate/<matchId> serves index.html with the match's own title and preview tags ----------
// The tags are found by their one-line format in index.html; a missing one is logged once and the page served anyway.
const SITE_URL = 'https://aoe2lobby.online';
const PAGE_SUFFIX = ' – Spectate | AoE2Lobby.online';
const loggedMissingTags = new Set();

// Feed text as one line of at most max characters, cut on a code point with an ellipsis
function clipText(text, max) {
    const chars = Array.from(String(text).replace(/[\x00-\x1F\x7F\s]+/g, ' ').trim());
    return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}

// Teams in display order; each player without a team is a side of their own (free-for-all, some custom games)
function spectateSides(players) {
    const teams = new Map(), solo = [];
    for (const p of players) {
        if (p.team === null) solo.push([p]);
        else if (teams.has(p.team)) teams.get(p.team).push(p);
        else teams.set(p.team, [p]);
    }
    return [...[...teams.keys()].sort((a, b) => a - b).map(t => teams.get(t)), ...solo];
}

// Plain text (escaped later) for the page's title and description; civs are left out, so hidden civs stay hidden
function spectatePageText(id, game) {
    if (!game) {
        return {
            title: `Match ${id}${PAGE_SUFFIX}`,
            description: 'An Age of Empires II: DE game on AoE2Lobby.online. Games in progress show their teams, civs and ratings, with a one-click Watch in game link.'
        };
    }
    const players = game.players, sides = spectateSides(players);
    let head;
    if (players.length === 2) head = `${players[0].name} vs ${players[1].name} on ${game.map}`;
    else if (sides.length >= 2 && players.every(p => p.team !== null)) head = `${game.map} ${sides.map(s => s.length).join('v')}`;
    else head = `${game.map} ${players.length} player${players.length === 1 ? '' : 's'}`;
    const matchup = sides.map(s => s.map(p => p.rating != null ? `${p.name} (${p.rating})` : p.name).join(', ')).join(' vs ');
    const details = [game.title, game.matchType, game.server && `${game.server} server`].filter(Boolean).join(', ');
    const delay = game.observerDelay > 0 ? `Spectators watch about ${game.observerDelay} min behind the live game.` : 'Spectators watch the live game without delay.';
    const description = game.endedAt
        ? `Finished Age of Empires II game on ${game.map}: ${matchup}. ${details}.`
        : `Live Age of Empires II game on ${game.map}: ${matchup}. ${details}. ${delay}`;
    return { title: clipText(head, 70 - PAGE_SUFFIX.length) + PAGE_SUFFIX, description: clipText(description, 200) };
}

function logMissingTag(name) {
    if (loggedMissingTags.has(name)) return;
    loggedMissingTags.add(name);
    console.error(`Match page: index.html has no ${name} tag, served without replacing it`);
}

// Uses whatever snapshot is cached: a page view never triggers a feed refresh (the page's own script calls the API)
async function serveSpectatePage(res, id) {
    let html;
    try {
        html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(e.code === 'ENOENT' ? 'File not found' : 'Server error: ' + e.code);
        return;
    }
    const { title, description } = spectatePageText(id, spectateGameById(spectateCache, id).game);
    const url = `${SITE_URL}/spectate/${id}`;
    const tags = [
        ['title', /<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`],
        ['description', /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${esc(description)}">`],
        ['canonical', /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/i, `<link rel="canonical" href="${url}">`],
        ['og:title', /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:title" content="${esc(title)}">`],
        ['og:description', /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:description" content="${esc(description)}">`],
        ['og:url', /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/i, `<meta property="og:url" content="${url}">`]
    ];
    // A replacer function, so "$&" and the like in feed text stay literal
    for (const [name, re, tag] of tags) {
        if (re.test(html)) html = html.replace(re, () => tag);
        else logMissingTag(name);
    }
    // Match pages only live for a game's length, so they stay out of search results (the header covers a missing tag)
    const robots = '<meta name="robots" content="noindex">';
    const robotsRe = /<meta\s+name="robots"\s+content="[^"]*"\s*\/?>/i;
    if (robotsRe.test(html)) html = html.replace(robotsRe, () => robots);
    else if (html.includes('</head>')) html = html.replace('</head>', () => `    ${robots}\n</head>`);
    else logMissingTag('robots');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
    res.end(html);
}

// A page served under a route of its own: /overlay/<matchId> and /overlay/player/<profileId> (the caster overlay,
// an OBS browser source, never indexed), and /replay (the replay viewer)
async function serveHtmlPage(res, file, noindex) {
    let html;
    try {
        html = await fs.promises.readFile(path.join(__dirname, file));
    } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(e.code === 'ENOENT' ? 'File not found' : 'Server error: ' + e.code);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(noindex ? { 'X-Robots-Tag': 'noindex' } : {}) });
    res.end(html);
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
// (civ is a label scraper.js took from the lobby feed's schema: named the way the spectate view names it)
function scrapedLobbyPlayer(p) {
    const civ = str(p.civ);
    return { name: str(p.name), profileId: profileIdOf(p.profileId), civ: civLabel(civ), civRor: ROR_SHARED_LABELS.has(civ), steamProfile: str(p.steamProfile), stats: cleanStats(p.stats) };
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
    const player = { id: p.profileId || 0, name: p.name || 'Unknown', team: 0, elo: null, totalGames: 0, totalWins: 0, winRate: "0.0%", steamProfile: p.steamProfile || sp?.steamProfile || null, civ: p.civ || null, civRor: !!(p.civ && p.civRor), statsPending: false };
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

    // Remove matches that drop off the Relic API feed. When a later page failed they may still be listed, so keep
    // them, but only for 2 minutes, so a repeatedly failing page can't keep closed lobbies joinable for good
    for (const [id, m] of activeMatches) {
        if (!currentMatchIds.has(id) && (complete || now - m.lastSeen > 2 * 60 * 1000)) activeMatches.delete(id);
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
            const civFrom = lp?.civ ? lp : sp?.civ ? sp : null;
            const civ = civFrom ? civFrom.civ : null;
            return {
                id: p.id, name, team: p.team, elo: cached ? cached.rating : null,
                totalGames: cached?.totalGames || 0, totalWins: cached?.totalWins || 0, winRate: cached?.winRate ? String(cached.winRate).replace(/%?$/, '%') : "0.0%",
                steamProfile, civ, civRor: !!(civFrom && civFrom.civRor), statsPending: isProfileId(p.id) && !cached
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

    // Spectate routes match the whole path (the query string is dropped): "/api/spectate", "/api/spectate/index",
    // "/api/spectate/<id>", "/api/spectate/player/<profileId>", and the pages "/spectate/<id>", "/overlay/<id>" and
    // "/overlay/player/<profileId>" with an optional trailing slash. Anything else under them is a 404, never a static file.
    // "/replay" is the replay viewer's page.
    const pathname = req.url.split('?')[0];
    if (pathname === '/api/spectate') {
        await serveSpectateList(res);
        return;
    }
    if (pathname === '/api/spectate/index') {
        await serveSpectateList(res, 'index');
        return;
    }
    if (pathname.startsWith('/api/spectate/player/')) {
        const id = pathname.slice('/api/spectate/player/'.length);
        if (!/^\d{1,12}$/.test(id) || !isProfileId(Number(id))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a profile id' }));
            return;
        }
        await serveSpectateMatch(res, Number(id), true);
        return;
    }
    if (pathname.startsWith('/overlay/')) {
        const rest = pathname.slice('/overlay/'.length).replace(/\/$/, '');
        const player = /^player\/(\d{1,12})$/.exec(rest);
        if (!(player ? isProfileId(Number(player[1])) : isMatchId(rest))) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        await serveHtmlPage(res, 'overlay.html', true);
        return;
    }
    if (pathname === '/replay' || pathname === '/replay/') {
        await serveHtmlPage(res, 'replay.html', false);
        return;
    }
    if (pathname.startsWith('/api/spectate/')) {
        const id = pathname.slice('/api/spectate/'.length);
        if (!isMatchId(id)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a match id' }));
            return;
        }
        await serveSpectateMatch(res, Number(id));
        return;
    }
    if (pathname.startsWith('/spectate/')) {
        const id = pathname.slice('/spectate/'.length).replace(/\/$/, '');
        if (!isMatchId(id)) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        await serveSpectatePage(res, Number(id));
        return;
    }

    if (req.url.startsWith('/api/lobbies')) {
        // Serve the cached body; past LOBBIES_CACHE_MS refresh it. Wait for the build when there is no body or it is
        // more than two cache periods old (a lone poller would otherwise always get the previous build); with
        // steady traffic the body is fresh enough that requests don't wait. A failed build keeps the old body.
        const age = Date.now() - lobbiesCache.at;
        if (!lobbiesCache.body || age >= LOBBIES_CACHE_MS) {
            const pending = refreshLobbies();
            if (pending && (!lobbiesCache.body || age > 2 * LOBBIES_CACHE_MS)) await pending;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(lobbiesCache.body || '{"matches":[]}');
        return;
    }

    // Serve static files (the query string is dropped first, so "/?fbclid=..." is the home page)
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
