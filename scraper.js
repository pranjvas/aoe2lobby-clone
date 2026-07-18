const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'scraped_lobbies.json');

const MODE_MAP = {
    0: "Random Map", 1: "Regicide", 2: "Death Match", 3: "Scenario", 11: "Empire Wars"
};
const SIZE_MAP = {
    0: "Tiny (2 player)", 1: "Small (3 player)", 2: "Medium (4 player)", 
    3: "Normal (6 player)", 4: "Large (8 player)", 5: "Giant", 6: "LudiKRIS"
};
const SPEED_MAP = {
    0: "Slow", 1: "Casual", 2: "Normal", 3: "Fast"
};

(async () => {
    console.log("Starting WebSocket interceptor for aoe2lobby.com...");
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    
    let lobbyMatchAll = null;
    let lobbyEloUpdate = {}; // { profileId: { mode1: stats, mode2: stats } }

    cdp.on('Network.webSocketFrameReceived', response => {
        try {
            const payload = response.response.payloadData;
            if (payload.includes('"lobby_match_all":')) {
                const data = JSON.parse(payload);
                if (data.lobby_match_all) lobbyMatchAll = data.lobby_match_all;
            }
            if (payload.includes('"lobby_elo_update":')) {
                const data = JSON.parse(payload);
                if (data.lobby_elo_update) {
                    for (const mode in data.lobby_elo_update) {
                        const elos = data.lobby_elo_update[mode];
                        for (const profileId in elos) {
                            if (!lobbyEloUpdate[profileId]) lobbyEloUpdate[profileId] = {};
                            lobbyEloUpdate[profileId][mode] = elos[profileId];
                        }
                    }
                }
            }
        } catch (e) { }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    
    let elapsed = 0;
    while (!lobbyMatchAll && elapsed < 15000) {
        await new Promise(r => setTimeout(r, 500));
        elapsed += 500;
    }
    await new Promise(r => setTimeout(r, 3000));
    await browser.close();

    if (!lobbyMatchAll) {
        console.error("Failed to capture lobby_match_all payload via WebSocket.");
        process.exit(1);
    }

    const scrapedLobbies = {};

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
                    
                    let eloStr = "";
                    let totalGames = "0";
                    let winRate = "0.0%";
                    let totalWins = "0";

                    const pStats = lobbyEloUpdate[slot.profileid];
                    let bestStat = null;
                    if (pStats) {
                        // Prioritize RM Team (13), RM 1v1 (4), Unranked (3), EW Team (15), EW 1v1 (14)
                        if (pStats['13']) bestStat = pStats['13'];
                        else if (pStats['4']) bestStat = pStats['4'];
                        else if (pStats['3']) bestStat = pStats['3'];
                        else if (pStats['15']) bestStat = pStats['15'];
                        else if (pStats['14']) bestStat = pStats['14'];
                        else {
                            // Fallback to the one with the most games
                            let maxGames = -1;
                            for (const m in pStats) {
                                if (pStats[m].games > maxGames) {
                                    maxGames = pStats[m].games;
                                    bestStat = pStats[m];
                                }
                            }
                        }
                    }

                    if (bestStat) {
                        eloStr = bestStat.rating ? bestStat.rating.toString() : "";
                        totalGames = bestStat.games ? bestStat.games.toString() : "0";
                        totalWins = bestStat.wins ? bestStat.wins.toString() : "0";
                        winRate = bestStat.winp ? bestStat.winp + "%" : "0.0%";
                    }

                    players.push({
                        name: slot.name,
                        elo: eloStr,
                        civ: slot.civilization ? slot.civilization.toString() : "",
                        totalGames: totalGames,
                        totalWins: totalWins,
                        winRate: winRate
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
    console.log(`Successfully scraped ${Object.keys(scrapedLobbies).length} lobbies via WebSocket intercept!`);
})();
