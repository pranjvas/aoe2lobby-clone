const puppeteer = require('puppeteer');
const fs = require('fs');

async function testParse() {
    const html = fs.readFileSync('dump_output.html', 'utf-8');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setContent(`<table>${html}</table>`);
    const results = await page.evaluate(() => {
        const detailRows = document.querySelectorAll('tr.lobbydetails');
        let res = [];
        detailRows.forEach(dr => {
            const playerNameEl = dr.querySelector('.playername');
            if (playerNameEl && playerNameEl.innerText.trim() && playerNameEl.innerText.trim() !== 'Open' && playerNameEl.innerText.trim() !== 'Closed') {
                const statsEls = dr.querySelectorAll('.stats');
                let games = "";
                let wins = "";
                let winRate = "";
                if (statsEls.length >= 4) {
                    games = statsEls[2].innerText.trim();
                    const winsStr = statsEls[3].innerText.trim();
                    const wrMatch = winsStr.match(/(.+?)\s*\((.+?)%\)/);
                    if (wrMatch) {
                        wins = wrMatch[1].trim();
                        winRate = wrMatch[2].trim() + "%";
                    } else {
                        wins = winsStr;
                    }
                } else {
                    res.push("Not enough stats elements: " + statsEls.length);
                    for (let s of statsEls) {
                        res.push(s.innerText);
                    }
                }
                res.push({games, wins, winRate});
            }
        });
        return res;
    });
    console.log(results);
    await browser.close();
}
testParse();
