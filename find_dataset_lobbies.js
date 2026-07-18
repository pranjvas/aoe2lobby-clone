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
        
        const result = await page.evaluate(async () => {
            const overviewRows = Array.from(document.querySelectorAll('tr.lobbyoverview'));
            // click all of them
            for (let i = 0; i < overviewRows.length; i++) {
                overviewRows[i].click();
            }
            await new Promise(r => setTimeout(r, 5000));
            
            let datasetHTML = "";
            for (let i = 0; i < overviewRows.length; i++) {
                let nextRow = overviewRows[i].nextElementSibling;
                while (nextRow && !nextRow.classList.contains('subtable') && !nextRow.classList.contains('lobbyoverview')) {
                    nextRow = nextRow.nextElementSibling;
                }
                if (nextRow && nextRow.classList.contains('subtable')) {
                    const html = nextRow.innerHTML;
                    if (html.includes('Dataset') || html.includes('Data Mod') || html.includes('Mod ') || html.includes('Mods')) {
                        datasetHTML += `\n<!-- LOBBY -->\n` + html;
                    }
                }
            }
            return datasetHTML;
        });
        
        fs.writeFileSync('subtable_dump_dataset.html', result);
        console.log("Dumped Dataset lobbies");
    } catch (e) {
        console.error(e);
    } finally {
        if (browser) await browser.close();
    }
}

run();
