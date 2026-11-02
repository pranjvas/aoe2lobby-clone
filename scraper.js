const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'scraped_lobbies_v2.json');
const PLAYERS_PATH = path.join(__dirname, 'scraped_players_v2.json');

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
    starting_age: { 0: "Standard", 1: "Dark Age", 2: "Feudal Age", 3: "Castle Age", 4: "Imperial Age", 5: "Post-Imperial Age" },
    resources: { 0: "Standard", 1: "Low", 2: "Medium", 3: "High", 4: "Ultra High", 5: "Infinite", 6: "Random" }
};
let liveSchema = null;

function label(field, value, unknown = "Unknown") {
    if (value === null || value === undefined) return unknown;
    return liveSchema?.[field]?.[String(value)] ?? FALLBACK_SCHEMA[field]?.[value] ?? unknown;
}

let lobbyMatchAll = null;
let lobbyEloUpdate = {}; // { profileId: { mode1: stats, mode2: stats } }

// Leaderboards to receive ratings for. aoe2lobby.com's page only subscribes to its defaults (0, 3, 4),
// so Empire Wars ratings would otherwise never arrive.
const ELO_TYPES = ['0', '3', '4', '13', '14'];

function mergeElo(update) {
    let merged = 0;
    for (const mode in update) {
        const elos = update[mode];
        for (const profileId in elos) {
            if (!lobbyEloUpdate[profileId]) lobbyEloUpdate[profileId] = {};
            lobbyEloUpdate[profileId][mode] = elos[profileId];
            merged++;
        }
    }
    return merged;
}

// aoe2lobby.com sends a full snapshot when a socket connects but no live updates afterwards,
// so take a fresh snapshot over a short-lived socket every SNAPSHOT_MS (Node 22+ global WebSocket).
const SNAPSHOT_MS = 15000;
function takeSnapshot() {
    return new Promise(resolve => {
        let ws;
        let gotMatches = false, gotElo = false;
        const done = () => {
            clearTimeout(timer);
            try { ws.close(); } catch (e) { }
            resolve();
        };
        const timer = setTimeout(done, 10000);
        try {
            ws = new WebSocket('wss://aoe2lobby.com/ws/lobby/');
        } catch (e) {
            return done();
        }
        ws.onopen = () => ws.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'lobby', ids: ELO_TYPES }));
        ws.onerror = done;
        ws.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data);
                if (data.schema) liveSchema = data.schema;
                if (data.lobby_match_all) { lobbyMatchAll = data.lobby_match_all; gotMatches = true; }
                if (data.lobby_elo_update) { mergeElo(data.lobby_elo_update); gotElo = true; }
                if (gotMatches && gotElo) { dumpData(); done(); }
            } catch (e) { }
        };
    });
}

function scheduleDump() {
    clearTimeout(global.dumpTimeout);
    global.dumpTimeout = setTimeout(dumpData, 2000);
}

async function dumpData() {
    if (!lobbyMatchAll) return;

    const scrapedLobbies = {};
    const scrapedPlayers = {};

    for (const matchId in lobbyMatchAll) {
        const lobby = lobbyMatchAll[matchId];
        
        let hostName = 'UNKNOWN';
        const players = [];
        
        if (lobby.slots) {
            for (const slotKey in lobby.slots) {
                const slot = lobby.slots[slotKey];
                if (slot.name && slot.name !== 'Closed' && slot.name !== 'Open') {
                    if (slot.profileid === lobby.host_profileid) {
                        hostName = slot.name;
                    }

                    const pStats = lobbyEloUpdate[slot.profileid] || {};
                    
                    scrapedPlayers[slot.name.toLowerCase()] = {
                        profileId: slot.profileid,
                        stats: pStats // Store all stats for all modes!
                    };

                    players.push({
                        name: slot.name,
                        profileId: slot.profileid,
                        civ: slot.civilization ? slot.civilization.toString() : "",
                        stats: pStats
                    });
                }
            }
        }
        
        if (hostName === 'UNKNOWN' && players.length > 0) {
            hostName = players[0].name;
        }
        if (hostName === 'UNKNOWN') continue;

        scrapedLobbies[hostName.toLowerCase()] = {
            host: hostName,
            title: lobby.description || "",
            map: lobby.map_name || "Unknown Map",
            isPlaying: lobby.open_slots === false,
            slotsTotal: lobby.slots_total,
            players: players,
            settings: {
                Mode: label('mode', lobby.mode),
                Size: label('size', lobby.size),
                Population: lobby.population ? lobby.population.toString() : "Unknown",
                Speed: label('speed', lobby.speed),
                "Starting Age": label('starting_age', lobby.starting_age),
                Resources: label('resources', lobby.resources, lobby.resources == null ? "Unknown" : "Custom"),
                Treaty: lobby.treaty_length || 0, // minutes, 0 = none
                "Data Mod": lobby.data_mod || "No Mods",
                Server: "Global"
            }
        };
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(scrapedLobbies, null, 2));
    fs.writeFileSync(PLAYERS_PATH, JSON.stringify(scrapedPlayers, null, 2));
    console.log(`Saved ${Object.keys(scrapedLobbies).length} lobbies and ${Object.keys(scrapedPlayers).length} players to disk.`);
}

(async () => {
    console.log("Starting WebSocket interceptor for aoe2lobby.com in daemon mode...");
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: process.env.PUPPETEER_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []
    });
    const page = await browser.newPage();
    // Ask aoe2lobby.com's socket for every leaderboard we show, not just the page defaults
    await page.evaluateOnNewDocument((eloTypes) => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
            ws.addEventListener('open', () => {
                ws.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'lobby', ids: eloTypes }));
            });
            return ws;
        };
        window.WebSocket.prototype = NativeWebSocket.prototype;
        Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    }, ELO_TYPES);
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    
    cdp.on('Network.webSocketFrameReceived', response => {
        try {
            const payload = response.response.payloadData;
            if (payload.includes('"schema":')) {
                const data = JSON.parse(payload);
                if (data.schema) liveSchema = data.schema;
            }
            if (payload.includes('"lobby_match_all":')) {
                const data = JSON.parse(payload);
                if (data.lobby_match_all) {
                    lobbyMatchAll = data.lobby_match_all;
                    dumpData();
                }
            }
            // Live changes between full snapshots: new/changed lobbies and closed lobbies
            if (lobbyMatchAll && payload.includes('"lobby_match_update":')) {
                const data = JSON.parse(payload);
                if (data.lobby_match_update) {
                    Object.assign(lobbyMatchAll, data.lobby_match_update);
                    scheduleDump();
                }
            }
            if (lobbyMatchAll && payload.includes('"lobby_match_remove":')) {
                const data = JSON.parse(payload);
                if (Array.isArray(data.lobby_match_remove)) {
                    for (const id of data.lobby_match_remove) delete lobbyMatchAll[id];
                    scheduleDump();
                }
            }
            if (payload.includes('"lobby_elo_update":')) {
                const data = JSON.parse(payload);
                if (data.lobby_elo_update && mergeElo(data.lobby_elo_update) > 0) scheduleDump();
            }
        } catch (e) { }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    
    // Periodically dump data every 20 seconds as a fallback
    setInterval(dumpData, 20000);

    // Primary freshness source: a direct snapshot every 15 seconds
    setInterval(takeSnapshot, SNAPSHOT_MS);

    // Periodically reload the page to trigger a fresh lobby_match_all payload for new lobbies
    setInterval(() => {
        page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    }, 60000);
})();
