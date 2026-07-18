const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function snap() {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 5000));
    const overviewRows = await page.$$('tr.lobbyoverview');
    if (overviewRows.length > 0) {
        await overviewRows[0].click();
        await new Promise(r => setTimeout(r, 2000));
    }
    await page.screenshot({ path: 'screenshot.png', fullPage: true });
    await browser.close();
}
snap();
