const http = require('http');
const { spawn } = require('child_process');

let childProc = null;

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

function startServer() {
    try {
        console.log('Starting fe_server.js...');
        childProc = spawn('node', ['fe_server.js'], { stdio: 'inherit' });
        childProc.on('exit', (code) => {
            console.log(`fe_server.js exited with code ${code}`);
            childProc = null;
        });
        childProc.on('error', (err) => {
            console.error('Failed to spawn fe_server.js', err);
        });
    } catch(e) {
        console.error('Exception in startServer:', e);
    }
}

function check() {
    try {
        const req = http.get('http://localhost:8080', (res) => {
            console.log(new Date().toISOString(), 'UP', res.statusCode);
            res.resume();
        });
        req.on('error', (err) => {
            console.log(new Date().toISOString(), 'DOWN', err ? err.message : err);
            if (childProc) {
                try { childProc.kill(); } catch(e) {}
                childProc = null;
            }
            startServer();
        });
        req.setTimeout(5000, () => {
            req.destroy(new Error('Timeout'));
        });
    } catch(e) {
        console.error('Exception in check:', e);
    }
}

setInterval(check, 30000);
console.log('Monitoring frontend every 30 seconds...');
check();
