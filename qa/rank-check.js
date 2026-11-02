// QA: where does aoe2lobby.online rank on Bing and DuckDuckGo for our target searches?
// Usage: node qa/rank-check.js            (Node 18+)
// Google is not scraped (it blocks automated queries); use Search Console > Performance for Google positions.
const SITE = 'aoe2lobby.online';
const QUERIES = [
    'aoe2lobby.online',
    'aoe2lobby online',
    'aoe2 lobby browser',
    'age of empires 2 lobby browser',
    'aoe2 lobby finder',
    'aoe2 treaty lobbies',
    'aoe2lobby',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Organic result URLs in page order
async function bing(q) {
    const html = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=US`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' } }).then(r => r.text());
    // Result links are bing.com/ck/a?...&u=a1<base64url of the real URL>
    return [...html.matchAll(/<li class="b_algo"[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"/g)].map(m => {
        const href = m[1].replace(/&amp;/g, '&');
        const u = href.match(/[?&]u=a1([^&]+)/);
        return u ? Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : href;
    });
}

async function duckduckgo(q) {
    const html = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } }).then(r => r.text());
    if (!/result__a/.test(html)) throw new Error('no results (DuckDuckGo rate-limits repeated queries; retry later)');
    return [...html.matchAll(/class="result__a" href="([^"]+)"/g)].map(m => {
        const u = m[1].match(/uddg=([^&]+)/);
        return u ? decodeURIComponent(u[1]) : m[1];
    });
}

const position = (urls) => {
    const i = urls.findIndex(u => { try { return new URL(u).hostname.replace(/^www\./, '') === SITE; } catch { return false; } });
    return i === -1 ? null : i + 1;
};

(async () => {
    const rows = [];
    for (const q of QUERIES) {
        const row = { query: q };
        for (const [name, fn] of [['bing', bing], ['duckduckgo', duckduckgo]]) {
            try {
                const urls = await fn(q);
                row[name] = urls.length ? (position(urls) ?? `not in top ${urls.length}`) : 'no results parsed';
                if (urls.length && position(urls) !== 1) row[name + 'Top'] = new URL(urls[0]).hostname;
            } catch (e) {
                row[name] = 'error: ' + e.message;
            }
            await sleep(name === 'duckduckgo' ? 8000 : 2000); // DuckDuckGo rate-limits quick repeats
        }
        rows.push(row);
    }
    console.table(rows);
    const met = rows.filter(r => r.bing === 1 && r.duckduckgo === 1).map(r => r.query);
    console.log(`#1 on both: ${met.length}/${rows.length}${met.length ? ' (' + met.join(', ') + ')' : ''}`);
})();
