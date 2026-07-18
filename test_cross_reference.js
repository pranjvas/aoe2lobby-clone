const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    try {
        console.log("Launching browser for cross-reference...");
        const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        console.log("Navigating to local app...");
        await page.goto('http://localhost:8080');
        console.log("Waiting 20s for the proxy cache to warm up and fetch 1500+ lobbies...");
        await new Promise(r => setTimeout(r, 20000));
        
        // Ensure "Open" filter is selected
        await page.select('#statusFilter', 'open');
        await page.type('#searchInput', 'michi');
        await new Promise(r => setTimeout(r, 1000));
        
        const localLobbies = await page.evaluate(() => {
            const cards = document.querySelectorAll('.lobby-card');
            const lobbies = [];
            cards.forEach(card => {
                const hostEl = card.querySelector('.host-name');
                if (hostEl) {
                    lobbies.push(hostEl.innerText.replace('Host:', '').trim());
                }
            });
            return lobbies;
        });
        
        console.log("Local Open Michi Lobbies:", localLobbies);
        
        console.log("Navigating to aoe2lobby.com...");
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 5000));
        
        // Note: aoe2lobby.com has a search bar or we can just extract all and filter
        const externalLobbies = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr');
            const lobbies = [];
            rows.forEach(row => {
                if (row.innerText.toLowerCase().includes('michi')) {
                    lobbies.push(row.innerText);
                }
            });
            return lobbies;
        });
        
        console.log("External Michi Lobbies detected:", externalLobbies.length);
        
        await browser.close();
        console.log("Cross-reference test completed.");
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
