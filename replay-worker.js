// Reads a replay off the page's main thread: the page posts the file's bytes, this answers with the parsed model
// (replay-parse.js) or an error message. Nothing is fetched or sent anywhere.
'use strict';

importScripts('/replay-parse.js?v=5');

// The header is raw DEFLATE (no zlib wrapper). A file can claim to inflate to anything, so this stops at maxBytes.
async function inflateRaw(bytes, maxBytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let total = 0;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel(); throw new Error('inflates past the limit'); }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

// Older browsers have DecompressionStream without 'deflate-raw'
function canInflate() {
    try {
        new DecompressionStream('deflate-raw');
        return true;
    } catch (e) {
        return false;
    }
}

self.onmessage = async e => {
    try {
        if (!canInflate()) {
            self.postMessage({ type: 'error', message: 'This browser is too old to read replays. Try a current Chrome, Edge, Firefox or Safari.' });
            return;
        }
        const model = await ReplayParse.parseFile(new Uint8Array(e.data), inflateRaw, text => self.postMessage({ type: 'progress', text }));
        self.postMessage({ type: 'done', model });
    } catch (err) {
        self.postMessage({ type: 'error', message: (err && err.userMessage) || 'That file couldn\'t be read as an AoE2: DE replay.' });
        console.error(err);
    }
};
