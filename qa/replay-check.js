// QA for the replay viewer.
//   node qa/replay-check.js                      the /replay page and its files on a running server (BASE, default
//                                                http://127.0.0.1:3002; BASE=https://aoe2lobby.online for the live site)
//   node qa/replay-check.js parse <dir|files…>   replay-parse.js on local replays (nothing is uploaded or copied):
//        [--sample N]                            N files spread over the save versions found (default: all)
// Prints PASS / FAIL lines and exits non-zero when any check fails. Replays hold other players' names and chat:
// the parse mode prints only counts and file names.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failures++;
    return ok;
}

// ------------------------------------------------------------------ server mode
async function serverChecks() {
    const BASE = (process.env.BASE || 'http://127.0.0.1:3002').replace(/\/+$/, '');
    const get = async p => {
        const res = await fetch(BASE + p, { redirect: 'manual' });
        return { status: res.status, type: res.headers.get('content-type') || '', cache: res.headers.get('cache-control') || '',
            robots: res.headers.get('x-robots-tag') || '', body: await res.text() };
    };
    for (const p of ['/replay', '/replay/']) {
        const r = await get(p);
        check(`${p} serves the viewer page`, r.status === 200 && /text\/html/.test(r.type) && /id="rvDrop"/.test(r.body), r.status);
        check(`${p} is indexable and revalidates`, !/noindex/.test(r.robots) && /no-cache/.test(r.cache), { robots: r.robots, cache: r.cache });
    }
    check('/replay.html is not a second copy', (await get('/replay.html')).status === 404);
    check('/replay/anything is a 404', (await get('/replay/x')).status === 404);
    const page = (await get('/replay')).body;
    for (const asset of ['/replay.js', '/replay.css', '/styles.css']) {
        const m = new RegExp(`${asset.replace('.', '\\.')}\\?v=\\d+`).exec(page);
        check(`page loads ${asset} versioned`, !!m);
        if (m) {
            const r = await get(m[0]);
            check(`${m[0]} served immutable`, r.status === 200 && /immutable/.test(r.cache), { status: r.status, cache: r.cache });
        }
    }
    const js = (await get('/replay.js')).body;
    const worker = /new Worker\('([^']+)'\)/.exec(js);
    check('replay.js names a versioned worker', !!(worker && /\?v=\d+$/.test(worker[1])), worker && worker[1]);
    if (worker) {
        const w = await get(worker[1]);
        check('the worker is served as JavaScript', w.status === 200 && /javascript/.test(w.type), w.status);
        const parser = /importScripts\('([^']+)'\)/.exec(w.body);
        check('the worker loads a versioned parser', !!(parser && /\?v=\d+$/.test(parser[1])), parser && parser[1]);
        if (parser) {
            const pr = await get(parser[1]);
            check('the parser is served', pr.status === 200 && /ReplayParse/.test(pr.body), pr.status);
        }
    }
    const data = await get('/replay-data.json');
    let json = null;
    try { json = JSON.parse(data.body); } catch (e) { }
    check('/replay-data.json is JSON', data.status === 200 && json !== null, data.status);
    if (json) {
        check('replay-data.json carries the MIT licence', /MIT License/.test(json.licence || '') && /aoe2techtree/.test(json.source || ''));
        for (const k of ['units', 'buildings', 'techs', 'civs', 'terrain', 'ages']) check(`replay-data.json has ${k}`, json[k] && typeof json[k] === 'object' && Object.keys(json[k]).length > 0);
        check('replay-data.json names the villager', json.units && json.units['83'] && /Villager/.test(json.units['83'].name));
        check('replay-data.json has the three age techs', json.ages && [json.ages.feudal, json.ages.castle, json.ages.imperial].every(id => json.techs[id]));
        check('replay-data.json is small', data.body.length < 250000, data.body.length);
        check('replay-data.json cached for at most a day', /max-age=86400/.test(data.cache), data.cache);
    }
    for (const p of ['/tools/build-replay-data.js', '/qa/replay-check.js', '/docs/spectate-plan.md']) check(`${p} is not served`, (await get(p)).status === 404);
}

// ------------------------------------------------------------------ parse mode
function replayFiles(args) {
    const out = [];
    for (const a of args) {
        const st = fs.statSync(a);
        if (st.isDirectory()) for (const f of fs.readdirSync(a)) { if (/\.(aoe2record|zip)$/i.test(f)) out.push(path.join(a, f)); }
        else out.push(a);
    }
    return out;
}

// The save version from the first bytes alone, to spread a sample over versions
function saveOf(file) {
    const fd = fs.openSync(file, 'r'), head = Buffer.alloc(8192);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    try {
        const h = zlib.inflateRawSync(head.subarray(8, Math.min(head.readUInt32LE(0), head.length)), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        const f = h.readFloatLE(8);
        return f === -1 ? Math.round(h.readUInt32LE(12) / 65536 * 100) / 100 : Math.round(f * 100) / 100;
    } catch (e) { return 'zip/other'; }
}

function sample(files, n) {
    if (!n || n >= files.length) return files;
    const by = new Map();
    for (const f of files) { const s = saveOf(f); if (!by.has(s)) by.set(s, []); by.get(s).push(f); }
    const groups = [...by.values()], out = [];
    for (let i = 0; out.length < n; i++) {
        let added = false;
        for (const g of groups) if (i < g.length && out.length < n) { out.push(g[Math.floor((i * 7919) % g.length)]); added = true; }
        if (!added) break;
    }
    return [...new Set(out)];
}

// Contract problems of one parsed model (see docs/spectate-plan.md, Parser output)
function modelProblems(m) {
    const p = [];
    const expect = (ok, what) => { if (!ok) p.push(what); };
    expect(m.file && typeof m.file.save === 'number', 'file.save');
    expect(Number.isFinite(m.duration) && m.duration >= 0, 'duration');
    expect(m.file && Number.isInteger(m.file.steps) && [true, false, null].includes(m.file.watched), 'file.steps and file.watched');
    expect(Array.isArray(m.players) && m.players.length >= 1 && m.players.length <= 8, 'players');
    const numbers = new Set();
    for (const pl of m.players || []) {
        expect(Number.isInteger(pl.number) && pl.number >= 1 && pl.number <= 8 && !numbers.has(pl.number), `player number ${pl.number}`);
        numbers.add(pl.number);
        expect(typeof pl.name === 'string' && pl.name.length > 0, 'player name');
        expect(Number.isInteger(pl.color) && pl.color >= 1 && pl.color <= 8, `player colour ${pl.color}`);
        expect(pl.team === null || (Number.isInteger(pl.team) && pl.team >= 1), `player team ${pl.team}`);
        expect(typeof pl.human === 'boolean', 'player human');
        expect(['dark', 'feudal', 'castle', 'imperial', 'postimperial'].includes(pl.startingAge), `player starting age ${pl.startingAge}`);
        expect(Number.isInteger(pl.civId) && pl.civId >= 0, 'player civId');
    }
    const d = m.map && m.map.dimension;
    expect(Number.isInteger(d) && d >= 40 && d <= 480, `map dimension ${d}`);
    expect(m.map && m.map.terrain && m.map.terrain.length === d * d && m.map.elevation.length === d * d, 'map tiles');
    const inMap = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= -1 && y >= -1 && x <= d + 1 && y <= d + 1;
    let lastT = -1, outside = 0, unordered = 0, unknownPlayer = 0;
    for (const e of m.events || []) {
        if (e.t < lastT) unordered++;
        lastT = e.t;
        if (!numbers.has(e.p)) unknownPlayer++;
        if ('x' in e && !inMap(e.x, e.y)) outside++;
        if (e.k === 'wall' && !(inMap(e.x1, e.y1) && inMap(e.x2, e.y2))) outside++;
    }
    expect(!unordered, `${unordered} events out of order`);
    expect(!outside, `${outside} event positions outside the map`);
    expect(unknownPlayer <= (m.events || []).length * 0.01, `${unknownPlayer} events by unknown players`);
    for (const [k, list] of Object.entries(m.gaia || {})) {
        let bad = 0;
        for (let i = 0; i + 1 < list.length; i += 2) if (!inMap(list[i], list[i + 1])) bad++;
        expect(!bad, `${bad} ${k} outside the map`);
    }
    for (const [num, rows] of Object.entries(m.stats || {})) {
        expect(numbers.has(Number(num)), `stats for unknown player ${num}`);
        let prev = -1, bad = 0;
        // A bank can dip below 0: one corpus game has a player at -1600 food
        for (const r of rows) { if (!(r[0] >= prev && Number.isFinite(r[1]) && r[2] >= 0)) bad++; prev = r[0]; }
        expect(!bad, `${bad} bad stats rows for player ${num}`);
    }
    for (const c of m.chat || []) expect(typeof c.text === 'string' && Number.isFinite(c.t) && !/^<player_id,/.test(c.text), 'chat row');
    expect(!(m.warnings || []).some(w => /couldn't be read/.test(w)), 'unreadable orders');
    return p;
}

async function parseChecks(args) {
    const n = Number((args[args.indexOf('--sample') + 1]) || 0);
    const paths = args.filter((a, i) => a !== '--sample' && args[i - 1] !== '--sample');
    const files = sample(replayFiles(paths), args.includes('--sample') ? n : 0);
    const ReplayParse = require('../replay-parse.js');
    const data = require('../replay-data.json');
    const inflateRaw = async b => new Uint8Array(zlib.inflateRawSync(b));
    const bySave = new Map();
    let slowest = 0, parsed = 0, withEvents = 0, withStats = 0, complete = 0, withRatings = 0, withChat = 0;
    const unnamed = { civ: new Set(), unit: new Set(), building: new Set(), terrain: new Set() };
    let namedTechs = 0, unnamedTechs = 0;
    check('found replays to read', files.length > 0);
    for (const file of files) {
        const bytes = new Uint8Array(fs.readFileSync(file));
        const started = Date.now();
        let model = null, error = null;
        try { model = await ReplayParse.parseFile(bytes, inflateRaw, () => { }); } catch (e) { error = e; }
        const ms = Date.now() - started;
        slowest = Math.max(slowest, ms);
        const save = model ? model.file.save : saveOf(file);
        const row = bySave.get(save) || { n: 0, ok: 0, truncated: 0, events: 0, ms: 0 };
        row.n++;
        row.ms += ms;
        const name = path.basename(file);
        if (error) { check(`parses ${name}`, false, error.userMessage || error.message); bySave.set(save, row); continue; }
        const problems = modelProblems(model);
        if (check(`model of ${name}`, !problems.length, problems.slice(0, 6))) row.ok++;
        if (!model.file.complete) row.truncated++;
        row.events += model.events.length;
        parsed++;
        if (model.events.length) withEvents++;
        if (Object.values(model.stats).some(rows => rows.length)) withStats++;
        if (model.file.complete) complete++;
        if (model.players.some(p => p.rating)) withRatings++;
        if (model.chat.length) withChat++;
        const humans = new Set(model.players.filter(p => p.human).map(p => p.number));
        for (const p of model.players) if (!data.civs[p.civId]) unnamed.civ.add(p.civId);
        for (const t of new Set(model.map.terrain)) if (!data.terrain[t]) unnamed.terrain.add(t);
        for (const e of model.events) {
            if (e.k === 'build' || e.k === 'wall') { if (!data.buildings[e.unit]) unnamed.building.add(e.unit); }
            // An AI can train what no civ can: one corpus game has 8 of unit 361
            else if (e.k === 'queue') { if (!model.settings.mod && humans.has(e.p) && !data.units[e.unit]) unnamed.unit.add(e.unit); }
            else if (e.k === 'research') { if (data.techs[e.tech]) namedTechs++; else unnamedTechs++; }
        }
        bySave.set(save, row);
    }
    for (const [save, r] of [...bySave.entries()].sort()) {
        console.log(`save ${save}: ${r.ok}/${r.n} pass, ${r.truncated} truncated, ${Math.round(r.events / Math.max(1, r.n))} events/game, ${Math.round(r.ms / Math.max(1, r.n))} ms/game`);
    }
    console.log(`slowest parse ${slowest} ms`);
    // A broken decoder can still give well-formed empty games, so a real sample must hold real games
    if (parsed >= 10) {
        check('most files have orders', withEvents >= parsed * 0.9, `${withEvents}/${parsed}`);
        check('most files have bank figures', withStats >= parsed * 0.9, `${withStats}/${parsed}`);
        check('at least half run to their closing record', complete >= parsed / 2, `${complete}/${parsed}`);
        check('some files have ratings', withRatings > 0);
        check('some files have chat', withChat > 0);
    }
    // Ids only: techs are a count, because mods and Chronicles civs use many ids aoe2techtree doesn't have
    for (const [kind, ids] of Object.entries(unnamed)) check(`replay-data.json names every ${kind}`, !ids.size, [...ids].slice(0, 12));
    console.log(`techs named ${namedTechs}, unnamed ${unnamedTechs}`);
}

(async () => {
    const args = process.argv.slice(2);
    if (args[0] === 'parse') await parseChecks(args.slice(1));
    else await serverChecks();
    console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
