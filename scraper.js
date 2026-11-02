const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'scraped_lobbies_v2.json');
const PLAYERS_PATH = path.join(__dirname, 'scraped_players_v2.json');

const MODE_MAP = {
    0: "Random Map", 1: "Regicide", 2: "Death Match", 3: "Scenario", 11: "Empire Wars"
};
const SIZE_MAP = {
    0: "Tiny (2 player)", 1: "Small (3 player)", 2: "Medium (4 player)", 
    3: "Normal (6 player)", 4: "Large (8 player)", 5: "Huge", 6: "Ludicrous"
};
const SPEED_MAP = {
    0: "Slow", 1: "Casual", 2: "Normal", 3: "Fast"
};

let lobbyMatchAll = null;
let lobbyEloUpdate = {}; // { profileId: { mode1: stats, mode2: stats } }

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
                        stats: pStats // Store all stats for all modes!
                    };

                    players.push({
                        name: slot.name,
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
            players: players,
            settings: {
                Mode: MODE_MAP[lobby.mode] || "Unknown",
                Size: SIZE_MAP[lobby.size] || "Unknown",
                Population: lobby.population ? lobby.population.toString() : "200",
                Speed: SPEED_MAP[lobby.speed] || "Unknown",
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
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    
    cdp.on('Network.webSocketFrameReceived', response => {
        try {
            const payload = response.response.payloadData;
            if (payload.includes('"lobby_match_all":')) {
                const data = JSON.parse(payload);
                if (data.lobby_match_all) {
                    lobbyMatchAll = data.lobby_match_all;
                    dumpData();
                }
            }
            if (payload.includes('"lobby_elo_update":')) {
                const data = JSON.parse(payload);
                if (data.lobby_elo_update) {
                    let newElos = 0;
                    for (const mode in data.lobby_elo_update) {
                        const elos = data.lobby_elo_update[mode];
                        for (const profileId in elos) {
                            if (!lobbyEloUpdate[profileId]) lobbyEloUpdate[profileId] = {};
                            lobbyEloUpdate[profileId][mode] = elos[profileId];
                            newElos++;
                        }
                    }
                    if (newElos > 0) {
                        clearTimeout(global.dumpTimeout);
                        global.dumpTimeout = setTimeout(dumpData, 5000);
                    }
                }
            }
        } catch (e) { }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    
    // Periodically dump data every 20 seconds as a fallback
    setInterval(dumpData, 20000);

    // Periodically reload the page to trigger a fresh lobby_match_all payload for new lobbies
    setInterval(() => {
        page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    }, 60000);
})();
