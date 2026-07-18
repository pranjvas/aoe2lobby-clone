const https = require('https');
const zlib = require('zlib');

https.get('https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0', {rejectUnauthorized: false}, (res) => {
    let d='';
    res.on('data', c=>d+=c);
    res.on('end', () => {
        const matches = JSON.parse(d).matches;
        for (let i = 0; i < Math.min(2, matches.length); i++) {
            const m = matches[i];
            const b1 = Buffer.from(m.options, 'base64');
            let str1 = zlib.inflateSync(b1).toString('utf-8');
            
            // Remove wrapping quotes if any
            if (str1.startsWith('"') && str1.endsWith('"')) {
                str1 = str1.slice(1, -1);
            }
            
            const b2 = Buffer.from(str1, 'base64');
            console.log(`--- Lobby ${i} ---`);
            console.log(b2.toString('utf-8'));
        }
    });
});
