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
            const overviewRows = Array.from(document.querySelectorAll('tr.lobbyoverview'));
            for (let i = 0; i < Math.min(50, overviewRows.length); i++) {
                overviewRows[i].click();
            }
            await new Promise(r => setTimeout(r, 5000));
            
            let result = "";
            for (let i = 0; i < Math.min(50, overviewRows.length); i++) {
                let nextRow = overviewRows[i].nextElementSibling;
                while (nextRow && !nextRow.classList.contains('subtable') && !nextRow.classList.contains('lobbyoverview')) {
                    nextRow = nextRow.nextElementSibling;
                }
                
                if (nextRow && nextRow.classList.contains('subtable')) {
                    if (nextRow.innerHTML.includes('Dataset') || nextRow.innerHTML.includes('Mod')) {
                        result += `\n<!-- LOBBY ${i} -->\n`;
                        result += nextRow.innerHTML;
                    }
                }
            }
            return result;
        });
        
        fs.writeFileSync('subtable_dump_mod.html', html);
        console.log("Dumped to subtable_dump_mod.html");
    } catch (e) {
        console.error(e);
    } finally {
        if (browser) await browser.close();
    }
}

run();
