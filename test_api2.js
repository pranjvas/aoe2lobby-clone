const http = require('http');

http.get('http://localhost:3001/api/lobbies', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const matches = JSON.parse(d).matches;
        const michiMatches = matches.filter(m => m.map.toLowerCase() === 'michi');
        console.log(`Found ${michiMatches.length} Michi lobbies.`);
        if (michiMatches.length > 0) {
            console.log(michiMatches[0].title, michiMatches[0].map, michiMatches[0].mapSize);
        }
    });
});
