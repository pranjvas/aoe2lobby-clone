// Caster overlay, for an OBS browser source (1920x1080, transparent). /overlay/<matchId> shows one game;
// /overlay/player/<profileId> shows whichever game that player is in, so the players and civs follow them from game to
// game. The score is in the URL and is read once: after each game the caster pastes the new link into the source.
// The match page's Caster tools write the settings into the query string:
//   bo  best of (1-15, odd)   s  score "left-right"   l / r  side names   t  title   swap=1  sides swapped
//   preview=1  a dark background, for checking it in a normal browser tab
// Everything from the feed or the URL goes in with textContent, never as HTML.
'use strict';

const route = /^\/overlay\/(?:(player)\/)?(\d{1,15})\/?$/.exec(location.pathname);
const byPlayer = !!(route && route[1]);
const routeId = route ? Number(route[2]) : 0;
const params = new URLSearchParams(location.search);
const POLL_MS = 30000;
const POLL_PENDING_MS = 20000;
const root = document.getElementById('overlay');

function text(name, max) {
    return Array.from((params.get(name) || '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim()).slice(0, max).join('');
}

function setting() {
    let bo = Number(params.get('bo'));
    bo = Number.isInteger(bo) && bo >= 1 && bo <= 15 ? (bo % 2 ? bo : bo + 1) : 1;
    const need = Math.ceil(bo / 2);
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(params.get('s') || '');
    const score = m ? [Math.min(need, Number(m[1])), Math.min(need, Number(m[2]))] : [0, 0];
    return { bo, need, score, names: [text('l', 40), text('r', 40)], title: text('t', 60), swap: params.get('swap') === '1' };
}
const cfg = setting();
if (params.get('preview') === '1') document.body.classList.add('preview');

// ------------------------------------------------------------------ data (the same answer as the match page's)
const intIn = (v, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max) ? v : null;
const str = (v) => (typeof v === 'string' && v) ? v : null;

function normalizeGame(g) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.players)) return null;
    const civsHidden = g.civsHidden === true;
    return {
        id: intIn(g.id, 1, Number.MAX_SAFE_INTEGER),
        map: str(g.map) || 'Unknown map',
        civsHidden,
        players: g.players.filter(p => p && typeof p === 'object').map(p => {
            const ai = p.kind === 'ai';
            return {
                id: ai ? 0 : (intIn(p.id, 1, Number.MAX_SAFE_INTEGER) ?? 0),
                kind: ai ? 'ai' : 'human',
                name: str(p.name) || (ai ? 'AI' : 'Player'),
                team: intIn(p.team, 1, 4),
                color: intIn(p.color, 1, 8),
                civ: civsHidden ? null : str(p.civ),
                rating: (!ai && typeof p.rating === 'number' && Number.isFinite(p.rating)) ? p.rating : null
            };
        })
    };
}

function normalize(data) {
    if (!data || typeof data !== 'object' || !['live', 'ended', 'unknown'].includes(data.status)) return null;
    const d = { status: data.status, stale: data.stale === true, game: null, result: null };
    if (d.status === 'unknown') return d;
    d.game = normalizeGame(data.game);
    if (!d.game) return null;
    const r = data.result;
    if (d.status === 'ended') {
        d.result = (r && r.state === 'found')
            ? { state: 'found', winningTeam: intIn(r.winningTeam, 1, 4), noWinner: r.noWinner === true, aiWon: r.aiWon === true,
                winners: new Set((Array.isArray(r.players) ? r.players : []).filter(p => p && p.won === true).map(p => p.id)) }
            : { state: (r && r.state === 'unavailable') ? 'unavailable' : 'pending' };
    }
    return d;
}

// Teams in order; each player without a team is a side of their own
function sidesOf(players) {
    const teams = new Map(), solo = [];
    for (const p of players) {
        if (p.team === null) { solo.push([p]); continue; }
        if (!teams.has(p.team)) teams.set(p.team, []);
        teams.get(p.team).push(p);
    }
    return [...[...teams.keys()].sort((a, b) => a - b).map(t => teams.get(t)), ...solo];
}

// ------------------------------------------------------------------ rendering
function el(tag, cls, content) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (content !== undefined && content !== null) e.textContent = String(content);
    return e;
}

// The caster's names are for the two sides of a scoreboard; a game with more sides only names its own
function sideName(side, index, twoSides = true) {
    if (twoSides && cfg.names[index]) return cfg.names[index];
    if (side.length === 1) return side[0].name;
    return side[0].team !== null ? `Team ${side[0].team}` : side.map(p => p.name).join(' + ');
}

function playerRow(p, showName) {
    const li = el('li', 'ov-player');
    li.append(el('span', `ov-swatch ov-color-${p.color ?? 'none'}`));
    if (showName) li.append(el('span', 'ov-player-name', p.name));
    li.append(el('span', 'ov-civ', p.civ || (p.kind === 'ai' ? 'AI' : '')));
    if (p.rating !== null) li.append(el('span', 'ov-rating', p.rating));
    return li;
}

function sideBlock(side, index, won) {
    const sec = el('section', `ov-side ov-side-${index ? 'right' : 'left'}${won ? ' ov-won' : ''}`);
    const name = sideName(side, index);
    const head = el('div', 'ov-side-head');
    head.append(el('h2', 'ov-name', name));
    if (cfg.bo > 1) {
        const dots = el('div', 'ov-score');
        dots.setAttribute('role', 'img');
        dots.setAttribute('aria-label', `${cfg.score[index]} of ${cfg.need} wins`);
        for (let i = 0; i < cfg.need; i++) dots.append(el('span', `ov-dot${i < cfg.score[index] ? ' ov-dot-on' : ''}`));
        head.append(dots);
    }
    sec.append(head);
    // A side named after its one player doesn't repeat the name on the player's row
    const list = el('ul', 'ov-players');
    for (const p of side) list.append(playerRow(p, !(side.length === 1 && name === p.name)));
    sec.append(list);
    return sec;
}

// Which side won: the result's team; without one, the one side holding winning players, or (an AI win, which has no
// result rows) the one side of AI players. -1 when that isn't exactly one side, as the match page then names players.
function wonIndex(sides, r) {
    if (!r || r.state !== 'found' || r.noWinner) return -1;
    if (r.winningTeam !== null) return sides.findIndex(side => side[0].team === r.winningTeam);
    const won = side => r.aiWon ? side.every(p => p.kind === 'ai') : side.some(p => r.winners.has(p.id));
    const hits = sides.map((side, i) => won(side) ? i : -1).filter(i => i >= 0);
    return hits.length === 1 ? hits[0] : -1;
}

let last = null; // the last answer with a game, kept while a refresh fails or the server can't tell

function render(d) {
    root.textContent = '';
    const bar = el('div', 'ov-bar');
    const center = el('div', 'ov-center');
    if (cfg.title) center.append(el('div', 'ov-title', cfg.title));
    if (!d || !d.game) {
        // Nothing read yet (or the first request failed), the feed is down, or no such game (yet): the message alone,
        // centred in a bar of its own width
        bar.classList.add('ov-bar-empty');
        center.append(el('div', 'ov-map', !d ? 'Loading…' : d.stale ? 'No live data'
            : byPlayer ? 'Waiting for the next game' : 'Game not found'));
        if (cfg.bo > 1) center.append(el('div', 'ov-meta', `Best of ${cfg.bo}`));
        bar.append(center);
        root.append(bar);
        return;
    }
    const g = d.game;
    let sides = sidesOf(g.players);
    // Following a player keeps their side on the left from game to game, like the score
    if (byPlayer && sides.length === 2 && sides[1].some(p => p.id === routeId)) sides = [sides[1], sides[0]];
    if (cfg.swap && sides.length === 2) sides = [sides[1], sides[0]];
    center.append(el('div', 'ov-map', g.map));
    const meta = [];
    if (cfg.bo > 1) meta.push(d.status === 'live' ? `Game ${Math.min(cfg.bo, cfg.score[0] + cfg.score[1] + 1)} · Best of ${cfg.bo}` : `Best of ${cfg.bo}`);
    if (g.civsHidden) meta.push('Civs hidden');
    if (meta.length) center.append(el('div', 'ov-meta', meta.join(' · ')));
    const won = d.status === 'ended' ? wonIndex(sides, d.result) : -1;
    // An ended game's end and result don't depend on live data: only a game that may still be on says "No live data"
    const noData = d.stale && d.status !== 'ended';
    center.append(el('div', `ov-status ov-status-${noData ? 'unknown' : d.status}`,
        noData ? 'No live data' : d.status === 'live' ? 'LIVE'
            : won >= 0 ? `${sideName(sides[won], won, sides.length === 2)} won`
            : d.result && d.result.state === 'found' && d.result.aiWon ? 'The AI won'
            : d.result && d.result.state === 'pending' ? 'Game over' : 'Ended'));
    if (sides.length === 2) {
        bar.append(sideBlock(sides[0], 0, won === 0), center, sideBlock(sides[1], 1, won === 1));
    } else {
        // Free-for-all or 3+ teams: everyone in one row, no score
        bar.classList.add('ov-bar-multi');
        const list = el('ul', 'ov-players ov-players-multi');
        for (const p of g.players) list.append(playerRow(p, true));
        bar.append(center, list);
    }
    root.append(bar);
}

// ------------------------------------------------------------------ polling
let timer = null;

async function refresh() {
    clearTimeout(timer);
    let delay = POLL_MS;
    try {
        const r = await fetch(`/api/spectate/${byPlayer ? 'player/' : ''}${routeId}`, { cache: 'no-store' });
        const d = r.ok ? normalize(await r.json()) : (r.status === 404 ? { status: 'unknown', stale: false, game: null } : null);
        if (!d) throw new Error('HTTP ' + r.status);
        // While the server can't tell (feed down), the game on screen stays (marked, unless it had already ended)
        if (d.status === 'unknown' && d.stale && last) last = { ...last, stale: last.status !== 'ended' };
        else last = d.game ? d : (byPlayer && last && last.status === 'ended' ? last : d);
        render(last);
        if (d.status === 'ended' && d.result.state === 'pending') delay = POLL_PENDING_MS;
        // One game's overlay has nothing more to wait for once its result is in (a player's waits for the next game)
        else if (!byPlayer && (d.status === 'ended' || (d.status === 'unknown' && !d.stale))) delay = null;
    } catch (e) {
        if (!last) render(null);
    }
    if (delay) timer = setTimeout(refresh, delay);
}

if (route) refresh();
else render(null);
