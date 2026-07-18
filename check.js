const fs = require('fs');
let content = fs.readFileSync('lobbies.json', 'utf16le');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
const data = JSON.parse(content);
const matches = data.matches;
console.log(matches[0]);
