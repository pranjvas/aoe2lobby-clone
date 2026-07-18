const https = require('https');
const zlib = require('zlib');

function parseBencode(str) {
    let i = 0;
    function parse() {
        if (i >= str.length) return null;
        if (str[i] === 'i') {
            i++;
            let end = str.indexOf('e', i);
            let val = parseInt(str.substring(i, end));
            i = end + 1;
            return val;
        } else if (str[i] === 'l') {
            i++;
            let arr = [];
            while(str[i] !== 'e') {
                arr.push(parse());
            }
            i++;
            return arr;
        } else if (str[i] === 'd') {
            i++;
            let obj = {};
            while(str[i] !== 'e') {
                let key = parse();
                let val = parse();
                obj[key] = val;
            }
            i++;
            return obj;
        } else {
            // String
            let colon = str.indexOf(':', i);
            let len = parseInt(str.substring(i, colon));
            let val = str.substring(colon + 1, colon + 1 + len);
            i = colon + 1 + len;
            return val;
        }
    }
    return parse();
}

https.get('https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0', {rejectUnauthorized: false}, (res) => {
    let d='';
    res.on('data', c=>d+=c);
    res.on('end', () => {
        const matches = JSON.parse(d).matches;
        console.log(`Found ${matches.length} matches`);
        for (let i = 0; i < Math.min(20, matches.length); i++) {
            const m = matches[i];
            try {
                const b = Buffer.from(m.options, 'base64');
                const str = zlib.inflateSync(b).toString();
                const obj = parseBencode(str);
                console.log(`--- Lobby ${i} ---`);
                console.log("Name:", m.description || m.name);
                console.log("Mapname:", m.mapname);
                console.log("Matchtype:", m.matchtype_id);
                console.log("Max Players:", m.max_players);
                console.log("Options Dict:", obj);
            } catch(e) {
                console.error("Error parsing lobby", i, e.message);
            }
        }
    });
});
