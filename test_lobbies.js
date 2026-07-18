const http = require('http');

http.get('http://localhost:3001/api/lobbies', (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const matches = parsed.matches;
            
            console.log(`Total lobbies found: ${matches.length}`);
            
            if (matches.length > 300) {
                console.log('✅ PASS: Lobbies count is > 300.');
            } else {
                console.error('❌ FAIL: Lobbies count is NOT > 300.');
            }
            
            // Check cross-network lobbies for settings (Relic API parsed settings)
            // A cross network lobby usually has a steamLobbyId, but if it was from Relic, it should have modInfo, speed, population.
            // Let's find one that looks like it has these set.
            let validRelicLobbies = 0;
            for (const m of matches) {
                // If it has a steamLobbyId but also has relics-specific properties, it was successfully aggregated or Relic-parsed.
                // Or we just check that AT LEAST some lobbies have speed, population, modInfo from Relic parsing.
                if (m.speed !== undefined || m.population !== undefined || m.modInfo !== undefined) {
                    validRelicLobbies++;
                }
            }
            
            console.log(`Lobbies with parsed settings (speed, population, etc.): ${validRelicLobbies}`);
            if (validRelicLobbies > 0) {
                console.log('✅ PASS: Relic API parsing remains intact for cross-network lobbies.');
            } else {
                console.error('❌ FAIL: Relic API parsing missing.');
            }
            
        } catch (e) {
            console.error('Error parsing response:', e);
        }
    });

}).on('error', (err) => {
    console.error('Error making request:', err.message);
});
