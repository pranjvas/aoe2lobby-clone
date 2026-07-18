const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.goto('https://api.aoe2companion.com/lobbies', { waitUntil: 'networkidle2' });
        const text = await page.evaluate(() => document.body.innerText);
        console.log(text.substring(0, 100));
        await browser.close();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
