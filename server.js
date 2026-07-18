const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); setTimeout(() => process.exit(1), 1000); });
process.on('unhandledRejection', (err) => { console.error('Unhandled Rejection:', err); setTimeout(() => process.exit(1), 1000); });

const PORT = process.env.PORT || 3000;
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
                        
                        let currentRating = 1000 + (profileId % 1000);
                        let totalWins = 0;
                        let totalGames = 0;
                        let winRate = "0.0";
                        
                        if (parsed.leaderboardStats) {
                            const stats = parsed.leaderboardStats.filter(ls => ls.statgroup_id === sg.id);
                            if (stats && stats.length > 0) {
                                // Prioritize Team RM (4) and 1v1 RM (3) over other leaderboards like Unranked (0)
                                const sorted = [...stats].sort((a, b) => {
                                    const rankA = a.leaderboard_id === 4 ? 2 : (a.leaderboard_id === 3 ? 1 : 0);
                                    const rankB = b.leaderboard_id === 4 ? 2 : (b.leaderboard_id === 3 ? 1 : 0);
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
                        profileCache.set(profileId, { alias, rating: currentRating, totalGames, totalWins, winRate });
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

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    if (req.url.startsWith('/api/lobbies')) {
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
                            const decompressed = zlib.inflateSync(Buffer.from(m.options, 'base64'));
                            const innerStr = decompressed.toString('utf-8');
                            const innerBase64 = JSON.parse(innerStr);
                            const innerBytes = Buffer.from(innerBase64, 'base64').toString('utf-8');
                            
                            // Extract the hidden 16-byte mod hash (typically prefixed with 52:)
                            const hashMatch = innerBytes.match(/52:([A-Za-z0-9+/=]+)/);
                            if (hashMatch && hashMatch[1]) {
                                const modHash = hashMatch[1];
                                m.modHash = modHash;
                                
                                const modStrMatch = innerBytes.match(/63:([^\x00]+)/);
                                if (modStrMatch && modStrMatch[1]) {
                                    m.modInfo = modStrMatch[1].replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
                                }
                                
                                const popMatch = innerBytes.match(/28:([^\x00]+)/);
                                if (popMatch && popMatch[1]) {
                                    m.relicPopulation = parseInt(popMatch[1].replace(/[^\d]/g, ''), 10);
                                }
                                
                                const speedMatch = innerBytes.match(/41:([^\x00]+)/);
                                if (speedMatch && speedMatch[1]) {
                                    const speedVal = speedMatch[1].replace(/[^\d]/g, '');
                                    if (speedVal === '0') m.relicSpeed = 'Slow';
                                    else if (speedVal === '1') m.relicSpeed = 'Casual';
                                    else if (speedVal === '2') m.relicSpeed = 'Normal';
                                    else if (speedVal === '3') m.relicSpeed = 'Fast';
                                }
                                
                                const modeMatch = innerBytes.match(/5:([^\x00]+)/);
                                if (modeMatch && modeMatch[1]) {
                                    const modeVal = modeMatch[1].replace(/[^\d]/g, '');
                                    if (modeVal === '0') m.relicMode = 'Random Map';
                                    else if (modeVal === '1') m.relicMode = 'Regicide';
                                    else if (modeVal === '2') m.relicMode = 'Death Match';
                                    else if (modeVal === '3') m.relicMode = 'Scenario';
                                    else if (modeVal === '11') m.relicMode = 'Empire Wars';
                                }
                                
                                const sizeMatch = innerBytes.match(/0:([^\x00]+)/);
                                if (sizeMatch && sizeMatch[1]) {
                                    const sizeVal = sizeMatch[1].replace(/[^\d]/g, '');
                                    if (sizeVal === '0') m.relicSize = 'Tiny (2 player)';
                                    else if (sizeVal === '1') m.relicSize = 'Small (3 player)';
                                    else if (sizeVal === '2') m.relicSize = 'Medium (4 player)';
                                    else if (sizeVal === '3') m.relicSize = 'Normal (6 player)';
                                    else if (sizeVal === '4') m.relicSize = 'Large (8 player)';
                                    else if (sizeVal === '5') m.relicSize = 'Giant';
                                    else if (sizeVal === '6') m.relicSize = 'LudiKRIS';
                                }

                                
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
                
                // Track missing matches as playing
                for (const [id, m] of activeMatches.entries()) {
                    if (!currentMatchIds.has(id)) {
                        m.isPlaying = true;
                        // Remove if playing for more than 1 hour
                        if (now - m.lastSeen > 3600000) {
                            activeMatches.delete(id);
                        }
                    }
                }
                
                let scrapedData = {};
                try {
                    const fs = require('fs');
                    if (fs.existsSync('scraped_maps.json')) {
                        scrapedData = JSON.parse(fs.readFileSync('scraped_maps.json', 'utf-8'));
                    }
                } catch (e) {}

                let scrapedPlayersStats = {};
                let scrapedMatchesStats = {};
                let scrapedMatchesByTitle = {};
                try {
                    const fs = require('fs');
                    const scrapedLobbiesPath = 'C:\\Users\\pranj\\.gemini\\antigravity\\scratch\\aoe2lobby-clone\\scraped_lobbies.json';
                    if (fs.existsSync(scrapedLobbiesPath)) {
                        const rawData = JSON.parse(fs.readFileSync(scrapedLobbiesPath, 'utf-8'));
                        const processPlayer = (p) => {
                            if (p && p.name) {
                                scrapedPlayersStats[p.name.toLowerCase()] = p;
                            }
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
                                    matchType: item.settings?.Mode,
                                    mapSize: item.settings?.Size,
                                    modInfo: finalModInfo,
                                    population: item.settings?.Population,
                                    speed: item.settings?.Speed,
                                    server: item.settings?.Server
                                };
                            }
                            if (item.title) {
                                scrapedMatchesByTitle[item.title.toLowerCase()] = {
                                    realHost: hostName,
                                    mapName: item.map,
                                    isPlaying: item.isPlaying,
                                    matchType: item.settings?.Mode,
                                    mapSize: item.settings?.Size,
                                    modInfo: finalModInfo,
                                    population: item.settings?.Population,
                                    speed: item.settings?.Speed,
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
                
                const allMatchesArray = Array.from(activeMatches.values()).map(m => {
                    const parsedPlayers = m.rawPlayers ? m.rawPlayers.map(p => {
                        const cached = profileCache.get(p.id) || { alias: 'Player_' + p.id, rating: 1000 + (p.id % 1000), totalGames: 0, totalWins: 0, winRate: "0.0" };
                        
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

                        return { id: p.id, name: cached.alias, team: p.team, elo: finalElo, totalGames: finalTotalGames, totalWins: finalTotalWins, winRate: finalWinRate };
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
                    let serverRegion = "Global";

                    let sm = scrapedMatchesStats[hostName];

                    if ((!sm || hostName === "unknown" || hostName === "player_0" || hostName === "") && m.description) {
                        const mTitleLower = m.description.toLowerCase();
                        if (scrapedMatchesByTitle[mTitleLower]) {
                            sm = scrapedMatchesByTitle[mTitleLower];
                            hostName = sm.realHost;
                            if (parsedPlayers.length > 0 && (parsedPlayers[0].name === "Unknown" || parsedPlayers[0].name.startsWith("Player_")) && hostName) {
                                parsedPlayers[0].name = hostName;
                            } else if (parsedPlayers.length === 0 && hostName) {
                                parsedPlayers.push({ id: 0, name: hostName, team: 0, elo: 1000, totalGames: 0, totalWins: 0, winRate: "0.0" });
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
                    if (m.relicMode) matchType = m.relicMode;
                    if (m.relicSize) mapSize = m.relicSize;

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
                        if (sm.server !== undefined) serverRegion = sm.server;
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
                        server: serverRegion,
                        isPasswordProtected: m.passwordprotected === 1,
                        maxPlayers: m.maxplayers,
                        isPlaying: m.isPlaying,
                        lastSeen: m.lastSeen,
                        players: parsedPlayers
                    };
                });
                let scrapedLobbiesObj = {};
                try {
                    const fs = require('fs');
                    const scrapedLobbiesPath = 'C:\\Users\\pranj\\.gemini\\antigravity\\scratch\\aoe2lobby-clone\\scraped_lobbies.json';
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
                        const parsedPlayers = (lobby.players || []).map(p => ({
                            id: 0, 
                            name: p.name, 
                            team: 0, 
                            elo: p.elo ? parseInt(p.elo) : 1000,
                            totalGames: p.totalGames ? parseInt(p.totalGames) : 0,
                            totalWins: p.totalWins ? parseInt(p.totalWins) : 0,
                            winRate: p.winRate || "0.0%"
                        }));
                        
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
                            server: lobby.settings?.Server || "Global",
                            isPasswordProtected: false,
                            maxPlayers: 8,
                            isPlaying: lobby.isPlaying || false,
                            lastSeen: Date.now(),
                            players: parsedPlayers
                        });
                    }
                }

                const responseData = JSON.stringify({ matches: allMatchesArray });
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
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(3001, () => {
    console.log(`API Server listening on port 3001`);
});

// Heartbeat to prevent task from being killed
setInterval(() => {
    console.log(`[HEARTBEAT] Server is alive at ${new Date().toISOString()}`);
}, 10000);
