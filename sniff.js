const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('api') || url.includes('json') || url.includes('lobbies') || url.includes('matches')) {
                console.log('Found API:', url);
                try {
                    const text = await response.text();
                    console.log('Response excerpt:', text.substring(0, 100));
                } catch(e) {}
            }
        });
        
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000));
        await browser.close();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
