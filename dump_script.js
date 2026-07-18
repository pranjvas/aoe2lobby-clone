const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

async function runDump() {
    let browser;
    try {
        console.log("Starting dump cycle...");
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 5000));
        
        const dumpHtml = await page.evaluate(async () => {
            // Click all lobbies on the current page to expand them
            const overviewRows = Array.from(document.querySelectorAll('tr.lobbyoverview'));
            if (overviewRows.length > 0) {
                overviewRows[0].click();
            }
            
            // Wait for the subtables to render
            await new Promise(r => setTimeout(r, 2000));
            
            if (overviewRows.length > 0) {
                let nextRow = overviewRows[0].nextElementSibling;
                while (nextRow && !nextRow.classList.contains('subtable') && !nextRow.classList.contains('lobbyoverview')) {
                    nextRow = nextRow.nextElementSibling;
                }
                if (nextRow && nextRow.classList.contains('subtable')) {
                    return nextRow.outerHTML;
                }
            }
            return "No subtable found.";
        });
        
        fs.writeFileSync('C:\\Users\\pranj\\.gemini\\antigravity\\scratch\\aoe2lobby-clone\\dump_output.html', dumpHtml);
        console.log("Dump written to dump_output.html");
    } catch (e) {
        console.error("Dump failed:", e.message);
    } finally {
        if (browser) await browser.close();
    }
}

runDump();
