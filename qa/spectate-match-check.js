// QA: the Spectate list and match APIs, and the /spectate/<id> match pages, of a running server (it starts nothing).
// Usage: node qa/spectate-match-check.js            (Node 22+; BASE=http://127.0.0.1:3002 by default)
//        BASE=https://aoe2lobby.online node qa/spectate-match-check.js
// Prints a PASS or FAIL line per check and exits non-zero when any check fails.
const http = require('http');
const https = require('https');

const BASE = (process.env.BASE || 'http://127.0.0.1:3002').replace(/\/+$/, '');
const SITE = 'https://aoe2lobby.online';
const SUFFIX = ' – Spectate | AoE2Lobby.online';
const UNKNOWN_ID = '999999999999999'; // well-formed (15 digits) but never a real match
const SOURCE = /createServer|require\(['"]/; // signs that a response is server source, not a page

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failures++;
    return ok;
}

// fetch normalises "../" and "%2e%2e" out of a URL, so traversal paths go out over http(s).request exactly as written
function rawGet(rawPath) {
    const base = new URL(BASE);
    const lib = base.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request({ hostname: base.hostname, port: base.port, path: rawPath, method: 'GET', timeout: 30000 }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

async function getJson(path) {
    const res = await fetch(BASE + path);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { }
    return { status: res.status, type: res.headers.get('content-type') || '', json, text };
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// The server's title text: one line, cut on a code point with an ellipsis
const clip = (text, max) => {
    const chars = Array.from(String(text).replace(/[\x00-\x1F\x7F\s]+/g, ' ').trim());
    return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
};
const isInt = (v) => Number.isSafeInteger(v);
const nullOr = (v, test) => v === null || test(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

// Contract problems of one game object. List games never carry country; detail games carry it for every human.
function gameProblems(g, { detail, ended }) {
    const problems = [];
    const expect = (ok, what) => { if (!ok) problems.push(what); };
    if (!g || typeof g !== 'object') return ['not an object'];
    expect(isInt(g.id) && g.id > 0, 'id');
    expect(isText(g.title), 'title');
    expect(typeof g.isRanked === 'boolean', 'isRanked');
    expect(isText(g.map), 'map');
    for (const k of ['matchType', 'mapSize', 'speed', 'server']) expect(nullOr(g[k], isText), k);
    expect(nullOr(g.population, Number.isFinite), 'population');
    expect(typeof g.modInfo === 'string', 'modInfo');
    for (const k of ['startTime', 'observerDelay', 'observers']) expect(Number.isFinite(g[k]), k);
    expect(typeof g.ladder === 'string' && /^\d+$/.test(g.ladder), 'ladder');
    expect(typeof g.civsHidden === 'boolean', 'civsHidden');
    expect(typeof g.record === 'boolean', 'record');
    expect(ended ? isInt(g.endedAt) && g.endedAt > 0 : g.endedAt === null, 'endedAt');
    expect(Array.isArray(g.players) && g.players.length > 0, 'players');
    (Array.isArray(g.players) ? g.players : []).forEach((p, i) => {
        const at = `players[${i}].`;
        expect(p.kind === 'human' || p.kind === 'ai', at + 'kind');
        expect(nullOr(p.team, t => isInt(t) && t >= 1 && t <= 4), at + 'team (null or 1-4)');
        expect(nullOr(p.color, c => isInt(c) && c >= 1 && c <= 8), at + 'color (null or 1-8)');
        expect(g.civsHidden ? p.civ === null : isText(p.civ), at + (g.civsHidden ? 'civ (hidden, so null)' : 'civ'));
        expect(p.ratings !== null && typeof p.ratings === 'object' && !Array.isArray(p.ratings), at + 'ratings');
        if (p.kind === 'ai') {
            expect(p.id === 0 && p.name === 'AI', at + 'AI id 0, name AI');
            expect(p.rating === null && p.ratings && Object.keys(p.ratings).length === 0, at + 'AI rating null, ratings {}');
            expect(!('country' in p) && !('steamProfile' in p), at + 'AI has no country or steamProfile');
        } else {
            expect(isInt(p.id) && p.id > 0, at + 'id');
            expect(isText(p.name), at + 'name');
            expect(nullOr(p.rating, Number.isFinite), at + 'rating');
            expect(p.ratings && Object.values(p.ratings).every(Number.isFinite), at + 'ratings values');
            expect(!('steamProfile' in p) || isText(p.steamProfile), at + 'steamProfile');
            if (detail) expect('country' in p && nullOr(p.country, c => /^[a-z]{2}$/.test(c)), at + 'country (lowercase ISO-2 or null)');
            else expect(!('country' in p), at + 'country (list must not carry it)');
        }
    });
    return problems;
}

function resultProblems(r) {
    if (!r || typeof r !== 'object') return ['not an object'];
    if (!['pending', 'found', 'unavailable'].includes(r.state)) return ['state'];
    const fields = ['completedAt', 'duration', 'winningTeam', 'noWinner', 'ratingKind', 'players', 'replay'];
    if (r.state !== 'found') return fields.filter(k => r[k] !== null).map(k => k + ' should be null while ' + r.state);
    const problems = [];
    const expect = (ok, what) => { if (!ok) problems.push(what); };
    expect(nullOr(r.completedAt, isInt) && nullOr(r.duration, d => isInt(d) && d >= 0), 'completedAt/duration');
    expect(nullOr(r.winningTeam, t => isInt(t) && t >= 1 && t <= 4), 'winningTeam');
    expect(typeof r.noWinner === 'boolean', 'noWinner');
    expect(r.ratingKind === 'ranked' || r.ratingKind === 'unranked', 'ratingKind');
    expect(Array.isArray(r.players) && r.players.every(p => isInt(p.id) && typeof p.won === 'boolean' && nullOr(p.oldRating, isInt) && nullOr(p.newRating, isInt)), 'players');
    expect(r.replay && typeof r.replay.available === 'boolean' && (r.replay.available ? isInt(r.replay.profileId) : r.replay.profileId === null), 'replay');
    expect(!/https?:|blob/.test(JSON.stringify(r)), 'no URLs in the result');
    return problems;
}

// Checks one /spectate/<id> page; `game` (from the detail API) gives the expected title, null for an unknown id
async function checkPage(id, game) {
    const page = await rawGet(`/spectate/${id}`);
    const html = page.body;
    const label = `page ${id}${game ? '' : ' (unknown id)'}`;
    check(`${label}: 200 text/html, Cache-Control no-cache`, page.status === 200 && /text\/html/.test(page.headers['content-type'] || '') && /no-cache/.test(page.headers['cache-control'] || ''), page.status);
    const rawTitle = (/<title>([^<]*)<\/title>/.exec(html) || [])[1];
    if (!check(`${label}: has a <title>`, rawTitle !== undefined)) return;
    const title = unesc(rawTitle);
    check(`${label}: title fully escaped`, esc(title) === rawTitle, rawTitle);
    check(`${label}: title is per-match, at most 70 chars`, title.endsWith(SUFFIX) && Array.from(title).length <= 70, title);
    if (game && game.players.length === 2) {
        const want = clip(`${game.players[0].name} vs ${game.players[1].name} on ${game.map}`, 70 - SUFFIX.length) + SUFFIX;
        check(`${label}: 1v1 title "A vs B on <map>"`, title === want, { got: title, want });
    } else if (game) {
        check(`${label}: team title starts with the map`, title.startsWith(clip(game.map, 30).replace(/…$/, '')), title);
    }
    const meta = (attr, name) => (new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`).exec(html) || [])[1];
    check(`${label}: og:title = title`, meta('property', 'og:title') === rawTitle);
    const description = meta('name', 'description');
    check(`${label}: description escaped, at most 200 chars, same in og:description`,
        description !== undefined && esc(unesc(description)) === description && Array.from(unesc(description)).length <= 200 && meta('property', 'og:description') === description, description);
    const url = `${SITE}/spectate/${Number(id)}`;
    check(`${label}: canonical ${url}`, html.includes(`<link rel="canonical" href="${url}">`));
    check(`${label}: og:url ${url}`, meta('property', 'og:url') === url);
    const robots = [...html.matchAll(/<meta\s+name="robots"\s+content="([^"]*)"/g)].map(m => m[1]);
    check(`${label}: noindex (and no other robots tag)`, robots.length >= 1 && robots.every(r => /noindex/.test(r)), robots);
    // The page lives at /spectate/<id>, so a relative asset URL would resolve under /spectate/ and 404
    const relative = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(m => m[1]).filter(u => !/^(\/|https?:|#|data:|mailto:|aoe2de:|steam:)/.test(u));
    check(`${label}: asset URLs are root-absolute`, relative.length === 0, relative);
    if (game) {
        const raw = game.players.map(p => p.name).concat(game.map, game.title).filter(t => /[<>"]/.test(t));
        const head = html.split('</head>')[0];
        check(`${label}: no unescaped feed text in <head>`, raw.every(t => !head.includes(t)), raw);
    }
}

(async () => {
    // ---- the list
    const list = await getJson(`/api/spectate?t=${Date.now()}`);
    check('list: 200 JSON', list.status === 200 && /json/.test(list.type) && list.json !== null, list.status);
    const data = list.json || {};
    const games = Array.isArray(data.games) ? data.games : [];
    check('list: updatedAt, stale and games', nullOr(data.updatedAt, isInt) && typeof data.stale === 'boolean' && Array.isArray(data.games));
    const listProblems = games.flatMap(g => gameProblems(g, { detail: false, ended: false }).map(p => `${g && g.id}: ${p}`));
    check(`list: ${games.length} games match the contract`, listProblems.length === 0, listProblems.slice(0, 10));
    check('list: never carries country', !/"country"/.test(list.text));
    const hasGames = check('list: has games in progress', games.length > 0, data.stale ? 'the snapshot is stale' : 'no games');
    console.log(`     ${games.length} games, ${games.filter(g => g.players.some(p => p.kind === 'ai')).length} with AI, ${games.filter(g => g.civsHidden).length} with hidden civs`);

    // ---- a live game's detail: the newest game, plus one with an AI and one with hidden civs when there are any
    const picks = [...new Map([games[0], games.find(g => g.players.some(p => p.kind === 'ai')), games.find(g => g.civsHidden)]
        .filter(Boolean).map(g => [g.id, g])).values()];
    const details = new Map();
    for (const listed of picks) {
        const res = await getJson(`/api/spectate/${listed.id}`);
        const d = res.json || {};
        const label = `detail ${listed.id}`;
        check(`${label}: 200 JSON`, res.status === 200 && /json/.test(res.type) && res.json !== null, res.status);
        // A refresh can land between the list and this request, so a listed game may have just ended
        check(`${label}: status live (or just ended)`, d.status === 'live' || d.status === 'ended', d.status);
        check(`${label}: updatedAt and stale`, nullOr(d.updatedAt, isInt) && typeof d.stale === 'boolean');
        const problems = gameProblems(d.game, { detail: true, ended: d.status === 'ended' });
        check(`${label}: game matches the contract`, problems.length === 0, problems);
        if (d.status === 'live') check(`${label}: result null while live`, d.result === null, d.result);
        else check(`${label}: result shape`, resultProblems(d.result).length === 0, resultProblems(d.result));
        if (d.status === 'live' && d.updatedAt === data.updatedAt && d.game) {
            const withoutCountry = { ...d.game, players: d.game.players.map(({ country, ...p }) => p) };
            check(`${label}: same as the list game, plus country`, JSON.stringify(withoutCountry) === JSON.stringify(listed));
        }
        if (d.game) details.set(listed.id, d.game);
    }
    if (!hasGames) check('detail: a live game to check', false, 'skipped: the list had no games');

    // ---- an unknown but well-formed id
    const unknown = await getJson(`/api/spectate/${UNKNOWN_ID}`);
    check('unknown id: status unknown, game and result null', unknown.status === 200 && unknown.json && unknown.json.status === 'unknown' && unknown.json.game === null && unknown.json.result === null, unknown.text.slice(0, 200));

    // ---- malformed ids: 404 JSON {error} from the API, 404 from the page route
    for (const bad of ['/api/spectate/abc', '/api/spectate/1234567890123456', '/api/spectate/12a', '/api/spectate/', '/api/spectate/123/']) {
        const res = await rawGet(bad);
        let error;
        try { error = JSON.parse(res.body).error; } catch (e) { }
        check(`${bad}: 404 JSON {error}`, res.status === 404 && typeof error === 'string' && !SOURCE.test(res.body), `${res.status} ${res.body.slice(0, 80)}`);
    }
    for (const bad of ['/spectate/abc', '/spectate/1234567890123456', '/spectate/', '/spectate/12a/']) {
        const res = await rawGet(bad);
        check(`${bad}: 404`, res.status === 404 && !SOURCE.test(res.body), res.status);
    }

    // ---- traversal-style paths never serve source (a proxy may normalise them first; any non-source answer is fine)
    const id = games.length ? games[0].id : UNKNOWN_ID;
    for (const bad of [`/spectate/${id}/../server.js`, `/spectate/${id}/../../server.js`, `/spectate/${id}/..%2fserver.js`, '/spectate/..%2f..%2fserver.js',
        '/spectate/%2e%2e/server.js', '/api/spectate/../server.js', '/api/spectate/..%2fserver.js', `/api/spectate/${id}/../../server.js`, '/server.js']) {
        const res = await rawGet(bad);
        check(`${bad}: no source`, !(res.status === 200 && SOURCE.test(res.body)) && !SOURCE.test(res.body), `${res.status} ${res.body.slice(0, 80)}`);
    }

    // ---- match pages: a game whose text needs escaping (when there is one), the newest game, and an unknown id
    const needsEscaping = games.find(g => [g.map, g.title, ...g.players.map(p => p.name)].some(t => /[&<>"']/.test(t)));
    for (const g of [...new Map([needsEscaping, games[0]].filter(Boolean).map(g => [g.id, g])).values()]) {
        await checkPage(String(g.id), details.get(g.id) || g);
    }
    if (!needsEscaping) console.log('     (no game in progress has text that needs escaping; escaping checked on plain text only)');
    await checkPage(UNKNOWN_ID, null);
    const slash = await rawGet(`/spectate/${id}/`);
    check(`/spectate/${id}/ (trailing slash): 200 with noindex`, slash.status === 200 && /<meta\s+name="robots"\s+content="noindex"/.test(slash.body), slash.status);

    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
