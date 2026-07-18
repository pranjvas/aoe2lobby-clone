const http = require('http');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', err => {
    console.error('CRASH:', err);
    fs.appendFileSync('crash.log', 'CRASH: ' + err.stack + '\n');
});

const server = http.createServer((req, res) => {
    try {
        let filePath = '.' + req.url.split('?')[0]; // Ignore query string
        if (filePath == './') filePath = './index.html';
        const extname = String(path.extname(filePath)).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml'
        };
        const contentType = mimeTypes[extname] || 'application/octet-stream';
        fs.readFile(filePath, function(error, content) {
            if (error) {
                if(error.code == 'ENOENT'){
                    res.writeHead(404);
                    res.end('File not found');
                } else {
                    res.writeHead(500);
                    res.end('Server error: '+error.code);
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    } catch(err) {
        console.error("Req Error", err);
    }
});
server.listen(8080);
console.log('Server running at http://localhost:8080/');

// Heartbeat to prevent task from being killed
setInterval(() => {
    console.log(`[HEARTBEAT] fe_server is alive at ${new Date().toISOString()}`);
}, 10000);
