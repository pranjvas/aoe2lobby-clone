const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ReplayParse = require('./replay-parse.js');

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
    '/robots.txt', // the sitemap is built by serveSitemap
    '/fonts/cinzel-variable.woff2', '/fonts/outfit-variable.woff2', '/fonts/cinzel-ext.woff2', '/fonts/outfit-ext.woff2', '/fonts/OFL.txt', // self-hosted fonts
    '/7e7c007e5148f7d5a2953120e8410d70.txt' // IndexNow key (lets Bing/Yandex accept our URL submissions)
]);
const FILE_ALIASES = { '/favicon.ico': '/favicon-32.png' };
const RELIC_API = 'https://aoe-api.worldsedgelink.com/community'; // aoe-api.reliclink.com is a CNAME of this host
// The lobby list, built again whenever Relic's list or aoe2lobby.com's data changes while anyone is watching (see "Live
// lobby list"), and shared by every visitor
let lobbiesCache = { at: 0, body: null };
let lobbiesFailUntil = 0, lobbiesFailures = 0;
// The page version index.html loads (its app.js?v=). The stream's whole list and /api/lobbies name it, and a page that
// was opened before a deploy reloads itself when it differs from its own.
let pageVersion = '';
try { pageVersion = (/\/app\.js\?v=(\d+)/.exec(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')) || [])[1] || ''; } catch (e) { }
let lobbyPlayers = { at: 0, ids: new Map() }; // who was in a lobby at the last build, and its map (the Maps view's "Active now" sort)
// Whether the lobby list is current: Relic's list read in the last RELIC_STALE_MS. The stream and /api/lobbies say so (feed),
// and the page shows a notice while it isn't. (Until 28 Nov 2026 this was aoe2lobby.com's feed, which has blocked us.)
function lobbyFeedOk() {
    return Date.now() - relicOkAt < RELIC_STALE_MS;
}
const profileCache = new Map(); // profile_id -> { alias, rating, totalGames, totalWins, winRate, stats, steamProfile, fetchedAt, lastSeen }
const PROFILE_REFRESH_MS = 6 * 60 * 60 * 1000; // cached profiles this old are refetched, in the background only
const PROFILE_FORGET_MS = 24 * 60 * 60 * 1000; // profiles not seen in any lobby for this long are dropped
const pendingProfileIds = new Set(); // profile ids with a GetPersonalStat request in flight
// Profile ids whose GetPersonalStat request failed (Relic down or slow): not asked again for PROFILE_RETRY_MS, as the
// list is rebuilt every few seconds while anyone is watching
const profileFailedAt = new Map();
const PROFILE_RETRY_MS = 15000;
// A joining player's stats show a spinner until Relic and aoe2companion have answered for them (see markPendingStats),
// and never longer than this into their stay in lobbies
const RATINGS_WAIT_MS = 20000;
// For players aoe2lobby.com doesn't list yet, the stay is timed by our own builds, which run only while someone is
// watching (every few seconds then): a player unseen for STAY_GAP_MS starts a new stay
const STAY_GAP_MS = 30000;
const PLAYER_SEEN_FORGET_MS = 10 * 60 * 1000;
const playerSeen = new Map(); // profile id -> { first, last }: our builds' view of the player's current stay
const lastRatings = new Map(); // profile id -> the last ratings aoe2lobby.com sent, kept while playerSeen has the player
const activeMatches = new Map(); // Keep track of matches to simulate "Playing" state
let relicReadOnce = false; // a lobby first seen in a later read was created about then (see firstSeen)

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
    const start = Date.now();
    if (profileFailedAt.size > 1000) {
        for (const [id, at] of profileFailedAt) if (start - at >= PROFILE_RETRY_MS) profileFailedAt.delete(id);
    }
    ids = ids.filter(id => isProfileId(id) && !pendingProfileIds.has(id) && !(start - (profileFailedAt.get(id) ?? -Infinity) < PROFILE_RETRY_MS));
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
                            // country: the profile's (aoe2insights shows this one; aoe2lobby.com's feed can differ)
                            profileCache.set(profileId, { alias, rating: currentRating, totalGames, totalWins, winRate, stats: ladderStats, steamProfile, country: countryCode(member.country), fetchedAt: now, lastSeen: now });
                        }
                    });
                    // Ids Relic answered for but returned nothing about: cache an empty entry so they stop showing as
                    // pending and aren't re-requested on every build (the 6 h refresh retries them)
                    const now = Date.now();
                    for (const id of chunk) {
                        profileFailedAt.delete(id);
                        if (!profileCache.has(id)) {
                            profileCache.set(id, { alias: 'Unknown', rating: null, totalGames: 0, totalWins: 0, winRate: "0.0", stats: {}, steamProfile: null, fetchedAt: now, lastSeen: now });
                        }
                    }
                }
            } catch(e) {
                console.error("Error fetching profile batch:", e.message);
                const failedAt = Date.now();
                for (const id of chunk) profileFailedAt.set(id, failedAt);
            }
        }
    } finally {
        ids.forEach(id => pendingProfileIds.delete(id));
    }
}

// A Relic lobby's slots (slotinfo: base64 of zlib of text holding a JSON array, one entry per slot). players: the human
// players, with their team code and civ code from the slot's metaData. total: the slots a player can take (status 0, open or
// taken; 1 is closed, 2 an AI), which is aoe2lobby.com's slots_total; ai: the AI slots. 8 of 8 lobbies agreed on 27 Nov 2026.
function parseSlotInfo(slotinfoBase64) {
    const none = { players: [], total: null, ai: null };
    try {
        const buffer = Buffer.from(slotinfoBase64, 'base64');
        const decompressed = zlib.inflateSync(buffer, { maxOutputLength: 256 * 1024 }).toString('utf-8');
        const bracketIndex = decompressed.indexOf('[');
        const lastBracketIndex = decompressed.lastIndexOf(']');
        if (bracketIndex === -1 || lastBracketIndex === -1) return none;
        const arr = JSON.parse(decompressed.substring(bracketIndex, lastBracketIndex + 1));
        if (!Array.isArray(arr)) return none;
        const slots = arr.filter(p => p && typeof p === 'object');
        const metas = slots.map(p => slotMeta(p.metaData));
        const teamCode = meta => /^\d$/.test(meta.Team || '') ? Number(meta.Team) : null;
        // slot: the player's place in the list, which is the order the game's own lobby shows its slots in
        const players = slots.map((p, slot) => ({ p, slot })).filter(({ p }) => p['profileInfo.id'] !== -1).map(({ p, slot }) => {
            const meta = metas[slot];
            return {
                id: p['profileInfo.id'],
                slot,
                teamCode: teamCode(meta),
                civCode: /^\d{1,9}$/.test(meta['1'] || '') ? meta['1'] : null
            };
        });
        return { players, total: slots.filter(p => p.status === 0).length, ai: slots.filter(p => p.status === 2).length, launch: launchSlots(slots, metas, teamCode) };
    } catch (e) { }
    return none;
}

// A lobby that is launching. When a game launches, the lobby's slots get its final picks a second or two before the
// lobby leaves the list (seen on 28 Nov 2026): every taken slot loses its civ pick (metaData "1") and gets its colour
// (metaData "0", 0-7, from 4294967295 for "any"), its civ in Relic's numbering (raceID, which is 0 in a lobby: see
// relicRaces), and its final team (a random "?" team becomes a real one). A lobby that just closes leaves without any of
// that. Returns the taken slots in lobby order, { kind, id, slot, teamCode, color (1-8), raceId }, or null while the lobby
// isn't launching. Needs a human: an AI-only lobby can't launch.
function launchSlots(slots, metas, teamCode) {
    const taken = [];
    slots.forEach((p, slot) => {
        const human = p.status === 0 && isProfileId(p['profileInfo.id']);
        if (human || p.status === 2) taken.push({ p, meta: metas[slot], slot, human });
    });
    if (!taken.some(t => t.human)) return null;
    if (!taken.every(t => !('1' in t.meta) && /^[0-7]$/.test(t.meta['0'] || ''))) return null;
    return taken.map(t => ({
        kind: t.human ? 'human' : 'ai',
        id: t.human ? t.p['profileInfo.id'] : 0,
        slot: t.slot,
        teamCode: teamCode(t.meta),
        color: Number(t.meta['0']) + 1,
        raceId: Number.isInteger(t.p.raceID) ? t.p.raceID : null
    }));
}

// A Relic slot's metaData: base64 of a JSON string holding base64 of [pair count] then [uint32 LE length][text] for each
// key and value, as a null-prototype object. "Team" is the team the lobby shows, in the codes aoe2lobby.com's slots use (see
// displayTeam): 223 of 229 players agreed with aoe2lobby.com on 25 Nov 2026, the rest having just switched (the slot's
// teamID is 0 for nearly everyone). "1" is the civ in the game's numbering (see RELIC_CODE_FIELDS).
function slotMeta(metaData) {
    const out = Object.create(null);
    if (typeof metaData !== 'string' || !metaData || metaData.length > 4096) return out;
    try {
        const inner = JSON.parse(Buffer.from(metaData, 'base64').toString('utf8'));
        if (typeof inner !== 'string') return out;
        const buf = Buffer.from(inner, 'base64');
        let i = 1;
        const text = () => {
            if (i + 4 > buf.length) return null;
            const len = buf.readUInt32LE(i);
            i += 4;
            if (i + len > buf.length) return null;
            const s = buf.subarray(i, i + len).toString('utf8');
            i += len;
            return s;
        };
        for (let n = 0; n < buf[0] && n < 32; n++) {
            const key = text(), value = text();
            if (key === null || value === null) break;
            if (key.length <= 40 && value.length <= 40) out[key] = value;
        }
    } catch (e) { }
    return out;
}

// A lobby player's team from a team code: Teams 1-4 (displayTeam), or none; randomTeam for "?" (0 or 6: the game picks)
function lobbyTeam(code) {
    return { team: displayTeam(code), randomTeam: code === 0 || code === 6 };
}

// --- Spectate: games in progress, from the game's public lobby list ---------------------------------------------------
// Only the game's signed-in API lists games in progress (the in-game Spectate list, which aoe2lobby.com and aoe2companion
// read with a game account); the public API has lobbies and finished games only, and its match history lists a game only
// once it has ended (none of 77 lobbies that closed within 4 minutes was in it while running, 28 Nov 2026). So a game is
// known here from its lobby: pollRelic reads the lobby list every 0.5-1 s, whether or not anyone is watching, and a
// lobby that launches (launchSlots) becomes a game in progress with its final civs, teams and colours. Matchmaking games
// (ranked, Quick Play) have no lobby in the list; until there is a way of our own, they come from aoe2companion (see
// "ranked and Quick Play games"). Only lobbies that allow spectators are kept: the Spectate list is games you can watch.
// A game stays live until the public match history has it (checkLiveEnds), or every player in it has moved on to a newer
// lobby or game (noteMovedOn), or it has run for LIVE_MAX_MS; then it is an ended game (see endedGames).
const LIVE_GAMES_PATH = path.join(__dirname, 'live_games.json');
const LIVE_MAX_MS = 5 * 60 * 60 * 1000;
const LAUNCH_UNDO_MS = 60000; // a launched lobby listed again this soon without its picks: the launch was called off
// Relic's list older than this (its reads keep failing): the list is reported stale, with no games
const SPECTATE_STALE_MS = 2 * 60 * 1000;
// games: match id -> game (the detail shape, with country and per-ladder stats), as of the last build
let spectateCache = { at: 0, snapAt: 0, body: null, index: null, games: new Map() };
let spectateDirty = true;
const liveGames = new Map(); // match id -> game, oldest first

// The schema labels civs up to its own table; newer civs arrive as their raw id negated (like negative mapids).
// The schema's 15 is singular, and three Return of Rome civs (58, 62, 66) carry internal names, not display names
const CIV_LABEL_FIXES = Object.assign(Object.create(null), { Aztec: 'Aztecs', OldPersians: 'Persians', OldRomans: 'Romans', LacViet: 'Lac Viet' });
// Those two then share a name with a DE civ, whose details (civ-info.json) don't apply: players get civRor: true
const ROR_SHARED_LABELS = new Set(['OldPersians', 'OldRomans']);

// A civ label from the lobby labels scraper.js wrote, as the site shows it
function civLabel(label) {
    return (label && CIV_LABEL_FIXES[label]) || label;
}

// Relic's civ numbers (a launching slot's raceID, match history's civilization_id), named as Relic's public
// getAvailableLeaderboards names them ("races", 28 Nov 2026), with the site's name where it differs. Civs added later are
// picked up from there (refreshRelicRaces, at start and once a day). Two launches checked by hand: players who picked
// Persians and Bohemians got 32 and 4.
const RELIC_RACE_FIXES = Object.assign(Object.create(null), { Indians: 'Hindustanis' });
const relicRaces = Object.assign(Object.create(null), {
    0: 'Armenians', 1: 'Aztecs', 2: 'Bengalis', 3: 'Berbers', 4: 'Bohemians', 5: 'Britons', 6: 'Bulgarians', 7: 'Burgundians',
    8: 'Burmese', 9: 'Byzantines', 10: 'Celts', 11: 'Chinese', 12: 'Cumans', 13: 'Dravidians', 14: 'Ethiopians', 15: 'Franks',
    16: 'Georgians', 17: 'Goths', 18: 'Gurjaras', 19: 'Huns', 20: 'Incas', 21: 'Hindustanis', 22: 'Italians', 23: 'Japanese',
    24: 'Khmer', 25: 'Koreans', 26: 'Lithuanians', 27: 'Magyars', 28: 'Malay', 29: 'Malians', 30: 'Mayans', 31: 'Mongols',
    32: 'Persians', 33: 'Poles', 34: 'Portuguese', 35: 'Romans', 36: 'Saracens', 37: 'Sicilians', 38: 'Slavs', 39: 'Spanish',
    40: 'Tatars', 41: 'Teutons', 42: 'Turks', 43: 'Vietnamese', 44: 'Vikings', 45: 'Achaemenids', 46: 'Athenians',
    47: 'Spartans', 48: 'Shu', 49: 'Wu', 50: 'Wei', 51: 'Jurchens', 52: 'Khitans', 55: 'Macedonians', 56: 'Thracians',
    57: 'Puru', 58: 'Muisca', 59: 'Mapuche', 60: 'Tupi', 61: 'Saxons', 62: 'Varangians', 63: 'Danes'
});
const RACES_REFRESH_MS = 24 * 60 * 60 * 1000;

function relicRaceName(id) {
    if (!Number.isInteger(id) || id < 0) return null;
    return own(relicRaces, String(id)) || 'Unknown civ';
}

async function refreshRelicRaces() {
    try {
        const data = JSON.parse(await httpsGet(`${RELIC_API}/leaderboard/getAvailableLeaderboards?title=age2`));
        let added = 0;
        for (const r of Array.isArray(data?.races) ? data.races : []) {
            const id = num(own(r, 'id')), name = str(own(r, 'name'));
            if (!Number.isInteger(id) || id < 0 || id > 10000 || !name || name.length > 40 || own(relicRaces, String(id))) continue;
            relicRaces[id] = RELIC_RACE_FIXES[name] || name;
            added++;
        }
        if (added) console.log(`Spectate: ${added} new civ name(s) from Relic's list`);
    } catch (e) {
        console.error('Reading Relic civ names failed:', e.message);
    }
}

// Lobby team codes 2-5 are Teams 1-4; 1 is "no team" (free-for-all) and 0 or 6 a team the game picks (none at launch)
function displayTeam(team) {
    const t = num(team);
    return (Number.isInteger(t) && t >= 2 && t <= 5) ? t - 1 : null;
}

// ISO-2 codes arrive in mixed case; a few are null or missing
function countryCode(country) {
    const c = typeof country === 'string' ? country.toLowerCase() : '';
    return /^[a-z]{2}$/.test(c) ? c : null;
}

// Map names learned earlier for maps that arrived as a bare id (e.g. "10979"), kept in map_names.json
const MAP_NAMES_PATH = path.join(__dirname, 'map_names.json');
let mapNames = Object.create(null);
try {
    const saved = JSON.parse(fs.readFileSync(MAP_NAMES_PATH, 'utf8'));
    if (saved && typeof saved === 'object') Object.assign(mapNames, saved);
} catch (e) { if (e.code !== 'ENOENT') console.error('Error reading map_names.json:', e.message); }

function mapDisplayName(mapName) {
    if (typeof mapName === 'number' && Number.isFinite(mapName)) mapName = String(mapName);
    if (typeof mapName !== 'string') return 'Unknown Map';
    if (!/^\d+$/.test(mapName)) return mapName || 'Unknown Map';
    const name = own(mapNames, mapName);
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

// A game in progress from a launching lobby: the lobby as buildLobbies built it (names, map, settings, ratings) and the
// final picks of its slots (m.launch). Every civ is shown, also in a game whose lobby hid them (option 85): the owner's
// choice (28 Nov 2026); the lobby list still hides picks while players choose. Players keep their lobby order. Ratings
// are the lobby's (every ladder known for each player); `rating` is the game's own ladder, as on the lobby list's Auto.
// The spectator count isn't known (null); the delay is the lobby's, in minutes.
function gameFromLaunch(lobby, m, now) {
    const opts = m.relicOptions || {};
    const civsHidden = false;
    const lobbyPlayers = new Map(lobby.players.map(p => [p.id, p]));
    const players = m.launch.map(s => {
        const team = displayTeam(s.teamCode);
        const civ = relicRaceName(s.raceId);
        if (s.kind === 'ai') return { id: 0, name: 'AI', kind: 'ai', team, color: s.color, civ, rating: null, ratings: {} };
        const lp = lobbyPlayers.get(s.id), cached = profileCache.get(s.id);
        const ratings = {}, stats = {};
        for (const [ladder, st] of Object.entries(lp?.allStats || lobbyPlayerStats(s.id, null) || {})) {
            if (!st || !Number.isFinite(st.rating)) continue;
            ratings[ladder] = st.rating;
            stats[ladder] = { games: num(st.games), wins: num(st.wins), winp: num(st.winp), streak: num(st.streak), highest: num(st.highest) };
        }
        const player = {
            id: s.id, name: lp?.name || (cached && cached.alias !== 'Unknown' ? cached.alias : `Player ${s.id}`), kind: 'human',
            team, color: s.color, civ, country: cached?.country || null, rating: null, ratings, stats
        };
        const steamProfile = lp?.steamProfile || cached?.steamProfile;
        if (steamProfile) player.steamProfile = steamProfile;
        return player;
    });
    const ladder = ladderFor(lobby.matchType, lobby.map, players.length === 2 ? 2 : 8);
    for (const p of players) if (p.kind === 'human') p.rating = p.ratings[ladder] ?? null;
    const delayS = num(m.observerdelay, 0);
    return {
        id: lobby.id,
        title: lobby.title || 'Age of Empires II Game',
        isRanked: false,
        isQuickPlay: false,
        map: lobby.map,
        matchType: lobby.matchType ?? null,
        mapSize: lobby.mapSize ?? null,
        speed: lobby.speed ?? null,
        population: num(lobby.population) || null,
        server: lobby.server || null,
        modInfo: lobby.modInfo || 'No Mods',
        startTime: Math.floor((m.launchedAt || now) / 1000),
        observerDelay: Math.max(0, Math.round(delayS / 60)),
        observers: null,
        ladder,
        civsHidden,
        record: null,
        endedAt: null,
        source: 'lobby',
        players
    };
}

// A game starts when a lobby leaves the list while launching, having launched at most LAUNCH_MAX_MS before. Measured at
// the site's read rate on 28 Nov 2026: 23 of 29 launches left within 1.3 s of their first launching reading, the rest
// within 3 s, and every one that allowed spectators within 3 s. A few lobbies (none allowing spectators) showed the same
// picks for 20 s to minutes, some then going back to normal: not taken.
const LAUNCH_MAX_MS = 15000;
const launchLobbies = new Map(); // lobby id -> the lobby as last built, while it is launching

// Called with each lobby list built: keeps the launching lobbies as built (names, map, settings, ratings) for when they
// leave the list, and ends the games whose players have moved on
function noteLaunching(lobbies, now) {
    const launching = new Set();
    for (const lobby of lobbies) {
        const m = typeof lobby.id === 'number' ? activeMatches.get(lobby.id) : undefined;
        if (m?.launch) {
            launchLobbies.set(lobby.id, lobby);
            launching.add(lobby.id);
        }
    }
    // Still listed but launching no more (a lobby that left is handled by noteLobbyGone)
    for (const id of launchLobbies.keys()) if (!launching.has(id) && activeMatches.has(id)) launchLobbies.delete(id);
    noteMovedOn(lobbies, now);
}

// Called by pollRelic for each lobby that left the list (m as last read): one that left while launching is a game in
// progress, kept when it allows spectators
function noteLobbyGone(m, now) {
    const lobby = launchLobbies.get(m.id);
    launchLobbies.delete(m.id);
    if (!lobby || !m.launch || !m.launchedAt || m.lastSeen - m.launchedAt > LAUNCH_MAX_MS) return;
    if (m.isobservable !== 1 || liveGames.has(m.id) || endedGames.has(m.id)) return;
    liveGames.set(m.id, gameFromLaunch(lobby, m, now));
    spectateDirty = true;
    saveLiveGamesSoon();
}

// Called by pollRelic for each lobby listed: one listed again soon after it "started" never did (a game that starts
// never comes back to the list)
function noteLobbyListed(id, now) {
    const g = liveGames.get(id);
    if (!g || now - g.startTime * 1000 > LAUNCH_UNDO_MS) return;
    liveGames.delete(id);
    liveChecks.delete(id);
    spectateDirty = true;
    saveLiveGamesSoon();
}

// A player in a lobby this server first saw after a game started, or in a game started after it, has left that game. A
// game whose players have all left is over; so is one past LIVE_MAX_MS. Its result is looked up when its page asks.
function noteMovedOn(lobbies, now) {
    if (!liveGames.size) return;
    const since = new Map(); // profile id -> the newest start (ms) of a lobby or game they are in
    const note = (id, t) => { if (isProfileId(id) && t > (since.get(id) ?? 0)) since.set(id, t); };
    for (const lobby of lobbies) {
        const first = activeMatches.get(lobby.id)?.firstSeen;
        if (first) for (const p of lobby.players) note(p.id, first);
    }
    for (const games of [liveGames, companionGames]) {
        for (const g of games.values()) for (const p of g.players) if (p.kind === 'human') note(p.id, g.startTime * 1000);
    }
    for (const [id, g] of liveGames) {
        const start = g.startTime * 1000;
        const humans = g.players.filter(p => p.kind === 'human');
        if (now - start > LIVE_MAX_MS || (humans.length && humans.every(p => (since.get(p.id) ?? 0) > start))) {
            endLiveGame(id, Math.floor(now / 1000));
        }
    }
}

// A live game becomes an ended one. `found`: its match history entry's start and the result read from it, when that is
// how its end was found.
function endLiveGame(id, endedAt, found = null) {
    const g = liveGames.get(id);
    if (!g) return;
    liveGames.delete(id);
    liveChecks.delete(id);
    const game = { ...g, endedAt, ...(found?.startTime ? { startTime: found.startTime } : {}) };
    endedGames.set(id, { game, result: found?.result || null, lookup: null, firstTryAt: 0, lastTryAt: 0, tries: 0 });
    pruneEndedGames();
    spectateDirty = true;
    saveLiveGamesSoon();
}

// --- Spectate: ends from the public match history -----------------------------------------------------------------------
// From LIVE_CHECK_FIRST_MS after its start, every LIVE_CHECK_EVERY_MS, each live game's history is read for one of its
// players (a different one each time): a game there has ended, with its result. One request every LIVE_CHECK_GAP_MS for up
// to LIVE_CHECK_BATCH games (one player each), so ~100 live games are each checked about every 3 minutes.
const LIVE_CHECK_FIRST_MS = 3 * 60 * 1000;
const LIVE_CHECK_EVERY_MS = 3 * 60 * 1000;
const LIVE_CHECK_GAP_MS = 10000;
const LIVE_CHECK_BATCH = 4;
const liveChecks = new Map(); // match id -> { at, tries }
let liveCheckBusy = false;

async function checkLiveEnds() {
    if (liveCheckBusy || !liveGames.size) return;
    const now = Date.now();
    const due = [...liveGames.values()]
        .filter(g => now - g.startTime * 1000 >= LIVE_CHECK_FIRST_MS && now - (liveChecks.get(g.id)?.at ?? 0) >= LIVE_CHECK_EVERY_MS)
        .sort((a, b) => (liveChecks.get(a.id)?.at ?? 0) - (liveChecks.get(b.id)?.at ?? 0))
        .slice(0, LIVE_CHECK_BATCH);
    if (!due.length) return;
    const asked = new Set();
    for (const g of due) {
        const humans = g.players.filter(p => p.kind === 'human');
        const check = liveChecks.get(g.id) || { at: 0, tries: 0 };
        check.at = now;
        const pid = humans.length ? humans[check.tries++ % humans.length].id : null;
        liveChecks.set(g.id, check);
        if (pid) asked.add(pid);
    }
    if (!asked.size) return;
    liveCheckBusy = true;
    try {
        const text = await httpsGet(`${RELIC_API}/leaderboard/getRecentMatchHistory?title=age2&profile_ids=[${[...asked].join(',')}]`,
            { 'User-Agent': 'aoe2lobby.online (spectate)' });
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('invalid JSON'); }
        const history = Array.isArray(own(data, 'matchHistoryStats')) ? data.matchHistoryStats : [];
        for (const g of due) {
            const entry = history.find(e => num(own(e, 'id')) === g.id);
            const completedAt = num(own(entry, 'completiontime'));
            if (!entry || !Number.isSafeInteger(completedAt) || completedAt <= 0) continue;
            const startTime = num(own(entry, 'startgametime'));
            const result = parseMatchResult(data, { ...g, startTime: Number.isSafeInteger(startTime) ? startTime : g.startTime });
            endLiveGame(g.id, completedAt, { startTime: Number.isSafeInteger(startTime) ? startTime : null, result });
        }
    } catch (e) {
        console.error('Spectate end check failed:', e.message);
    } finally {
        liveCheckBusy = false;
    }
}
setInterval(() => { checkLiveEnds(); }, LIVE_CHECK_GAP_MS).unref();

// --- Spectate: ranked and Quick Play games, from aoe2companion (a stopgap) --------------------------------------------
// Matchmaking games never have a public lobby, so the lobby list can't show them. Until there is a way of our own, they
// come from aoe2companion's public list of games in progress, the socket its own app uses: the whole list when it opens,
// then each game as it is added or removed. Only its matchmaking games (named AUTOMATCH) are taken; lobby games are ours.
// One socket, reopened after A2C_RETRY_MIN_MS doubling to A2C_RETRY_MAX_MS while it fails, and closed and reopened when
// it has said nothing for A2C_SILENT_MS (several games start every minute, so silence means a dead socket).
const A2C_SOCKET = 'wss://socket.aoe2companion.com/listen?handler=ongoing-matches';
const A2C_RETRY_MIN_MS = 5000;
const A2C_RETRY_MAX_MS = 5 * 60 * 1000;
const A2C_SILENT_MS = 5 * 60 * 1000;
const A2C_STALE_MS = 10 * 60 * 1000; // its socket down this long: its games are left out of the list (not ended)
const A2C_FULL_MIN = 50; // a whole list with fewer matchmaking games is a glitch: it ends nothing
// Its leaderboards as the site's ladders (the console queues as the PC ladders, as before); Quick Play has none
const A2C_LADDERS = Object.assign(Object.create(null), {
    rm_1v1: '3', rm_1v1_console: '3', rm_team: '4', rm_team_console: '4', ew_1v1: '13', ew_1v1_console: '13',
    ew_team: '14', ew_team_console: '14', dm_1v1: '1', dm_team: '2'
});
const A2C_CIV_FIXES = Object.assign(Object.create(null), { Maya: 'Mayans', Inca: 'Incas', Indians: 'Hindustanis' });
const companionGames = new Map(); // match id -> game
let a2cSocket = null, a2cLastAt = 0, a2cDownSince = Date.now(), a2cRetryMs = A2C_RETRY_MIN_MS, a2cLoggedDown = false;
let a2cOpenedAt = 0; // when the current socket was made

// aoe2companion writes "[speed.unknown]" and the like for a value it doesn't know
function a2cText(v) {
    const s = str(v);
    return s && !/^\[.*\]$/.test(s) ? s : null;
}

// One of its games in the detail shape, or null when it isn't a matchmaking game with a human in it. Every civ is shown,
// also in a game that hides them (the owner's choice, 28 Nov 2026). Ratings here are the game's own ladder, as its list
// gives them; buildSpectateCache adds every other ladder.
function companionGame(m) {
    if (!m || typeof m !== 'object' || m.name !== 'AUTOMATCH' || !Array.isArray(m.players)) return null;
    const id = num(m.matchId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const board = str(m.leaderboardId) || '';
    const isQuickPlay = board.startsWith('qp_');
    const ladder = isQuickPlay ? null : (A2C_LADDERS[board] ?? null);
    const civsHidden = false;
    const players = m.players.filter(p => p && typeof p === 'object').map(p => {
        const team = Number.isInteger(p.team) && p.team >= 1 && p.team <= 4 ? p.team : null;
        const color = Number.isInteger(p.color) && p.color >= 1 && p.color <= 8 ? p.color : null;
        const civName = a2cText(p.civName);
        const civ = civName ? (A2C_CIV_FIXES[civName] || civName) : 'Unknown civ';
        if (p.status === 'ai' || !isProfileId(p.profileId)) return { id: 0, name: 'AI', kind: 'ai', team, color, civ, rating: null, ratings: {} };
        const ratings = {}, stats = {};
        const rating = num(p.rating);
        if (ladder && Number.isFinite(rating)) {
            const games = num(p.games), wins = num(p.wins);
            ratings[ladder] = rating;
            stats[ladder] = { games, wins, winp: games ? Math.round(100 * (wins || 0) / games) : null, streak: null, highest: num(p.maxRating) };
        }
        const player = {
            id: p.profileId, name: str(p.name) || `Player ${p.profileId}`, kind: 'human', team, color, civ,
            country: countryCode(p.country), rating: ladder ? (ratings[ladder] ?? null) : null, ratings, stats
        };
        if (/^\d{17}$/.test(String(p.steamId ?? ''))) player.steamProfile = `https://steamcommunity.com/profiles/${p.steamId}`;
        return player;
    });
    if (!players.some(p => p.kind === 'human')) return null;
    const started = Date.parse(m.started);
    return {
        id,
        title: isQuickPlay ? 'Quick Play' : 'Ranked match',
        isRanked: !isQuickPlay,
        isQuickPlay,
        map: a2cText(m.mapName) || 'Unknown Map',
        matchType: a2cText(m.gameModeName),
        mapSize: a2cText(m.mapSizeName)?.replace(/\s*\[\d+\]$/, '') || null,
        speed: a2cText(m.speedName),
        population: num(m.population) || null,
        server: regionName(str(m.server)),
        modInfo: m.mod === true && a2cText(m.modDataset) ? a2cText(m.modDataset).replace(/^\d+-/, '') : 'No Mods',
        startTime: Number.isFinite(started) ? Math.floor(started / 1000) : 0,
        observerDelay: 2, // matchmaking games' spectator delay
        observers: null,
        ladder,
        civsHidden,
        record: m.recordGame !== false,
        endedAt: null,
        source: 'matchmaking',
        players
    };
}

function endCompanionGame(id, now) {
    const g = companionGames.get(id);
    if (!g) return;
    companionGames.delete(id);
    endedGames.set(id, { game: { ...g, endedAt: Math.floor(now / 1000) }, result: null, lookup: null, firstTryAt: 0, lastTryAt: 0, tries: 0 });
    pruneEndedGames();
    saveLiveGamesSoon();
}

// One socket message: an array of { type, data } events. The first message on a socket is the whole list: games kept
// from before that aren't in it have ended.
function applyCompanionMessage(text, whole) {
    let events;
    try { events = JSON.parse(text); } catch (e) { return; }
    if (!Array.isArray(events)) events = [events];
    const now = Date.now();
    const listed = whole ? new Set() : null;
    for (const ev of events) {
        const type = ev?.type, data = ev?.data;
        if (type === 'matchAdded' || type === 'matchUpdated' || type === 'matchChanged') {
            const g = companionGame(data);
            if (!g) continue;
            listed?.add(g.id);
            endedGames.delete(g.id); // listed again: live again
            companionGames.set(g.id, g);
        } else if (type === 'matchRemoved' || type === 'matchFinished' || type === 'matchEnded') {
            const id = num(typeof data === 'object' && data ? data.matchId : data);
            if (Number.isSafeInteger(id)) endCompanionGame(id, now);
        }
    }
    if (listed && listed.size >= A2C_FULL_MIN) {
        for (const id of [...companionGames.keys()]) if (!listed.has(id)) endCompanionGame(id, now);
    }
    spectateDirty = true;
}

function connectCompanion() {
    let ws;
    try {
        ws = new WebSocket(A2C_SOCKET, { headers: { 'User-Agent': 'aoe2lobby.online (spectate)' } });
    } catch (e) {
        return companionClosed(null, e.message);
    }
    a2cSocket = ws;
    a2cOpenedAt = Date.now();
    let whole = true;
    ws.onmessage = (msg) => {
        if (a2cSocket !== ws || typeof msg.data !== 'string') return;
        a2cLastAt = Date.now();
        a2cDownSince = 0;
        a2cRetryMs = A2C_RETRY_MIN_MS;
        if (a2cLoggedDown) { console.log('aoe2companion live games: connected again'); a2cLoggedDown = false; }
        applyCompanionMessage(msg.data, whole);
        whole = false;
    };
    ws.onerror = (e) => companionClosed(ws, e?.message || 'socket error');
    ws.onclose = (e) => companionClosed(ws, `closed (code ${e?.code})`);
}

function companionClosed(ws, reason) {
    if (ws && a2cSocket !== ws) return; // already handled
    a2cSocket = null;
    if (ws) { ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch (e) { } }
    if (!a2cDownSince) a2cDownSince = Date.now();
    if (!a2cLoggedDown) { console.error(`aoe2companion live games: ${reason}; reconnecting`); a2cLoggedDown = true; }
    setTimeout(connectCompanion, a2cRetryMs).unref();
    a2cRetryMs = Math.min(A2C_RETRY_MAX_MS, a2cRetryMs * 2);
}

setInterval(() => {
    if (a2cSocket && Date.now() - Math.max(a2cLastAt, a2cOpenedAt) > A2C_SILENT_MS) companionClosed(a2cSocket, 'silent for 5 minutes');
}, 30000).unref();

function companionUsable() {
    return !a2cDownSince || Date.now() - a2cDownSince <= A2C_STALE_MS;
}

// --- Spectate: the list, and keeping it across restarts -----------------------------------------------------------------
// The games: ours (lobbies seen launching) and aoe2companion's matchmaking ones. Built at most every SPECTATE_BUILD_MS
// when something changed (aoe2companion's socket changes it every few seconds), and every SPECTATE_REBUILD_MS anyway, so
// updatedAt (the build's time) stays current. The list drops country and the per-ladder stats (it shows neither); the
// detail API serves the games kept in `games`, which have them. The index is the list cut down to what followed-player
// alerts need, so a browser can match its follows without sending them.
const SPECTATE_BUILD_MS = 2000;
const SPECTATE_REBUILD_MS = 30000;

// Every ladder for every player, as aoe2lobby.com had them: the ranked ladders (DM, RM and EW, 1v1 and team) from the
// game's public profile stats (fetchProfilesBatch, profileCache: rating, wins, losses, streak, highest, the numbers
// aoe2lobby.com showed), and Unranked, which the game's public API doesn't have, from the same lookup as the lobby list
// (unrankedCache). A ladder the game itself carries keeps its own numbers when they have as many games or more (newer).
// Players not known yet are looked up in the background, SPECTATE_ASK_MAX at a time every SPECTATE_ASK_MS, so the ~3,000
// players of a full list are known within a few minutes without a burst of requests; their games show the rest once in.
const SPECTATE_UNRANKED_REFRESH_MS = 60 * 60 * 1000; // a player in a game: their Unranked rating can't change meanwhile
const SPECTATE_ASK_MS = 10000;
const SPECTATE_ASK_MAX = 200;
let spectateAskedAt = 0;
function withEveryLadder(p, game, now, needRelic, needUnranked) {
    if (p.kind !== 'human' || !isProfileId(p.id)) return p;
    const cached = profileCache.get(p.id), unranked = unrankedCache.get(p.id);
    if (cached) cached.lastSeen = now; else if (!pendingProfileIds.has(p.id)) needRelic.add(p.id);
    if (cached && now - cached.fetchedAt > PROFILE_REFRESH_MS && !pendingProfileIds.has(p.id)) needRelic.add(p.id);
    if (unranked) unranked.lastSeen = now;
    if ((!unranked || now - unranked.fetchedAt > SPECTATE_UNRANKED_REFRESH_MS) && !unrankedWanted.has(p.id) &&
        !(now - (unrankedFailedAt.get(p.id) ?? -Infinity) < PROFILE_RETRY_MS)) needUnranked.add(p.id);
    const ratings = { ...(p.ratings || {}) }, stats = { ...(p.stats || {}) };
    const add = (ladder, s) => {
        if (!s || !Number.isFinite(s.rating)) return;
        if (Number.isFinite(ratings[ladder]) && (stats[ladder]?.games ?? -1) >= (num(s.games) ?? 0)) return;
        ratings[ladder] = s.rating;
        stats[ladder] = { games: num(s.games), wins: num(s.wins), winp: num(s.winp), streak: num(s.streak), highest: num(s.highest) };
    };
    for (const ladder of RELIC_LADDERS) add(ladder, cached?.stats?.[ladder]);
    add('0', unranked?.stats);
    const steam = !p.steamProfile && cached?.steamProfile ? { steamProfile: cached.steamProfile } : {};
    const country = !p.country && cached?.country ? { country: cached.country } : {};
    return { ...p, ...steam, ...country, ratings, stats, rating: game.ladder !== null ? (ratings[game.ladder] ?? null) : null };
}

// Looks up the players withEveryLadder found missing (at most SPECTATE_ASK_MAX of each kind every SPECTATE_ASK_MS); the
// list is built again when the answers are in
function askSpectateRatings(needRelic, needUnranked, now) {
    if (now - spectateAskedAt < SPECTATE_ASK_MS || (!needRelic.size && !needUnranked.size)) return;
    spectateAskedAt = now;
    const relic = [...needRelic].slice(0, SPECTATE_ASK_MAX);
    if (relic.length) fetchProfilesBatch(relic).then(() => { spectateDirty = true; }, e => console.error('Spectate ratings:', e.message));
    const unranked = [...needUnranked].slice(0, SPECTATE_ASK_MAX);
    if (unranked.length) askUnranked(unranked);
}

function buildSpectateCache(now) {
    const sourceGames = [...liveGames.values()];
    if (companionUsable()) for (const g of companionGames.values()) if (!liveGames.has(g.id)) sourceGames.push(g);
    const needRelic = new Set(), needUnranked = new Set();
    const games = sourceGames.map(g => ({ ...g, players: g.players.map(p => withEveryLadder(p, g, now, needRelic, needUnranked)) }));
    askSpectateRatings(needRelic, needUnranked, now);
    games.sort((a, b) => b.startTime - a.startTime);
    const updatedAt = Math.floor(now / 1000);
    const listGames = games.map(({ source, ...g }) => ({ ...g, players: g.players.map(({ country, stats, ...p }) => p) }));
    const indexGames = games.map(g => ({ id: g.id, startTime: g.startTime, map: g.map, players: g.players.filter(p => p.kind === 'human').map(p => p.id) }));
    spectateCache = {
        at: now,
        snapAt: now,
        body: JSON.stringify({ updatedAt, stale: false, games: listGames }),
        index: JSON.stringify({ updatedAt, stale: false, games: indexGames }),
        games: new Map(games.map(g => [g.id, g]))
    };
    spectateDirty = false;
}

// Usable while either source is: Relic's list read lately, or aoe2companion's socket up. Otherwise the list shows no
// games and no game counts as live.
function spectateFresh(cache) {
    return !!cache.body && (Date.now() - relicOkAt <= SPECTATE_STALE_MS || companionUsable());
}

// The games, rebuilt when they changed (at most every SPECTATE_BUILD_MS) or the build is SPECTATE_REBUILD_MS old. Async,
// as callers await it.
async function freshSpectate() {
    const now = Date.now();
    if (!spectateCache.body || (spectateDirty && now - spectateCache.at >= SPECTATE_BUILD_MS) || now - spectateCache.at >= SPECTATE_REBUILD_MS) {
        buildSpectateCache(now);
    }
    return spectateCache;
}

let liveSaveTimer = null;
function saveLiveGamesSoon() {
    if (liveSaveTimer) return;
    liveSaveTimer = setTimeout(saveLiveGames, 5000);
    liveSaveTimer.unref();
}
function saveLiveGames() {
    clearTimeout(liveSaveTimer);
    liveSaveTimer = null;
    const ended = [...endedGames.values()].map(e => ({ game: e.game, result: e.result && e.result.state === 'found' ? e.result : null }));
    writeJsonAtomic(LIVE_GAMES_PATH, { savedAt: Date.now(), live: [...liveGames.values()], ended });
}
// Called once at start, after endedGames exists
function loadLiveGames() {
    try {
        const data = JSON.parse(fs.readFileSync(LIVE_GAMES_PATH, 'utf8'));
        const now = Date.now();
        for (const g of Array.isArray(data?.live) ? data.live : []) {
            if (g && Number.isSafeInteger(g.id) && Array.isArray(g.players) && now - g.startTime * 1000 < LIVE_MAX_MS) liveGames.set(g.id, g);
        }
        for (const e of Array.isArray(data?.ended) ? data.ended : []) {
            if (e?.game && Number.isSafeInteger(e.game.id) && !liveGames.has(e.game.id)) {
                endedGames.set(e.game.id, { game: e.game, result: e.result || null, lookup: null, firstTryAt: 0, lastTryAt: 0, tries: 0 });
            }
        }
        pruneEndedGames();
        console.log(`Spectate: ${liveGames.size} live and ${endedGames.size} ended games from ${path.basename(LIVE_GAMES_PATH)}`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`Reading ${path.basename(LIVE_GAMES_PATH)} failed:`, e.message);
    }
}

// --- Spectate: ended games, and their results from World's Edge's match history --------------------------------------
// A game that has ended (endLiveGame) keeps its page, which then shows the winner, rating changes and replay link.
const ENDED_KEEP_MS = 2 * 60 * 60 * 1000;
const ENDED_MAX = 5000;
const RESULT_GIVE_UP_S = 15 * 60; // after the first lookup (normally right after the game ended)
const RESULT_FAST_S = 3 * 60; // retries are >= 20 s apart for this long after the game ended, then >= 60 s
const RESULT_WAIT_MS = 3000; // the longest a detail request waits for a lookup in flight
const endedGames = new Map(); // match id -> { game (with endedAt), result, lookup, firstTryAt, lastTryAt, tries }, oldest first
// World's Edge serves the lobby list too: lookups run one at a time, >= 1 s apart, at most 30 a minute
let resultLookupBusy = false;
const resultLookupStarts = []; // start times (ms) within the last minute

// Map order is insertion order, which is roughly endedAt order: drop expired entries, then the oldest past the cap
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

// Who is playing now, for the Maps view: profile id -> the live game they started last (the same rule as
// spectateGameByPlayer, so a team game they have left and since finished another doesn't count). Every game in the list
// allows spectators: only lobbies that allow them are kept (noteLobbyGone). Built once per list.
function playingIndex(cache) {
    if (!spectateFresh(cache)) return new Map();
    if (cache.playing && cache.playing.games === cache.games) return cache.playing.index;
    const index = new Map();
    for (const g of cache.games.values()) {
        for (const p of g.players) {
            if (p.kind !== 'human' || !isProfileId(p.id)) continue;
            const had = index.get(p.id);
            if (!had || g.startTime > had.startTime) index.set(p.id, g);
        }
    }
    const keptSince = Math.floor((Date.now() - ENDED_KEEP_MS) / 1000);
    for (const e of endedGames.values()) {
        if (e.game.endedAt < keptSince) continue;
        for (const p of e.game.players) {
            const live = p.kind === 'human' ? index.get(p.id) : undefined;
            if (live && e.game.startTime > live.startTime) index.delete(p.id);
        }
    }
    cache.playing = { games: cache.games, index };
    return index;
}

function emptyResult(state) {
    return { state, completedAt: null, duration: null, winningTeam: null, noWinner: null, aiWon: null, ratingKind: null, players: null, replay: null };
}

// The result of `game` from one getRecentMatchHistory response, or null while the game isn't in it. The history is
// unsorted and holds older games, so the entry must match the id and, for aoe2lobby.com's feed's games (kept from before
// 28 Nov 2026), the start time. A game taken from its lobby (source 'lobby') has only the time it was seen launching, a
// few seconds before the real start, and matchmaking ones (source 'matchmaking') are matched the same way: the id alone
// (a match id is unique) and the entry's own start. Only ids, outcomes, ratings, times and replay sizes are read:
// matchurls[].url is a signed blob URL and is never touched.
function parseMatchResult(data, game) {
    const history = own(data, 'matchHistoryStats');
    if (!Array.isArray(history)) return null;
    const fromLobby = !!game.source;
    const entry = history.find(e => num(own(e, 'id')) === game.id && (fromLobby || num(own(e, 'startgametime')) === game.startTime));
    if (!entry) return null;
    if (fromLobby) {
        const start = num(own(entry, 'startgametime'));
        if (Number.isSafeInteger(start) && start > 0) game = { ...game, startTime: start };
    }
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
// A game's players with what their Relic profile says (GetPersonalStat, as fetchProfilesBatch keeps it; one not kept yet,
// or kept over PROFILE_REFRESH_MS, is fetched first, ~0.15 s): the country (aoe2lobby.com's feed had robincule in the US,
// his profile and aoe2insights in India), and the ladders the feed doesn't carry (DM 1v1 and DM Team, or any other it
// lacks). The feed's own ladders stay: its numbers are newer. A copy: the snapshot's games are shared.
const RELIC_LADDERS = ['1', '2', '3', '4', '13', '14'];
const MATCH_PROFILE_WAIT_MS = 2000;
async function withRelicProfiles(game) {
    if (!game) return game;
    const now = Date.now();
    const humans = game.players.filter(p => p.kind === 'human' && isProfileId(p.id)).map(p => p.id);
    const missing = humans.filter(pid => { const c = profileCache.get(pid); return !c || now - c.fetchedAt > PROFILE_REFRESH_MS; });
    if (missing.length) await settleWithin(fetchProfilesBatch(missing).catch(() => { }), MATCH_PROFILE_WAIT_MS);
    return {
        ...game,
        players: game.players.map(p => {
            const c = p.kind === 'human' ? profileCache.get(p.id) : null;
            if (!c) return p;
            c.lastSeen = now;
            const stats = { ...(p.stats || {}) }, ratings = { ...(p.ratings || {}) };
            for (const board of RELIC_LADDERS) {
                const s = c.stats && c.stats[board];
                if (Object.hasOwn(stats, board) || !s || !Number.isFinite(s.rating)) continue;
                ratings[board] = s.rating;
                stats[board] = { games: s.games ?? null, wins: s.wins ?? null, winp: s.winp ?? null, streak: s.streak ?? null, highest: s.highest ?? null };
            }
            const steam = !p.steamProfile && c.steamProfile ? { steamProfile: c.steamProfile } : {};
            return { ...p, ...steam, country: c.country || p.country || null, ratings, stats };
        })
    };
}

async function serveSpectateMatch(res, id, byPlayer = false) {
    const cache = await freshSpectate();
    const found = byPlayer ? spectateGameByPlayer(cache, id) : spectateGameById(cache, id);
    let result = null;
    if (found.ended) {
        startResultLookup(found.ended);
        if (found.ended.lookup) await settleWithin(found.ended.lookup, RESULT_WAIT_MS);
        result = found.ended.result || emptyResult('pending');
    }
    const game = await withRelicProfiles(found.game);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: found.status,
        updatedAt: cache.body ? Math.floor(cache.snapAt / 1000) : null,
        stale: !spectateFresh(cache),
        game,
        relay: relayOpen(found.game),
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

// --- Replays: /api/replay/<matchId> ------------------------------------------------------------------------
// The official replay ZIP of a finished game, for the viewer. It takes only a match id: the game must be one this server
// has seen end, or one a player search listed, and the link is built from what the public match history said about that
// game, so nobody can point it at anything else. The link redirects to the file, and that address is never logged or
// kept. Files stay in memory for a short while, so everyone opening a shared game costs one download.
const REPLAY_MAX_BYTES = 32 * 1024 * 1024;
const REPLAY_TIMEOUT_MS = 30000;
const REPLAY_FETCHES_PER_MINUTE = 30;
const REPLAY_KEEP_MS = 30 * 60 * 1000;
const REPLAY_KEEP_BYTES = 64 * 1024 * 1024;
const replayFiles = new Map(); // match id -> { body, at }, oldest first
const replayFetches = new Map(); // match id -> the download in progress
let replayWindow = { startedAt: 0, count: 0 };
const KNOWN_REPLAY_MS = 24 * 60 * 60 * 1000;
const KNOWN_REPLAY_MAX = 5000;
const knownReplays = new Map(); // match id -> { profileId, at }: the uploader of a game a search listed, oldest first

function rememberReplay(id, profileId) {
    knownReplays.delete(id);
    knownReplays.set(id, { profileId, at: Date.now() });
    if (knownReplays.size > KNOWN_REPLAY_MAX) knownReplays.delete(knownReplays.keys().next().value);
}

// --- A player's recent games: /api/player-games?q=<exact name or profile id> ---------------------------------
// The history is public, but names are exact and shared: one name can be ten accounts, so several are asked for at once.
const SEARCH_ACCOUNTS = 5;
const SEARCH_GAMES = 30;
const SEARCH_KEEP_MS = 60000;
const SEARCH_PER_MINUTE = 30;
const searches = new Map(); // query -> { body, at }
let searchWindow = { startedAt: 0, count: 0 };

function mapLabel(mapname) {
    const name = String(mapname || '').replace(/\.rms2?$/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return name || 'Unknown map';
}

// Only ids, names, outcomes and times are read, and of an upload only its size: matchurls[].url is never touched
function gamesFromHistory(data, accounts) {
    const names = new Map();
    for (const p of Array.isArray(own(data, 'profiles')) ? data.profiles : []) names.set(profileIdOf(own(p, 'profile_id')), str(own(p, 'alias')));
    const games = new Map();
    for (const entry of Array.isArray(own(data, 'matchHistoryStats')) ? data.matchHistoryStats : []) {
        const id = num(own(entry, 'id')), start = num(own(entry, 'startgametime')), end = num(own(entry, 'completiontime'));
        if (!Number.isSafeInteger(id) || id <= 0 || games.has(id) || !(end > start)) continue;
        let uploader = null, best = 0;
        for (const u of Array.isArray(entry.matchurls) ? entry.matchurls : []) {
            const size = num(own(u, 'size')), by = profileIdOf(own(u, 'profile_id'));
            if (by && Number.isSafeInteger(size) && size > best) { best = size; uploader = by; }
        }
        if (uploader) rememberReplay(id, uploader);
        const players = (Array.isArray(entry.matchhistorymember) ? entry.matchhistorymember : []).map(m => {
            const pid = profileIdOf(own(m, 'profile_id'));
            return { name: names.get(pid) || 'Player', team: num(own(m, 'teamid')), won: num(own(m, 'outcome')) === 1, searched: accounts.has(pid) };
        });
        games.set(id, { id, map: mapLabel(own(entry, 'mapname')), startTime: start, seconds: end - start, replay: !!uploader, players });
    }
    return [...games.values()].sort((a, b) => b.startTime - a.startTime).slice(0, SEARCH_GAMES);
}

async function servePlayerGames(res, query) {
    const answer = (status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const q = String(query || '').trim();
    if (!q || Array.from(q).length > 40) return answer(400, { error: 'bad query' });
    const kept = searches.get(q);
    if (kept && Date.now() - kept.at < SEARCH_KEEP_MS) return answer(200, kept.body);
    if (Date.now() - searchWindow.startedAt > 60000) searchWindow = { startedAt: Date.now(), count: 0 };
    if (++searchWindow.count > SEARCH_PER_MINUTE) return answer(429, { error: 'busy' }, { 'Retry-After': '60' });
    try {
        let ids = [];
        if (/^\d{1,12}$/.test(q) && isProfileId(Number(q))) {
            ids = [Number(q)];
        } else {
            const stats = JSON.parse(await httpsGet(`${RELIC_API}/leaderboard/GetPersonalStat?title=age2&aliases=${encodeURIComponent(JSON.stringify([q]))}`));
            for (const group of Array.isArray(own(stats, 'statGroups')) ? stats.statGroups : []) {
                for (const m of Array.isArray(own(group, 'members')) ? group.members : []) {
                    const id = profileIdOf(own(m, 'profile_id'));
                    if (id && !ids.includes(id) && ids.length < SEARCH_ACCOUNTS) ids.push(id);
                }
            }
        }
        const games = ids.length
            ? gamesFromHistory(JSON.parse(await httpsGet(`${RELIC_API}/leaderboard/getRecentMatchHistory?title=age2&profile_ids=${encodeURIComponent(JSON.stringify(ids))}`)), new Set(ids))
            : [];
        const body = JSON.stringify({ query: q, accounts: ids.length, games });
        searches.set(q, { body, at: Date.now() });
        if (searches.size > 200) searches.delete(searches.keys().next().value);
        answer(200, body);
    } catch (e) {
        console.error(`Player search failed: ${e.name}`);
        answer(502, { error: 'failed' });
    }
}

function keepReplay(id, body) {
    replayFiles.set(id, { body, at: Date.now() });
    let bytes = 0;
    for (const file of replayFiles.values()) bytes += file.body.length;
    for (const [oldId, file] of replayFiles) {
        if (bytes <= REPLAY_KEEP_BYTES && Date.now() - file.at < REPLAY_KEEP_MS) break;
        bytes -= file.body.length;
        replayFiles.delete(oldId);
    }
}

async function downloadReplay(id, profileId) {
    const res = await fetch(`https://aoe.ms/replay/?gameId=${id}&profileId=${profileId}`, { signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        size += chunk.length;
        if (size > REPLAY_MAX_BYTES) throw new Error('too large');
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) throw new Error('not a ZIP');
    return body;
}

async function serveReplay(res, id) {
    const refuse = (status, error, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify({ error }));
    };
    const cache = await freshSpectate();
    const found = spectateGameById(cache, id);
    if (found.status === 'live') return refuse(409, 'live');
    const listed = knownReplays.get(id);
    let uploader = listed && Date.now() - listed.at < KNOWN_REPLAY_MS ? listed.profileId : null;
    if (!uploader) {
        if (!found.ended) return refuse(404, 'unknown');
        startResultLookup(found.ended);
        if (found.ended.lookup) await settleWithin(found.ended.lookup, RESULT_WAIT_MS);
        const result = found.ended.result;
        if (!result || result.state !== 'found') return refuse(404, 'pending');
        if (!result.replay || !result.replay.available) return refuse(404, 'none');
        uploader = result.replay.profileId;
    }
    const kept = replayFiles.get(id);
    let body = kept && Date.now() - kept.at < REPLAY_KEEP_MS ? kept.body : null;
    if (!body) {
        let download = replayFetches.get(id);
        if (!download) {
            if (Date.now() - replayWindow.startedAt > 60000) replayWindow = { startedAt: Date.now(), count: 0 };
            if (++replayWindow.count > REPLAY_FETCHES_PER_MINUTE) return refuse(429, 'busy', { 'Retry-After': '60' });
            download = downloadReplay(id, uploader).finally(() => replayFetches.delete(id));
            replayFetches.set(id, download);
        }
        try {
            body = await download;
        } catch (e) {
            // The name alone: a message could carry the address
            console.error(`Replay of ${id} failed: ${e.name}`);
            return refuse(502, 'failed');
        }
        keepReplay(id, body);
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(body);
}

// --- Live relay: /api/live -----------------------------------------------------------------------------------
// A game client watching a game writes a recording as it goes, and the follow page in that PC's browser can send it here,
// so anyone can follow the game with no game of their own. Only the holder of the key can send. The game must be in
// the feed, live or ended (a watcher can run long after the real game is over), and nothing is served until the
// recording proves to be a watched game of those same players: a recording of a game someone is playing would show
// their opponents' orders. Everything is also held back until it's at least RELAY_BEHIND_MS behind (counting the lobby's
// own spectator delay), so players can't scout their own game here.
const RELAY_KEY_PATH = path.join(os.homedir(), '.aoe2lobby-relay-key');
const RELAY_BEHIND_MS = Number(process.env.RELAY_BEHIND_MS) || 120000;
const RELAY_MAX_GAMES = 3;
const RELAY_MAX_BYTES = 32 * 1024 * 1024;
const RELAY_CHUNK_BYTES = 8 * 1024 * 1024;
const RELAY_IDLE_MS = 5 * 60 * 1000;
const RELAY_ENDED_KEEP_MS = 10 * 60 * 1000;
const RELAY_BIG_READ_BYTES = 256 * 1024; // a viewer's first read: later ones are a few KB
const RELAY_BIG_READS_PER_MINUTE = 60;
const relays = new Map(); // match id -> { game, data, shown: [{ size, at }], behind, checked, ended, lastAt }
let relayKeyHash = null;
let relayReadWindow = { startedAt: 0, count: 0 };

// Made on first use and kept outside the deployed folder, so a deploy doesn't replace it
function relayKeyDigest() {
    if (relayKeyHash) return relayKeyHash;
    let key = '';
    try { key = fs.readFileSync(RELAY_KEY_PATH, 'utf8').trim(); } catch (e) { }
    if (!key) {
        key = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(RELAY_KEY_PATH, key + '\n', { mode: 0o600 });
    }
    relayKeyHash = crypto.createHash('sha256').update(key).digest();
    return relayKeyHash;
}

function relayKeyMatches(given) {
    if (typeof given !== 'string' || !given) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), relayKeyDigest());
}

function sweepRelays() {
    for (const [id, r] of relays) if (Date.now() - r.lastAt > (r.ended ? RELAY_ENDED_KEEP_MS : RELAY_IDLE_MS)) relays.delete(id);
}

function readBody(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) { reject(new Error('too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// 'ok' once it's a watched game of the feed's players; 'wait' until the file can say; else why it's refused
async function checkRelay(r) {
    if (r.checked) return 'ok';
    let model;
    try {
        model = await ReplayParse.parseFile(new Uint8Array(r.data), async (b, max) => new Uint8Array(zlib.inflateRawSync(b, { maxOutputLength: max })));
    } catch (e) {
        return 'wait';
    }
    if (model.file.watched === false) return 'playing';
    const seated = new Set(r.game.players.filter(p => p.kind === 'human').map(p => p.id));
    const humans = model.players.filter(p => p.human);
    if (!humans.length || !humans.every(p => seated.has(p.profileId))) return 'wrong game';
    if (model.file.watched === null) return 'wait';
    r.behind = Math.max(0, RELAY_BEHIND_MS - model.settings.spectatorDelay * 1000);
    r.checked = true;
    return 'ok';
}

async function receiveRelay(req, res, id, at, ended) {
    const answer = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
    };
    if (!relayKeyMatches(req.headers['x-relay-key'])) return answer(401, { error: 'key' });
    let body;
    try {
        body = await readBody(req, RELAY_CHUNK_BYTES);
    } catch (e) {
        return answer(413, { error: 'too large' });
    }
    sweepRelays();
    let r = relays.get(id);
    if (at === 0) {
        const found = spectateGameById(await freshSpectate(), id);
        if (!found.game) return answer(409, { error: 'unknown game' });
        if (!r && relays.size >= RELAY_MAX_GAMES) return answer(429, { error: 'busy' });
        r = { game: found.game, data: Buffer.alloc(0), shown: [], behind: RELAY_BEHIND_MS, checked: false, ended: false, lastAt: Date.now() };
        relays.set(id, r);
    }
    if (!r) return answer(404, { error: 'none' });
    if (at !== r.data.length) return answer(409, { error: 'offset', size: r.data.length });
    if (at + body.length > RELAY_MAX_BYTES) return answer(413, { error: 'too large' });
    r.data = Buffer.concat([r.data, body]);
    r.shown.push({ size: r.data.length, at: Date.now() });
    r.lastAt = Date.now();
    if (ended) r.ended = true;
    const state = await checkRelay(r);
    if (state === 'playing' || state === 'wrong game') {
        relays.delete(id);
        return answer(403, { error: state });
    }
    answer(200, { size: r.data.length, state });
}

// Being shared now, for a game's page
function relayOpen(game) {
    const r = game ? relays.get(game.id) : null;
    return !!(r && r.checked && !r.ended);
}

// What's old enough to show
function relayVisible(r) {
    if (!r.checked) return 0;
    const before = Date.now() - r.behind;
    let size = 0;
    for (const s of r.shown) {
        if (s.at > before && !r.ended) break;
        size = s.size;
    }
    return size;
}

function serveRelay(res, id, from) {
    sweepRelays();
    const r = relays.get(id);
    if (!r) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'none' }));
        return;
    }
    const visible = relayVisible(r);
    if (visible - from > RELAY_BIG_READ_BYTES) {
        if (Date.now() - relayReadWindow.startedAt > 60000) relayReadWindow = { startedAt: Date.now(), count: 0 };
        if (++relayReadWindow.count > RELAY_BIG_READS_PER_MINUTE) {
            res.writeHead(429, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Live-Size': String(visible) });
    res.end(r.data.subarray(Math.min(from, visible), visible));
}

function serveRelayList(res) {
    sweepRelays();
    const games = [...relays.entries()].filter(([, r]) => relayVisible(r) > 0 && !r.ended).map(([id, r]) => ({
        id, map: r.game.map, players: r.game.players.filter(p => p.kind === 'human').map(p => p.name)
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ games }));
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

// --- Lobby fields straight from Relic, decoded with code tables learned from aoe2lobby.com ------------------------------
// aoe2lobby.com's page shows only what its server pushes (wss://data.aoe2lobby.com/ws/lobby/: the whole list, then whole
// lobbies upserted, removals and ratings; read from its main bundle on 27 Nov 2026), and its server builds every lobby field
// from Relic's own list, a median 3-4 s after Relic has it. Each field is a Relic lobby option or slot value in another
// numbering; on 27 Nov 2026 all 54 lobbies agreed: option 10 the map, 5 the game mode, 8 the map size, 0 the starting age,
// 37 the resources (aoe2lobby.com also reports custom resources, which no single option shows), 57 the treaty in minutes,
// 28 the population, 41 the speed, 7 whether the lobby is full, 85 whether civs are hidden; and a slot's metaData "1" its civ
// (111 of 122 players; the rest had just changed civ). Relic's codes are learned per field: once a lobby (or a player's
// slot) has shown the same Relic code and aoe2lobby.com label for RELIC_LEARN_MS, that pair counts once, and a code decodes to
// the label most lobbies showed with it. A host changing a setting reaches the two feeds seconds apart, and that mix never
// lasts long enough to count. The counts are kept in relic_codes.json (deploy/push.sh keeps it).
// Merging (mergeRelicField): aoe2lobby.com's label is exact, so it is shown, except while Relic's code has changed within
// A2L_CATCH_UP_MS and decodes to another label: aoe2lobby.com hasn't caught up yet, and the change shows within a second. A
// lobby aoe2lobby.com doesn't list (just created, or its feed down) gets the decoded values alone.
const RELIC_CODES_PATH = path.join(__dirname, 'relic_codes.json');
const RELIC_MAP_IDS_PATH = path.join(__dirname, 'relic_map_ids.json'); // the first map table, read into relic_codes.json once
const RELIC_CODE_FIELDS = ['map', 'mode', 'size', 'age', 'resources', 'civ'];
const RELIC_LEARN_MS = 15000;
const A2L_CATCH_UP_MS = 12000; // aoe2lobby.com trails Relic by a median 3-4 s, 6.5 s at the 90th percentile
const RELIC_CODES_SAVE_MS = 60000;
const RELIC_CODE_COUNT_MAX = 1000; // past this a code's counts are halved, so a later label can still win
const relicCodes = Object.create(null); // field -> Relic code -> label -> how many lobbies showed the pair
for (const field of RELIC_CODE_FIELDS) relicCodes[field] = Object.create(null);
const okRelicCode = c => typeof c === 'string' && /^-?\d{1,9}$/.test(c);
const okCodeLabel = l => typeof l === 'string' && l.length > 0 && l.length <= 200 && l !== 'Unknown'; // "Unknown" names no code
function addRelicCode(field, code, label, n) {
    if (!okRelicCode(code) || !okCodeLabel(label) || !Number.isSafeInteger(n) || n <= 0) return;
    const labels = relicCodes[field][code] || (relicCodes[field][code] = Object.create(null));
    labels[label] = Math.min(RELIC_CODE_COUNT_MAX, (labels[label] || 0) + n);
}
try {
    const saved = JSON.parse(fs.readFileSync(RELIC_CODES_PATH, 'utf8'));
    for (const field of RELIC_CODE_FIELDS) {
        const table = saved && typeof saved === 'object' ? saved[field] : null;
        if (!table || typeof table !== 'object') continue;
        for (const [code, labels] of Object.entries(table)) {
            if (labels && typeof labels === 'object') for (const [label, n] of Object.entries(labels)) addRelicCode(field, code, label, n);
        }
    }
} catch (e) { if (e.code !== 'ENOENT') console.error('Error reading relic_codes.json:', e.message); }
if (!Object.keys(relicCodes.map).length) {
    try {
        const saved = JSON.parse(fs.readFileSync(RELIC_MAP_IDS_PATH, 'utf8'));
        if (saved && typeof saved === 'object') for (const [id, name] of Object.entries(saved)) addRelicCode('map', id, name, 1);
    } catch (e) { if (e.code !== 'ENOENT') console.error('Error reading relic_map_ids.json:', e.message); }
}
const relicLobbyFields = new Map(); // lobby id -> Map(field key -> { code, codeSince, pair, pairSince, counted })
let relicCodesDirty = false, relicCodesSavedAt = 0;

// The label most lobbies showed with this code, or undefined
function relicDecode(field, code) {
    const labels = okRelicCode(code) ? relicCodes[field][code] : undefined;
    if (!labels) return undefined;
    let best, most = 0;
    for (const [label, n] of Object.entries(labels)) if (n > most) { best = label; most = n; }
    return best;
}

function learnRelicCode(st, field, code, label, now) {
    if (!okRelicCode(code) || !okCodeLabel(label)) return;
    const pair = code + '\u0000' + label;
    if (st.pair !== pair) { st.pair = pair; st.pairSince = now; st.counted = false; return; }
    if (st.counted || now - st.pairSince < RELIC_LEARN_MS) return;
    st.counted = true;
    const labels = relicCodes[field][code] || (relicCodes[field][code] = Object.create(null));
    labels[label] = (labels[label] || 0) + 1;
    if (labels[label] > RELIC_CODE_COUNT_MAX) for (const l of Object.keys(labels)) labels[l] = Math.floor(labels[l] / 2);
    relicCodesDirty = true;
}

// One field of one lobby (key: the field, or "civ:<profile id>"): the value to show, from Relic's code (decoded through the
// field's table, or passed as decoded) and aoe2lobby.com's label (undefined when it has none). A lobby's first code doesn't
// count as a change, so aoe2lobby.com's label wins as soon as it has one. learn: false for a pair that says nothing about
// the code's meaning (a custom map's file, a hidden civ).
function mergeRelicField(lobbyId, key, field, code, a2lLabel, now, { decoded, learn = true } = {}) {
    let fields = relicLobbyFields.get(lobbyId);
    if (!fields) relicLobbyFields.set(lobbyId, fields = new Map());
    let st = fields.get(key);
    if (!st) fields.set(key, st = { code, codeSince: 0, pair: null, pairSince: 0, counted: false });
    else if (st.code !== code) { st.code = code; st.codeSince = now; }
    if (decoded === undefined && field) decoded = relicDecode(field, code);
    if (a2lLabel === undefined || a2lLabel === null) return decoded;
    if (field && learn) learnRelicCode(st, field, code, String(a2lLabel), now);
    if (decoded === undefined || decoded === null || String(decoded) === String(a2lLabel)) return a2lLabel;
    return now - st.codeSince < A2L_CATCH_UP_MS ? decoded : a2lLabel;
}

function saveRelicCodes(now) {
    if (!relicCodesDirty || now - relicCodesSavedAt < RELIC_CODES_SAVE_MS) return;
    relicCodesDirty = false;
    relicCodesSavedAt = now;
    writeJsonAtomic(RELIC_CODES_PATH, relicCodes);
}

// The map as Relic's data names it: a custom map's file name, a learned id's name, or else the id itself (the way
// aoe2lobby.com shows an id it can't name; mapDisplayName then names it from map_names.json, or as "Map #<id>").
// known is false for that last case, so a map named in the title can be preferred. null when Relic gives no map.
function relicMapName(m) {
    const id = m.relicMapId;
    if (id === '-2') return m.relicRms ? { name: m.relicRms, known: true } : null;
    if (!id || !/^\d+$/.test(id)) return null;
    const learned = relicDecode('map', id);
    if (learned) return { name: learned, known: true };
    return { name: id, known: !!own(mapNames, id) };
}

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
    // When the scraper first listed the player in their current stay in lobbies (ms); markPendingStats times its wait from it
    const since = num(p.inLobbySince);
    const team = num(p.team);
    return {
        name: str(p.name), profileId: profileIdOf(p.profileId), civ: civLabel(civ), civRor: ROR_SHARED_LABELS.has(civ), steamProfile: str(p.steamProfile), stats: cleanStats(p.stats),
        rawCiv: civ, // the label as scraper.js wrote it (what Relic's civ codes are learned against)
        since: since !== null && since > 0 ? since : null,
        team: Number.isInteger(team) ? team : null // the slot's team code (lobby players only)
    };
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
            createdTime: num(val.createdTime),
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

// The ladders the site shows (the Elo Type filter's options). Relic's profile also has Deathmatch, console and Return
// of Rome ladders; kept out, the Auto view's most-played fallback (pickStat) can't show one of those ratings unlabelled.
const SITE_LADDERS = ['0', '3', '4', '13', '14'];

// A player's ladders from both sources. Relic's profile has the ranked ladders only (never 0, Unranked), and
// aoe2lobby.com's set can lack ladders Relic has. Where both have a ladder, the one with more games is the newer
// record (games only go up), so an hours-old cached profile never hides a new game.
function mergedStats(scraped, cached) {
    let relic = null;
    if (cached && typeof cached === 'object') {
        for (const ladder of SITE_LADDERS) {
            if (Object.hasOwn(cached, ladder)) (relic ||= {})[ladder] = cached[ladder];
        }
    }
    if (!scraped || !relic) return scraped || relic;
    const out = relic;
    for (const ladder of Object.keys(scraped)) {
        if (!out[ladder] || scraped[ladder].games >= out[ladder].games) out[ladder] = scraped[ladder];
    }
    return out;
}

// aoe2lobby.com's ratings for a player: the latest snapshot's, else the last ones it sent, since a snapshot now and
// then lacks a player's ratings for a few seconds (seen for 4 of 253 joining players) and the stats would flick back
// to "No games on this ladder". Ratings only change after a game, so the last ones stay right while the player waits.
function ratingsFor(id, scrapedPlayers) {
    if (!isProfileId(id)) return null;
    const stats = scrapedPlayers.get(id)?.stats;
    if (stats) lastRatings.set(id, stats);
    return stats || lastRatings.get(id) || null;
}

// --- Unranked ratings (ladder 0) from aoe2companion -----------------------------------------------------------------------
// Relic's profile API has the ranked ladders only. aoe2lobby.com's feed, the other source of Unranked ratings, comes and
// goes: on 26 Nov 2026 it sent none at all, so players who joined then showed "No games on this ladder". aoe2companion's
// public API has every player's Unranked rating, the numbers aoe2lobby.com shows (the same rating, games and wins for the
// players checked), and answers for up to UNRANKED_BATCH players in one request, in about 0.1 s; players with no Unranked
// games are left out of its answer. Each player in a lobby is asked for once, then every UNRANKED_REFRESH_MS while they
// stay; one request at a time, at least UNRANKED_GAP_MS apart.
const COMPANION_API = 'https://data.aoe2companion.com/api';
const COMPANION_HEADERS = { 'User-Agent': 'aoe2lobby.online (+https://aoe2lobby.online)' };
const UNRANKED_BATCH = 50;
const UNRANKED_REFRESH_MS = 10 * 60 * 1000;
const UNRANKED_GAP_MS = 500;
const unrankedCache = new Map(); // profile id -> { stats (rating, games, wins, winp, highest, streak) or null, fetchedAt, lastSeen }
const unrankedFailedAt = new Map(); // profile id -> when a request for it failed: not asked again for PROFILE_RETRY_MS
const unrankedWanted = new Set(); // queued or in flight
let unrankedRunning = false;

function askUnranked(ids) {
    for (const id of ids) unrankedWanted.add(id);
    if (!unrankedRunning && unrankedWanted.size) fetchUnranked().catch(e => console.error('Unranked ratings:', e));
}

async function fetchUnranked() {
    unrankedRunning = true;
    try {
        while (unrankedWanted.size) {
            const chunk = [...unrankedWanted].slice(0, UNRANKED_BATCH);
            try {
                const data = JSON.parse(await httpsGet(`${COMPANION_API}/leaderboards/unranked?profile_ids=${chunk.join(',')}`, COMPANION_HEADERS));
                if (!data || !Array.isArray(data.players)) throw new Error('no players list in the answer');
                const asked = new Set(chunk);
                const found = new Map();
                for (const p of data.players) {
                    const id = p && typeof p === 'object' ? profileIdOf(p.profileId) : 0;
                    if (!asked.has(id)) continue;
                    const games = num(p.games, 0), wins = num(p.wins, 0);
                    found.set(id, { rating: num(p.rating), games, wins, winp: games > 0 ? Math.round(wins / games * 100) : 0, highest: num(p.maxRating), streak: num(p.streak) });
                }
                const now = Date.now();
                for (const id of chunk) {
                    unrankedFailedAt.delete(id);
                    unrankedCache.set(id, { stats: found.get(id) || null, fetchedAt: now, lastSeen: unrankedCache.get(id)?.lastSeen ?? now });
                }
                rebuildSoon(); // the spinners these answers end
                spectateDirty = true; // and the Spectate players' Unranked ratings
            } catch (e) {
                console.error('Unranked ratings (aoe2companion):', e.message);
                const failedAt = Date.now();
                for (const id of chunk) unrankedFailedAt.set(id, failedAt);
            }
            for (const id of chunk) unrankedWanted.delete(id);
            if (unrankedWanted.size) await new Promise(resolve => setTimeout(resolve, UNRANKED_GAP_MS));
        }
    } finally {
        unrankedRunning = false;
    }
}

// aoe2companion's Unranked record over aoe2lobby.com's when it has more games (games only go up, so it is the newer one)
function withUnranked(scraped, id) {
    const u = isProfileId(id) ? unrankedCache.get(id)?.stats : null;
    if (!u) return scraped;
    if (!scraped) return { '0': u };
    return (!scraped['0'] || u.games > scraped['0'].games) ? { ...scraped, '0': u } : scraped;
}

// Every ladder known for a lobby player: aoe2lobby.com's, aoe2companion's Unranked and Relic's ranked ones
function lobbyPlayerStats(id, scraped) {
    return mergedStats(withUnranked(scraped, id), isProfileId(id) ? profileCache.get(id)?.stats : null);
}

// Sets statsPending on every player of the built lobby list, and asks Relic and aoe2companion for players they haven't
// answered for. Pending (a spinner, not "No games on this ladder") lasts until both have had their say, normally well
// under a second: Relic (the ranked ladders and the player's name) and, for the Unranked ladder (the default view),
// aoe2companion, unless aoe2lobby.com has already sent the player's ratings. A source that fails, or hasn't answered
// RATINGS_WAIT_MS into the player's stay in lobbies, isn't waited for (for Relic only while it fails: the name comes from
// it). The stay is timed by scraper.js (inLobbySince) for players aoe2lobby.com lists, else by our own builds.
// requested: ids this build already asked Relic for, not asked twice if that just failed. Runs after the lobbies are
// built, so ratingsFor has already seen every player.
function markPendingStats(lobbies, now, scrapedPlayers, requested) {
    const askRelic = [], askCompanion = [];
    for (const lobby of lobbies) {
        for (const p of lobby.players) {
            if (!isProfileId(p.id)) { p.statsPending = false; continue; }
            let seen = playerSeen.get(p.id);
            if (!seen || now - seen.last > STAY_GAP_MS) playerSeen.set(p.id, seen = { first: now, last: now });
            seen.last = now;
            const cached = profileCache.get(p.id);
            const relicDue = !cached && !profileFailedAt.has(p.id);
            const stayStart = scrapedPlayers.get(p.id)?.since ?? seen.first;
            const unranked = unrankedCache.get(p.id);
            if (unranked) unranked.lastSeen = now;
            const unrankedDue = !unranked && !lastRatings.has(p.id) && !unrankedFailedAt.has(p.id) && now - stayStart < RATINGS_WAIT_MS;
            p.statsPending = relicDue || unrankedDue;
            // Also refresh old profiles: those of players only aoe2lobby.com lists get no other refresh
            if ((!cached || now - cached.fetchedAt > PROFILE_REFRESH_MS) && !requested.has(p.id)) askRelic.push(p.id);
            if ((!unranked || now - unranked.fetchedAt > UNRANKED_REFRESH_MS) && !unrankedWanted.has(p.id) &&
                !(now - (unrankedFailedAt.get(p.id) ?? -Infinity) < PROFILE_RETRY_MS)) askCompanion.push(p.id);
        }
    }
    for (const [id, at] of unrankedFailedAt) if (now - at >= PROFILE_RETRY_MS) unrankedFailedAt.delete(id);
    if (askCompanion.length) askUnranked([...new Set(askCompanion)]);
    for (const [id, seen] of playerSeen) {
        if (now - seen.last > PLAYER_SEEN_FORGET_MS) { playerSeen.delete(id); lastRatings.delete(id); }
    }
    // Every player ratingsFor sees reaches the loop above, so this drops nothing today; it keeps the map bounded if
    // a later change calls ratingsFor for a player who isn't listed
    for (const id of lastRatings.keys()) if (!playerSeen.has(id)) lastRatings.delete(id);
    // In the background, like the other non-host players; fetchProfilesBatch also skips ids with a request in flight
    const ids = [...new Set(askRelic)];
    for (let i = 0; i < ids.length; i += 200) {
        fetchProfilesBatch(ids.slice(i, i + 200)).catch(e => console.error(e));
    }
}

// A player known only from aoe2lobby.com (scraped-only lobby, or a Relic lobby without slot info). statsPending is
// set afterwards, by markPendingStats.
function playerFromScraped(p, scrapedPlayers, ladder, now) {
    const sp = p.profileId ? scrapedPlayers.get(p.profileId) : undefined;
    const cached = p.profileId ? profileCache.get(p.profileId) : undefined;
    if (cached) cached.lastSeen = now;
    const player = { id: p.profileId || 0, name: p.name || 'Unknown', ...lobbyTeam(p.team), elo: null, totalGames: 0, totalWins: 0, winRate: "0.0%", steamProfile: p.steamProfile || sp?.steamProfile || null, civ: p.civ || null, civRor: !!(p.civ && p.civRor), statsPending: false };
    applyStat(player, lobbyPlayerStats(p.profileId, ratingsFor(p.profileId, scrapedPlayers) || p.stats), ladder);
    return player;
}

// Relic's lobby list, every page. Throws when page 0 fails or there are no lobbies at all; complete is false
// when a later page failed (so lobbies missing from this crawl may still exist).
// The pages are read at once, as many as the last read needed (one more when its last page was nearly full), then one
// more at a time while the last is full: one round trip (~0.2 s) however many lobbies there are. The list is newest
// first and start is an offset into it, so a lobby closing during the read moves the ones after it up a place; the pages
// overlap by RELIC_OVERLAP so those are still read (a duplicate is dropped by id).
const RELIC_PAGE = 100; // the most findAdvertisements gives per request (count=101 is an error)
const RELIC_OVERLAP = 10;
const RELIC_STEP = RELIC_PAGE - RELIC_OVERLAP;
const RELIC_MAX_PAGES = 12;
let relicPagesWanted = 1;
async function fetchRelicLobbies() {
    const byId = new Map();
    let complete = true;
    const readPage = async (index) => {
        const start = index * RELIC_STEP;
        try {
            const parsed = JSON.parse(await httpsGet(`${RELIC_API}/advertisement/findAdvertisements?title=age2&start=${start}&count=${RELIC_PAGE}`));
            return parsed && Array.isArray(parsed.matches) ? parsed.matches : [];
        } catch (e) {
            if (index === 0) throw new Error('Relic lobby list: ' + e.message);
            console.error("Error fetching page:", start, e.message);
            complete = false;
            return null;
        }
    };
    let next = 0, batch = relicPagesWanted, end = false;
    while (next < RELIC_MAX_PAGES) {
        const indexes = [];
        for (let i = next; i < Math.min(next + batch, RELIC_MAX_PAGES); i++) indexes.push(i);
        const pages = await Promise.all(indexes.map(readPage));
        pages.forEach((page, i) => {
            if (page === null || end) return;
            for (const m of page) if (m && typeof m === 'object' && Number.isSafeInteger(m.id) && m.id > 0) byId.set(m.id, m);
            if (page.length < RELIC_PAGE) { // a short page is the last
                end = true;
                relicPagesWanted = indexes[i] + 1 + (page.length > RELIC_PAGE - RELIC_OVERLAP ? 1 : 0);
            }
        });
        if (end || !complete) break;
        next += indexes.length;
        batch = 1;
    }
    if (!end && complete) relicPagesWanted = RELIC_MAX_PAGES; // every page was full: read them all at once next time
    if (byId.size === 0) throw new Error('Relic returned no lobbies');
    return { matches: [...byId.values()], complete };
}

// Reads Relic's lobby list into activeMatches, fetching the profiles of new hosts first so every host has a name. Throws
// when Relic gives nothing usable. Returns the profile ids it asked Relic for (buildLobbies doesn't ask again).
async function pollRelic() {
    const { matches: allMatches, complete } = await fetchRelicLobbies();
    const now = Date.now();
    const currentMatchIds = new Set();
    const missingIds = new Set(); // not cached yet
    const staleIds = new Set(); // cached, but due for a refresh

    allMatches.forEach(m => {
        currentMatchIds.add(m.id);
        noteLobbyListed(m.id, now);
        m.lastSeen = now;
        m.isPlaying = false;
        m.rawPlayers = [];

        let trueMapName = str(m.mapname) || "Unknown Map";

        // Deep decode the options payload to find the hidden map hash!
        try {
            if (typeof m.options === 'string' && m.options) {
                const options = parseRelicOptions(m.options);

                // 52 is a value of its own for every lobby (not the map's: 58 lobbies had 58 values on 27 Nov 2026), so
                // only the old entries in mapDictionary are looked up; nothing is learned from it. Only options verified
                // against aoe2lobby.com are read here (63 data mod, 28 population, 41 speed, 10/11 the map); Relic's mode
                // and size codes don't map to aoe2lobby.com's, so those come from the scraper only.
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

                    if (mapDictionary[modHash]) {
                        trueMapName = mapDictionary[modHash];
                    }
                }
                // The options the lobby fields are decoded from (see "Lobby fields straight from Relic")
                m.relicOptions = options;
                // 10 = the map's id in the game's numbering (aoe2lobby.com numbers maps its own way), -2 for a custom
                // map, whose file name is 11 (the name aoe2lobby.com shows for it). See relicMapName.
                if (/^-?\d{1,9}$/.test(options['10'] || '')) m.relicMapId = options['10'];
                const rms = typeof options['11'] === 'string' ? options['11'].replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim() : '';
                if (rms && rms.length <= 200) m.relicRms = rms;
            }
        } catch(e) {
            // Silently fail if decoding options fails
        }
        m.mapname = trueMapName;

        // When this server first saw the lobby: its created time while aoe2lobby.com has none (unknown for the lobbies of
        // the first read after a start)
        const prev = activeMatches.get(m.id);
        m.firstSeen = prev ? prev.firstSeen : relicReadOnce ? now : null;

        if (typeof m.slotinfo === 'string' && m.slotinfo) {
            const slots = parseSlotInfo(m.slotinfo);
            m.rawPlayers = slots.players;
            m.relicSlotsTotal = slots.total;
            m.relicAiSlots = slots.ai;
            // Launching: if it then leaves the list, it is a game in progress (noteLaunching, noteLobbyGone)
            m.launch = slots.launch || null;
            m.launchedAt = m.launch ? (prev?.launchedAt || now) : null;
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
            // activeMatches already has the new lobbies: no build until their hosts have names
            relicApplying = true;
            try { await Promise.all(promises); } finally { relicApplying = false; }
        }

        // Fetch remaining player profiles, and refresh old ones, asynchronously so we don't block
        // and build again as soon as they arrive (~0.15 s), so a new player's name and ratings don't wait for the next read
        const remainingIds = [...missingIds, ...staleIds].filter(id => !hostIdsToFetch.has(id));
        for (let i = 0; i < remainingIds.length; i += 200) {
            fetchProfilesBatch(remainingIds.slice(i, i + 200)).then(rebuildSoon, e => console.error(e));
        }
    }

    // Remove matches that drop off the Relic API feed. When a later page failed they may still be listed, so keep
    // them, but only for 2 minutes, so a repeatedly failing page can't keep closed lobbies joinable for good
    for (const [id, m] of activeMatches) {
        if (!currentMatchIds.has(id) && (complete || now - m.lastSeen > 2 * 60 * 1000)) {
            noteLobbyGone(m, now); // left while launching: a game in progress
            activeMatches.delete(id);
            relicLobbyFields.delete(id);
        }
    }
    relicReadOnce = true;
    // Forget profiles and Unranked ratings that no lobby has shown for a day
    for (const [id, p] of profileCache) {
        if (now - p.lastSeen > PROFILE_FORGET_MS) profileCache.delete(id);
    }
    for (const [id, u] of unrankedCache) {
        if (now - u.lastSeen > PROFILE_FORGET_MS) unrankedCache.delete(id);
    }
    return new Set([...missingIds, ...staleIds]);
}

// The lobby list: Relic's lobbies as pollRelic last read them, with aoe2lobby.com's data (scraper.js's files) merged in,
// and its lobbies that Relic doesn't list. Synchronous, so it can run again on every change of the files.
function buildLobbies(requested = new Set()) {
    const now = Date.now();
    // aoe2lobby.com data; both files are skipped together when the lobbies file is stale
    const scrapedLobbiesRaw = readScrapedJson(SCRAPED_LOBBIES_PATH);
    const scrapedById = loadScrapedLobbies(scrapedLobbiesRaw);
    const scrapedPlayers = loadScrapedPlayers(scrapedLobbiesRaw ? readScrapedJson(SCRAPED_PLAYERS_PATH) : null, scrapedById);
    let titleMaps = null;

    const allMatchesArray = Array.from(activeMatches.values()).map(m => {
        const sm = scrapedById.get(String(m.id));
        const hostId = hostIdOf(m);
        const opts = m.relicOptions || {};

        const parsedPlayers = m.rawPlayers.map(p => {
            const cached = profileCache.get(p.id);
            if (cached) cached.lastSeen = now;
            const sp = isProfileId(p.id) ? scrapedPlayers.get(p.id) : undefined;
            const lp = sm && isProfileId(p.id) ? sm.playersById.get(p.id) : undefined; // this player's slot in the same lobby on aoe2lobby.com
            const alias = cached && cached.alias !== 'Unknown' ? cached.alias : null;
            const name = alias || lp?.name || sp?.name || (cached ? cached.alias : 'Player_' + p.id);
            const steamProfile = sp?.steamProfile || lp?.steamProfile || cached?.steamProfile || null;
            // The civ: Relic's slot code decoded and merged with aoe2lobby.com's label (see mergeRelicField), else the
            // player's last label on aoe2lobby.com. A pick the lobby hides is never shown: with Relic's option 85 on (or
            // aoe2lobby.com saying Hidden) it is Hidden, and codes are decoded only while Relic says civs are shown.
            let rawCiv;
            if (opts['85'] === '1' || lp?.rawCiv === 'Hidden') rawCiv = 'Hidden';
            else if (opts['85'] === '0') rawCiv = mergeRelicField(m.id, 'civ:' + p.id, 'civ', p.civCode, lp?.rawCiv ?? undefined, now) ?? sp?.rawCiv ?? null;
            else rawCiv = lp?.rawCiv ?? sp?.rawCiv ?? null;
            return {
                // The team as Relic's slot has it now, else as aoe2lobby.com last listed it
                id: p.id, name, ...lobbyTeam(p.teamCode ?? lp?.team ?? null), elo: cached ? cached.rating : null,
                totalGames: cached?.totalGames || 0, totalWins: cached?.totalWins || 0, winRate: cached?.winRate ? String(cached.winRate).replace(/%?$/, '%') : "0.0%",
                steamProfile, civ: rawCiv ? civLabel(rawCiv) : null, civRor: ROR_SHARED_LABELS.has(rawCiv), statsPending: false, // set by markPendingStats
                slot: p.slot // the in-game lobby's order (the list itself has the host first)
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

        let modInfo = m.modInfo || "No Mods";
        let serverRegion = regionName(m.relayserver_region);
        const s = sm ? sm.settings : {};
        if (sm) {
            modInfo = (s['Data Mod'] && s['Data Mod'] !== "None") ? s['Data Mod'] : "No Mods";
            if (!serverRegion && regionName(s.Server)) serverRegion = regionName(s.Server);
        }

        // Each setting from Relic's options, decoded and merged with aoe2lobby.com's label (see mergeRelicField): a change
        // shows within a second, and a lobby aoe2lobby.com doesn't list yet has its settings anyway. aoe2lobby.com's
        // "Unknown" is an answer too (custom resources, say), so a decoded guess doesn't replace it for long.
        const a2l = v => (v === undefined || v === null) ? undefined : v;
        const minutes = v => /^\d{1,4}$/.test(v || '') ? Number(v) : undefined;
        const matchType = mergeRelicField(m.id, 'mode', 'mode', opts['5'], a2l(s.Mode), now);
        const mapSize = mergeRelicField(m.id, 'size', 'size', opts['8'], a2l(s.Size), now);
        const startingAge = mergeRelicField(m.id, 'age', 'age', opts['0'], a2l(s['Starting Age']), now);
        const resources = mergeRelicField(m.id, 'resources', 'resources', opts['37'], a2l(s.Resources), now);
        const treaty = mergeRelicField(m.id, 'treaty', null, opts['57'], a2l(s.Treaty), now, { decoded: minutes(opts['57']) });
        const population = mergeRelicField(m.id, 'population', null, opts['28'], a2l(s.Population), now, { decoded: m.relicPopulation || undefined });
        const speed = mergeRelicField(m.id, 'speed', null, opts['41'], a2l(s.Speed), now, { decoded: m.relicSpeed || undefined });
        // Option 7 is aoe2lobby.com's open_slots inverted (1: no open slot), which scraper.js reads as isPlaying
        const full = mergeRelicField(m.id, 'full', null, opts['7'], sm ? sm.isPlaying : undefined, now,
            { decoded: opts['7'] === '1' ? true : opts['7'] === '0' ? false : undefined });
        m.isPlaying = full === true;

        // The map: aoe2lobby.com's name, or Relic's map id (or custom map file) decoded while aoe2lobby.com has none or
        // hasn't caught up with a change; else a known map name in the title, else the bare id
        const smMapUsable = sm && sm.map !== undefined && !GENERIC_MAPS.includes(String(sm.map).toLowerCase());
        const relicMap = relicMapName(m);
        const mapCode = m.relicMapId === '-2' ? `-2|${m.relicRms || ''}` : m.relicMapId;
        const mergedMap = mergeRelicField(m.id, 'map', 'map', mapCode, smMapUsable ? sm.map : undefined, now,
            { decoded: relicMap?.known ? relicMap.name : undefined, learn: /^\d+$/.test(m.relicMapId || '') });
        if (mergedMap !== undefined) finalMapName = mergedMap;
        const title = str(m.description);
        if (!smMapUsable && !relicMap?.known && title) {
            if (!titleMaps) titleMaps = knownTitleMaps();
            const descLower = title.toLowerCase();
            for (const mapName of titleMaps) {
                if (descLower.includes(mapName.toLowerCase())) {
                    finalMapName = mapName;
                    break;
                }
            }
        }
        if (relicMap && !relicMap.known && GENERIC_MAPS.includes(String(finalMapName).toLowerCase())) finalMapName = relicMap.name;

        finalMapName = mapDisplayName(finalMapName);
        // Relic's slots give the same counts as aoe2lobby.com's, sooner
        const slotsTotal = m.relicSlotsTotal || (sm && sm.slotsTotal) || num(m.maxplayers);
        const targetMode = ladderFor(matchType, finalMapName, slotsTotal);

        parsedPlayers.forEach(p => {
            applyStat(p, lobbyPlayerStats(p.id, ratingsFor(p.id, scrapedPlayers)), targetMode);
        });
        // Relic gave no slot info: show aoe2lobby.com's players for this lobby instead
        if (parsedPlayers.length === 0 && sm) {
            // scraper.js lists them in slot order: that is their slot
            parsedPlayers.push(...hostFirst(sm.players.map((p, slot) => ({ ...playerFromScraped(p, scrapedPlayers, targetMode, now), slot })), sm.hostProfileId));
        }

        return {
            id: m.id,
            steamLobbyId: (typeof m.steamlobbyid === 'number' || typeof m.steamlobbyid === 'string') ? m.steamlobbyid : null,
            title: title || "Age of Empires II Game",
            map: finalMapName,
            matchType: matchType,
            mapSize: mapSize,
            modInfo: modInfo,
            // Relic's id of the data mod (option 59; 0 or none: no mod), so a mod's lobbies can be found by id
            modId: /^\d{1,9}$/.test(opts['59'] || '') && opts['59'] !== '0' ? Number(opts['59']) : null,
            population: population,
            speed: speed,
            startingAge: startingAge,
            resources: resources,
            treaty: treaty,
            server: serverRegion,
            isPasswordProtected: m.passwordprotected === 1 || m.passwordprotected === true || (sm ? sm.password : false),
            maxPlayers: slotsTotal,
            aiSlots: m.relicAiSlots ?? ((sm && sm.aiSlots) || 0),
            isPlaying: m.isPlaying === true,
            lastSeen: m.lastSeen,
            // aoe2lobby.com's (Relic's list has none), else when this server first saw the lobby (unix seconds)
            createdTime: sm?.createdTime ?? (m.firstSeen ? Math.floor(m.firstSeen / 1000) : null),
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
        const parsedPlayers = hostFirst(lobby.players.map((p, slot) => ({ ...playerFromScraped(p, scrapedPlayers, ladder, now), slot })), lobby.hostProfileId);

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
            createdTime: lobby.createdTime,
            players: parsedPlayers
        });
    }

    markPendingStats(allMatchesArray, now, scrapedPlayers, requested);
    // Who is in a lobby now, and on which map (the Maps view's "Active now" sort puts the map's own lobbies first)
    const ids = new Map();
    for (const lobby of allMatchesArray) for (const p of lobby.players) if (isProfileId(p.id) && !ids.has(p.id)) ids.set(p.id, lobby.map);
    lobbyPlayers = { at: now, ids };
    saveRelicCodes(now);
    return allMatchesArray;
}

// --- Live lobby list -----------------------------------------------------------------------------------------------------
// Relic's list is read every relicPollMs() (0.5-1 s) from the start, whether or not anyone is watching (the Spectate list
// needs every launch: see noteLobbyGone), and the list is built again as soon as it or aoe2lobby.com's data changes (scraper.js
// rewrites its files on each of the feed's updates, about every 3 s). Each build that changes anything goes to every open
// stream at once, as just the lobbies that changed.
// Relic's list is live (at 4 reads a second, 259 of 360 differed on 27 Nov 2026; its max-age=5 header is advisory), so the
// read interval is most of our delay. Every 500 ms while the list fits in 3 pages, slower as it grows, so the requests a
// second never exceed 6 (the rate of a 6-page list read every second).
const RELIC_POLL_MIN_MS = 500;
const RELIC_POLL_MAX_MS = 1000;
const RELIC_REQUESTS_PER_S = 6;
function relicPollMs() {
    return Math.min(RELIC_POLL_MAX_MS, Math.max(RELIC_POLL_MIN_MS, Math.round(relicPagesWanted * 1000 / RELIC_REQUESTS_PER_S)));
}
const SCRAPED_CHECK_MS = 100; // how often the scraped files' times are checked (a stat each, while anyone is watching)
const RELIC_STALE_MS = 60000; // once Relic's list is this old (it keeps failing), aoe2lobby.com's updates alone don't rebuild
const RELIC_WAIT_MS = 10000; // a poll finding Relic's list older than this waits for a fresh read
let relicPolling = null, relicPollStartedAt = 0, relicOkAt = 0;
let relicApplying = false; // pollRelic is between updating activeMatches and having every new host's name
let scrapedMtime = 0; // the scraped files' newest time, as of the last build
let lobbyLoopTimer = null;
let rebuildWanted = false; // new stats arrived (aoe2companion): build again at the next tick

function rebuildSoon() {
    rebuildWanted = true;
}

// Reads Relic's list and publishes the list built from it. One read at a time, shared by every waiting request; after a
// failure, wait (15 s doubling to 60 s) before retrying
function refreshLobbies() {
    if (!relicPolling && Date.now() >= lobbiesFailUntil) {
        relicPollStartedAt = Date.now();
        relicPolling = pollRelic()
            .then(requested => {
                relicOkAt = Date.now();
                lobbiesFailures = 0;
                publishLobbies(requested);
            })
            .catch(e => {
                lobbiesFailures++;
                lobbiesFailUntil = Date.now() + Math.min(60000, 15000 * 2 ** (lobbiesFailures - 1));
                console.error('Lobbies refresh failed:', e.message);
            })
            .finally(() => { relicPolling = null; });
    }
    return relicPolling;
}

function scrapedFilesTime() {
    let t = 0;
    for (const file of [SCRAPED_LOBBIES_PATH, SCRAPED_PLAYERS_PATH]) {
        try { t = Math.max(t, fs.statSync(file).mtimeMs); } catch (e) { }
    }
    return t;
}

// Builds the list, keeps it for /api/lobbies and sends what changed to the open streams
function publishLobbies(requested) {
    scrapedMtime = scrapedFilesTime(); // before reading them: a write in between is seen as a change, and built again
    let matches;
    try {
        matches = buildLobbies(requested);
    } catch (e) {
        console.error('Building the lobby list failed:', e);
        return;
    }
    noteLaunching(matches, Date.now()); // the Spectate list's games come from the lobbies that launch
    recordMapSnapshot(matches, Date.now()); // the Maps view's counts (every MAP_SNAPSHOT_MS)
    lobbiesCache = { at: Date.now(), body: JSON.stringify({ v: pageVersion, feed: lobbyFeedOk(), matches }) };
    streamLobbies(matches);
}

function lobbyTick() {
    lobbyLoopTimer = null;
    const now = Date.now();
    // Relic's list is read whether or not anyone is watching: the Spectate list's games are the lobbies seen launching,
    // and a launch shows for about a second (see noteLobbyGone)
    // aoe2lobby.com's data changed: build again with the Relic list we have, also while a Relic read waits on the network
    // (it builds again when it's done)
    if (!relicApplying && now - relicOkAt < RELIC_STALE_MS && (rebuildWanted || scrapedFilesTime() !== scrapedMtime)) {
        rebuildWanted = false;
        publishLobbies();
    }
    if (now - relicPollStartedAt >= relicPollMs()) refreshLobbies();
    lobbyLoopTimer = setTimeout(lobbyTick, SCRAPED_CHECK_MS);
}

function watchLobbies() {
    if (!lobbyLoopTimer) lobbyTick();
}

// --- The lobby stream (/api/lobbies/stream, server-sent events) ----------------------------------------------------------
// The page's EventSource gets the whole list when it connects, then each change as it is built: the lobbies that changed
// (upsert), those that closed (remove) and, when it changed, the order of every id. seq counts the changes; a diff names
// the seq it follows (base), so a page that missed one reconnects for the whole list. A ping every STREAM_PING_MS keeps
// proxies from closing a quiet stream and lets the page notice a dead one. Every message carries the server's clock (now).
// lastSeen is left out of the lobbies (it moves on with every Relic read): most lobbies share one, sent once as seenAt,
// with the few others in seen by id.
const STREAM_MAX = 2000;
const STREAM_PER_IP = 20;
const STREAM_PING_MS = 15000;
const STREAM_BUFFER_MAX = 1024 * 1024; // a client this far behind is dropped; it reconnects and starts from a whole list
const streamClients = new Map(); // response -> { ip, ready }: ready once it has the whole list
const streamPerIp = new Map();
let streamSeq = 0;
let sentLobbies = new Map(); // id (as text) -> the lobby's JSON without lastSeen, as last sent
let sentOrder = [];
let sentSeen = { seenAt: 0, seen: {} };
let streamFullCache = null; // the whole list as a message body, for clients that connect before the next change

function seenOf(matches) {
    const counts = new Map();
    for (const m of matches) counts.set(m.lastSeen, (counts.get(m.lastSeen) || 0) + 1);
    let seenAt = 0, most = 0;
    for (const [t, n] of counts) if (n > most) { seenAt = t; most = n; }
    const seen = {};
    for (const m of matches) if (m.lastSeen !== seenAt) seen[String(m.id)] = m.lastSeen;
    return { seenAt: Number(seenAt) || 0, seen };
}

function streamWrite(res, text) {
    if (res.writableLength > STREAM_BUFFER_MAX) { res.destroy(); return; }
    res.write(text);
}

function streamLobbies(matches) {
    const next = new Map(), order = [];
    for (const m of matches) {
        const key = String(m.id);
        if (next.has(key)) continue;
        const { lastSeen, ...lobby } = m;
        next.set(key, JSON.stringify(lobby));
        order.push(key);
    }
    const upsert = [], remove = [];
    for (const [key, json] of next) if (sentLobbies.get(key) !== json) upsert.push(json);
    for (const key of sentLobbies.keys()) if (!next.has(key)) remove.push(key);
    const orderChanged = order.length !== sentOrder.length || order.some((key, i) => key !== sentOrder[i]);
    sentSeen = seenOf(matches);
    streamFullCache = null;
    if (!upsert.length && !remove.length && !orderChanged) return; // only lastSeen moved on: nothing to send
    const base = streamSeq++;
    sentLobbies = next;
    sentOrder = order;
    let ready = 0;
    for (const client of streamClients.values()) if (client.ready) ready++;
    if (!ready) return;
    const msg = `data: {"t":"diff","seq":${streamSeq},"base":${base},"now":${Date.now()},"feed":${lobbyFeedOk()},"seenAt":${sentSeen.seenAt},` +
        `"seen":${JSON.stringify(sentSeen.seen)},${orderChanged ? `"order":${JSON.stringify(order)},` : ''}` +
        `"remove":${JSON.stringify(remove)},"upsert":[${upsert.join(',')}]}\n\n`;
    for (const [res, client] of streamClients) if (client.ready) streamWrite(res, msg);
}

function streamFullMessage() {
    if (!streamFullCache) {
        streamFullCache = `"seenAt":${sentSeen.seenAt},"seen":${JSON.stringify(sentSeen.seen)},` +
            `"matches":[${sentOrder.map(key => sentLobbies.get(key)).join(',')}]}`;
    }
    return `data: {"t":"full","seq":${streamSeq},"v":${JSON.stringify(pageVersion)},"now":${Date.now()},"feed":${lobbyFeedOk()},${streamFullCache}\n\n`;
}

// Caddy passes the visitor's address in X-Forwarded-For (it replaces any the visitor sent)
function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    return forwarded || req.socket.remoteAddress || '';
}

async function serveLobbyStream(req, res) {
    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end();
        return;
    }
    const ip = clientIp(req);
    if (streamClients.size >= STREAM_MAX || (streamPerIp.get(ip) || 0) >= STREAM_PER_IP) {
        // The page polls /api/lobbies instead, and tries the stream again later
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30', 'Cache-Control': 'no-store' });
        res.end('Too many live connections');
        return;
    }
    const client = { ip, ready: false };
    streamClients.set(res, client);
    streamPerIp.set(ip, (streamPerIp.get(ip) || 0) + 1);
    res.on('close', () => {
        if (!streamClients.delete(res)) return;
        const n = (streamPerIp.get(ip) || 1) - 1;
        if (n > 0) streamPerIp.set(ip, n); else streamPerIp.delete(ip);
    });
    // Caddy compresses the stream (the same lobbies repeat, so it shrinks several times over) and flushes every event at once
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n'); // how long the browser waits before reconnecting after a drop
    watchLobbies();
    // No list yet (the server just started): wait for the first. One from before anyone was watching: wait up to 5 s for
    // a fresh read, else send it, and the change follows.
    if (!lobbiesCache.body || Date.now() - relicOkAt > RELIC_WAIT_MS) {
        const pending = refreshLobbies();
        if (pending && !lobbiesCache.body) await pending;
        else if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    }
    if (!streamClients.has(res)) return; // gone while waiting
    streamWrite(res, streamFullMessage());
    client.ready = true;
}

setInterval(() => {
    if (!streamClients.size) return;
    const msg = `data: {"t":"ping","seq":${streamSeq},"now":${Date.now()},"feed":${lobbyFeedOk()}}\n\n`;
    for (const [res, client] of streamClients) if (client.ready) streamWrite(res, msg);
}, STREAM_PING_MS).unref();

// --- Map history (the Maps view): which players keep showing up in each map's lobbies ----------------------------------
// Counted here into a SQLite file (map-history.js), kept for good: every MAP_SNAPSHOT_MS, the lobbies of the last build
// (recordMapSnapshot; a player counts once per lobby and map). Until 28 Nov 2026 scraper.js counted aoe2lobby.com's lobbies
// instead; that feed has blocked us. Stored map names are grouped by the name the lobby cards show (mapDisplayName: a
// Steam mod map's number becomes its name). Answers are kept MAP_CACHE_MS: the counts change once per snapshot. Every
// player is listed: the page asks for them a page at a time, sorted and searched here (a busy map has thousands).
const { MapHistoryReader, MapHistoryWriter, MAP_SORTS, MAP_LADDERS, sortMapPlayers, mapPlayersPage } = require('./map-history');
const mapHistory = new MapHistoryReader();
const MAP_SNAPSHOT_MS = 15000;
let mapHistoryWriter = null, lastMapSnapshotAt = 0;
try {
    mapHistoryWriter = new MapHistoryWriter();
} catch (e) {
    console.error('Map history: counting is off:', e.message);
}

// One snapshot of the built lobby list: Relic's lobbies (numeric ids), each under the map name its card shows, or the
// mod map's number while that has no name (as aoe2lobby.com's feed stored it, so a name learned later groups them).
// Players whose name isn't known yet (no profile fetched) wait for the next snapshot: the counting would store the stand-in.
function recordMapSnapshot(lobbies, now) {
    if (!mapHistoryWriter || now - lastMapSnapshotAt < MAP_SNAPSHOT_MS) return;
    lastMapSnapshotAt = now;
    const snapshot = [];
    for (const lobby of lobbies) {
        if (typeof lobby.id !== 'number' || typeof lobby.map !== 'string') continue;
        const map = /^Map #(\d+)$/.exec(lobby.map)?.[1] ?? lobby.map;
        const players = lobby.players
            .filter(p => isProfileId(p.id) && typeof p.name === 'string' && p.name && p.name !== 'Unknown' && p.name !== `Player_${p.id}`)
            .map(p => ({ profileId: p.id, name: p.name, steamProfile: p.steamProfile || null, stats: p.allStats || null }));
        if (players.length) snapshot.push({ matchId: String(lobby.id), map, players });
    }
    try {
        mapHistoryWriter.recordSnapshot(snapshot, now);
    } catch (e) {
        console.error('Map history: snapshot not saved:', e.message);
    }
}
const MAP_LIST_MAX = 1000; // maps in the picker, most lobbies first
const MAP_PAGE_MAX = 1000; // players per request (the page asks for 60 at a time, and up to what it shows to refresh)
const MAP_PAGE_OLD = 300; // a request without `limit` (an app.js from before paging): its 300 most frequent players
const MAP_CACHE_MS = 30000;
let mapListCache = { at: 0, list: null, names: null, since: null };
const mapPlayersCache = new Map(); // display name -> { at, entry, players, sorted: Map(`${sort}|${ladder}` -> players) }

// [{ name, lobbies, players, stored: [stored names] }], most lobbies first, and display name -> that entry. Names that
// differ only in case ("Highland" and "highland") are one map, shown as the spelling most of its lobbies used; every
// spelling finds it.
function mapList() {
    if (mapListCache.list && Date.now() - mapListCache.at < MAP_CACHE_MS) return mapListCache;
    const byKey = new Map(), spellings = new Map(); // lower-case name -> entry; entry -> Map(spelling -> lobbies)
    for (const row of mapHistory.maps()) {
        const name = mapDisplayName(String(row.name));
        const key = name.toLowerCase();
        if (GENERIC_MAPS.includes(key)) continue;
        let entry = byKey.get(key);
        if (!entry) {
            byKey.set(key, entry = { name, lobbies: 0, players: 0, last: 0, stored: [] });
            spellings.set(entry, new Map());
        }
        const lobbies = Number(row.lobbies) || 0;
        entry.lobbies += lobbies;
        entry.players += Number(row.players) || 0;
        entry.last = Math.max(entry.last, Number(row.last) || 0);
        entry.stored.push(String(row.name));
        spellings.get(entry).set(name, (spellings.get(entry).get(name) || 0) + lobbies);
    }
    const names = new Map();
    for (const entry of byKey.values()) {
        const byLobbies = [...spellings.get(entry)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        entry.name = byLobbies[0][0];
        for (const [spelling] of byLobbies) names.set(spelling, entry);
        // A map stored under two names (a mod map's number and its name, or two spellings): count a player on both once
        if (entry.stored.length > 1) entry.players = mapHistory.playerCount(entry.stored);
    }
    const list = [...byKey.values()].filter(m => m.players > 0).sort((a, b) => b.lobbies - a.lobbies || b.last - a.last);
    mapListCache = { at: Date.now(), list, names, since: mapHistory.since() };
    mapPlayersCache.clear();
    return mapListCache;
}

function answerJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveMapList(res) {
    try {
        const { maps: { list, since }, slugOf } = mapSlugs();
        answerJson(res, 200, {
            since,
            maps: list.slice(0, MAP_LIST_MAX).map(m => ({
                name: m.name, lobbies: m.lobbies, players: m.players,
                page: slugOf.has(m.name) ? MapPages.mapPath(slugOf.get(m.name)) : undefined
            }))
        });
    } catch (e) {
        console.error('Map history: list failed:', e.message);
        answerJson(res, 503, { error: 'map history unavailable' });
    }
}

// Every player of a shown map, kept MAP_CACHE_MS (with the sorted orders asked for meanwhile); null for an unknown map
function mapPlayersOf(name) {
    const entry = mapList().names.get(name); // first: a new list empties mapPlayersCache, so both stay in step
    if (!entry) return null;
    const now = Date.now();
    let kept = mapPlayersCache.get(name);
    if (kept && now - kept.at < MAP_CACHE_MS) return kept;
    for (const [key, old] of mapPlayersCache) if (now - old.at >= MAP_CACHE_MS) mapPlayersCache.delete(key);
    const players = mapHistory.players(entry.stored).map(mapPlayerFromRow).filter(p => p.id);
    kept = { at: now, entry, players, sorted: new Map() };
    mapPlayersCache.set(name, kept);
    return kept;
}

// A map history row as the Maps view's player: ratings as last seen in a lobby, with Relic's ranked ladders where we
// have the player's profile
function mapPlayerFromRow(row) {
    const id = profileIdOf(Number(row.id));
    let stats = null;
    try { stats = cleanStats(JSON.parse(row.stats || 'null')); } catch (e) { }
    return {
        id, name: str(row.name) || `Player ${id}`, steamProfile: str(row.steam), count: Number(row.count) || 0,
        lastSeen: Number(row.lastSeen) || 0, allStats: lobbyPlayerStats(id, stats)
    };
}

// ?map=&sort=&ladder=&q=&offset=&limit=: one page of the map's players, sorted, narrowed to names containing q. A player
// in a game in progress (every listed game allows spectators) carries it as playing, so the page can offer to watch it;
// the games are the Spectate view's (the lobbies seen launching).
const MAP_PLAYING_WAIT_MS = 2500; // the longest a request waits for the games
async function serveMapPlayers(res, query) {
    const name = String(query.get('map') || '');
    if (!name || name.length > 120) return answerJson(res, 400, { error: 'bad map' });
    const sort = MAP_SORTS.includes(query.get('sort')) ? query.get('sort') : 'count';
    const ladder = MAP_LADDERS.includes(query.get('ladder')) ? query.get('ladder') : '0';
    const q = String(query.get('q') || '').slice(0, 64).toLowerCase();
    const whole = (v, min, max, fallback) => { const n = Number(v); return v !== null && Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback; };
    const offset = whole(query.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = whole(query.get('limit'), 1, MAP_PAGE_MAX, query.has('limit') ? 60 : MAP_PAGE_OLD);
    try {
        await settleWithin(freshSpectate().catch(() => null), MAP_PLAYING_WAIT_MS);
        const playing = playingIndex(spectateCache);
        const { since } = mapList();
        const kept = mapPlayersOf(name);
        if (!kept) return answerJson(res, 200, { map: name, since, lobbies: 0, total: 0, matched: 0, offset, players: [] });
        const order = `${sort}|${ladder}`;
        let sorted = kept.sorted.get(order);
        if (!sorted) {
            // A lobby list older than 2 min (nobody on the site) says nothing about who is in a lobby now. In a lobby on
            // this map ranks 3, in a game on it 2, in another lobby or game 1.
            const live = Date.now() - lobbyPlayers.at < 2 * 60 * 1000 ? lobbyPlayers.ids : new Map();
            const thisMap = name.toLowerCase();
            const activeRank = id => {
                const lobbyMap = live.get(id);
                if (lobbyMap !== undefined) return String(lobbyMap).toLowerCase() === thisMap ? 3 : 1;
                const game = playing.get(id);
                return !game ? 0 : String(game.map).toLowerCase() === thisMap ? 2 : 1;
            };
            kept.sorted.set(order, sorted = sortMapPlayers(kept.players, sort, ladder, activeRank));
        }
        const page = mapPlayersPage(sorted, q, offset, limit);
        // New objects: the kept players are shared by every request
        const players = page.players.map(p => {
            const g = playing.get(p.id);
            return g ? { ...p, playing: { id: g.id, map: g.map, title: g.title, startTime: g.startTime, observerDelay: g.observerDelay } } : p;
        });
        // How many of the map's players are in a game on it now (not in a lobby), for the line above the cards
        let playingHere = 0;
        if (playing.size) {
            const inLobby = Date.now() - lobbyPlayers.at < 2 * 60 * 1000 ? lobbyPlayers.ids : new Map();
            const thisMap = name.toLowerCase();
            for (const p of kept.players) {
                const g = playing.get(p.id);
                if (g && !inLobby.has(p.id) && String(g.map).toLowerCase() === thisMap) playingHere++;
            }
        }
        answerJson(res, 200, { map: name, since, lobbies: kept.entry.lobbies, total: kept.players.length, matched: page.matched, offset, playingHere, players });
    } catch (e) {
        console.error('Map history: players failed:', e.message);
        answerJson(res, 503, { error: 'map history unavailable' });
    }
}

// --- pv's mods (the page's Mods section) --------------------------------------------------------------------------------
// pv-mods.json lists pv's published mods as their My Mods page on ageofempires.com showed them (read once, by hand: since
// late Nov 2026 the mod site and its API answer only signed-in visitors, so nothing here fetches them, and the numbers are
// as of readAt). Each mod's thumbnail is an image in mod-thumbs/: <id>.webp, .png or .jpg when there is one (generated
// art, from tools/mod-thumb-prompts.md), else <id>.svg, drawn by tools/make-mod-thumbs.js; the CSP allows images from
// this site only. /mods (serveModsPage) adds the lobbies and games in progress using each mod.
const PV_MODS_PATH = path.join(__dirname, 'pv-mods.json');
let pvMods = { author: 'pv', readAt: null, mods: [] };
try {
    const saved = JSON.parse(fs.readFileSync(PV_MODS_PATH, 'utf8'));
    const mods = (saved && Array.isArray(saved.mods) ? saved.mods : [])
        .filter(m => m && Number.isSafeInteger(m.id) && m.id > 0 && str(m.name))
        .map(m => ({
            id: m.id, name: m.name, summary: str(m.summary) || '', tag: str(m.tag), version: str(m.version),
            created: str(m.created), updated: str(m.updated), fileSize: num(m.fileSize),
            downloads: num(m.downloads, 0), installs: num(m.installs, 0), likes: num(m.likes, 0), ratings: num(m.ratings, 0),
            link: `https://www.ageofempires.com/mods/details/${m.id}/`,
            thumb: ['webp', 'png', 'jpg', 'svg'].map(ext => `/mod-thumbs/${m.id}.${ext}`).find(p => fs.existsSync(path.join(__dirname, p))) || null
        }));
    for (const m of mods) {
        if (!m.thumb) continue;
        PUBLIC_FILES.add(m.thumb);
        // ?v= is the image's content hash: a new image gets a new address, so no browser keeps showing the old one
        const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, m.thumb))).digest('hex').slice(0, 10);
        m.thumb += `?v=${hash}`;
    }
    pvMods = { author: str(saved.author) || 'pv', readAt: str(saved.readAt), mods };
} catch (e) { if (e.code !== 'ENOENT') console.error('Error reading pv-mods.json:', e.message); }
const pvModIds = new Set(pvMods.mods.map(m => m.id));
const pvModByName = new Map(); // lower-case name -> id; a name two mods share goes to the one with more downloads
for (const m of [...pvMods.mods].sort((a, b) => a.downloads - b.downloads)) pvModByName.set(m.name.trim().toLowerCase(), m.id);

// The pv mod a lobby's or game's data mod text names: "<id>_<name>" (and "<id>-", "<id> ") by id, else the exact name
function pvModIdFor(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const t = text.trim();
    const byId = /^(\d{1,9})[_\- ]/.exec(t);
    if (byId && pvModIds.has(Number(byId[1]))) return Number(byId[1]);
    return pvModByName.get(t.toLowerCase()) ?? null;
}

// /mods: the mods page (map-pages.js renderModsPage), last updated first. Kept MODS_PAGE_CACHE_MS: what is in use changes
// with the lobbies. The games are the Spectate view's.
const MODS_PAGE_CACHE_MS = 20000;
let modsPageCache = { at: 0, body: null };
async function serveModsPage(res) {
    if (!modsPageCache.body || Date.now() - modsPageCache.at >= MODS_PAGE_CACHE_MS) {
        await settleWithin(freshSpectate().catch(() => null), MAP_PLAYING_WAIT_MS);
        const { at, list } = await currentLobbyList();
        const lobbies = new Map(), games = new Map(); // mod id -> lobbies / games in progress using it
        for (const l of list) {
            const id = l.modId && pvModIds.has(l.modId) ? l.modId : pvModIdFor(l.modInfo);
            if (!id) continue;
            if (!lobbies.has(id)) lobbies.set(id, []);
            lobbies.get(id).push(l);
        }
        if (spectateFresh(spectateCache)) {
            for (const g of spectateCache.games.values()) {
                const id = pvModIdFor(g.modInfo);
                if (!id) continue;
                if (!games.has(id)) games.set(id, []);
                games.get(id).push({ id: g.id, map: g.map, startTime: g.startTime, players: g.players.filter(p => p.kind === 'human').length });
            }
        }
        const time = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; };
        const mods = pvMods.mods.map(m => ({ ...m, lobbies: lobbies.get(m.id) || [], games: games.get(m.id) || [] }))
            .sort((a, b) => time(b.updated) - time(a.updated) || time(b.created) - time(a.created) || b.id - a.id);
        modsPageCache = { at: Date.now(), body: MapPages.renderModsPage({ author: pvMods.author, readAt: pvMods.readAt, mods, lobbiesAt: at || null, stylesHref, isMatchId }) };
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=20' });
    res.end(modsPageCache.body);
}

// --- Map pages (map-pages.js): /maps/, /maps/<slug>, the sitemap, and the home page's links to busy maps -------------
// Server-rendered, so search engines read them without the site's script. Each answer is kept PAGE_CACHE_MS.
const MapPages = require('./map-pages');
const PAGE_CACHE_MS = 2 * 60 * 1000;
const PAGE_CACHE_MAX = 2000;
const pageCache = new Map(); // key -> { at, status, body, type }
let slugsCache = { at: -1, bySlug: new Map(), slugOf: new Map() };
let homeLinks = { at: 0, html: '' };
// The stylesheet as index.html links it (with its ?v=), so the pages get the same cached file
let stylesHref = '/styles.css';
try { stylesHref = (/\/styles\.css\?v=\d+/.exec(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')) || [stylesHref])[0]; } catch (e) { }

// The map list with each map's page address (slug), rebuilt with the list
function mapSlugs() {
    const maps = mapList();
    if (slugsCache.at !== maps.at) slugsCache = { at: maps.at, ...MapPages.slugIndex(maps.list) };
    return { maps, bySlug: slugsCache.bySlug, slugOf: slugsCache.slugOf };
}

// The lobby list as the home page last got it, rebuilt first when it is over a minute old (nobody on the site)
let lobbyListParsed = { at: -1, list: [] };
async function currentLobbyList() {
    if (Date.now() - lobbiesCache.at > 60000) {
        const pending = refreshLobbies();
        if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
    }
    if (lobbyListParsed.at !== lobbiesCache.at) {
        let list = [];
        try { list = JSON.parse(lobbiesCache.body || '{}').matches || []; } catch (e) { }
        lobbyListParsed = { at: lobbiesCache.at, list: Array.isArray(list) ? list : [] };
    }
    return lobbyListParsed;
}

function redirect(res, location) {
    res.writeHead(301, { Location: location, 'Cache-Control': 'public, max-age=3600' });
    res.end();
}

// Serves build()'s { status, body, type } from the cache, building it when missing or older than PAGE_CACHE_MS
async function sendCached(res, key, build) {
    const now = Date.now();
    let kept = pageCache.get(key);
    if (!kept || now - kept.at >= PAGE_CACHE_MS) {
        for (const [k, old] of pageCache) if (now - old.at >= PAGE_CACHE_MS) pageCache.delete(k);
        kept = { at: now, ...(await build()) };
        if (pageCache.size < PAGE_CACHE_MAX) pageCache.set(key, kept);
    }
    res.writeHead(kept.status, { 'Content-Type': kept.type || 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
    res.end(kept.body);
}

function mapPageUnavailable(res, e) {
    console.error('Map pages failed:', e.message);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    res.end('Map history unavailable, try again in a minute.');
}

async function serveMapsIndex(res) {
    try {
        await sendCached(res, 'maps-index', () => {
            const { maps, slugOf } = mapSlugs();
            return { status: 200, body: MapPages.renderMapsIndex({ list: maps.list, slugOf, since: maps.since, stylesHref }) };
        });
    } catch (e) { mapPageUnavailable(res, e); }
}

// raw: the path after /maps/, still percent-encoded
async function serveMapPage(res, raw) {
    let slug = '';
    try { slug = decodeURIComponent(raw); } catch (e) { }
    let found;
    try { found = mapSlugs(); } catch (e) { return mapPageUnavailable(res, e); }
    const map = found.bySlug.get(slug);
    if (!map) {
        // Another way of writing a map's address (capitals, spaces, a trailing slash) goes to the map's own
        const canonical = MapPages.mapSlug(slug);
        if (canonical && canonical !== slug && found.bySlug.has(canonical)) return redirect(res, MapPages.mapPath(canonical));
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' });
        res.end(MapPages.renderNotFound({ stylesHref }));
        return;
    }
    try {
        await sendCached(res, 'map:' + slug, async () => {
            const { at, list } = await currentLobbyList();
            // The map list may have been rebuilt meanwhile (new entries): take the map, its rank and the links from one list
            const { maps, bySlug, slugOf } = mapSlugs();
            const entry = bySlug.get(slug) || map;
            const key = entry.name.toLowerCase();
            const lobbies = list.filter(l => !l.isPlaying && typeof l.map === 'string' && l.map.toLowerCase() === key);
            const players = mapHistory.players(entry.stored, MapPages.TOP_PLAYERS).map(mapPlayerFromRow).filter(p => p.id);
            const body = MapPages.renderMapPage({
                map: entry, slug, rank: maps.list.indexOf(entry) + 1, since: maps.since, players, lobbies, lobbiesAt: at || null,
                related: maps.list.filter(MapPages.isIndexable), slugOf, stylesHref, isMatchId
            });
            return { status: 200, body };
        });
    } catch (e) { mapPageUnavailable(res, e); }
}

// The home page, the replay viewer, /maps/ and every map page busy enough to be indexed
async function serveSitemap(res) {
    await sendCached(res, 'sitemap', () => {
        const urls = [{ path: '/' }, { path: '/replay' }];
        if (pvMods.mods.length) urls.push({ path: '/mods', lastmod: Math.max(0, ...pvMods.mods.map(m => Date.parse(m.updated || '') || 0)) || null });
        try {
            const { maps, slugOf } = mapSlugs();
            const indexed = maps.list.filter(m => MapPages.isIndexable(m) && slugOf.has(m.name));
            urls.push({ path: '/maps/', lastmod: Math.max(0, ...indexed.map(m => m.last)) || null });
            for (const m of indexed) urls.push({ path: MapPages.mapPath(slugOf.get(m.name)), lastmod: m.last || null });
        } catch (e) {
            console.error('Sitemap: map history unavailable:', e.message);
        }
        return { status: 200, body: MapPages.renderSitemap(urls), type: 'application/xml; charset=utf-8' };
    });
}

// index.html, with links to the busiest maps' pages where it says <!-- popular-maps -->
async function serveHomePage(res) {
    let html;
    try {
        html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 500);
        res.end(e.code === 'ENOENT' ? 'File not found' : 'Server error: ' + e.code);
        return;
    }
    if (Date.now() - homeLinks.at >= PAGE_CACHE_MS) {
        let links = '';
        try { const { maps, slugOf } = mapSlugs(); links = MapPages.popularMapsHtml(maps.list, slugOf); } catch (e) { }
        homeLinks = { at: Date.now(), html: links };
    }
    html = html.replace('<!-- popular-maps -->', () => homeLinks.html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
}

async function handleRequest(req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // Read-only site: anything but GET/HEAD is refused before routing (so it can't trigger a rebuild), apart from the
    // keyed live relay
    const pathname = req.url.split('?')[0];
    const query = new URLSearchParams(req.url.split('?')[1] || '');
    if (req.method === 'POST' && pathname.startsWith('/api/live/') && isMatchId(pathname.slice('/api/live/'.length))) {
        const at = query.has('at') ? Number(query.get('at')) : -1;
        if (!Number.isSafeInteger(at) || at < 0) { res.writeHead(400); res.end(); return; }
        await receiveRelay(req, res, Number(pathname.slice('/api/live/'.length)), at, query.get('end') === '1');
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
    }

    // Spectate routes match the whole path (the query string is dropped): "/api/spectate", "/api/spectate/index",
    // "/api/spectate/<id>", "/api/spectate/player/<profileId>", and the pages "/spectate/<id>", "/overlay/<id>" and
    // "/overlay/player/<profileId>" with an optional trailing slash. Anything else under them is a 404, never a static file.
    // "/replay" is the replay viewer's page.
    if (pathname === '/api/live') {
        serveRelayList(res);
        return;
    }
    if (pathname.startsWith('/api/live/')) {
        const id = pathname.slice('/api/live/'.length);
        const from = Number(query.get('from') || 0);
        if (!isMatchId(id) || !Number.isSafeInteger(from) || from < 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a match id' }));
            return;
        }
        serveRelay(res, Number(id), from);
        return;
    }
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
    if (pathname === '/api/maps') {
        serveMapList(res);
        return;
    }
    if (pathname === '/mods' || pathname === '/mods/') {
        if (pathname === '/mods/') return redirect(res, '/mods');
        await serveModsPage(res);
        return;
    }
    if (pathname === '/api/maps/players') {
        serveMapPlayers(res, query).catch(e => console.error('Map players request failed:', e.message));
        return;
    }
    if (pathname === '/api/player-games') {
        await servePlayerGames(res, new URLSearchParams(req.url.split('?')[1] || '').get('q'));
        return;
    }
    if (pathname.startsWith('/api/replay/')) {
        const id = pathname.slice('/api/replay/'.length);
        if (!isMatchId(id)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not a match id' }));
            return;
        }
        await serveReplay(res, Number(id));
        return;
    }
    if (pathname === '/replay' || pathname === '/replay/') {
        await serveHtmlPage(res, 'replay.html', false);
        return;
    }
    if (pathname === '/maps') return redirect(res, '/maps/');
    if (pathname === '/maps/') return serveMapsIndex(res);
    if (pathname.startsWith('/maps/')) return serveMapPage(res, pathname.slice('/maps/'.length));
    if (pathname === '/sitemap.xml') return serveSitemap(res);
    if (pathname === '/' || pathname === '/index.html') return serveHomePage(res);
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

    if (pathname === '/api/lobbies/stream') {
        await serveLobbyStream(req, res);
        return;
    }
    if (req.url.startsWith('/api/lobbies')) {
        // Polled by pages whose stream is down (and by pages from before the stream). A poll waits for a fresh read when
        // Relic's list is out of date (its reads were failing). A failed read keeps the old body.
        watchLobbies();
        if (!lobbiesCache.body || Date.now() - relicOkAt > RELIC_WAIT_MS) {
            const pending = refreshLobbies();
            if (pending) await pending;
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
        '.jpg': 'image/jpeg',
        '.webp': 'image/webp',
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

// The Spectate list: the games kept over the restart, Relic's civ names, the lobby list read from now on, and
// aoe2companion's matchmaking games
loadLiveGames();
refreshRelicRaces();
setInterval(refreshRelicRaces, RACES_REFRESH_MS).unref();
watchLobbies();
connectCompanion();

// pm2 stop/reload sends SIGINT: finish in-flight requests, then exit (force it after 8 s). Open lobby streams are ended
// first (they would hold the server open); their pages reconnect to the new process. The games in progress are saved
// for the next process.
function shutdown() {
    for (const res of streamClients.keys()) res.end();
    clearTimeout(lobbyLoopTimer);
    saveLiveGames();
    try { mapHistoryWriter?.close(); } catch (e) { } // each snapshot is already committed
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
