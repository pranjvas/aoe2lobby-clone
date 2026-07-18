const puppeteer = require('puppeteer');

async function runTests() {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log(`[${new Date().toISOString()}] Navigating to http://localhost:8080...`);
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });
    
    console.log(`[${new Date().toISOString()}] Waiting for lobbies to load...`);
    await page.waitForSelector('.lobby-card', { timeout: 10000 });
    
    console.log(`[${new Date().toISOString()}] Clicking on a lobby card...`);
    const lobbyCards = await page.$$('.lobby-card');
    if (lobbyCards.length > 0) {
      await lobbyCards[0].click();
    } else {
      throw new Error("No .lobby-card elements found.");
    }
    
    console.log(`[${new Date().toISOString()}] Verifying .player-list is visible...`);
    await page.waitForSelector('.player-list', { visible: true, timeout: 5000 });
    
    console.log(`[${new Date().toISOString()}] SUCCESS: UI Test passed.`);
  } catch (error) {
    console.error(`\n========================================`);
    console.error(`[${new Date().toISOString()}] FAILURE: UI Test failed!`);
    console.error(error);
    console.error(`========================================\n`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function loopTests() {
  while (true) {
    await runTests();
    console.log(`[${new Date().toISOString()}] Waiting 15 seconds before next test...`);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
}

loopTests();
