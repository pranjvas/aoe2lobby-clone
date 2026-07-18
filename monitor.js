const http = require('http');
const { spawn } = require('child_process');

process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection at:`, promise, 'reason:', reason);
});
process.on('exit', (code) => {
    console.log(`[${new Date().toISOString()}] monitor.js exiting with code ${code}`);
});

const processes = {
    'server.js': null,
    'fe_server.js': null
};

const lastRestart = {
    'server.js': 0,
    'fe_server.js': 0
};

function startServer(scriptName) {
    const now = Date.now();
    if (now - lastRestart[scriptName] < 10000) {
        return; // debounce restarts
    }
    lastRestart[scriptName] = now;

    if (processes[scriptName]) {
        try { processes[scriptName].kill(); } catch (e) {}
    }
    console.log(`[${new Date().toISOString()}] Starting ${scriptName}...`);
    const child = spawn('node', [scriptName], { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
        console.log(`[${new Date().toISOString()}] ${scriptName} exited with code ${code} and signal ${signal}`);
        processes[scriptName] = null;
    });
    child.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] Error starting ${scriptName}:`, err);
    });
    processes[scriptName] = child;
}

function checkAndRestart(url, scriptName) {
    let handled = false;
    const req = http.get(url, (res) => {
        // Consume response data to free up memory
        res.on('data', () => {});
        res.on('end', () => {});
        res.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] Response error on ${url}: ${err.message}`);
        });

        if (handled) return;
        handled = true;
        if (res.statusCode !== 200) {
            console.log(`[${new Date().toISOString()}] ${url} returned status ${res.statusCode}. Restarting ${scriptName}...`);
            startServer(scriptName);
        } else {
            console.log(`[${new Date().toISOString()}] ${url} is OK (200).`);
        }
    });

    req.on('error', (err) => {
        if (handled) return;
        handled = true;
        console.log(`[${new Date().toISOString()}] Error accessing ${url}: ${err.message}. Restarting ${scriptName}...`);
        startServer(scriptName);
    });

    req.setTimeout(5000, () => {
        if (handled) return;
        handled = true;
        console.log(`[${new Date().toISOString()}] Timeout accessing ${url}. Restarting ${scriptName}...`);
        req.destroy(); 
        startServer(scriptName);
    });
}

console.log("Uptime monitor started. Checking every 15 seconds.");

setInterval(() => {
    checkAndRestart('http://localhost:3000/api/lobbies', 'server.js');
    checkAndRestart('http://localhost:8080', 'fe_server.js');
}, 15000);

// Perform initial check
checkAndRestart('http://localhost:3000/api/lobbies', 'server.js');
checkAndRestart('http://localhost:8080', 'fe_server.js');
