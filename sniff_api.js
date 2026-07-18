const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function sniff() {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('api') || url.includes('lobby') || url.includes('json')) {
            console.log("Response URL:", url);
            try {
                const text = await response.text();
                if (text.length > 50) {
                    console.log("Snippet:", text.substring(0, 200));
                }
            } catch(e) {}
        }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
}
sniff();
