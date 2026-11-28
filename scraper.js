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

// aoe2lobby.com's page opens its sockets on data.aoe2lobby.com (getBaseDomain in its script). On 26 Nov 2026 the old host
// began refusing every handshake (403), and the lobby data stopped for 17 hours. The old host stays as the second choice:
// after a socket that never opened, the next attempt tries the other host.
const WS_HOSTS = ['data.aoe2lobby.com', 'aoe2lobby.com'];
let wsHostIndex = 0;
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
    // server.js; keep the two in sync. Neither feed documents them. The two-digit id is the civ's number in the game's
    // own civ list (resources/_common/dat/civilizations.json, position + 1: 55 Macedonians, 56 Thracians, 57 Puru, 61-63
    // Saxons, Varangians, Danes), negated. The lobby id is -(990 + 10 x that number): -1540, -1600, -1610 and -1620 were each
    // checked against a finished game in match history, and -1550 and -1560 (Thracians and Puru, Chronicles: Alexander the
    // Great) follow from the game's list. The rule holds only for ids the schema lacks: a civ it knows arrives as the
    // schema's id (Mapuche, number 59, as 75, not -1580). A new id gets logged with a player and lobby to check it against.
    civilization: {
        "-56": "Thracians", "-57": "Puru", "-61": "Saxons", "-62": "Varangians", "-63": "Danes",
        "-1540": "Macedonians", "-1550": "Thracians", "-1560": "Puru", "-1600": "Saxons", "-1610": "Varangians", "-1620": "Danes"
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

// A slot's civ. An id neither table labels is logged once, with the first player and lobby seen with it (their finished game
// in match history, e.g. aoe2companion's /api/matches?profile_ids=<player>, names the civ), so the tables can be updated by
// hand, and shown as "Unknown civ" like the Spectate views. A slot with no civ stays null, and so does any id before the live
// schema arrives, when it can't be read.
const loggedUnknownCivs = new Set();
function civLabel(value, profileId, matchId) {
    const civ = label('civilization', value, null);
    if (civ || (typeof value !== 'string' && typeof value !== 'number') || !liveSchema?.civilization) return civ;
    const key = String(value);
    if (!loggedUnknownCivs.has(key) && loggedUnknownCivs.size < 100) {
        loggedUnknownCivs.add(key);
        console.log(`Lobby: civ id ${JSON.stringify(key.slice(0, 20))} has no label, shown as "Unknown civ" (player ${profileId} in lobby ${matchId}; add it to FALLBACK_SCHEMA.civilization and NEW_CIVS)`);
    }
    return 'Unknown civ';
}

// Feed ids are positive integers (numbers, or digit strings as object keys); anything else is dropped
function toId(value) {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

let lobbyMatchAll = null; // match id -> lobby, kept current from the socket's messages
let lastDataAt = 0; // when the last lobby list or update arrived
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

// When each player's current stay in lobbies began: the first write that listed them in any lobby slot, kept while
// they move between lobbies. Missing from the writes for over PRESENCE_GAP_MS starts a new stay. Written as
// inLobbySince: server.js waits RATINGS_WAIT_MS from it for a joining player's ratings before showing "No games on
// this ladder", and this clock runs on every update (about every 3 s) whether or not anyone is on the site.
const PRESENCE_GAP_MS = 45000;
const presence = new Map(); // profileId -> { since, last }

function stayStart(profileId, now) {
    let stay = presence.get(profileId);
    if (!stay || now - stay.last > PRESENCE_GAP_MS) presence.set(profileId, stay = { since: now, last: now });
    stay.last = now;
    return stay.since;
}

// --- Map history (the Maps view): how many of each map's lobbies each player has been in, kept in SQLite (map-history.js).
// Since 28 Nov 2026 server.js counts it from Relic's lobby list (aoe2lobby.com has blocked this server), and only one
// process may write map_history.sqlite, so this file no longer does.

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

// aoe2lobby.com's socket sends the whole lobby list when it connects (lobby_match_all) with the players' ratings, then,
// while its live updates work, about every 3 s the lobbies again (lobby_match_update, merged in the way aoe2lobby.com's own
// page does: added over the list) and the ones that closed (lobby_match_remove). Its updates come and go: on 25 Nov 2026
// they stopped after its server restarted, and every socket got the list and nothing more. So the socket stays open while
// updates come, and when none comes for DATA_WAIT_MS a new socket takes a fresh list. Either way the files are rewritten
// within a few seconds of a change.
const WRITE_DELAY_MS = 150; // the ratings for an update arrive just after it: write once, with both
const DATA_WAIT_MS = 5000; // updates come every ~3 s; this long without one, take a fresh list
const FIRST_LIST_MS = 15000; // a new socket that sends no list in this time has failed
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RESYNC_MS = 30 * 60 * 1000; // a fresh whole list now and then, in case a removal was ever missed
// Since 28 Nov 2026 13:28 CET data.aoe2lobby.com drops every connection from this server (ping answers, TCP times out;
// the same socket opens from elsewhere): it has blocked us. While no socket opens on either host, try once every
// BLOCKED_RETRY_MS, and don't let the watchdog restart the process (a restart would only knock again at once).
const BLOCKED_RETRY_MS = 10 * 60 * 1000;
let unopenedInARow = 0; // sockets in a row that never opened
let ws = null, wsOpenedAt = 0, wsOpened = false, waitTimer = null, writeTimer = null, reconnectMs = RECONNECT_MIN_MS;
let liveUpdates = null; // whether aoe2lobby.com is sending live updates, as last logged

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function connect() {
    let sock;
    wsOpened = false;
    try {
        sock = new WebSocket(`wss://${WS_HOSTS[wsHostIndex]}/ws/lobby/`, { headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
        return dropSocket(e.message);
    }
    ws = sock;
    wsOpenedAt = Date.now();
    let updates = 0;
    armWait(FIRST_LIST_MS, () => dropSocket(`no lobby list within ${FIRST_LIST_MS / 1000} s`));
    sock.onopen = () => {
        wsOpened = true;
        sock.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'lobby', ids: ELO_TYPES }));
    };
    sock.onerror = (e) => { if (sock === ws) dropSocket(`socket error ${e?.message || e?.error?.message || ''}`.trim()); };
    sock.onclose = (e) => { if (sock === ws) dropSocket(`socket closed (code ${e?.code})`); };
    sock.onmessage = (msg) => {
        if (sock !== ws) return;
        const kind = onMessage(msg.data);
        if (!kind) return; // ratings and the like: the wait is for lobbies
        if (kind === 'update') { updates++; noteLiveUpdates(true); }
        // Planned: reconnect for a fresh whole list (no backoff, nothing logged)
        if (Date.now() - wsOpenedAt > RESYNC_MS) return dropSocket(null);
        armWait(DATA_WAIT_MS, () => {
            if (!updates) noteLiveUpdates(false);
            dropSocket(null);
        });
    };
}

function armWait(ms, onTimeout) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(onTimeout, ms);
}

// Logged only when it changes (in snapshot mode the socket is replaced every few seconds)
function noteLiveUpdates(on) {
    if (liveUpdates === on) return;
    liveUpdates = on;
    console.log(on ? 'aoe2lobby.com is sending live updates: following them'
        : `aoe2lobby.com is sending no live updates: taking a fresh list every ${DATA_WAIT_MS / 1000} s`);
}

// Close the socket and open another: at once for a fresh list (reason null), else after a delay that doubles up to
// RECONNECT_MAX_MS while it keeps failing. The files stop being rewritten meanwhile, so the server sees them go stale.
function dropSocket(reason) {
    const sock = ws;
    ws = null;
    clearTimeout(waitTimer);
    if (sock) { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; try { sock.close(); } catch (e) { } }
    unopenedInARow = wsOpened ? 0 : unopenedInARow + 1;
    const blocked = unopenedInARow >= 2 * WS_HOSTS.length; // every host refused, twice over
    const delay = reason === null ? 0 : blocked ? BLOCKED_RETRY_MS : reconnectMs;
    if (reason !== null) {
        const host = WS_HOSTS[wsHostIndex];
        if (!wsOpened) wsHostIndex = (wsHostIndex + 1) % WS_HOSTS.length; // refused: try the other host next
        // While blocked, logged once per hour (each attempt is 10 min apart)
        if (!blocked || unopenedInARow % 6 === 0) {
            console.error(`Socket (${host}): ${reason}; reconnecting in ${delay / 1000} s${!wsOpened ? ` to ${WS_HOSTS[wsHostIndex]}` : ''}` +
                (blocked ? ` (no socket has opened in ${unopenedInARow} tries: the host seems to block this server)` : ''));
        }
        reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
    }
    setTimeout(connect, delay);
}

// Applies one socket message. Returns 'all' for a whole lobby list, 'update' for live updates, else null.
function onMessage(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        console.error('Bad socket message:', e.message);
        return null;
    }
    if (!isObject(data)) return null;
    if (isObject(data.schema)) liveSchema = data.schema;
    let changed = false;
    // A null-prototype object: a feed key such as "__proto__" stays a plain entry (dumpData checks every entry)
    if (isObject(data.lobby_match_all)) {
        lobbyMatchAll = Object.assign(Object.create(null), data.lobby_match_all);
        lastDataAt = Date.now();
        reconnectMs = RECONNECT_MIN_MS; // a whole list arrived: the connection works
        changed = true;
    }
    if (lobbyMatchAll && isObject(data.lobby_match_update)) {
        Object.assign(lobbyMatchAll, data.lobby_match_update);
        lastDataAt = Date.now();
        changed = true;
    }
    if (lobbyMatchAll && Array.isArray(data.lobby_match_remove)) {
        for (const id of data.lobby_match_remove) {
            if ((typeof id === 'string' || typeof id === 'number') && Object.hasOwn(lobbyMatchAll, String(id))) {
                delete lobbyMatchAll[String(id)];
                changed = true;
            }
        }
    }
    if (data.lobby_elo_update && mergeElo(data.lobby_elo_update) > 0) changed = true;
    if (changed && lobbyMatchAll) scheduleWrite();
    return isObject(data.lobby_match_all) ? 'all' : (lobbyMatchAll && isObject(data.lobby_match_update)) ? 'update' : null;
}

function scheduleWrite() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
        writeTimer = null;
        try { dumpData(); } catch (e) { console.error('Failed to save lobbies:', e); }
    }, WRITE_DELAY_MS);
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
                const civ = civLabel(slot.civilization, profileId, matchId); // e.g. Franks, or Random / Custom / Hidden before the game starts
                const stats = playerStats(profileId);
                const inLobbySince = stayStart(String(profileId), now);

                // The slot's team as the lobby sets it: 1 none ("-"), 2-5 teams 1-4, 0 or 6 random ("?"); server.js reads it
                const team = Number.isSafeInteger(slot.team) && slot.team >= 0 && slot.team <= 6 ? slot.team : null;

                scrapedPlayers[String(profileId)] = { profileId, name: slot.name, steamProfile, civ, stats, inLobbySince };
                players.push({ name: slot.name, profileId, civ, steamProfile, stats, inLobbySince, team });
            }
        }

        if (hostName === 'UNKNOWN' && players.length > 0) {
            // The listed host isn't in the slots: use the first player for both the name and the id
            hostName = players[0].name;
            hostProfileId = players[0].profileId;
        }
        if (hostName === 'UNKNOWN') continue;

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
    // Log only when the counts change, to keep pm2 logs small
    const summary = `${Object.keys(scrapedLobbies).length} lobbies and ${Object.keys(scrapedPlayers).length} players`;
    if (savedLobbies && savedPlayers && summary !== lastSavedSummary) {
        console.log(`Saved ${summary} to disk.`);
        lastSavedSummary = summary;
    }
}

// Watchdog: if no lobby list or update arrives for WATCHDOG_MS (reconnecting hasn't helped), exit so pm2 restarts the scraper
const WATCHDOG_MS = 180000;
setInterval(() => {
    const since = Math.max(lastDataAt, startedAt);
    // Not while sockets don't even open: the host refuses us, and a restart would only try again at once
    if (Date.now() - since > WATCHDOG_MS && unopenedInARow < 2 * WS_HOSTS.length) {
        console.error(`No lobbies from aoe2lobby.com for ${Math.round((Date.now() - since) / 1000)} s; exiting so pm2 restarts the scraper.`);
        process.exit(1);
    }
}, 10000);

// pm2 stop/reload sends SIGINT: exit at once (the files are written whole, by rename)
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => process.exit(0));
}

console.log('Starting aoe2lobby.com lobby scraper (one live WebSocket; the files are rewritten on each update)...');
connect();
