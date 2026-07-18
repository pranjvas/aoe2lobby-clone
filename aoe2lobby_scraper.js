const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

async function runScraper() {
    let browser;
    try {
        console.log("Starting scrape cycle...");
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 5000));
        
        const mapData = await page.evaluate(() => {
            const result = {};
            const rows = document.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length > 5) {
                    const title = cells[1] ? cells[1].innerText.trim().toLowerCase() : "";
                    const mapName = cells[2] ? cells[2].innerText.trim() : "";
                    const hostName = cells[3] ? cells[3].innerText.trim().toLowerCase() : "";
                    
                    if (hostName && mapName) {
                        result[hostName] = mapName;
                    }
                }
            });
            return result;
        });
        
        fs.writeFileSync('C:/Users/pranj/.gemini/antigravity/scratch/aoe2lobby-clone/scraped_maps.json', JSON.stringify(mapData, null, 2));
        console.log(`Scraped ${Object.keys(mapData).length} lobbies successfully.`);
    } catch (e) {
        console.error("Scrape failed:", e.message);
    } finally {
        if (browser) await browser.close();
    }
    
    // Run again in 20 seconds
    setTimeout(runScraper, 20000);
}

runScraper();
