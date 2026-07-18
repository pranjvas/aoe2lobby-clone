const puppeteer = require('puppeteer');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function runTest() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        
        // Navigate to the app
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle0', timeout: 10000 });
        
        // Wait for lobbies to load
        await page.waitForSelector('.lobby-card', { timeout: 10000 });
        
        // Wait for status filter and select 'open'
        await page.waitForSelector('#statusFilter', { timeout: 10000 });
        await page.select('#statusFilter', 'open');
        
        // Wait for the search input and type 'Michi'
        await page.waitForSelector('#searchInput');
        await page.evaluate(() => document.getElementById('searchInput').value = '');
        await page.type('#searchInput', 'Michi', { delay: 50 });
        
        // Wait for filtering logic
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Count the number of lobbies
        const lobbies = await page.$$('.lobby-card');
        console.log(`Found ${lobbies.length} lobbies matching "open" and "Michi".`);
        
        if (lobbies.length > 2) {
            console.log('Success: More than 2 results found.');
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

runTest().then(passed => {
    if (passed) {
        console.log("\n==============================================");
        console.log("SUCCESS! The E2E Michi test fully passed!");
        console.log("==============================================\n");
        process.exit(0);
    } else {
        process.exit(1);
    }
});
