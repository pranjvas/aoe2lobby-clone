const https = require('https');
const zlib = require('zlib');

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parseBencoded(str) {
    let result = {};
    const regex = /(\d+):(.*)/g; // simplistic parse for display
    let i = 0;
    while(i < str.length) {
        let colonIdx = str.indexOf(':', i);
        if (colonIdx === -1) break;
        let lenStr = '';
        let j = i;
        while(j < colonIdx && str[j] >= '0' && str[j] <= '9') {
            lenStr += str[j];
            j++;
        }
        let len = parseInt(lenStr, 10);
        if (isNaN(len)) { i++; continue; }
        let value = str.substring(colonIdx + 1, colonIdx + 1 + len);
        // We just print all values
        if (value.length > 5) {
            console.log(value);
        }
        i = colonIdx + 1 + len;
    }
}

async function test() {
    const url = `https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0`;
    const data = await httpsGet(url);
    const parsed = JSON.parse(data);
    const matches = parsed.matches || [];
    
    matches.forEach((m, idx) => {
        try {
            const b = Buffer.from(m.options, 'base64');
            const str = zlib.inflateSync(b).toString();
            // Just grep anything that looks like a mod string, e.g. contains letters and is > 15 chars, ignoring base64 hashes
            const matches = str.match(/\d+:([A-Za-z0-9 -_]{15,})/g);
            if (matches) {
                console.log(`Lobby ${idx}:`, matches);
            }
        } catch(e){}
    });
}
test();
