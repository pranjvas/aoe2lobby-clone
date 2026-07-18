const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        page.on('request', request => {
            if (request.url().includes('api') || request.url().includes('lobby') || request.url().includes('match')) {
                console.log('REQ:', request.url());
            }
        });
        
        console.log("Navigating...");
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        
        console.log("Clicking Next...");
        try {
            await page.click('.pagination-next, [aria-label="Next page"], button:contains("Next")');
        } catch(e) {
            console.log("Could not click next, trying to evaluate click");
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                buttons.forEach(b => {
                    if(b.innerText.includes('2') || b.innerText.includes('>')) b.click();
                });
            });
        }
        
        await new Promise(r => setTimeout(r, 5000));
        await browser.close();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
