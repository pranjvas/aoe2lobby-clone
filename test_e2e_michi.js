const puppeteer = require('puppeteer');

async function runTest() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        
        // Navigate to the app
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle0', timeout: 10000 });
        
        // Wait for lobbies to load from the server
        await page.waitForSelector('.lobby-card', { timeout: 10000 });
        
        // Wait for statusFilter to exist in the DOM (it might be added concurrently by devs)
        await page.waitForSelector('#statusFilter', { timeout: 10000 });
        
        // Select 'open' in the status filter
        await page.select('#statusFilter', 'open');
        
        // Wait for the search input and type 'michi'
        await page.waitForSelector('#searchInput');
        await page.evaluate(() => document.getElementById('searchInput').value = '');
        await page.type('#searchInput', 'michi', { delay: 50 });
        
        // Wait a bit to ensure filtering logic runs and DOM updates
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Count the number of lobbies currently shown
        const lobbies = await page.$$('.lobby-card');
        console.log(`Found ${lobbies.length} lobbies matching "open" and "michi".`);
        
        if (lobbies.length > 2) {
            await browser.close();
            return true;
        } else {
            console.log(`Assertion failed: Expected > 2 lobbies, but got ${lobbies.length}`);
            await browser.close();
            return false;
        }
    } catch (err) {
        console.log(`Test encountered an error: ${err.message}`);
        if (browser) await browser.close();
        return false;
    }
}

async function loop() {
    console.log("Starting E2E Michi Test Loop...");
    while (true) {
        const passed = await runTest();
        if (passed) {
            console.log("\n==============================================");
            console.log("SUCCESS! The E2E Michi test fully passed!");
            console.log("==============================================\n");
            break;
        }
        console.log("Retrying in 5 seconds...\n");
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

loop();
