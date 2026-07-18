const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

https.get('https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0', {rejectUnauthorized: false}, (res) => {
    let d='';
    res.on('data', c=>d+=c);
    res.on('end', () => {
        const matches = JSON.parse(d).matches;
        const results = [];
        for (let i = 0; i < Math.min(100, matches.length); i++) {
            const m = matches[i];
            try {
                const b1 = Buffer.from(m.options, 'base64');
                let str1 = zlib.inflateSync(b1).toString('utf-8');
                if (str1.startsWith('"') && str1.endsWith('"')) {
                    str1 = str1.slice(1, -1);
                }
                const b2 = Buffer.from(str1, 'base64');
                const rawStr = b2.toString('utf-8');
                
                // parse key:value pairs. Format is like "K\t61:2\t0:0"
                const parts = rawStr.split(/[\t\x00]/); 
                const opts = {};
                parts.forEach(p => {
                    const colonIdx = p.indexOf(':');
                    if (colonIdx > 0) {
                        const key = p.substring(0, colonIdx);
                        const val = p.substring(colonIdx + 1);
                        opts[key] = val;
                    }
                });

                results.push({
                    name: m.description || m.name || "",
                    mapname: m.mapname,
                    matchtype_id: m.matchtype_id,
                    max_players: m.max_players,
                    options: opts
                });
            } catch(e) {}
        }
        
        fs.writeFileSync('lobbies_parsed.json', JSON.stringify(results, null, 2));
        console.log(`Saved ${results.length} lobbies to lobbies_parsed.json`);
    });
});
