const fs = require('fs');
const html = fs.readFileSync('subtable_dump_2.html', 'utf8');
const regex = /<td class="setting">([^<]+)<\/td><td class="settingvalue">([^<]*)<\/td>/g;
const matches = [...html.matchAll(regex)];
const settings = new Set(matches.map(m => m[1]));
console.log([...settings]);
