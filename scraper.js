const fs = require('fs');
const path = require('path');

// Uses Node's global WebSocket (undici), which accepts { headers } as its second argument.
if (typeof WebSocket === 'undefined') {
    console.error('Node >=22.12 required (global WebSocket missing)');
    process.exit(1);
}

// Fail loudly: pm2 restarts the process (restart_delay in ecosystem.config.js) instead of a zombie
// that stays "online" but no longer scrapes.
process.on('unhandledRejection', e => { console.error('Unhandled rejection:', e); process.exit(1); });
process.on('uncaughtException', e => { console.error('Uncaught exception:', e); process.exit(1); });

const OUTPUT_PATH = path.join(__dirname, 'scraped_lobbies_v2.json');
const PLAYERS_PATH = path.join(__dirname, 'scraped_players_v2.json');

const WS_URL = 'wss://aoe2lobby.com/ws/lobby/';
const USER_AGENT = 'aoe2lobby.online lobby mirror (+https://aoe2lobby.online)';

// Value labels as aoe2lobby.com defines them. It also sends this table as "schema" when a socket
// connects; that live copy wins (see label()), these are the fallback.
const FALLBACK_SCHEMA = {
    mode: {
        0: "Random Map", 1: "Empire Wars", 2: "Regicide", 3: "King of the Hill", 4: "Death Match", 5: "Battle Royale",
        6: "Sudden Death", 7: "Capture the Relic", 8: "Defend the Wonder", 9: "Wonder Race", 10: "Custom Scenario", 11: "Co-Op Campaign"
    },
    size: {
        0: "Tiny (2 player)", 1: "Small (3 player)", 2: "Medium (4 player)", 3: "Normal (6 player)", 4: "Large (8 player)",
        5: "Huge", 6: "Ludicrous", 7: "Giant", 8: "Massive", 9: "Enormous", 10: "Colossal", 11: "Incredible", 12: "Monstrous"
    },
    speed: { 0: "Slow", 1: "Casual", 2: "Normal", 3: "Fast" },
    server: {
        0: "brazilsouth", 1: "australiasoutheast", 2: "ukwest", 3: "southeastasia", 4: "westeurope", 5: "westus3",
        6: "koreacentral", 7: "centralindia", 8: "eastus", 9: "chilecentral", 10: "southcentralus"
    },
    starting_age: { 0: "Standard", 1: "Dark Age", 2: "Feudal Age", 3: "Castle Age", 4: "Imperial Age", 5: "Post-Imperial Age" },
    resources: { 0: "Standard", 1: "Low", 2: "Medium", 3: "High", 4: "Ultra High", 5: "Infinite", 6: "Random" },
    // Civs newer than the live schema's table, which never labels them. The two feeds use different ids for the same civ: lobby
    // slots send the four-digit ids, and the spectate feed sends the two-digit ones. Both sets are here, and in NEW_CIVS in
    // server.js; keep the two in sync. The lobby ids aren't documented: each was checked against a finished game in match
    // history, so add one only once it has been seen. Don't work it out from the others: the steps of 10 they follow would give
    // Mapuche -1580, and the feed sends 75.
    civilization: {
        "-56": "Thracians", "-57": "Puru", "-61": "Saxons", "-62": "Varangians", "-63": "Danes",
        "-1540": "Macedonians", "-1600": "Saxons", "-1610": "Varangians", "-1620": "Danes"
    }
};
let liveSchema = null;

// Own string entries only, so a feed value such as "__proto__" or "constructor" cannot return a prototype member
function label(field, value, unknown = "Unknown") {
    if (typeof value !== 'string' && typeof value !== 'number') return unknown;
    const key = String(value);
    const live = liveSchema?.[field];
    if (live && typeof live === 'object' && Object.hasOwn(live, key) && typeof live[key] === 'string') return live[key];
    const fallback = FALLBACK_SCHEMA[field];
    if (fallback && Object.hasOwn(fallback, key)) return fallback[key];
    return unknown;
}

// A slot's civ. An id neither table labels is logged once, so the tables can be updated by hand, and shown as "Unknown civ" like
// the Spectate views. A slot with no civ stays null, and so does any id before the live schema arrives, when it can't be read.
const loggedUnknownCivs = new Set();
function civLabel(value) {
    const civ = label('civilization', value, null);
    if (civ || (typeof value !== 'string' && typeof value !== 'number') || !liveSchema?.civilization) return civ;
    const key = String(value);
    if (!loggedUnknownCivs.has(key) && loggedUnknownCivs.size < 100) {
        loggedUnknownCivs.add(key);
        console.log(`Lobby: civ id ${JSON.stringify(key.slice(0, 20))} has no label, shown as "Unknown civ" (add it to FALLBACK_SCHEMA.civilization and NEW_CIVS)`);
    }
    return 'Unknown civ';
}

// Feed ids are positive integers (numbers, or digit strings as object keys); anything else is dropped
function toId(value) {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

let lobbyMatchAll = null;
let lastDataAt = 0; // when the last lobby_match_all arrived
const startedAt = Date.now();
let lobbyEloUpdate = Object.create(null); // { profileId: { mode1: stats, mode2: stats } }
// When each player's ratings last arrived; players not seen for ELO_KEEP_MS are dropped so memory stays bounded
const eloSeenAt = new Map();
const ELO_KEEP_MS = 6 * 60 * 60 * 1000;

// Leaderboards to receive ratings for. aoe2lobby.com's page only subscribes to its defaults (0, 3, 4),
// so Empire Wars ratings would otherwise never arrive.
const ELO_TYPES = ['0', '3', '4', '13', '14'];

function mergeElo(update) {
    let merged = 0;
    if (!update || typeof update !== 'object') return merged;
    for (const mode of ELO_TYPES) {
        if (!Object.hasOwn(update, mode)) continue;
        const elos = update[mode];
        if (!elos || typeof elos !== 'object') continue;
        for (const profileId of Object.keys(elos)) {
            if (!/^\d+$/.test(profileId)) continue;
            const stats = elos[profileId];
            if (!stats || typeof stats !== 'object') continue;
            if (!lobbyEloUpdate[profileId]) lobbyEloUpdate[profileId] = Object.create(null);
            lobbyEloUpdate[profileId][mode] = stats;
            eloSeenAt.set(profileId, Date.now());
            merged++;
        }
    }
    return merged;
}

// When each player's current stay in lobbies began: the first snapshot that listed them in any lobby slot, kept while
// they move between lobbies. Missing from the snapshots for over PRESENCE_GAP_MS starts a new stay. Written as
// inLobbySince: server.js waits RATINGS_WAIT_MS from it for a joining player's ratings before showing "No games on
// this ladder", and this clock runs every SNAPSHOT_MS whether or not anyone is on the site.
const PRESENCE_GAP_MS = 45000;
const presence = new Map(); // profileId -> { since, last }

function stayStart(profileId, now) {
    let stay = presence.get(profileId);
    if (!stay || now - stay.last > PRESENCE_GAP_MS) presence.set(profileId, stay = { since: now, last: now });
    stay.last = now;
    return stay.since;
}

// --- Map regulars (the Maps view): how many of each map's lobbies each player has been in -------------------------
// A player counts once per lobby (match id + map, so a host changing the map counts again). Kept in
// MAP_PLAYERS_PATH, which server.js reads; it matches scraped_*_v2.json, so deploys keep it. Map names are the
// feed's own (numbers are Steam mod maps, named by server.js); generic names say nothing about the map and are skipped.
const MAP_PLAYERS_PATH = path.join(__dirname, 'scraped_map_players_v2.json');
const MAP_GENERIC = new Set(['unknown map', 'my map', 'custom map', '']);
const MAP_LIVE_KEEP_MS = 2 * 60 * 1000; // a lobby gone from the feed this long has closed; a shorter gap isn't counted twice
const MAP_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // a player (or map) not seen for this long is dropped, unless a regular
const MAP_KEEP_COUNT = 3; // players seen in this many of a map's lobbies are kept however long ago
const MAP_MAX_PLAYERS = 2000; // per map, most appearances first
const MAP_MAX_MAPS = 1000; // most lobbies first
const MAP_SAVE_MS = 60000;
const mapCounts = new Map(); // map name -> { lobbies, last, players: Map<profileId, { n, last }> }
const mapPlayerInfo = new Map(); // profileId -> { name, steam, stats, last }: as last seen in any lobby
const mapLive = new Map(); // `${matchId}|${map}` -> { last, players: Set<profileId> }: lobbies already counted
let mapSince = Date.now(), mapDirty = false, mapSavedAt = 0;

// The file is arrays, never objects keyed by feed text, so a map called "__proto__" is just a name
function loadMapPlayers() {
    let d;
    try { d = JSON.parse(fs.readFileSync(MAP_PLAYERS_PATH, 'utf8')); } catch (e) { return; } // first run: start counting now
    if (!d || d.version !== 1) return;
    if (Number.isSafeInteger(d.since) && d.since > 0) mapSince = d.since;
    for (const m of Array.isArray(d.maps) ? d.maps : []) {
        if (!Array.isArray(m) || typeof m[0] !== 'string' || !Array.isArray(m[3])) continue;
        const players = new Map();
        for (const p of m[3]) if (Array.isArray(p) && typeof p[0] === 'string') players.set(p[0], { n: Number(p[1]) || 0, last: Number(p[2]) || 0 });
        mapCounts.set(m[0], { lobbies: Number(m[1]) || 0, last: Number(m[2]) || 0, players });
    }
    for (const p of Array.isArray(d.players) ? d.players : []) {
        if (Array.isArray(p) && typeof p[0] === 'string') mapPlayerInfo.set(p[0], { name: String(p[1] ?? ''), steam: p[2] || null, last: Number(p[3]) || 0, stats: p[4] && typeof p[4] === 'object' ? p[4] : null });
    }
    // Lobbies counted before a restart, so a restart doesn't count them again
    for (const l of Array.isArray(d.live) ? d.live : []) {
        if (Array.isArray(l) && typeof l[0] === 'string' && Array.isArray(l[2])) mapLive.set(l[0], { last: Number(l[1]) || 0, players: new Set(l[2].map(String)) });
    }
    console.log(`Map regulars: ${mapCounts.size} maps, ${mapPlayerInfo.size} players, counting since ${new Date(mapSince).toISOString()}`);
}

// Ratings worth keeping for the Maps view: the four numbers it shows, per ladder
function slimStats(stats) {
    const out = {};
    for (const ladder of Object.keys(stats || {})) {
        const s = stats[ladder];
        if (!s || typeof s !== 'object') continue;
        out[ladder] = { rating: s.rating, games: s.games, wins: s.wins, winp: s.winp };
    }
    return Object.keys(out).length ? out : null;
}

function recordMapLobby(matchId, mapName, players, now) {
    if (typeof mapName === 'number') mapName = String(mapName);
    if (typeof mapName !== 'string') return;
    const map = mapName.trim().slice(0, 120);
    if (MAP_GENERIC.has(map.toLowerCase())) return;
    let entry = mapCounts.get(map);
    if (!entry) mapCounts.set(map, entry = { lobbies: 0, last: now, players: new Map() });
    entry.last = now;
    const key = `${matchId}|${map}`;
    let live = mapLive.get(key);
    if (!live) { mapLive.set(key, live = { last: now, players: new Set() }); entry.lobbies++; }
    live.last = now;
    for (const p of players) {
        const id = String(p.profileId);
        let rec = entry.players.get(id);
        if (!rec) entry.players.set(id, rec = { n: 0, last: now });
        if (!live.players.has(id)) { live.players.add(id); rec.n++; }
        rec.last = now;
        const prev = mapPlayerInfo.get(id);
        mapPlayerInfo.set(id, { name: p.name, steam: p.steamProfile || prev?.steam || null, stats: slimStats(p.stats) || prev?.stats || null, last: now });
    }
    mapDirty = true;
}

// After each snapshot: forget closed lobbies, and save at most every MAP_SAVE_MS (or now, at shutdown)
function finishMapSnapshot(now, force = false) {
    for (const [key, live] of mapLive) if (now - live.last > MAP_LIVE_KEEP_MS) mapLive.delete(key);
    if (!mapDirty || (!force && now - mapSavedAt < MAP_SAVE_MS)) return;
    const maps = [];
    const keep = new Set();
    const byLobbies = [...mapCounts].sort((a, b) => b[1].lobbies - a[1].lobbies);
    for (const [name, entry] of byLobbies) {
        let players = [...entry.players].filter(([, r]) => r.n >= MAP_KEEP_COUNT || now - r.last <= MAP_KEEP_MS);
        players.sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last);
        players = players.slice(0, MAP_MAX_PLAYERS);
        if (!players.length || maps.length >= MAP_MAX_MAPS) { mapCounts.delete(name); continue; }
        entry.players = new Map(players);
        for (const [id] of players) keep.add(id);
        maps.push([name, entry.lobbies, entry.last, players.map(([id, r]) => [id, r.n, r.last])]);
    }
    for (const id of mapPlayerInfo.keys()) if (!keep.has(id)) mapPlayerInfo.delete(id);
    const players = [...mapPlayerInfo].map(([id, p]) => [id, p.name, p.steam, p.last, p.stats]);
    const live = [...mapLive].map(([key, l]) => [key, l.last, [...l.players]]);
    if (writeJsonAtomic(MAP_PLAYERS_PATH, { version: 1, since: mapSince, savedAt: now, maps, players, live })) {
        mapDirty = false;
        mapSavedAt = now;
    }
}

// Only the ladders this player has data on
function playerStats(profileId) {
    const all = lobbyEloUpdate[profileId];
    const stats = {};
    if (all) {
        for (const mode of ELO_TYPES) {
            if (all[mode] && Object.keys(all[mode]).length) stats[mode] = all[mode];
        }
    }
    return stats;
}

// aoe2lobby.com sends a full snapshot when a socket connects but no live updates afterwards,
// so take a fresh snapshot over a short-lived socket every SNAPSHOT_MS. This is the only source.
const SNAPSHOT_MS = 15000;
const SNAPSHOT_TIMEOUT_MS = 10000;
function takeSnapshot() {
    return new Promise(resolve => {
        let ws;
        let gotMatches = false, gotElo = false, finished = false;
        const done = (reason) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            try { ws.close(); } catch (e) { }
            if (gotMatches) {
                // Lobbies are fresh even if the rating update did not arrive; ratings from earlier snapshots are kept
                try { dumpData(); } catch (e) { console.error('Failed to save snapshot:', e); }
            } else {
                console.error(`Snapshot failed: ${reason}`);
            }
            resolve();
        };
        const timer = setTimeout(() => done(`no lobby_match_all within ${SNAPSHOT_TIMEOUT_MS / 1000} s`), SNAPSHOT_TIMEOUT_MS);
        try {
            ws = new WebSocket(WS_URL, { headers: { 'User-Agent': USER_AGENT } });
        } catch (e) {
            return done(e.message);
        }
        ws.onopen = () => ws.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'lobby', ids: ELO_TYPES }));
        ws.onerror = (e) => done(`socket error ${e?.message || e?.error?.message || ''}`.trim());
        ws.onclose = (e) => done(`socket closed (code ${e?.code})`);
        ws.onmessage = (msg) => {
            if (finished) return;
            try {
                const data = JSON.parse(msg.data);
                if (data.schema && typeof data.schema === 'object') liveSchema = data.schema;
                if (data.lobby_match_all && typeof data.lobby_match_all === 'object') {
                    lobbyMatchAll = data.lobby_match_all;
                    lastDataAt = Date.now();
                    gotMatches = true;
                }
                if (data.lobby_elo_update) { mergeElo(data.lobby_elo_update); gotElo = true; }
                if (gotMatches && gotElo) done();
            } catch (e) {
                console.error('Bad snapshot message:', e.message);
            }
        };
    });
}

// One snapshot at a time: a slow one makes the next tick skip instead of opening a second socket
let snapshotInFlight = false;
async function snapshotTick() {
    if (snapshotInFlight) return;
    snapshotInFlight = true;
    try {
        await takeSnapshot();
    } finally {
        snapshotInFlight = false;
    }
}

// Write to a temp file and rename it over the target, so the server never reads a half-written file
function writeJsonAtomic(file, obj) {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.error('Failed to write ' + file + ':', e.message);
        try { fs.unlinkSync(tmp); } catch (_) { }
        return false;
    }
}

const MAX_DATA_AGE_MS = 60000;
let lastSavedSummary = '';

function dumpData() {
    if (!lobbyMatchAll) return;
    // Never refresh the files (and their mtime) with a frozen snapshot: the server treats old files as stale
    if (Date.now() - lastDataAt > MAX_DATA_AGE_MS) return;

    // Keyed by String(matchid) and String(profileId), never by display name
    const scrapedLobbies = Object.create(null);
    const scrapedPlayers = Object.create(null);

    const now = Date.now();
    for (const [profileId, seenAt] of eloSeenAt) {
        if (now - seenAt > ELO_KEEP_MS) { eloSeenAt.delete(profileId); delete lobbyEloUpdate[profileId]; }
    }
    // Stays that have ended: stayStart would start a new one anyway, so this only keeps the map small
    for (const [profileId, stay] of presence) {
        if (now - stay.last > PRESENCE_GAP_MS) presence.delete(profileId);
    }

    for (const key of Object.keys(lobbyMatchAll)) {
      // One malformed lobby is skipped, never the whole write
      try {
        const lobby = lobbyMatchAll[key];
        if (!lobby || typeof lobby !== 'object') continue;
        const matchId = toId(lobby.matchid) ?? toId(key);
        if (matchId === null) continue;
        let hostProfileId = toId(lobby.host_profileid);

        let hostName = 'UNKNOWN';
        const players = [];

        if (lobby.slots && typeof lobby.slots === 'object') {
            for (const slot of Object.values(lobby.slots)) {
                if (!slot || typeof slot.name !== 'string' || !slot.name || slot.name === 'Closed' || slot.name === 'Open') continue;
                const profileId = toId(slot.profileid);
                if (profileId === null) continue;
                if (profileId === hostProfileId) hostName = slot.name;

                const steamProfile = typeof slot.steam_profile === 'string' && slot.steam_profile ? slot.steam_profile : null;
                const civ = civLabel(slot.civilization); // e.g. Franks, or Random / Custom / Hidden before the game starts
                const stats = playerStats(profileId);
                const inLobbySince = stayStart(String(profileId), now);

                scrapedPlayers[String(profileId)] = { profileId, name: slot.name, steamProfile, civ, stats, inLobbySince };
                players.push({ name: slot.name, profileId, civ, steamProfile, stats, inLobbySince });
            }
        }

        if (hostName === 'UNKNOWN' && players.length > 0) {
            // The listed host isn't in the slots: use the first player for both the name and the id
            hostName = players[0].name;
            hostProfileId = players[0].profileId;
        }
        if (hostName === 'UNKNOWN') continue;
        recordMapLobby(String(matchId), lobby.map_name, players, now);

        scrapedLobbies[String(matchId)] = {
            matchId: String(matchId),
            host: hostName,
            hostProfileId,
            title: typeof lobby.description === 'string' ? lobby.description : "",
            map: typeof lobby.map_name === 'string' && lobby.map_name ? lobby.map_name : "Unknown Map",
            isPlaying: lobby.open_slots === false,
            slotsTotal: Number.isSafeInteger(lobby.slots_total) ? lobby.slots_total : 0, // slots a player can take (open + taken); closed and AI slots excluded
            aiSlots: Object.values(lobby.slots || {}).filter(slot => slot && slot.status === 2).length,
            password: lobby.password === true,
            createdTime: Number.isSafeInteger(lobby.created_time) && lobby.created_time > 0 ? lobby.created_time : null, // unix seconds
            players: players,
            settings: {
                Mode: label('mode', lobby.mode),
                Size: label('size', lobby.size),
                Population: Number.isFinite(lobby.population) && lobby.population > 0 ? String(lobby.population) : "Unknown",
                Speed: label('speed', lobby.speed),
                "Starting Age": label('starting_age', lobby.starting_age),
                Resources: label('resources', lobby.resources, lobby.resources == null ? "Unknown" : "Custom"),
                Treaty: Number.isFinite(lobby.treaty_length) && lobby.treaty_length > 0 ? lobby.treaty_length : 0, // minutes, 0 = none
                "Data Mod": typeof lobby.data_mod === 'string' && lobby.data_mod ? lobby.data_mod : "No Mods",
                Server: label('server', lobby.server)
            }
        };
      } catch (e) {
        console.error('Skipped malformed lobby', key + ':', e.message);
      }
    }

    const savedLobbies = writeJsonAtomic(OUTPUT_PATH, scrapedLobbies);
    const savedPlayers = writeJsonAtomic(PLAYERS_PATH, scrapedPlayers);
    finishMapSnapshot(now);
    // Log only when the counts change, to keep pm2 logs small
    const summary = `${Object.keys(scrapedLobbies).length} lobbies and ${Object.keys(scrapedPlayers).length} players`;
    if (savedLobbies && savedPlayers && summary !== lastSavedSummary) {
        console.log(`Saved ${summary} to disk.`);
        lastSavedSummary = summary;
    }
}

// Watchdog: if no lobby_match_all arrives for WATCHDOG_MS, exit so pm2 restarts the scraper
const WATCHDOG_MS = 180000;
setInterval(() => {
    const since = Math.max(lastDataAt, startedAt);
    if (Date.now() - since > WATCHDOG_MS) {
        console.error(`No lobby_match_all from aoe2lobby.com for ${Math.round((Date.now() - since) / 1000)} s; exiting so pm2 restarts the scraper.`);
        process.exit(1);
    }
}, 10000);

// pm2 stop/reload sends SIGINT: save the map counts first, so up to a minute of them isn't lost
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        try { finishMapSnapshot(Date.now(), true); } catch (e) { console.error('Failed to save map regulars:', e.message); }
        process.exit(0);
    });
}

console.log(`Starting aoe2lobby.com lobby scraper (direct WebSocket snapshot every ${SNAPSHOT_MS / 1000} s)...`);
loadMapPlayers();
snapshotTick();
setInterval(snapshotTick, SNAPSHOT_MS);
