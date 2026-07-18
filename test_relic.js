const https = require('https');

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function test() {
    const url = `https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0`;
    const data = await httpsGet(url);
    const parsed = JSON.parse(data);
    const matches = parsed.matches || [];
    
    // Dump the first match completely
    if (matches.length > 0) {
        console.log(JSON.stringify(matches[0], null, 2));
    }
}
test();
