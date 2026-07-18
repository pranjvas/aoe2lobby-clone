const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scraped_lobbies.json'));
for (const host in data) {
    const lobby = data[host];
    for (const player of lobby.players) {
        if (player.winRate === "") {
            console.log("Empty winRate for:", player.name, "in lobby by:", host, "Title:", lobby.title);
            console.log(player);
        }
    }
}
