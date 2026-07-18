const http = require('http');

http.get('http://localhost:3001/api/lobbies', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const response = JSON.parse(d);
        const lobbies = response.matches;
        
        let unknownCount = 0;
        let validEloCount = 0;
        let totalPlayers = 0;
        
        lobbies.forEach(l => {
            (l.players || []).forEach(p => {
                totalPlayers++;
                if (p.name === 'UNKNOWN') unknownCount++;
                if (p.elo && p.elo !== '') validEloCount++;
            });
        });
        
        console.log('Total Lobbies:', lobbies.length);
        console.log('Total Players:', totalPlayers);
        console.log('UNKNOWN Players:', unknownCount);
        console.log('Players with ELO:', validEloCount);
        
        if (unknownCount > 0) {
            console.error('Test Failed: There are still UNKNOWN players!');
            process.exit(1);
        } else {
            console.log('Test Passed: 0 UNKNOWN players found.');
        }
    });
}).on('error', e => console.error(e));
