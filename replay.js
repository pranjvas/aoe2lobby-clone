// Replay viewer (/replay): plays back a finished AoE2: DE game from its .aoe2record file, in the browser.
// The file is parsed in a worker (replay-worker.js, using replay-parse.js) and never leaves the page. Names, costs
// and terrain colours come from /replay-data.json (built from aoe2techtree's data by tools/build-replay-data.js).
// Everything from the file is put in with textContent, never as HTML.
'use strict';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const PLAYER_COLORS = { 1: '#405BFF', 2: '#FF0000', 3: '#00FF00', 4: '#FFFF00', 5: '#00FFFF', 6: '#FF57B3', 7: '#797979', 8: '#FF9600' };
const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
const ORDER_FADE_MS = 30000;    // how long a "units sent here" marker stays on the map (game time)
const FLARE_MS = 8000;
const CARD_REFRESH_MS = 250;     // player cards and tables redraw at most this often while playing
const AGES = ['feudal', 'castle', 'imperial'];
const AGE_NAMES = { dark: 'Dark Age', feudal: 'Feudal Age', castle: 'Castle Age', imperial: 'Imperial Age', postimperial: 'Post-Imperial' };
const RESOURCES = ['food', 'wood', 'gold', 'stone'];
const ORDER_KINDS = new Set(['move', 'attackMove', 'patrol', 'attackGround', 'order']);
const NOT_ARMY = new Set([13, 545]); // Fishing Ship, Transport Ship: Dock units, but not fighters
const RESOURCE_MARKS = [['gold', 'Gold', '#e2bd3c'], ['stone', 'Stone', '#c3cad1'], ['forage', 'Forage', '#c45cc0'], ['fish', 'Fish', '#7fd3ff'], ['relic', 'Relic', '#ffffff']];
const READ_TIMEOUT_MS = 60000;   // a real file takes under 3 s
const FOLLOW_POLL_MS = 6000;     // how often a recording being followed is read again
const FOLLOW_FRESH_MS = 60000;   // a recording written to within this is taken to be running
const FOLLOW_IDLE_MS = 600000;   // a pause can be long; this long without new data, the game is over
const OWN_GAME_FRESH_MS = 300000;
// A recording holds every player's orders as they happen, so a live view of your own game would show you your
// opponents'. The game hides that from its players, and so must this page.
const OWN_GAME_MESSAGE = 'This is a game you\'re playing. A recording holds every player\'s orders, so it can only be opened once the game has ended.';
// The longest list in 745 replays is 88,005 market rows; a forged file could ask for millions
const LIST_MAX = 100000;
const TABLE_ROWS_MAX = 5000;

const $ = id => document.getElementById(id);
let gameData = null;              // replay-data.json, or an empty stand-in if it failed to load
let dataLoading = null;
let game = null;                  // the parsed replay plus what the viewer derives from it
let view = null;                  // the built page: elements, map, charts
let currentLoad = null;           // the file being read: a newer one replaces it
let follow = null;                // the running game being followed: { handle, size, changedAt, timer, failures, shown }
const clockState = { t: 0, playing: false, speed: 8, lastFrame: 0, lastCards: 0, frame: 0 };

// ------------------------------------------------------------------ small helpers
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
}

const pad2 = n => String(n).padStart(2, '0');

function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

const fmt = n => Math.round(n).toLocaleString('en-US');

function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e4) return `${Math.round(n / 1000)}K`;
    if (a >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(Math.round(n));
}

function swatch(color) {
    const s = el('span', `player-color player-color-${PLAYER_COLORS[color] ? color : 'none'}`);
    s.setAttribute('aria-hidden', 'true');
    return s;
}

// Index of the last item with item.t <= t in a list sorted by t (-1 if none)
function lastAtOrBefore(list, t, key = x => x.t) {
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (key(list[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

function unitInfo(id) { return (gameData.units && gameData.units[id]) || (gameData.buildings && gameData.buildings[id]) || null; }
function unitName(id) { const u = unitInfo(id); return u ? u.name : `Unit ${id}`; }
function buildingInfo(id) { return (gameData.buildings && gameData.buildings[id]) || null; }
function buildingName(id) { const b = buildingInfo(id); return b ? b.name : unitName(id); }
// A building's footprint in tiles: the game's own size for that player (farms and civ buildings vary), else the table's
// A gate's is [width, height], so this always answers that way
function sizeOf(player, id) {
    const own = game.sizes && game.sizes[player] && game.sizes[player][id];
    const info = buildingInfo(id);
    const size = own || (info && info.size) || 2;
    return Array.isArray(size) ? size : [size, size];
}
function techInfo(id) { return (gameData.techs && gameData.techs[id]) || null; }
function techName(id) { const t = techInfo(id); return t ? t.name : `Tech ${id}`; }
function civName(p) { return (gameData.civs && gameData.civs[p.civId]) || (p.civId ? `Civ ${p.civId}` : ''); }

function status(text, isError = false) {
    const s = $('rvStatus');
    s.textContent = text;
    s.classList.toggle('rv-error', isError);
}

// ------------------------------------------------------------------ loading
function loadGameData() {
    if (!dataLoading) {
        dataLoading = fetch('/replay-data.json')
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .catch(() => {
                dataLoading = null; // the next file tries again
                return { units: {}, buildings: {}, techs: {}, ages: {}, civs: {}, maps: {}, terrain: {}, failed: true };
            })
            .then(d => { gameData = d; return d; });
    }
    return dataLoading;
}

// A load replaced by a newer one is stopped here and its promise never settles: the newer load owns the page
function parseInWorker(buffer, load) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker('/replay-worker.js?v=2');
        } catch (e) {
            reject(new Error('This browser can\'t run the replay reader.'));
            return;
        }
        const stop = () => { clearTimeout(timer); worker.terminate(); };
        const timer = setTimeout(() => { stop(); reject(new Error('That file took too long to read.')); }, READ_TIMEOUT_MS);
        load.stop = stop;
        worker.onmessage = e => {
            const m = e.data || {};
            if (m.type === 'progress') { if (load === currentLoad) status(m.text); }
            else if (m.type === 'done') { stop(); resolve(m.model); }
            else if (m.type === 'error') { stop(); reject(new Error(m.message)); }
        };
        worker.onerror = e => { e.preventDefault(); stop(); reject(new Error('The replay reader stopped unexpectedly.')); };
        worker.postMessage(buffer, [buffer]);
    });
}

async function openFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { status('That file is too big to be a replay (over 64 MB).', true); return; }
    if (file.size < 64) { status('That file is too small to be a replay.', true); return; }
    // Only a file that will really be read replaces the one being read
    stopFollowing();
    if (currentLoad && currentLoad.stop) currentLoad.stop();
    const load = currentLoad = { stop: null };
    stopPlaying();
    status(`Reading ${file.name}…`);
    $('rvPick').disabled = true;
    try {
        const [buffer] = await Promise.all([file.arrayBuffer(), loadGameData()]);
        if (load !== currentLoad) return;
        const model = await parseInWorker(buffer, load);
        if (load !== currentLoad) return;
        // A file that stops mid-game and was written just now is a game still running
        if (!model.file.complete && model.file.watched === false && Date.now() - file.lastModified < OWN_GAME_FRESH_MS) {
            status(OWN_GAME_MESSAGE, true);
            return;
        }
        showGame(model);
        status('');
    } catch (e) {
        if (load === currentLoad) status(e.message || 'That file couldn\'t be read.', true);
    } finally {
        if (load === currentLoad) {
            currentLoad = null;
            $('rvPick').disabled = false;
            $('rvFile').value = '';
        }
    }
}

function wireLoading() {
    $('rvPick').addEventListener('click', () => $('rvFile').click());
    if (window.showDirectoryPicker) {
        $('rvFollow').hidden = false;
        $('rvFollowPick').addEventListener('click', pickFollowFolder);
    }
    $('rvFile').addEventListener('change', e => openFile(e.target.files && e.target.files[0]));
    // A file can be dropped anywhere on the page
    let depth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; document.body.classList.add('rv-dragging'); });
    document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('rv-dragging'); });
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        document.body.classList.remove('rv-dragging');
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) { $('rvLoad').hidden = false; openFile(file); }
    });
}

// ------------------------------------------------------------------ what the viewer derives from the model
function derive(model) {
    const g = model;
    g.players.sort((a, b) => (a.team ?? 99) - (b.team ?? 99) || a.number - b.number);
    g.byNumber = new Map(g.players.map(p => [p.number, p]));
    const per = new Map(g.players.map(p => [p.number, {
        queue: [], research: [], ageLines: [], build: [], wall: [], market: [], tribute: [], tributeIn: [], orders: [], flares: [], resign: null
    }]));
    g.builds = []; g.walls = []; g.orders = []; g.flares = [];
    for (const e of g.events) {
        const pe = per.get(e.p);
        if (!pe) continue;
        if (e.k === 'queue') pe.queue.push(e);
        else if (e.k === 'research') pe.research.push(e);
        else if (e.k === 'age') pe.ageLines.push(e);
        else if (e.k === 'build') { pe.build.push(e); g.builds.push(e); }
        else if (e.k === 'wall') { pe.wall.push(e); g.walls.push(e); }
        else if (e.k === 'buy' || e.k === 'sell') pe.market.push(e);
        else if (e.k === 'tribute') { pe.tribute.push(e); const to = per.get(e.to); if (to) to.tributeIn.push(e); }
        else if (e.k === 'flare') { pe.flares.push(e); g.flares.push(e); }
        else if (e.k === 'resign') { if (!pe.resign) pe.resign = e; }
        else if (ORDER_KINDS.has(e.k)) { pe.orders.push(e); g.orders.push(e); }
    }
    g.per = per;
    g.ageLines = g.events.some(e => e.k === 'age');
    for (const p of g.players) {
        p.colorHex = PLAYER_COLORS[p.color] || '#9aa4ae';
        p.ages = ageTimes(g, per.get(p.number));
        p.stats = (g.stats && g.stats[p.number]) || [];
        // Quiet minutes after a player's last order are zeros. AI players have no row, so no flat line on the chart
        const row = g.apm && g.apm[p.number];
        p.apm = row ? row.slice() : [];
        if (row) while (p.apm.length <= Math.floor((g.duration || 0) / 60000)) p.apm.push(0);
    }
    g.sides = sidesOf(g.players);
    g.duration = Math.max(g.duration || 0, 1000);
    return g;
}

// Age-ups: the game announces them, so the times are exact. A file without those lines falls back on the last click
// on each age tech (an earlier one was cancelled) plus its research time, an estimate: a click can wait behind units.
function ageTimes(g, pe) {
    const lastClick = new Map();
    for (const e of pe.research) lastClick.set(e.tech, e.t);
    const clickOf = age => lastClick.get(gameData.ages && gameData.ages[age]) ?? null;
    if (g.ageLines) return pe.ageLines.map(e => ({ age: e.age, label: e.label, click: clickOf(e.age) ?? e.t, reached: e.t, exact: true }));
    const ages = [];
    for (const age of AGES) {
        const click = clickOf(age);
        if (click === null) continue;
        const tech = techInfo(gameData.ages[age]);
        const seconds = g.settings.turbo ? 0 : (tech && tech.time) || 0;
        ages.push({ age, click, reached: click + seconds * 1000, exact: false });
    }
    return ages;
}

function ageLabel(a) { return a.label || AGE_NAMES[a.age]; }
function ageWhen(a) { return `${a.exact ? '' : '≈'}${clock(a.reached)}`; }

function ageAt(g, p, t) {
    let age = AGE_NAMES[p.startingAge] || AGE_NAMES.dark;
    let researching = null;
    for (const a of p.ages) {
        if (a.reached <= t) age = ageLabel(a);
        else if (a.click <= t) researching = ageLabel(a);
    }
    return { age, researching };
}

// Teams in order; each player without a team is a side of their own
function sidesOf(players) {
    const teams = new Map(), solo = [];
    for (const p of players) {
        if (p.team === null || p.team === undefined) { solo.push([p]); continue; }
        if (!teams.has(p.team)) teams.set(p.team, []);
        teams.get(p.team).push(p);
    }
    return [...[...teams.keys()].sort((a, b) => a - b).map(t => teams.get(t)), ...solo];
}

function costOf(info, n = 1) {
    const c = (info && info.cost) || {};
    return { food: (c.food || 0) * n, wood: (c.wood || 0) * n, gold: (c.gold || 0) * n, stone: (c.stone || 0) * n };
}

function wallTiles(e) { return Math.max(Math.abs(e.x2 - e.x1), Math.abs(e.y2 - e.y1)) + 1; }

// A player's orders up to time t: units queued by type, buildings placed by type, techs, resources spent (estimates)
function tallyAt(g, p, t) {
    const pe = g.per.get(p.number);
    const units = new Map(), buildings = new Map(), techs = [];
    const spent = { food: 0, wood: 0, gold: 0, stone: 0 };
    const add = c => { for (const r of RESOURCES) spent[r] += c[r]; };
    let villagers = 0, army = 0;
    for (let i = 0, n = lastAtOrBefore(pe.queue, t); i <= n; i++) {
        const e = pe.queue[i];
        units.set(e.unit, (units.get(e.unit) || 0) + e.n);
        const info = unitInfo(e.unit);
        add(costOf(info, e.n));
        if (info && info.cls === 'villager') villagers += e.n;
        else if (!NOT_ARMY.has(e.unit) && (!info || !['trade', 'other'].includes(info.cls))) army += e.n;
    }
    for (let i = 0, n = lastAtOrBefore(pe.build, t); i <= n; i++) {
        const e = pe.build[i];
        buildings.set(e.unit, (buildings.get(e.unit) || 0) + 1);
        add(costOf(buildingInfo(e.unit)));
    }
    for (let i = 0, n = lastAtOrBefore(pe.wall, t); i <= n; i++) {
        const e = pe.wall[i];
        buildings.set(e.unit, (buildings.get(e.unit) || 0) + wallTiles(e));
        add(costOf(buildingInfo(e.unit), wallTiles(e)));
    }
    for (let i = 0, n = lastAtOrBefore(pe.research, t); i <= n; i++) {
        techs.push(pe.research[i]);
        add(costOf(techInfo(pe.research[i].tech)));
    }
    return { units, buildings, techs, spent, villagers, army };
}

function statAt(p, t) {
    const i = lastAtOrBefore(p.stats, t, r => r[0]);
    return i < 0 ? null : { t: p.stats[i][0], bank: p.stats[i][1], objects: p.stats[i][2] };
}

// The last full minute, so a figure never includes orders still to come
function apmAt(p, t) {
    return p.apm[Math.floor(t / 60000) - 1] || 0;
}

// ------------------------------------------------------------------ building the page
function showGame(model) {
    stopPlaying();
    game = derive(model);
    clockState.t = follow ? game.duration : 0;
    const root = $('rvView');
    root.textContent = '';
    view = { cards: new Map(), charts: [], logs: [], tabs: {} };
    root.append(buildHead(), buildGrid(), buildTimeline(), buildTabs());
    $('rvLoad').hidden = true;
    root.hidden = false;
    view.map.resize();
    for (const c of view.charts) c.measure();
    renderAll(true);
    root.querySelector('h2').focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
}

function formatLabel(g) {
    const sizes = g.sides.map(s => s.length);
    if (sizes.length > 2 && sizes.every(n => n === 1)) return `${sizes.length}-player free for all`;
    return sizes.join('v');
}

function buildHead() {
    const g = game, s = g.settings;
    const head = el('header', 'glass-panel rv-head');
    const left = el('div');
    const title = el('h2', null, s.map || (gameData.maps && gameData.maps[s.rmsMapId]) || 'Unknown map');
    title.tabIndex = -1;
    const meta = [formatLabel(g)];
    if (s.mapSize) meta.push(s.mapSize);
    meta.push(follow ? 'In progress' : clock(g.duration));
    if (g.startedAt) meta.push(new Date(g.startedAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    if (s.speed && s.speed !== 'Normal') meta.push(`${s.speed} speed`);
    if (s.population) meta.push(`${s.population} pop`);
    if (s.turbo) meta.push('Turbo');
    if (s.treaty) meta.push(`${s.treaty} min treaty`);
    left.append(title, el('p', 'rv-meta', meta.join(' · ')));
    const notes = [];
    if (s.lobby) notes.push(`Lobby: ${s.lobby}`);
    notes.push(`Game file ${g.file.game}, save ${g.file.save}${g.file.build ? `, build ${g.file.build}` : ''}`);
    left.append(el('p', 'rv-notes', notes.join(' · ')));
    if (!follow) for (const w of g.warnings || []) left.append(el('p', 'rv-notes', w));
    if (gameData.failed) left.append(el('p', 'rv-notes', 'The game data couldn\'t be loaded: names show as ids, the map is one colour, and the villager, army and spent figures are wrong. Reload the page, or open the file again, to try again.'));
    const again = el('button', 'btn-view', 'Open another replay');
    again.type = 'button';
    again.addEventListener('click', () => {
        stopFollowing();
        stopPlaying();
        $('rvLoad').hidden = false;
        $('rvView').hidden = true;
        $('rvPick').focus();
    });
    head.append(left, again);
    return head;
}

function buildGrid() {
    const grid = el('div', 'rv-grid');
    grid.append(buildMapPanel(), buildPlayers());
    return grid;
}

// ------------------------------------------------------------------ the map
const LAYERS = [
    { key: 'resources', label: 'Resources', on: true },
    { key: 'buildings', label: 'Buildings', on: true },
    { key: 'orders', label: 'Units sent', on: true },
    { key: 'work', label: 'Villagers sent to gather', on: false },
    { key: 'flares', label: 'Flares', on: true }
];

function buildMapPanel() {
    const panel = el('section', 'glass-panel rv-map-panel');
    panel.setAttribute('aria-label', 'Map');
    const wrap = el('div', 'rv-map-wrap');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Map of the game: terrain, resources, buildings placed so far and where units were sent recently');
    const tip = el('div', 'rv-map-tip');
    tip.hidden = true;
    wrap.append(canvas, tip);
    const layers = el('div', 'rv-layers');
    const on = {};
    for (const l of LAYERS) {
        on[l.key] = l.on;
        const label = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = l.on;
        box.addEventListener('change', () => { on[l.key] = box.checked; view.map.dirty = true; drawMap(); });
        label.append(box, document.createTextNode(l.label));
        layers.append(label);
    }
    const zoom = el('span', 'rv-zoom');
    const button = (text, label, act) => {
        const b = el('button', 'btn-view rv-zoom-btn', text);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.addEventListener('click', act);
        zoom.append(b);
    };
    button('+', 'Zoom in', () => view.map.zoomBy(1));
    button('−', 'Zoom out', () => view.map.zoomBy(-1));
    button('←', 'Move the map left', () => view.map.panBy(60, 0));
    button('↑', 'Move the map up', () => view.map.panBy(0, 60));
    button('↓', 'Move the map down', () => view.map.panBy(0, -60));
    button('→', 'Move the map right', () => view.map.panBy(-60, 0));
    button('Reset', 'Reset the map view', () => view.map.zoomBy(0));
    layers.append(zoom);
    const marks = el('div', 'rv-layers rv-marks-key');
    marks.append(el('span', null, 'Resources:'));
    for (const [, name, color] of RESOURCE_MARKS) {
        const item = el('span', 'rv-mark-key');
        const dot = el('span', 'rv-key');
        dot.style.background = color;
        dot.setAttribute('aria-hidden', 'true');
        item.append(dot, document.createTextNode(name));
        marks.append(item);
    }
    panel.append(wrap, layers, marks, el('p', 'rv-map-note',
        'Everything else is in each player\'s colour. Buildings show where they were placed: the file doesn\'t say when '
        + 'one is finished or destroyed. Dots show where units were sent in the last 30 game seconds, crosses where '
        + 'villagers were sent to gather, and rings are flares. On the timeline, bars mark age-ups and dots mark '
        + 'resignations. Drag to move, scroll or use the buttons to zoom.'));
    view.map = new MapView(canvas, tip, on);
    return panel;
}

function hexRgb(hex) {
    const n = parseInt(String(hex || '#000').slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class MapView {
    constructor(canvas, tip, layers) {
        this.canvas = canvas;
        this.tip = tip;
        this.layers = layers;
        this.ctx = canvas.getContext('2d');
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.dim = game.map.dimension;
        this.base = this.buildBase();
        this.footprints = game.builds.map(e => this.footprint(e));
        const parts = gameData.parts || {};
        this.startBuildings = (game.startObjects || []).filter(o => buildingInfo(o.unit) && !parts[o.unit] && game.byNumber.has(o.player)).map(o => {
            const [w, h] = sizeOf(o.player, o.unit);
            return { p: game.byNumber.get(o.player), w, h, x0: o.x - w / 2, y0: o.y - h / 2 };
        });
        this.dirty = true;
        this.wire();
        new ResizeObserver(() => { this.resize(); drawMap(); }).observe(canvas.parentElement);
    }

    // Terrain to one pixel per tile, shaded by elevation, with trees darkened in
    buildBase() {
        const dim = this.dim, terrain = game.map.terrain, elevation = game.map.elevation;
        const off = document.createElement('canvas');
        off.width = dim;
        off.height = dim;
        const octx = off.getContext('2d');
        const img = octx.createImageData(dim, dim);
        const palette = new Map();
        const colorOf = id => {
            if (!palette.has(id)) palette.set(id, hexRgb((gameData.terrain && gameData.terrain[id] && gameData.terrain[id].color) || '#4a6a3a'));
            return palette.get(id);
        };
        for (let i = 0; i < dim * dim; i++) {
            // Stored row-major as [y][x]: image pixel (x, y) is tile (x, y)
            const [r, g, b] = colorOf(terrain[i]);
            const shade = 0.86 + Math.min(elevation[i] || 0, 8) * 0.045;
            img.data[i * 4] = Math.min(255, r * shade);
            img.data[i * 4 + 1] = Math.min(255, g * shade);
            img.data[i * 4 + 2] = Math.min(255, b * shade);
            img.data[i * 4 + 3] = 255;
        }
        const trees = (game.gaia && game.gaia.tree) || [];
        for (let i = 0; i + 1 < trees.length; i += 2) {
            const x = Math.floor(trees[i]), y = Math.floor(trees[i + 1]);
            if (x < 0 || y < 0 || x >= dim || y >= dim) continue;
            const k = (y * dim + x) * 4;
            img.data[k] = 34; img.data[k + 1] = 70; img.data[k + 2] = 38;
        }
        octx.putImageData(img, 0, 0);
        return off;
    }

    // Buildings placed since the last read of a game in progress
    refresh() {
        this.footprints = game.builds.map(e => this.footprint(e));
        this.dirty = true;
    }

    footprint(e) {
        const [w, h] = sizeOf(e.p, e.unit);
        return { e, w, h, x0: e.x - w / 2, y0: e.y - h / 2 };
    }

    resize() {
        const r = this.canvas.parentElement.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = Math.max(1, Math.round(r.width * dpr));
        this.canvas.height = Math.max(1, Math.round(r.height * dpr));
        this.cssW = r.width;
        this.cssH = r.height;
        this.dpr = dpr;
        this.dirty = true;
    }

    // Tile (x, y) to canvas pixels. The map is a 2:1 diamond like the game's minimap: tile (0, 0) at the left corner,
    // x running up to the top corner and y down to the bottom corner (as RecAnalyst draws it).
    matrix() {
        const W = this.canvas.width, H = this.canvas.height, d = this.dim, z = this.zoom;
        const a = z * W / (2 * d), b = z * H / (2 * d);
        // Zoomed about the canvas centre, then panned
        return [a, -b, a, b, W / 2 * (1 - z) + this.panX * this.dpr, H / 2 + this.panY * this.dpr];
    }

    toScreen(x, y) {
        const [a, b, c, d, e, f] = this.matrix();
        return [a * x + c * y + e, b * x + d * y + f];
    }

    toTile(px, py) {
        // Inverse of the affine matrix (canvas pixels to tile)
        const [a, b, c, d, e, f] = this.matrix();
        const det = a * d - b * c;
        const x = px - e, y = py - f;
        return [(d * x - c * y) / det, (-b * x + a * y) / det];
    }

    zoomBy(step, cx, cy) {
        const old = this.zoom;
        const z = step === 0 ? 1 : Math.min(8, Math.max(1, old * (step > 0 ? 1.4 : 1 / 1.4)));
        if (step === 0) { this.panX = 0; this.panY = 0; }
        else {
            // Keep the point under the pointer (or the centre) still
            const px = cx ?? this.cssW / 2, py = cy ?? this.cssH / 2;
            this.panX = px - (px - this.panX - this.cssW / 2) * (z / old) - this.cssW / 2;
            this.panY = py - (py - this.panY - this.cssH / 2) * (z / old) - this.cssH / 2;
        }
        this.zoom = z;
        // Zoomed in, a finger moves the map; at full size it scrolls the page
        this.canvas.style.touchAction = z > 1 ? 'none' : 'pan-y';
        this.clampPan();
        this.dirty = true;
        drawMap();
    }

    panBy(dx, dy) {
        this.panX += dx;
        this.panY += dy;
        this.clampPan();
        this.dirty = true;
        drawMap();
    }

    clampPan() {
        const limX = this.cssW * (this.zoom - 1) / 2 + 40, limY = this.cssH * (this.zoom - 1) / 2 + 40;
        this.panX = Math.max(-limX, Math.min(limX, this.panX));
        this.panY = Math.max(-limY, Math.min(limY, this.panY));
    }

    wire() {
        const c = this.canvas;
        let drag = null;
        c.addEventListener('wheel', e => {
            e.preventDefault();
            const r = c.getBoundingClientRect();
            this.zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY }; c.setPointerCapture(e.pointerId); });
        c.addEventListener('pointermove', e => {
            if (drag) {
                this.panX = drag.px + e.clientX - drag.x;
                this.panY = drag.py + e.clientY - drag.y;
                this.clampPan();
                this.dirty = true;
                drawMap();
                this.tip.hidden = true;
                return;
            }
            this.hover(e);
        });
        c.addEventListener('pointerup', e => {
            // A tap has no hover, so it names what's under it
            if (drag && e.pointerType !== 'mouse' && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) this.hover(e);
            drag = null;
        });
        c.addEventListener('pointercancel', () => { drag = null; });
        c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.tip.hidden = true; });
        c.addEventListener('dblclick', () => this.zoomBy(0));
    }

    // Names the building under the pointer: the newest one placed there by now
    hover(e) {
        const r = this.canvas.getBoundingClientRect();
        const [tx, ty] = this.toTile((e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
        let found = null;
        if (this.layers.buildings) {
            const n = lastAtOrBefore(game.builds, clockState.t);
            for (let i = n; i >= 0; i--) {
                const f = this.footprints[i];
                if (tx >= f.x0 && tx <= f.x0 + f.w && ty >= f.y0 && ty <= f.y0 + f.h) { found = f.e; break; }
            }
        }
        if (!found) { this.tip.hidden = true; return; }
        const p = game.byNumber.get(found.p);
        this.tip.textContent = '';
        this.tip.append(el('strong', null, buildingName(found.unit)), el('br'),
            document.createTextNode(`${p ? p.name : 'Player'} · placed ${clock(found.t)}`));
        // Anchored from the side it opens towards, so it never runs off the map
        const x = e.clientX - r.left, y = e.clientY - r.top, right = x > this.cssW / 2, below = y > this.cssH / 2;
        Object.assign(this.tip.style, {
            left: right ? 'auto' : `${x + 12}px`, right: right ? `${this.cssW - x + 12}px` : 'auto',
            top: below ? 'auto' : `${y + 12}px`, bottom: below ? `${this.cssH - y + 12}px` : 'auto'
        });
        this.tip.hidden = false;
    }

    draw(t) {
        const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const m = this.matrix();
        ctx.setTransform(...m);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.base, 0, 0);
        const px = Math.max(1.5, this.zoom * W / (2 * this.dim) * 0.9);   // about one tile, in canvas pixels
        if (this.layers.resources) this.drawResources(ctx, px);
        if (this.layers.buildings) this.drawBuildings(ctx, t);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (this.layers.orders || this.layers.work) this.drawOrders(ctx, t, px);
        if (this.layers.flares) this.drawFlares(ctx, t, px);
        this.dirty = false;
    }

    drawResources(ctx, px) {
        const g = game.gaia || {};
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const r = Math.max(1, px * 0.45);
        for (const [kind, , color] of RESOURCE_MARKS) {
            const list = g[kind] || [];
            ctx.fillStyle = color;
            for (let i = 0; i + 1 < list.length; i += 2) {
                const [sx, sy] = this.toScreen(list[i], list[i + 1]);
                if (kind === 'relic') { ctx.fillRect(sx - r, sy - r, r * 2, r * 2); continue; }
                ctx.beginPath();
                ctx.arc(sx, sy, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    drawBuildings(ctx, t) {
        // Drawn in tile space, so a square footprint becomes a diamond like the map
        const pad = 0.12;
        const place = (f, color) => {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(f.x0 - pad, f.y0 - pad, f.w + 2 * pad, f.h + 2 * pad);
            ctx.fillStyle = color;
            ctx.fillRect(f.x0, f.y0, f.w, f.h);
        };
        for (const f of this.startBuildings) place(f, f.p.colorHex);
        const n = lastAtOrBefore(game.walls, t);
        ctx.lineCap = 'square';
        for (let i = 0; i <= n; i++) {
            const w = game.walls[i], p = game.byNumber.get(w.p);
            ctx.strokeStyle = p ? p.colorHex : '#999';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(w.x1 + 0.5, w.y1 + 0.5);
            ctx.lineTo(w.x2 + 0.5, w.y2 + 0.5);
            ctx.stroke();
        }
        const nb = lastAtOrBefore(game.builds, t);
        for (let i = 0; i <= nb; i++) {
            const f = this.footprints[i], p = game.byNumber.get(f.e.p);
            if (p) place(f, p.colorHex);
        }
    }

    drawOrders(ctx, t, px) {
        const from = lastAtOrBefore(game.orders, t - ORDER_FADE_MS) + 1, to = lastAtOrBefore(game.orders, t);
        for (let i = from; i <= to; i++) {
            const e = game.orders[i], p = game.byNumber.get(e.p);
            if (!p || !this.layers[e.work ? 'work' : 'orders']) continue;
            const age = (t - e.t) / ORDER_FADE_MS;
            const [sx, sy] = this.toScreen(e.x, e.y);
            const r = Math.max(2.5, px * 0.6) * (1 + Math.log2(Math.max(1, e.n || 1)) / 3);
            ctx.globalAlpha = Math.max(0, 1 - age) * 0.85;
            if (e.work) {
                // A cross, a shape nothing else on the map uses
                ctx.lineWidth = 2 * this.dpr;
                ctx.strokeStyle = p.colorHex;
                ctx.beginPath();
                ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx + r, sy + r);
                ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx - r, sy + r);
                ctx.stroke();
                continue;
            }
            ctx.fillStyle = p.colorHex;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 1.5 * this.dpr;
            ctx.strokeStyle = 'rgba(15,20,27,0.9)';
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    drawFlares(ctx, t, px) {
        const from = lastAtOrBefore(game.flares, t - FLARE_MS) + 1, to = lastAtOrBefore(game.flares, t);
        for (let i = from; i <= to; i++) {
            const e = game.flares[i], p = game.byNumber.get(e.p);
            if (!p) continue;
            const age = (t - e.t) / FLARE_MS;
            const [sx, sy] = this.toScreen(e.x, e.y);
            ctx.globalAlpha = 1 - age;
            ctx.strokeStyle = p.colorHex;
            ctx.lineWidth = 2.5 * this.dpr;
            for (const k of [0, 0.5]) {
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(6, px * 2) * (1 + ((age * 3 + k) % 1) * 2), 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }
}

function drawMap() {
    if (view && view.map) view.map.draw(clockState.t);
}

// ------------------------------------------------------------------ players
function buildPlayers() {
    const wrap = el('section', 'rv-players');
    wrap.setAttribute('aria-label', 'Players');
    // Players without a team share one box; a team gets a box and a heading of its own
    const teams = game.sides.filter(s => s[0].team !== null), solo = game.sides.filter(s => s[0].team === null).flat();
    const box = (heading, players) => {
        const panel = el('div', 'glass-panel rv-team');
        if (heading) panel.append(el('h3', 'rv-team-name', heading));
        const list = el('div', 'rv-team-players');
        for (const p of players) list.append(buildCard(p));
        panel.append(list);
        wrap.append(panel);
    };
    for (const side of teams) box(`Team ${side[0].team}`, side);
    if (solo.length) box(teams.length ? 'No team' : null, solo);
    return wrap;
}

function buildCard(p) {
    const card = el('article', 'rv-player');
    const head = el('div', 'rv-player-head');
    const name = el('span', 'rv-player-name', p.name);
    name.title = p.name;
    head.append(swatch(p.color), name, el('span', 'rv-player-civ', civName(p)));
    const sub = el('div', 'rv-player-sub');
    const stats = el('div', 'rv-stats');
    const stat = (label, title) => {
        const box = el('div', 'rv-stat');
        const v = el('div', 'rv-stat-value', '–');
        const l = el('div', 'rv-stat-label', label);
        if (title) box.title = title;
        box.append(v, l);
        stats.append(box);
        return { v, l };
    };
    const bank = stat('in the bank', 'Food, wood, gold and stone together, from the game\'s own figures in the file');
    const refs = {
        card, sub,
        bank: bank.v,
        bankLabel: bank.l,
        objects: stat('units & buildings', 'Objects the player has, from the game\'s own figures (walls and foundations count)').v,
        apm: stat('actions last minute', 'Orders given in the last full game minute').v,
        trained: el('div', 'rv-player-sub'),
        army: el('div', 'rv-army'),
        spent: el('div', 'rv-spent')
    };
    card.append(head, sub, stats, refs.trained, refs.army, refs.spent);
    view.cards.set(p.number, refs);
    return card;
}

function renderCards(t) {
    for (const p of game.players) {
        const refs = view.cards.get(p.number);
        const pe = game.per.get(p.number);
        const out = pe.resign && pe.resign.t <= t;
        refs.card.classList.toggle('rv-out', !!out);
        const { age, researching } = ageAt(game, p, t);
        refs.sub.textContent = '';
        refs.sub.append(el('span', 'rv-age', age));
        if (researching) refs.sub.append(el('span', null, `→ ${researching}`));
        const ups = p.ages.filter(a => a.reached <= t).map(a => `${ageLabel(a).split(' ')[0]} ${ageWhen(a)}`);
        if (ups.length) refs.sub.append(el('span', null, ups.join(' · ')));
        if (p.rating) refs.sub.append(el('span', null, `${p.rating}`));
        if (!p.human) refs.sub.append(el('span', null, 'AI'));
        if (out) refs.sub.append(el('span', 'rv-tag-out', `Resigned ${clock(pe.resign.t)}`));
        const s = statAt(p, t);
        refs.bank.textContent = game.settings.infiniteResources ? 'Infinite' : s ? fmt(s.bank) : '–';
        // The file updates this every few seconds to two minutes, so it says how old it is
        refs.bankLabel.textContent = s && !game.settings.infiniteResources ? `in the bank at ${clock(s.t)}` : 'in the bank';
        refs.objects.textContent = s ? fmt(s.objects) : '–';
        refs.apm.textContent = String(apmAt(p, t));
        const tally = tallyAt(game, p, t);
        refs.trained.textContent = `Villagers ${tally.villagers} · Army ${tally.army} · Techs ${tally.techs.length} (queued)`;
        const top = [...tally.units.entries()].filter(([u]) => { const i = unitInfo(u); return !i || i.cls !== 'villager'; })
            .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u, n]) => `${unitName(u)} ${n}`);
        refs.army.textContent = top.length ? top.join(' · ') : 'No army queued yet';
        refs.spent.textContent = '';
        refs.spent.append(el('span', 'rv-log-kind', 'Spent, estimated from base costs:'));
        for (const r of RESOURCES) refs.spent.append(el('span', `rv-res rv-res-${r}`, `${compact(tally.spent[r])} ${r}`));
    }
}

// ------------------------------------------------------------------ timeline
function buildTimeline() {
    const bar = el('section', 'glass-panel rv-timeline');
    bar.setAttribute('aria-label', 'Playback');
    const play = el('button', 'rv-play', '▶');
    play.type = 'button';
    play.setAttribute('aria-label', 'Play');
    play.addEventListener('click', () => (clockState.playing ? stopPlaying() : startPlaying()));
    const time = el('div', 'rv-clock');
    const now = el('span', null, '0:00');
    const total = el('span', 'rv-clock-total', ` / ${clock(game.duration)}`);
    time.append(now, total);
    const track = el('div', 'rv-track');
    const marks = el('div', 'rv-marks');
    marks.setAttribute('aria-hidden', 'true');
    const scrub = el('input', 'rv-scrub');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = String(Math.ceil(game.duration / 1000));
    scrub.step = '1';
    scrub.value = '0';
    scrub.setAttribute('aria-label', 'Game time');
    scrub.addEventListener('input', () => seek(Number(scrub.value) * 1000));
    scrub.addEventListener('pointerdown', () => { view.scrubbing = true; });
    track.append(marks, scrub);
    const speed = el('select', 'rv-speed');
    speed.setAttribute('aria-label', 'Playback speed');
    for (const s of SPEEDS) {
        const o = el('option', null, `${s}×`);
        o.value = String(s);
        if (s === clockState.speed) o.selected = true;
        speed.append(o);
    }
    speed.addEventListener('change', () => { clockState.speed = Number(speed.value); });
    bar.append(play, time, track, speed);
    Object.assign(view, { play, now, scrub, total, marks });
    drawMarks();
    if (follow) bar.append(buildLiveControls());
    return bar;
}

// The age-ups and resignations on the timeline, placed against the game's length so far
function drawMarks() {
    const marks = view.marks;
    marks.textContent = '';
    for (const p of game.players) {
        for (const a of p.ages) {
            const m = el('span', 'rv-mark');
            m.style.left = `${(a.reached / game.duration) * 100}%`;
            m.style.background = p.colorHex;
            m.title = `${p.name}: ${ageLabel(a)} ${ageWhen(a)}`;
            marks.append(m);
        }
        const r = game.per.get(p.number).resign;
        if (r) {
            const m = el('span', 'rv-mark rv-mark-resign');
            m.style.left = `${(r.t / game.duration) * 100}%`;
            m.style.background = p.colorHex;
            marks.append(m);
        }
    }
}

function buildLiveControls() {
    const row = el('div', 'rv-live');
    const badge = el('span', 'rv-live-badge', 'LIVE');
    const note = el('span', 'rv-live-note');
    note.setAttribute('role', 'status');
    const button = (text, act) => {
        const b = el('button', 'btn-view rv-zoom-btn', text);
        b.type = 'button';
        b.addEventListener('click', act);
        row.append(b);
    };
    row.append(badge, note);
    button('From the start', () => { seek(0); startPlaying(); });
    button('Go live', () => { stopPlaying(); seek(game.duration); });
    button('Stop following', () => endFollowing('Stopped following. The game is shown up to here.'));
    Object.assign(view, { liveRow: row, liveBadge: badge, liveNote: note });
    return row;
}

// Where the playback is against the newest moment read
function renderLive(t) {
    if (!follow || !view.liveNote) return;
    const behind = game.duration - t;
    const live = behind < 1000;
    view.liveBadge.classList.toggle('rv-live-behind', !live);
    view.liveBadge.textContent = live ? 'LIVE' : 'REPLAY';
    view.liveNote.textContent = live ? 'Following the game as it is recorded' : `${clock(behind)} behind the newest moment`;
}

function startPlaying() {
    if (!game) return;
    // Play at the end of a replay starts it again; at the live edge there's just nothing to play yet
    if (clockState.t >= game.duration && !follow) clockState.t = 0;
    clockState.playing = true;
    clockState.lastFrame = performance.now();
    view.play.textContent = '❚❚';
    view.play.setAttribute('aria-label', 'Pause');
    cancelAnimationFrame(clockState.frame);
    clockState.frame = requestAnimationFrame(tick);
}

function stopPlaying() {
    clockState.playing = false;
    cancelAnimationFrame(clockState.frame);
    if (view && view.play) {
        view.play.textContent = '▶';
        view.play.setAttribute('aria-label', 'Play');
        renderAll(true);
    }
}

function tick(now) {
    if (!clockState.playing) return;
    const dt = Math.min(250, now - clockState.lastFrame);
    clockState.lastFrame = now;
    clockState.t = Math.min(game.duration, clockState.t + dt * clockState.speed);
    renderAll(false);
    if (clockState.t >= game.duration) { stopPlaying(); return; }
    clockState.frame = requestAnimationFrame(tick);
}

function seek(t) {
    clockState.t = Math.max(0, Math.min(game.duration, t));
    renderAll(true);
}

// Map and clock every frame; cards, tables and lists at most every CARD_REFRESH_MS while playing
function renderAll(force) {
    if (!game || !view) return;
    const t = clockState.t;
    view.now.textContent = clock(t);
    renderLive(t);
    // A held thumb stays under the pointer
    if (!view.scrubbing || !clockState.playing) view.scrub.value = String(Math.floor(t / 1000));
    view.scrub.setAttribute('aria-valuetext', clock(t));
    drawMap();
    const now = performance.now();
    if (!force && now - clockState.lastCards < CARD_REFRESH_MS) return;
    clockState.lastCards = now;
    renderCards(t);
    for (const c of view.charts) c.setPlayhead(t);
    const active = view.tabs.active && view.tabs[view.tabs.active];
    if (active && active.update) active.update(t);
}

// ------------------------------------------------------------------ tabs
const TABS = [
    { key: 'charts', label: 'Charts', build: buildChartsTab },
    { key: 'build', label: 'Build order', build: buildOrderTab },
    { key: 'army', label: 'Units & techs', build: buildArmyTab },
    { key: 'chat', label: 'Chat', build: buildChatTab },
    { key: 'market', label: 'Market & tributes', build: buildMarketTab }
];

function buildTabs() {
    const panel = el('section', 'glass-panel rv-tabs-panel');
    const list = el('div', 'rv-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Details');
    const buttons = [];
    for (const tab of TABS) {
        const b = el('button', 'rv-tab', tab.label);
        b.type = 'button';
        b.id = `rvTab-${tab.key}`;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-controls', `rvPanel-${tab.key}`);
        b.addEventListener('click', () => selectTab(tab.key));
        b.addEventListener('keydown', e => {
            const i = TABS.indexOf(tab);
            const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : -1;
            if (j < 0) return;
            e.preventDefault();
            selectTab(TABS[j].key);
            buttons[j].focus();
        });
        buttons.push(b);
        list.append(b);
    }
    panel.append(list);
    for (const tab of TABS) {
        const p = el('div', 'rv-tab-body');
        p.id = `rvPanel-${tab.key}`;
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', `rvTab-${tab.key}`);
        p.hidden = true;
        panel.append(p);
        view.tabs[tab.key] = { panel: p, button: buttons[TABS.indexOf(tab)], tab, built: false };
    }
    selectTab('charts');
    return panel;
}

function selectTab(key) {
    for (const k of TABS.map(t => t.key)) {
        const v = view.tabs[k];
        const on = k === key;
        v.button.setAttribute('aria-selected', String(on));
        v.button.tabIndex = on ? 0 : -1;
        v.panel.hidden = !on;
        if (on && !v.built) {
            Object.assign(v, v.tab.build(v.panel) || {});
            v.built = true;
        }
    }
    view.tabs.active = key;
    const v = view.tabs[key];
    for (const c of view.charts) c.measure();
    if (v.update) v.update(clockState.t);
}

// A row of player buttons; calls onPick(number). Returns the row.
function playerPicker(onPick, selected) {
    const row = el('div', 'rv-pick-player');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Player');
    const buttons = [];
    for (const p of game.players) {
        const b = el('button');
        b.type = 'button';
        b.append(swatch(p.color), document.createTextNode(p.name));
        b.setAttribute('aria-pressed', String(p.number === selected));
        b.addEventListener('click', () => {
            for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
            onPick(p.number);
        });
        buttons.push(b);
        row.append(b);
    }
    return row;
}

// A time that seeks the playback when clicked
function timeButton(t) {
    const b = el('button', 'rv-log-time', clock(t));
    b.type = 'button';
    b.setAttribute('aria-label', `Go to ${clock(t)}`);
    b.addEventListener('click', () => seek(t));
    return b;
}

function moreRow(total) { return el('li', 'rv-empty', `and ${fmt(total - LIST_MAX)} more`); }

// Marks a list's rows as past, current or still to come
function markLog(list, t) {
    let nowRow = null;
    for (const li of list.children) {
        if (li.dataset.t === undefined) continue;
        const rt = Number(li.dataset.t);
        li.classList.toggle('rv-future', rt > t);
        li.classList.remove('rv-now');
        if (rt <= t) nowRow = li;
    }
    if (nowRow) nowRow.classList.add('rv-now');
}

// ------------------------------------------------------------------ charts tab
function buildChartsTab(panel) {
    panel.append(el('p', 'rv-panel-note',
        'Resources in the bank and units & buildings are the game\'s own figures. The file holds them every few seconds '
        + 'to two minutes, about once a minute in a big game. Pick a player in a legend to pick them out; click a chart to '
        + 'jump there.'));
    const grid = el('div', 'rv-charts');
    const series = key => () => game.players.map(p => ({ p, points: p.stats.map(r => [r[0], r[key]]) }));
    if (!game.settings.infiniteResources) grid.append(lineChart({ title: 'Resources in the bank', sub: 'Food, wood, gold and stone together', seriesOf: series(1) }));
    grid.append(
        lineChart({ title: 'Units & buildings', sub: 'Objects each player has (walls and foundations count)', seriesOf: series(2) }),
        lineChart({
            title: 'Actions per minute', sub: 'Orders given in each game minute',
            seriesOf: () => game.players.map(p => ({ p, points: p.apm.map((v, i) => [i * 60000 + 30000, v]) }))
        })
    );
    panel.append(grid);
    for (const c of view.charts) c.setPlayhead(clockState.t);
    return {};
}

function niceStep(max, ticks) {
    const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw || 1));
    const norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

// A line chart in SVG: one 2 px line per player, hairline grid, legend (click to pick one out), crosshair with a tooltip
// listing every player, a playhead, click to seek, and a table of the same numbers. It draws at its real width, so
// lines and text stay their size, and again when that changes (a hidden tab has no width until it's opened).
function lineChart({ title, sub, seriesOf }) {
    const NS = 'http://www.w3.org/2000/svg';
    const H = 220;
    const box = el('figure', 'rv-chart');
    box.append(el('h3', null, title), el('p', 'rv-chart-sub', sub));
    const plotWrap = el('div', 'rv-chart-plot');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${title}, by player over the game. The table below has the numbers.`);
    const tip = el('div', 'rv-chart-tip');
    tip.hidden = true;
    plotWrap.append(svg, tip);
    box.append(plotWrap);
    const node = (tag, attrs) => {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        svg.append(n);
        return n;
    };
    let series, maxT, step, top, times;
    const load = () => {
        series = seriesOf();
        maxT = game.duration;
        const maxV = series.reduce((m, s) => s.points.reduce((a, p) => Math.max(a, p[1]), m), 1);
        step = niceStep(maxV, 4);
        top = Math.ceil(maxV / step) * step;
        // The times to snap to: every sample of any player
        times = [...new Set(series.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b);
    };
    load();
    const valueAt = (s, t) => { const i = lastAtOrBefore(s.points, t, p => p[0]); return i < 0 ? null : s.points[i][1]; };
    let W = 0, M = null, lines = [], playhead = null, cross = null, picked = null, playheadAt = 0;
    const x = t => M.l + (t / maxT) * (W - M.l - M.r);
    const y = v => H - M.b - (Math.max(0, v) / top) * (H - M.t - M.b);
    const tFromEvent = e => {
        const r = svg.getBoundingClientRect();
        return Math.max(0, Math.min(maxT, (e.clientX - r.left - M.l) / (W - M.l - M.r) * maxT));
    };
    const showPick = () => {
        lines.forEach((l, j) => l.setAttribute('opacity', picked === null || picked === j ? 1 : 0.15));
        if (picked !== null) svg.insertBefore(lines[picked], playhead);
    };
    const movePlayhead = () => {
        if (!playhead) return;
        playhead.setAttribute('x1', x(playheadAt));
        playhead.setAttribute('x2', x(playheadAt));
    };
    const hover = e => {
        if (!times.length) return;
        const t0 = tFromEvent(e);
        const i = Math.max(0, lastAtOrBefore(times, t0, v => v));
        const t = (i + 1 < times.length && times[i + 1] - t0 < t0 - times[i]) ? times[i + 1] : times[i];
        cross.setAttribute('x1', x(t));
        cross.setAttribute('x2', x(t));
        cross.setAttribute('opacity', 0.6);
        tip.textContent = '';
        tip.append(el('div', 'rv-log-kind', clock(t)));
        const rows = series.map(s => ({ s, v: valueAt(s, t) })).filter(r => r.v !== null).sort((a, b) => b.v - a.v);
        for (const r of rows) {
            const row = el('div', 'rv-chart-tip-row');
            const key = el('span', 'rv-line-key');
            key.style.background = r.s.p.colorHex;
            row.append(el('strong', null, fmt(r.v)), key, document.createTextNode(r.s.p.name));
            tip.append(row);
        }
        tip.hidden = false;
        tip.style.left = `${x(t) > W / 2 ? x(t) - tip.offsetWidth - 10 : x(t) + 10}px`;
    };
    const draw = width => {
        W = width;
        svg.textContent = '';
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        // Line ends are named when there's room for it; the legend always names everyone
        const named = series.length <= 4 && W >= 400;
        M = { l: 46, r: named ? 104 : 12, t: 8, b: 24 };
        for (let v = 0; v <= top + 1e-9; v += step) {
            node('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--rv-axis)' : 'var(--rv-grid)', 'stroke-width': 1 });
            node('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--rv-muted)' }).textContent = compact(v);
        }
        const minutes = maxT / 60000, ticks = Math.max(2, Math.floor((W - M.l - M.r) / 70));
        const tickMin = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240].find(m => minutes / m <= ticks) || Math.ceil(minutes / ticks);
        for (let m = 0; m <= minutes; m += tickMin) {
            node('text', { x: x(m * 60000), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--rv-muted)' }).textContent = `${m}m`;
        }
        lines = series.map(s => {
            const d = s.points.map((pt, i) => `${i ? 'L' : 'M'}${x(pt[0]).toFixed(1)},${y(pt[1]).toFixed(1)}`).join('');
            return node('path', { d: d || 'M0,0', fill: 'none', stroke: s.p.colorHex, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        });
        if (named) {
            // Apart by a line height, and all inside the plot
            const ends = series.map((s, i) => ({ i, y: y(s.points.length ? s.points[s.points.length - 1][1] : 0) })).sort((a, b) => a.y - b.y);
            for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 13);
            for (let k = ends.length - 1, limit = H - M.b; k >= 0; k--, limit -= 13) ends[k].y = Math.min(ends[k].y, limit);
            for (const e of ends) {
                const name = series[e.i].p.name;
                node('text', { x: W - M.r + 6, y: e.y + 4, 'font-size': 11, fill: 'var(--text-secondary)' }).textContent = name.length > 14 ? `${name.slice(0, 13)}…` : name;
            }
        }
        playhead = node('line', { y1: M.t, y2: H - M.b, stroke: 'var(--gold-primary)', 'stroke-width': 1.5, opacity: 0.8 });
        cross = node('line', { y1: M.t, y2: H - M.b, stroke: 'var(--text-secondary)', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' });
        const hit = node('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent', style: 'cursor: crosshair' });
        hit.addEventListener('pointermove', hover);
        hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('opacity', 0); });
        hit.addEventListener('click', e => seek(tFromEvent(e)));
        showPick();
        movePlayhead();
    };
    const measure = () => {
        const width = Math.round(plotWrap.getBoundingClientRect().width);
        if (width > 0 && width !== W) draw(width);
    };
    new ResizeObserver(measure).observe(plotWrap);
    // Legend: a player's button picks them out (the others fade); press again to show all
    const legend = el('div', 'rv-legend');
    legend.setAttribute('role', 'group');
    legend.setAttribute('aria-label', `${title}: pick out a player`);
    const buttons = series.map((s, i) => {
        const b = el('button');
        b.type = 'button';
        const key = el('span', 'rv-line-key');
        key.style.background = s.p.colorHex;
        b.append(key, document.createTextNode(s.p.name));
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => {
            picked = picked === i ? null : i;
            buttons.forEach((other, j) => other.setAttribute('aria-pressed', String(picked === j)));
            if (playhead) showPick();
        });
        legend.append(b);
        return b;
    });
    box.append(legend);
    // The same numbers as a table, built when first opened
    const table = el('details', 'rv-table-toggle');
    table.append(el('summary', null, 'Show as a table'));
    let tableWrap = null;
    const buildTable = () => {
        const wrap = tableWrap = el('div', 'rv-table-wrap');
        const tbl = el('table', 'rv-table');
        const head = el('tr');
        head.append(el('th', null, 'Time'));
        for (const s of series) head.append(el('th', 'rv-num', s.p.name));
        const thead = el('thead');
        thead.append(head);
        const body = el('tbody');
        for (const t of times.slice(0, TABLE_ROWS_MAX)) {
            const tr = el('tr');
            tr.append(el('td', null, clock(t)));
            for (const s of series) { const v = valueAt(s, t); tr.append(el('td', 'rv-num', v === null ? '–' : fmt(v))); }
            body.append(tr);
        }
        tbl.append(thead, body);
        wrap.append(tbl);
        wrap.style.maxHeight = '320px';
        table.append(wrap);
    };
    table.addEventListener('toggle', () => { if (table.open && !tableWrap) buildTable(); });
    box.append(table);
    const chart = {
        measure,
        setPlayhead(t) { playheadAt = t; movePlayhead(); },
        // New figures from a game in progress
        refresh() {
            load();
            if (W) draw(W);
            if (tableWrap) { tableWrap.remove(); tableWrap = null; }
            if (table.open) buildTable();
        }
    };
    view.charts.push(chart);
    return box;
}

// ------------------------------------------------------------------ build order tab
function buildOrderTab(panel) {
    panel.append(el('p', 'rv-panel-note',
        'Everything the player ordered, in order: units and techs queued, buildings placed, ages clicked. '
        + 'Repeats in a row are grouped. Later orders are faded until the playback reaches them.'));
    const list = el('ol', 'rv-log');
    const show = number => {
        view.orderPlayer = number;
        list.textContent = '';
        const items = buildOrderItems(number);
        for (const item of items.slice(0, LIST_MAX)) {
            const li = el('li');
            li.dataset.t = String(item.t);
            const body = el('span', 'rv-log-body');
            body.append(document.createTextNode(item.text + ' '), el('span', 'rv-log-kind', item.kind));
            li.append(timeButton(item.t), body);
            list.append(li);
        }
        if (items.length > LIST_MAX) list.append(moreRow(items.length));
        if (!list.children.length) list.append(el('li', 'rv-empty', 'No orders.'));
        markLog(list, clockState.t);
    };
    const first = view.orderPlayer ?? game.players[0].number;
    panel.append(playerPicker(show, first), list);
    show(first);
    return { update: t => markLog(list, t) };
}

function buildOrderItems(number) {
    const pe = game.per.get(number);
    const ageTech = new Map(AGES.map(a => [gameData.ages && gameData.ages[a], a]));
    const items = [];
    for (const e of pe.queue) items.push({ t: e.t, key: `u${e.unit}`, text: unitName(e.unit), n: e.n, kind: 'unit' });
    for (const e of pe.research) {
        const age = ageTech.get(e.tech);
        items.push({ t: e.t, key: `t${e.tech}`, text: age ? `${AGE_NAMES[age]} (clicked)` : techName(e.tech), n: 1, kind: age ? 'age' : 'tech' });
    }
    for (const e of pe.ageLines) items.push({ t: e.t, key: `a${e.age}`, text: `Reached the ${e.label || AGE_NAMES[e.age]}`, n: 1, kind: 'age' });
    for (const e of pe.build) items.push({ t: e.t, key: `b${e.unit}`, text: buildingName(e.unit), n: 1, kind: 'building' });
    for (const e of pe.wall) items.push({ t: e.t, key: `w${e.unit}`, text: buildingName(e.unit), n: wallTiles(e), kind: 'wall tiles' });
    if (pe.resign) items.push({ t: pe.resign.t, key: 'resign', text: 'Resigned', n: 1, kind: '' });
    items.sort((a, b) => a.t - b.t);
    // Repeats of the same thing in a row become one line ("Villager ×4")
    const out = [];
    for (const it of items) {
        const prev = out[out.length - 1];
        if (prev && prev.key === it.key && it.kind !== 'age' && it.kind !== 'tech') { prev.n += it.n; continue; }
        out.push({ ...it });
    }
    for (const it of out) if (it.n > 1) it.text += ` ×${it.n}`;
    return out;
}

// ------------------------------------------------------------------ units & techs tab
function buildArmyTab(panel) {
    panel.append(el('p', 'rv-panel-note',
        'Totals ordered so far (queued units and techs, buildings placed), at the playback time. A queued unit '
        + 'may have been cancelled, so these are estimates.'));
    const holder = el('div');
    panel.append(holder);
    let lastKey = '';
    return {
        update(t) {
            const tallies = game.players.map(p => tallyAt(game, p, t));
            const key = tallies.map(x => `${[...x.units.values()].join(',')}:${[...x.buildings.values()].join(',')}:${x.techs.length}`).join('|');
            if (key === lastKey) return;
            lastKey = key;
            holder.textContent = '';
            holder.append(countTable('Units', tallies, x => x.units, unitName), countTable('Buildings', tallies, x => x.buildings, buildingName));
            const techs = el('div', 'rv-table-wrap');
            const tbl = el('table', 'rv-table');
            const head = el('tr');
            head.append(el('th', null, 'Techs'));
            game.players.forEach(p => { const th = el('th'); th.append(swatch(p.color), document.createTextNode(` ${p.name}`)); head.append(th); });
            const thead = el('thead'); thead.append(head);
            const row = el('tr');
            row.append(el('td', null, `${tallies.reduce((n, x) => n + x.techs.length, 0)} ordered`));
            for (const x of tallies) {
                const td = el('td');
                td.style.whiteSpace = 'normal';
                td.style.verticalAlign = 'top';
                td.textContent = x.techs.map(e => techName(e.tech)).join(', ') || '–';
                row.append(td);
            }
            const body = el('tbody'); body.append(row);
            tbl.append(thead, body);
            techs.append(tbl);
            holder.append(techs);
        }
    };
}

function countTable(label, tallies, pick, nameOf) {
    const ids = new Set();
    for (const x of tallies) for (const id of pick(x).keys()) ids.add(id);
    const wrap = el('div', 'rv-table-wrap');
    wrap.style.marginBottom = '1rem';
    if (!ids.size) { wrap.append(el('p', 'rv-empty', `No ${label.toLowerCase()} yet.`)); return wrap; }
    const rows = [...ids].map(id => ({ id, name: nameOf(id), total: tallies.reduce((n, x) => n + (pick(x).get(id) || 0), 0) }))
        .sort((a, b) => b.total - a.total).slice(0, TABLE_ROWS_MAX);
    const tbl = el('table', 'rv-table');
    const head = el('tr');
    head.append(el('th', null, label));
    game.players.forEach(p => { const th = el('th', 'rv-num'); th.append(swatch(p.color), document.createTextNode(` ${p.name}`)); head.append(th); });
    const thead = el('thead'); thead.append(head);
    const body = el('tbody');
    for (const r of rows) {
        const tr = el('tr');
        tr.append(el('td', null, r.name));
        for (const x of tallies) { const n = pick(x).get(r.id) || 0; tr.append(el('td', `rv-num${n ? '' : ' rv-zero'}`, n)); }
        body.append(tr);
    }
    tbl.append(thead, body);
    wrap.append(tbl);
    return wrap;
}

// ------------------------------------------------------------------ chat tab
function buildChatTab(panel) {
    const all = el('label', 'rv-layers');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!view.allChat;
    all.append(box, document.createTextNode('Show messages still to come'));
    const list = el('ol', 'rv-log');
    const lines = game.chat || [];
    for (const c of lines.slice(0, LIST_MAX)) {
        const p = game.byNumber.get(c.p);
        const li = el('li');
        li.dataset.t = String(c.t);
        const body = el('span', 'rv-log-body');
        const who = el('span', 'rv-log-who');
        who.append(p ? swatch(p.color) : document.createTextNode(''), document.createTextNode(p ? p.name : 'Someone'));
        body.append(who);
        if (c.audience && c.audience !== 'all') body.append(el('span', 'rv-log-aud', `(${c.audience})`));
        body.append(document.createTextNode(c.text));
        li.append(timeButton(c.t), body);
        list.append(li);
    }
    if (!list.children.length) { panel.append(el('p', 'rv-empty', 'Nobody wrote anything in this game.')); return {}; }
    if (lines.length > LIST_MAX) list.append(moreRow(lines.length));
    panel.append(el('p', 'rv-panel-note', 'Messages up to the playback time. In-game chat only: lobby chat isn\'t shown.'), all, list);
    const update = t => {
        for (const li of list.children) if (li.dataset.t !== undefined) li.hidden = !box.checked && Number(li.dataset.t) > t;
        markLog(list, t);
    };
    box.addEventListener('change', () => { view.allChat = box.checked; update(clockState.t); });
    return { update };
}

// ------------------------------------------------------------------ market & tributes tab
function buildMarketTab(panel) {
    const items = [];
    for (const p of game.players) {
        const pe = game.per.get(p.number);
        for (const e of pe.market) items.push({ t: e.t, p, text: `${e.k === 'buy' ? 'Bought' : 'Sold'} ${e.amount} ${e.resource}` });
        for (const e of pe.tribute) {
            const to = game.byNumber.get(e.to);
            const what = RESOURCES.filter(r => e[r] > 0).map(r => `${fmt(e[r])} ${r}`).join(', ');
            items.push({ t: e.t, p, text: `Sent ${what || 'a tribute'} to ${to ? to.name : 'another player'}` });
        }
    }
    items.sort((a, b) => a.t - b.t);
    if (!items.length) { panel.append(el('p', 'rv-empty', 'No market trades or tributes in this game.')); return {}; }
    panel.append(el('p', 'rv-panel-note', 'Market buys and sells and tributes, as ordered.'));
    const list = el('ol', 'rv-log');
    for (const it of items.slice(0, LIST_MAX)) {
        const li = el('li');
        li.dataset.t = String(it.t);
        const body = el('span', 'rv-log-body');
        const who = el('span', 'rv-log-who');
        who.append(swatch(it.p.color), document.createTextNode(it.p.name));
        body.append(who, document.createTextNode(it.text));
        li.append(timeButton(it.t), body);
        list.append(li);
    }
    if (items.length > LIST_MAX) list.append(moreRow(items.length));
    panel.append(list);
    return { update: t => markLog(list, t) };
}

// ------------------------------------------------------------------ keyboard and start-up
document.addEventListener('keydown', e => {
    if (!game || $('rvView').hidden) return;
    const tag = (e.target && e.target.tagName) || '';
    // The timeline's thumb has focus after a click, and Space there should still play
    if (e.target !== view.scrub && (/^(INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY)$/.test(tag) || e.target.isContentEditable)) return;
    if (e.key === ' ') { e.preventDefault(); clockState.playing ? stopPlaying() : startPlaying(); }
});

// ------------------------------------------------------------------ following a game in progress
// The game writes its recording as it goes. Reading it again every few seconds shows the game up to the newest moment
// the game has received, and the whole game before that: a recording holds it from the first second, even when
// the watcher joined late. Only the visitor's own browser ever sees the folder or the file.
async function pickFollowFolder() {
    let dir;
    try {
        dir = await window.showDirectoryPicker({ id: 'aoe2-savegame', mode: 'read' });
    } catch (e) {
        if (e.name !== 'AbortError') status('That folder couldn\'t be opened.', true);
        return;
    }
    startFollowing(dir);
}

async function newestRecording(dir) {
    let best = null;
    for await (const entry of dir.values()) {
        if (entry.kind !== 'file' || !/\.aoe2record$/i.test(entry.name)) continue;
        const file = await entry.getFile();
        if (!best || file.lastModified > best.file.lastModified) best = { handle: entry, file };
    }
    return best;
}

async function startFollowing(dir) {
    stopFollowing();
    stopPlaying();
    status('Looking for a game being recorded…');
    try {
        await loadGameData();
        const found = await newestRecording(dir);
        if (!found || Date.now() - found.file.lastModified > FOLLOW_FRESH_MS) {
            status('Nothing is being recorded in that folder right now. Start watching a game in Age of Empires II, then try again.', true);
            return;
        }
        follow = { handle: found.handle, size: -1, changedAt: Date.now(), timer: 0, failures: 0 };
        followStep();
    } catch (e) {
        status('That folder couldn\'t be read.', true);
    }
}

// The file can change while it's being read, which a browser reports as an error: the next try gets it
async function readRecording(handle) {
    for (let tries = 0; ; tries++) {
        const file = await handle.getFile();
        try {
            return { size: file.size, buffer: await file.arrayBuffer() };
        } catch (e) {
            if (tries >= 4) throw e;
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
}

async function followStep() {
    const mine = follow;
    if (!mine) return;
    const load = currentLoad = { stop: null };
    try {
        const { size, buffer } = await readRecording(mine.handle);
        if (mine !== follow) return;
        if (size === mine.size) {
            if (Date.now() - mine.changedAt > FOLLOW_IDLE_MS) endFollowing('No new data for 10 minutes, so the page stopped following.');
            return;
        }
        mine.size = size;
        mine.changedAt = Date.now();
        const model = await parseInWorker(buffer, load);
        if (mine !== follow) return;
        mine.failures = 0;
        // Checked on every read, before anything from the file reaches the page
        if (model.file.watched === false && !model.file.complete) {
            stopFollowing();
            $('rvView').hidden = true;
            $('rvLoad').hidden = false;
            status(OWN_GAME_MESSAGE, true);
            return;
        }
        if (model.file.watched === null) { status('Waiting for the game to start…'); return; }
        if (mine.shown) updateGame(model);
        else { mine.shown = true; showGame(model); status(''); }
        if (model.file.complete) endFollowing('The game is over. This is the whole game.');
    } catch (e) {
        if (mine !== follow) return;
        if (++mine.failures >= 3) {
            stopFollowing();
            status(e.message && e.name === 'Error' ? e.message : 'The recording couldn\'t be read any more.', true);
        }
    } finally {
        if (load === currentLoad) currentLoad = null;
        if (mine === follow) mine.timer = setTimeout(followStep, FOLLOW_POLL_MS);
    }
}

// New figures, with the view as it is: the same tab, map position and playback
function updateGame(model) {
    const atEdge = clockState.t >= game.duration - 1000;
    game = derive(model);
    if (atEdge) clockState.t = game.duration;
    view.scrub.max = String(Math.ceil(game.duration / 1000));
    view.total.textContent = ` / ${clock(game.duration)}`;
    drawMarks();
    view.map.refresh();
    for (const c of view.charts) c.refresh();
    for (const tab of TABS) {
        const v = view.tabs[tab.key];
        if (tab.key === 'charts' || !v.built) continue;
        const list = v.panel.querySelector('.rv-log'), top = list ? list.scrollTop : 0;
        v.panel.textContent = '';
        v.built = false;
        delete v.update;
        if (view.tabs.active !== tab.key) continue;
        selectTab(tab.key);
        const fresh = v.panel.querySelector('.rv-log');
        if (fresh) fresh.scrollTop = top;
    }
    renderAll(true);
}

function stopFollowing() {
    if (!follow) return;
    clearTimeout(follow.timer);
    follow = null;
    if (currentLoad && currentLoad.stop) currentLoad.stop();
    currentLoad = null;
}

// Leaves what's on screen as an ordinary replay of the game so far
function endFollowing(message) {
    stopFollowing();
    if (!view || !view.liveRow) return;
    view.liveRow.textContent = '';
    view.liveRow.append(el('span', 'rv-live-note', message));
    view.liveNote = null;
    const head = document.querySelector('.rv-head');
    if (head) head.replaceWith(buildHead());
}

const endScrub = () => { if (view) view.scrubbing = false; };
window.addEventListener('pointerup', endScrub);
window.addEventListener('pointercancel', endScrub);

wireLoading();
loadGameData();
