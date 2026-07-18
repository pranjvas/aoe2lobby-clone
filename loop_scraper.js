const { spawn } = require('child_process');

function runScraper() {
    console.log(`[${new Date().toISOString()}] Running scraper...`);
    const child = spawn('node', ['scraper.js']);
    
    child.stdout.on('data', data => console.log(`Scraper stdout: ${data}`));
    child.stderr.on('data', data => console.error(`Scraper stderr: ${data}`));
    
    child.on('close', code => {
        console.log(`Scraper exited with code ${code}. Restarting in 15 seconds...`);
        setTimeout(runScraper, 15000);
    });
}

runScraper();
