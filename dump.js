const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    
    cdp.on('Network.webSocketFrameReceived', response => {
        const payload = response.response.payloadData;
        if (payload.includes('"lobby_match_all":')) {
            fs.writeFileSync('aoe2lobby_ws.json', payload);
            console.log('Saved lobby_match_all to aoe2lobby_ws.json');
        }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 8000));
    await browser.close();
})();
