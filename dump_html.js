const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

async function run() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 5000));
        
        const html = await page.evaluate(async () => {
            const overviewRow = document.querySelector('tr.lobbyoverview');
            if (overviewRow) {
                overviewRow.click();
                await new Promise(r => setTimeout(r, 2000));
                
                let nextRow = overviewRow.nextElementSibling;
                while (nextRow && !nextRow.classList.contains('subtable') && !nextRow.classList.contains('lobbyoverview')) {
                    nextRow = nextRow.nextElementSibling;
                }
                
                if (nextRow && nextRow.classList.contains('subtable')) {
                    return nextRow.innerHTML;
                }
            }
            return "No subtable found";
        });
        
        fs.writeFileSync('subtable_dump.html', html);
        console.log("Dumped to subtable_dump.html");
    } catch (e) {
        console.error(e);
    } finally {
        if (browser) await browser.close();
    }
}

run();
