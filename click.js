const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();

    page.on('request', request => {
        if (!request.url().includes('google') && !request.url().includes('cloudflare')) {
            console.log('REQ:', request.url());
        }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 3000));
    
    // find row with Nemesis and click it
    await page.evaluate(() => {
        const rows = document.querySelectorAll('tr.lobbyoverview');
        for (const r of rows) {
            if (r.innerText.includes('Nemesis')) {
                r.click();
                break;
            }
        }
    });
    
    await new Promise(r => setTimeout(r, 2000));
    const html = await page.content();
    require('fs').writeFileSync('dom_dump2.html', html);
    console.log('Saved dom_dump2.html');
    
    await browser.close();
})();
