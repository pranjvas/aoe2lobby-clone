const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

async function runDump() {
    let browser;
    try {
        console.log("Starting full dump cycle...");
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 8000));
        
        const dumpHtml = await page.evaluate(async () => {
            return document.body.innerHTML;
        });
        
        fs.writeFileSync('C:\\Users\\pranj\\.gemini\\antigravity\\scratch\\aoe2lobby-clone\\full_dump.html', dumpHtml);
        console.log("Dump written to full_dump.html");
    } catch (e) {
        console.error("Dump failed:", e.message);
    } finally {
        if (browser) await browser.close();
    }
}

runDump();
