const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    // Intercept network requests
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.url().includes('api')) {
            console.log('API Request:', request.url());
        }
        request.continue();
    });

    page.on('response', async response => {
        if (response.url().includes('api')) {
            console.log('API Response URL:', response.url());
            try {
                const text = await response.text();
                console.log('API Response Body length:', text.length);
            } catch (e) {}
        }
    });

    await page.goto('https://aoe2lobby.com/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 5000));
    
    // Dump HTML
    const html = await page.content();
    require('fs').writeFileSync('dom_dump.html', html);
    console.log('Saved dom_dump.html');

    // Dump all rows and text
    const data = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('tr')).map(tr => tr.innerText.replace(/\n/g, ' | '));
    });
    require('fs').writeFileSync('rows_dump.txt', data.join('\n'));
    console.log('Saved rows_dump.txt');

    await browser.close();
})();
