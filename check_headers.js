const fs = require('fs');
const html = fs.readFileSync('dump_output.html', 'utf-8');
const puppeteer = require('puppeteer');

async function checkHeaders() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setContent(`<table>${html}</table>`);
    const result = await page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('thead th, thead td'));
        const bodyRows = document.querySelectorAll('tbody tr.lobbydetails');
        
        let headerTexts = headers.map(th => th.innerText.trim());
        let gameIdx = headerTexts.indexOf('Games');
        let winsIdx = headerTexts.indexOf('Wins');
        
        let rowData = [];
        bodyRows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, th'));
            rowData.push({
                games: gameIdx !== -1 && cells[gameIdx] ? cells[gameIdx].innerText.trim() : null,
                wins: winsIdx !== -1 && cells[winsIdx] ? cells[winsIdx].innerText.trim() : null
            });
        });
        return { headers: headerTexts, gameIdx, winsIdx, rowData };
    });
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
}
checkHeaders();
