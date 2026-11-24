// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver and others) about the site's pages: reads the live
// sitemap and submits every URL in it. Run after a deploy that adds or changes pages:
//   node tools/indexnow.js            submit
//   node tools/indexnow.js --dry-run  only list what would be submitted
// The key is the file of the same name at the site root (server.js serves it), which proves the site is ours.
const SITE = 'https://aoe2lobby.online';
const KEY = '7e7c007e5148f7d5a2953120e8410d70';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10000; // IndexNow's limit per request

(async () => {
    const dryRun = process.argv.includes('--dry-run');
    const keyFile = await fetch(`${SITE}/${KEY}.txt`);
    if (!keyFile.ok || (await keyFile.text()).trim() !== KEY) throw new Error(`the key file at ${SITE}/${KEY}.txt is missing or wrong`);
    const sitemap = await fetch(`${SITE}/sitemap.xml`);
    if (!sitemap.ok) throw new Error(`sitemap: HTTP ${sitemap.status}`);
    const urls = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
        .filter(u => u.startsWith(SITE + '/'));
    if (!urls.length) throw new Error('the sitemap lists no URLs');
    console.log(`${urls.length} URLs in the sitemap`);
    if (dryRun) { console.log(urls.join('\n')); return; }
    for (let i = 0; i < urls.length; i += MAX_URLS) {
        const urlList = urls.slice(i, i + MAX_URLS);
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ host: new URL(SITE).host, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList })
        });
        // 200: accepted; 202: accepted, key check pending; anything else is an error
        console.log(`submitted ${urlList.length}: HTTP ${res.status} ${res.statusText} ${(await res.text()).slice(0, 300)}`);
        if (res.status !== 200 && res.status !== 202) process.exitCode = 1;
    }
})().catch(e => { console.error(e.message); process.exit(1); });
