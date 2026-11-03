// Builds civ-info.json (the civ details the site shows on hover) from SiegeEngineers/aoe2techtree's data, MIT licence.
//   node tools/build-civ-info.js            fetches the pinned commit below from GitHub
//   node tools/build-civ-info.js <dir>      reads <dir>/data.json and <dir>/strings.json (data/locales/en/strings.json)
// Bump COMMIT (and GAME_UPDATE) after a game update, rerun, and commit civ-info.json. No dependencies.
// app.js fetches civ-info.json unversioned, so visitors get a new one within a day (the server's cache time for it).
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'SiegeEngineers/aoe2techtree';
const COMMIT = 'e56728e76b7d08301fba7b18d5f16bc8554c109a';
const GAME_UPDATE = '188329';
const LICENCE = 'MIT License, Copyright (c) 2018 HSZemi';
// aoe2techtree's LICENSE at that commit, shipped in full with the data taken from it
const LICENCE_TEXT = `MIT License

Copyright (c) 2018 HSZemi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const OUT = path.join(__dirname, '..', 'civ-info.json');

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'aoe2lobby.online civ-info build' } }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function load(dir) {
    if (dir) {
        return [JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, 'strings.json'), 'utf8'))];
    }
    const raw = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/data`;
    return Promise.all([get(`${raw}/data.json`).then(JSON.parse), get(`${raw}/locales/en/strings.json`).then(JSON.parse)]);
}

// Help texts are small HTML: <br> lines, <b>Section:</b> headers, "• " bullets
function plain(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&bull;|&#8226;|&#x2022;/gi, '•').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// "Composite Bowman (Foot Archer), Warrior Priest (Infantry)": split on commas outside parentheses
function splitTop(text) {
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of text) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

// "Name (what it does, maybe (nested))" -> [name, inside]; no parentheses -> [text, '']
function nameAndNote(text) {
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) return [text.trim(), ''];
    return [text.slice(0, open).trim(), text.slice(open + 1, close).trim()];
}

// Joins a line the help text wrapped ("... in Dark/Feudal/" + "Castle/Imperial Age"): no space after a slash or a
// hyphen ending a word ("Spearman-"); a spaced dash keeps its space
function joinWrapped(a, b) {
    return /(\/|\S-)$/.test(a) ? a + b : `${a} ${b}`;
}

function parseHelp(html) {
    const lines = html.split(/<br\s*\/?>/i).map(l => l.trim());
    const civ = { type: '', bonuses: [], uniqueUnits: [], uniqueTechs: [], teamBonus: '' };
    const items = { bonuses: [], units: [], techs: [], team: [] };
    let section = 'bonuses';
    for (const line of lines) {
        const header = /^<b>([^<]*?):?\s*<\/b>$/i.exec(line);
        if (header) {
            const h = header[1].toLowerCase();
            section = h.startsWith('unique unit') ? 'units' : h.startsWith('unique tech') ? 'techs' : h.startsWith('team bonus') ? 'team' : 'other';
            continue;
        }
        const text = plain(line);
        if (!text) continue;
        if (!civ.type) { civ.type = text; continue; }
        // A type line wrapped before its last word ("Cavalry and Naval" + "civilization")
        if (section === 'bonuses' && !items.bonuses.length && !/^•/.test(text) && !/civilization$/i.test(civ.type)) {
            civ.type = joinWrapped(civ.type, text);
            continue;
        }
        const list = items[section];
        if (!list) continue;
        // Bonuses and techs are "• " bullets: a line without one continues the bullet before it. Unit and team bonus
        // lines have no bullets, so each section's lines make one text.
        const bullet = /^•\s*/.test(text);
        const item = text.replace(/^•\s*/, '');
        const prev = list[list.length - 1];
        // A unit line after a finished "Name (class)" is another unit, not the rest of the line
        if (section === 'units' && prev !== undefined) list[list.length - 1] = /[),]$/.test(prev) ? `${prev.replace(/,$/, '')}, ${item}` : joinWrapped(prev, item);
        else if (prev !== undefined && (section === 'team' || !bullet)) list[list.length - 1] = joinWrapped(prev, item);
        else list.push(item);
    }
    civ.bonuses = items.bonuses;
    for (const text of items.units) {
        for (const u of splitTop(text).filter(Boolean)) { const [name, kind] = nameAndNote(u); civ.uniqueUnits.push({ name, kind }); }
    }
    for (const text of items.techs) { const [name, effect] = nameAndNote(text); civ.uniqueTechs.push({ name, effect }); }
    civ.teamBonus = items.team.join(' ');
    return civ;
}

const round = v => Math.round(v * 100) / 100;

function unitStats(u) {
    const cost = {};
    for (const [res, amount] of Object.entries(u.Cost || {})) if (amount > 0) cost[res.toLowerCase()] = amount;
    return {
        cost,
        hp: u.HP,
        attack: u.Attack,
        meleeArmor: u.MeleeArmor,
        pierceArmor: u.PierceArmor,
        range: round(u.Range || 0),
        speed: round(u.Speed || 0),
        trainTime: u.TrainTime
    };
}

async function main() {
    const [data, strings] = await load(process.argv[2]);
    // A unit's English name is string LanguageNameId + 9000, sometimes split over lines ("Throwing<br>\nAxeman"), or
    // for a few newer units the string LanguageNameId itself ("Ratha (Ranged)"); the Elite version has a name of its own
    const unitsByName = new Map();
    for (const u of Object.values(data.data.Unit)) {
        for (const id of [u.LanguageNameId + 9000, u.LanguageNameId]) {
            const name = plain(strings[String(id)] || '');
            if (!name) continue;
            if (!unitsByName.has(name)) unitsByName.set(name, []);
            unitsByName.get(name).push(u);
        }
    }
    const civs = {};
    const unmatched = [];
    // Keyed by the data's civ key, which is the name the game's lobby feeds use ("Incas", where the text says "Inca")
    for (const [key, c] of Object.entries(data.civs)) {
        const help = strings[c.help_string_id];
        if (!help) { unmatched.push(`${key}: no help text`); continue; }
        const info = parseHelp(help);
        // Each unique unit by name, preferring one in the civ's own unit list. A unit with modes ("Ratha") has no entry
        // of its own: the mode that fits its class stands in (ranged for an archer), named in statsOf
        for (const uu of info.uniqueUnits) {
            let units = unitsByName.get(uu.name) || [];
            if (!units.length) {
                const modes = [...unitsByName.keys()].filter(n => n.startsWith(`${uu.name} (`)).sort();
                const mode = modes.find(n => /archer/i.test(uu.kind) === /ranged/i.test(n)) || modes[0];
                if (mode) { units = unitsByName.get(mode); uu.statsOf = mode; }
            }
            const unit = units.find(u => (c.Unit || []).includes(u.ID)) || units[0];
            if (unit) uu.stats = unitStats(unit);
            else unmatched.push(`${key}: no unit data for ${uu.name}`);
        }
        // Anything that looks mis-parsed is printed (after a data update, check these before committing)
        if (!/^[A-Z][\w ,'-]* civilization$/.test(info.type)) unmatched.push(`${key}: type "${info.type}"`);
        if (!info.bonuses.length || !info.uniqueUnits.length || !info.uniqueTechs.length || !info.teamBonus) unmatched.push(`${key}: a section is empty`);
        // A bullet the parser didn't recognise merges items: every civ has 2 unique techs, and no text holds a second
        // "Name (" after a closing parenthesis
        if (info.uniqueTechs.length !== 2) unmatched.push(`${key}: ${info.uniqueTechs.length} unique techs`);
        for (const b of info.bonuses) if (!/^[A-Z0-9+]/.test(b) || b.length > 200) unmatched.push(`${key}: bonus "${b.slice(0, 60)}"`);
        for (const t of info.uniqueTechs) {
            if (!t.name || !t.effect || !/^[A-Z]/.test(t.name) || /\)\s+[A-Z][^()]*\(/.test(t.effect)) unmatched.push(`${key}: tech "${t.name}"`);
        }
        civs[key] = info;
    }
    const out = {
        source: `${REPO} at ${COMMIT.slice(0, 7)} (game update ${GAME_UPDATE}), ${LICENCE}`,
        licence: LICENCE_TEXT,
        civs
    };
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(civs).length} civs, ${fs.statSync(OUT).size} bytes`);
    for (const m of unmatched) console.log('  ' + m);
}

main().catch(e => { console.error(e); process.exit(1); });
