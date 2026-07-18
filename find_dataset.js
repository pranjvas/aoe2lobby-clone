const fs = require('fs');
const html = fs.readFileSync('subtable_dump_mod.html', 'utf8');

// Find occurrences of 'Dataset'
let index = html.indexOf('Dataset');
if (index !== -1) {
    console.log("Dataset found around:", html.substring(index - 100, index + 200));
}

// Find occurrences of 'Mod ' or 'Mods'
index = html.indexOf('Mod');
if (index !== -1) {
    console.log("Mod found around:", html.substring(index - 100, index + 200));
}
