const http = require('http');
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/api/lobbies')) {
        const fakeMatches = [
            {
                id: 1,
                title: 'Michi 3v3 noobs', // map will be evaluated as Michi based on title
                isPlaying: false,
                players: [{ name: 'Player1', elo: 1000, team: 1 }, { name: 'Player2', elo: 1100, team: 2 }]
            },
            {
                id: 2,
                title: 'Arabia 1v1',
                map: 'Arabia',
                isPlaying: false,
                players: [{ name: 'MichiFan', elo: 1200, team: 1 }, { name: 'Player4', elo: 1250, team: 2 }]
            },
            {
                id: 3,
                title: 'Arena 2v2',
                map: 'Arena',
                isPlaying: false,
                players: [{ name: 'Player5', elo: 900, team: 1 }]
            }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ matches: fakeMatches }));
    } else {
        res.writeHead(404);
        res.end();
    }
});
server.listen(3000, () => console.log('Mock server on 3000'));
