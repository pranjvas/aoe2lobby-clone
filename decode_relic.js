const https = require('https');
const zlib = require('zlib');

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
    
    matches.forEach(m => {
        if (m.options) {
            try {
                const buf = Buffer.from(m.options, 'base64');
                const unzipped = zlib.inflateSync(buf);
                const str = unzipped.toString('utf-8');
                if (str.toLowerCase().includes('mod') || str.toLowerCase().includes('dataset')) {
                    console.log("Decoded options:", str);
                }
            } catch (e) {
                console.error("Error decoding:", e.message);
            }
        }
    });
}
test();
