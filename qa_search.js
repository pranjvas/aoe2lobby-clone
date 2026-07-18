const puppeteer = require('puppeteer');

(async () => {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        // Listen to console for errors
        page.on('console', msg => {
            if (msg.type() === 'error') {
                console.error(`Browser console error: ${msg.text()}`);
            }
        });

        // Intercept API requests
        await page.setRequestInterception(true);
        page.on('request', interceptedRequest => {
            if (interceptedRequest.url().includes('/api/lobbies')) {
                const fakeMatches = [
                    {
                        id: 1,
                        title: 'Custom Game',
                        map: 'Michi', // This will explicitly be the Michi map
                        isPlaying: false,
                        players: [{ name: 'Player1', elo: 1000, team: 1 }, { name: 'Player2', elo: 1100, team: 2 }]
                    },
                    {
                        id: 2,
                        title: 'Arabia 1v1',
                        map: 'Arabia',
                        isPlaying: false,
                        players: [{ name: 'MichiFan', elo: 1200, team: 1 }, { name: 'Player4', elo: 1250, team: 2 }]
                    },
                    {
                        id: 3,
                        title: 'Arena 2v2',
                        map: 'Arena',
                        isPlaying: false,
                        players: [{ name: 'Player5', elo: 900, team: 1 }, { name: 'Player6', elo: 950, team: 2 }]
                    }
                ];
                interceptedRequest.respond({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ matches: fakeMatches }),
                    headers: { 'Access-Control-Allow-Origin': '*' }
                });
            } else {
                interceptedRequest.continue();
            }
        });

        console.log("Navigating to http://localhost:8080");
        await page.goto('http://localhost:8080', { waitUntil: 'networkidle0' });

        console.log("Clicking the 'Players' toggle button");
        await page.click('#viewPlayersBtn');
        
        // Wait for player grid to be visible and players to render
        await page.waitForSelector('#playerGrid .lobby-card', { visible: true });

        // Wait a bit for all cards to render
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get initial count
        const initialCount = await page.$$eval('#playerGrid .lobby-card', cards => cards.length);
        console.log(`Initial player cards: ${initialCount}`);

        console.log("Typing 'Michi' into the #playerSearch input box");
        await page.type('#playerSearch', 'Michi');
        
        // Wait a bit for JS to filter and re-render
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Get updated count
        const finalCount = await page.$$eval('#playerGrid .lobby-card', cards => cards.length);
        console.log(`Filtered player cards: ${finalCount}`);

        // Verify the rendered cards
        const renderedCards = await page.$$eval('#playerGrid .lobby-card', cards => {
            return cards.map(card => {
                const name = card.querySelector('.host-name').textContent.replace(/\s+/g, ' ').trim();
                const rows = Array.from(card.querySelectorAll('.detail-row'));
                let map = 'Unknown';
                for (const row of rows) {
                    if (row.textContent.includes('Playing:')) {
                        map = row.textContent.replace('Playing:', '').trim();
                    }
                }
                return { name, map };
            });
        });

        console.log("Cards currently displayed:");
        console.dir(renderedCards);

        let pass = true;
        for (const card of renderedCards) {
            const hasMichi = card.name.toLowerCase().includes('michi') || card.map.toLowerCase().includes('michi');
            if (!hasMichi) {
                console.error(`ERROR: Found card that does not match filter. Name: "${card.name}", Map: "${card.map}"`);
                pass = false;
            }
        }

        if (finalCount !== 3) {
            console.error(`ERROR: Expected 3 cards after filtering (Player1 on Michi, Player2 on Michi, MichiFan on Arabia), got ${finalCount}`);
            pass = false;
        }

        if (pass) {
            console.log("SUCCESS: Filter correctly updated DOM to show only matching cards.");
        } else {
            console.error("FAILURE: Filter did not work as expected.");
            process.exit(1);
        }

    } catch (err) {
        console.error("Test execution failed:", err);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
