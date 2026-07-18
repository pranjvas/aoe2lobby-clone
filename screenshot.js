const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

puppeteer.use(StealthPlugin());

async function takeScreenshot() {
    let browser;
    try {
        console.log('Launching browser for screenshot...');
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        
        console.log('Navigating to http://localhost:8080...');
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle0' });
        
        // Wait for lobbies to render
        await new Promise(r => setTimeout(r, 2000));
        
        // Click the View Players button
        console.log('Clicking Players view button...');
        await page.click('#viewPlayersBtn');
        
        // Wait for players to render
        await new Promise(r => setTimeout(r, 1000));
        
        const screenshotPath = path.join('C:\\Users\\pranj\\.gemini\\antigravity\\brain\\1b6f6029-ffae-4c7d-8940-eb5ae2d6b01b', 'player_view.png');
        await page.screenshot({ path: screenshotPath });
        console.log(`Screenshot saved to ${screenshotPath}`);
    } catch (e) {
        console.error('Screenshot failed:', e.message);
    } finally {
        if (browser) await browser.close();
    }
}

takeScreenshot();
