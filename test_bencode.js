const https = require('https');
const zlib = require('zlib');
const bencode = require('bencode'); // maybe bencode is not installed, but let's try a simple manual parser

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

async function test() {
    https.get('https://aoe-api.reliclink.com/community/advertisement/findAdvertisements?title=age2&start=0', {rejectUnauthorized: false}, (res) => {
        let d='';
        res.on('data', c=>d+=c);
        res.on('end', () => {
            JSON.parse(d).matches.forEach(m => {
                try {
                    const b=Buffer.from(m.options, 'base64');
                    const str = zlib.inflateSync(b).toString();
                    const obj = parseBencode(str);
                    if (obj) {
                        for (let k in obj) {
                            if (typeof obj[k] === 'string' && obj[k].length > 15) {
                                // console.log(k, obj[k]);
                            }
                        }
                        // Just dump keys and values
                        // console.log(obj);
                        // Let's specifically look for Dataset / Mod
                        if (obj['59'] || obj['61']) { // Maybe these are keys? No, keys in dictionary are usually strings
                            // wait, in bencode dict keys are strings, so they are like "1", "2", "3" etc.
                        }
                    }
                } catch(e){}
            });
        });
    });
}
test();
