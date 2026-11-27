// Crawlable pages for the Maps view's data: /maps/ (every map) and /maps/<slug> (one map's regular players and the lobbies
// open on it now). Plain server-rendered HTML, so search engines read them without running the site's script, and a
// sitemap listing them. Pure functions: server.js passes the data in.
const crypto = require('crypto');

const SITE_URL = 'https://aoe2lobby.online';
const SITE_NAME = 'AoE2Lobby.online';
// Maps with fewer players or lobbies get a page (the Maps tab links to it) but stay out of search results and the sitemap
const INDEX_MIN_PLAYERS = 50;
const INDEX_MIN_LOBBIES = 20;
const MAPS_PAGE_MIN_PLAYERS = 5; // the /maps/ list leaves out maps with fewer players (one-off names, test maps)
const TOP_PLAYERS = 100; // players listed on a map's page
const OPEN_LOBBIES = 25; // open lobbies listed on a map's page
const RELATED_MAPS = 20; // other busy maps linked from a map's page
const LADDER_NAMES = { '0': 'Unranked', '3': 'RM 1v1', '4': 'RM Team', '13': 'EW 1v1', '14': 'EW Team' };

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Text as one line of at most max characters, cut on a code point with an ellipsis
function clip(text, max) {
    const chars = Array.from(String(text).replace(/[\x00-\x1F\x7F\s]+/g, ' ').trim());
    return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}

const number = n => Number(n || 0).toLocaleString('en-US');
const date = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
function ordinal(n) {
    const tens = n % 100, ones = n % 10;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
    return n + suffix;
}

// The URL slug of a map name: lower case, letters (any script) and digits kept, everything else one hyphen; '' when
// nothing is left (names like "?")
function mapSlug(name) {
    return String(name).normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
        .slice(0, 80).replace(/-+$/, '');
}

// list: maps, busiest first ([{ name, lobbies, players, last }]). Each map with a non-empty slug gets a page; names that
// share a slug each get a short hash of the name added, so every page keeps its address whatever the counts do.
function slugIndex(list) {
    const groups = new Map();
    for (const m of list) {
        const slug = mapSlug(m.name);
        if (!slug) continue;
        if (!groups.has(slug)) groups.set(slug, []);
        groups.get(slug).push(m);
    }
    const bySlug = new Map(), slugOf = new Map();
    for (const [slug, maps] of groups) {
        for (const m of maps) {
            const own = maps.length === 1 ? slug : `${slug}-${crypto.createHash('sha1').update(m.name).digest('hex').slice(0, 6)}`;
            bySlug.set(own, m);
            slugOf.set(m.name, own);
        }
    }
    return { bySlug, slugOf };
}

const isIndexable = m => m.players >= INDEX_MIN_PLAYERS && m.lobbies >= INDEX_MIN_LOBBIES;
const mapPath = slug => `/maps/${encodeURIComponent(slug)}`;

// allStats: { ladder: { rating, games, winp } } -> the most played ladder's { ladder, rating, games, winp }, or null
function mainLadder(allStats) {
    let best = null;
    if (allStats && typeof allStats === 'object') {
        for (const [ladder, s] of Object.entries(allStats)) {
            if (s && typeof s === 'object' && Number.isFinite(s.games) && (!best || s.games > best.games)) best = { ladder, ...s };
        }
    }
    if (!best) return null;
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { ladder: best.ladder, rating: num(best.rating), games: num(best.games) ?? 0, winp: num(best.winp) };
}

// The header's Mods link icon: a gold puzzle piece (the same as index.html's)
const MODS_ICON = '<svg class="nav-mods-icon" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="navModsGold" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#f8e39a"/><stop offset=".55" stop-color="#d4af37"/><stop offset="1" stop-color="#8f6a1c"/></linearGradient></defs>' +
    '<path fill="url(#navModsGold)" stroke="#5a4210" stroke-width=".6" d="M10 3.5a2 2 0 0 1 4 0V5h4a1 1 0 0 1 1 1v4h1.5a2 2 0 0 1 0 4H19v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V19H6a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z"/></svg>';

// The page around the content: the site's header, stylesheet, icons, preview tags and analytics
function page({ title, description, path, indexable, jsonLd, body, stylesHref }) {
    const url = SITE_URL + path;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="canonical" href="${esc(url)}">
    <meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'}">
    <meta name="theme-color" content="#0d1117">
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    <link rel="manifest" href="/site.webmanifest">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${SITE_NAME}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${esc(url)}">
    <meta property="og:image" content="${SITE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
    <link rel="stylesheet" href="${esc(stylesHref)}">
</head>
<body>
    <div class="bg-shape shape-1"></div>
    <div class="bg-shape shape-2"></div>
    <div class="bg-shape shape-3"></div>
    <div class="app-container">
        <header class="navbar">
            <a class="nav-logo nav-home" href="/">
                <span class="logo-icon">🛡️</span>
                <span class="nav-brand">AoE2<span>Lobby</span> <small class="nav-tagline">Live Age of Empires II lobby browser</small></span>
            </a>
            <a class="nav-mods-link${path === '/mods' ? ' is-current' : ''}" href="/mods"${path === '/mods' ? ' aria-current="page"' : ''}>${MODS_ICON}<span>Mods</span></a>
        </header>
        <main class="main-content seo-page">
${body}
        </main>
        <footer class="seo-footer">
            <p><a href="/">Live lobbies</a> · <a href="/maps/">Maps</a> · <a href="/replay">Replay viewer</a> · <a href="/mods">Mods</a></p>
            <p>${SITE_NAME} is a fan-made site and isn't affiliated with Microsoft, Xbox Game Studios, World's Edge or Forgotten Empires.</p>
        </footer>
    </div>
    <!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "f2cacd7749024f8ba136403fdf2d8b78"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
`;
}

function breadcrumbs(items) {
    const html = items.map((it, i) => i === items.length - 1
        ? `<span aria-current="page">${esc(it.name)}</span>`
        : `<a href="${esc(it.path)}">${esc(it.name)}</a>`).join(' <span aria-hidden="true">›</span> ');
    const jsonLd = {
        '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: SITE_URL + it.path }))
    };
    return { html: `            <nav class="seo-breadcrumbs" aria-label="Breadcrumb">${html}</nav>`, jsonLd };
}

// /maps/: every map with at least MAPS_PAGE_MIN_PLAYERS players, busiest first
function renderMapsIndex({ list, slugOf, since, stylesHref }) {
    const shown = list.filter(m => m.players >= MAPS_PAGE_MIN_PLAYERS && slugOf.has(m.name));
    const crumbs = breadcrumbs([{ name: 'Lobbies', path: '/' }, { name: 'Maps', path: '/maps/' }]);
    const rows = shown.map((m, i) => `                    <tr>
                        <td class="seo-num">${i + 1}</td>
                        <td><a href="${esc(mapPath(slugOf.get(m.name)))}">${esc(m.name)}</a></td>
                        <td class="seo-num">${number(m.lobbies)}</td>
                        <td class="seo-num">${number(m.players)}</td>
                        <td class="seo-date">${m.last ? date(m.last) : ''}</td>
                    </tr>`).join('\n');
    const sinceText = since ? ` since ${date(since)}` : '';
    const body = `${crumbs.html}
            <section class="glass-panel seo-panel">
                <h1>Age of Empires II maps in custom lobbies</h1>
                <p class="seo-lead">Every map seen in Age of Empires II: Definitive Edition multiplayer lobbies${sinceText}, busiest first: ${number(shown.length)} maps. Open one to see the players who join its lobbies most often, with their ratings and win rates, and its lobbies open right now.</p>
                <p>The <a href="/">lobby list</a> shows every open lobby live, and its <strong>Maps</strong> tab lists all of a map's players, with sorting and search.</p>
            </section>
            <section class="glass-panel seo-panel">
                <h2>Maps by lobbies seen</h2>
                <div class="seo-table-wrap">
                <table class="seo-table">
                    <thead><tr><th class="seo-num">#</th><th>Map</th><th class="seo-num">Lobbies</th><th class="seo-num">Players</th><th>Last lobby</th></tr></thead>
                    <tbody>
${rows}
                    </tbody>
                </table>
                </div>
            </section>`;
    const description = `The ${number(shown.length)} Age of Empires II: DE maps seen in multiplayer lobbies${sinceText}, busiest first, with how many lobbies and players each has had and who plays each map most.`;
    return page({
        title: `AoE2 maps in custom lobbies – who plays each map | ${SITE_NAME}`,
        description: clip(description, 200),
        path: '/maps/',
        indexable: true,
        jsonLd: { '@context': 'https://schema.org', '@graph': [crumbs.jsonLd, { '@type': 'CollectionPage', name: 'Age of Empires II maps in custom lobbies', url: `${SITE_URL}/maps/` }] },
        body,
        stylesHref
    });
}

// One open lobby on the map, as a list item
function lobbyItem(l, isMatchId) {
    const players = Array.isArray(l.players) ? l.players : [];
    const host = players[0]?.name;
    const filled = players.length + (Number(l.aiSlots) || 0);
    const max = Number(l.maxPlayers) || 8;
    const facts = [
        host ? `host ${esc(host)}` : '',
        `${filled}/${max} players`,
        l.matchType && l.matchType !== 'Unknown' ? esc(l.matchType) : '',
        l.server ? esc(l.server) : ''
    ].filter(Boolean).join(' · ');
    const action = l.isPasswordProtected ? '<span class="seo-tag">Password</span>'
        : filled >= max ? '<span class="seo-tag">Full</span>'
        : isMatchId(String(l.id)) ? `<a class="seo-join" href="aoe2de://0/${esc(l.id)}">Join</a>` : '';
    return `                    <li><span class="seo-lobby-title">${esc(clip(l.title || 'Age of Empires II Game', 80))}</span> <span class="seo-lobby-facts">${facts}</span> ${action}</li>`;
}

// /maps/<slug>: the map's numbers, its open lobbies (lobbies: the current list, already narrowed to this map), its
// TOP_PLAYERS most frequent players and links to other busy maps
function renderMapPage({ map, slug, rank, since, players, lobbies, lobbiesAt, related, slugOf, stylesHref, isMatchId }) {
    const name = map.name;
    const path = mapPath(slug);
    const crumbs = breadcrumbs([{ name: 'Lobbies', path: '/' }, { name: 'Maps', path: '/maps/' }, { name, path }]);
    const sinceText = since ? ` since ${date(since)}` : '';
    const place = rank === 1 ? 'the busiest map' : rank > 1 ? `the ${ordinal(rank)} busiest map` : 'one of the maps';
    const lead = `${esc(name)} is ${place} in the Age of Empires II: DE multiplayer lobbies we track. ` +
        `${number(map.lobbies)} ${esc(name)} ${map.lobbies === 1 ? 'lobby has' : 'lobbies have'} been opened${sinceText}, with ${number(map.players)} different ${map.players === 1 ? 'player' : 'players'}. ` +
        `Below are the ${esc(name)} lobbies open right now and the players who join its lobbies most often.`;

    const open = lobbies.slice(0, OPEN_LOBBIES);
    const asOf = lobbiesAt ? ` As of ${new Date(lobbiesAt).toISOString().slice(11, 16)} UTC.` : '';
    const lobbySection = open.length
        ? `                <ul class="seo-lobbies">
${open.map(l => lobbyItem(l, isMatchId)).join('\n')}
                </ul>
                <p class="seo-note">${lobbies.length > open.length ? `${number(lobbies.length)} open, the first ${open.length} shown.` : ''}${asOf} The <a href="/">lobby list</a> updates live.</p>`
        : `                <p>No ${esc(name)} lobby is open right now.${asOf} The <a href="/">lobby list</a> updates live, so check it for new ones.</p>`;

    const rows = players.map((p, i) => {
        const s = mainLadder(p.allStats);
        const rating = s && s.rating != null ? `${number(s.rating)} <small>${esc(LADDER_NAMES[s.ladder] || 'ladder ' + s.ladder)}</small>` : '–';
        const games = s ? number(s.games) : '–';
        const winp = s && s.games > 0 && s.winp != null ? `${s.winp}%` : '–';
        const nameHtml = Number.isInteger(p.id) && p.id > 0
            ? `<a href="https://www.aoe2insights.com/user/relic/${p.id}" target="_blank" rel="nofollow noopener" title="AoE2Insights profile">${esc(p.name)}</a>`
            : esc(p.name);
        return `                    <tr>
                        <td class="seo-num">${i + 1}</td>
                        <td class="seo-player">${nameHtml}</td>
                        <td class="seo-num">${number(p.count)}</td>
                        <td class="seo-num">${rating}</td>
                        <td class="seo-num">${games}</td>
                        <td class="seo-num">${winp}</td>
                        <td class="seo-date">${p.lastSeen ? date(p.lastSeen) : ''}</td>
                    </tr>`;
    }).join('\n');
    const playersSection = players.length
        ? `                <p>The ${players.length === 1 ? 'player' : `${number(players.length)} players`} seen in the most ${esc(name)} lobbies${sinceText}. A player counts once per lobby. Rating, games and win rate are for each player's most played ladder, as last seen in a lobby.</p>
                <div class="seo-table-wrap">
                <table class="seo-table seo-players">
                    <thead><tr><th class="seo-num">#</th><th>Player</th><th class="seo-num">Lobbies</th><th class="seo-num">Rating</th><th class="seo-num">Games</th><th class="seo-num">Win rate</th><th>Last seen</th></tr></thead>
                    <tbody>
${rows}
                    </tbody>
                </table>
                </div>`
        : `                <p>Nobody has been seen in ${esc(name)} lobbies so far.</p>`;

    const relatedLinks = related.filter(m => m.name !== name && slugOf.has(m.name)).slice(0, RELATED_MAPS)
        .map(m => `<a href="${esc(mapPath(slugOf.get(m.name)))}">${esc(m.name)}</a>`).join(' · ');
    const allLink = `/?map=${encodeURIComponent(name)}`;

    const body = `${crumbs.html}
            <section class="glass-panel seo-panel">
                <h1>${esc(name)}: AoE2 lobbies and regular players</h1>
                <p class="seo-lead">${lead}</p>
                <p class="seo-stats"><span><strong>${number(map.lobbies)}</strong> lobbies</span><span><strong>${number(map.players)}</strong> players</span><span><strong>${lobbies.length}</strong> open now</span>${map.last ? `<span>last lobby <strong>${date(map.last)}</strong></span>` : ''}</p>
                <p><a class="seo-button" href="${esc(allLink)}">All ${number(map.players)} players in the Maps tab</a></p>
            </section>
            <section class="glass-panel seo-panel">
                <h2>${esc(name)} lobbies open now</h2>
${lobbySection}
            </section>
            <section class="glass-panel seo-panel">
                <h2>Who plays ${esc(name)} most</h2>
${playersSection}
                ${map.players > players.length ? `<p><a href="${esc(allLink)}">See all ${number(map.players)} players</a>, sorted by rating, win rate, games or who's in a lobby now, in the Maps tab.</p>` : ''}
            </section>
            <section class="glass-panel seo-panel">
                <h2>Other busy maps</h2>
                <p class="seo-links">${relatedLinks}</p>
                <p><a href="/maps/">Every map</a></p>
            </section>`;

    const description = `${number(map.players)} players in ${number(map.lobbies)} ${name} lobbies${sinceText}: who plays ${name} most in Age of Empires II: DE, their ratings and win rates, and the ${name} lobbies open now.`;
    return page({
        title: `${clip(name, 40)} – AoE2 lobbies and players | ${SITE_NAME}`,
        description: clip(description, 200),
        path,
        indexable: isIndexable(map),
        jsonLd: { '@context': 'https://schema.org', '@graph': [crumbs.jsonLd] },
        body,
        stylesHref
    });
}

// /mods: pv's published mods, last updated first, each with what it changes and the lobbies and games using it now.
// mods: [{ id, name, summary, tag, version, created, updated, fileSize, downloads, installs, ratings, link, thumb,
// lobbies: [lobby list entries], games: [{ id, map, startTime, players }] }]; readAt: when the numbers were read.
function renderModsPage({ author, readAt, mods, lobbiesAt, stylesHref, isMatchId }) {
    const path = '/mods';
    const title = `Mods by ${author}`;
    const crumbs = breadcrumbs([{ name: 'Lobbies', path: '/' }, { name: title, path }]);
    const day = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? '' : date(t); };
    const total = mods.reduce((n, m) => n + (m.downloads || 0), 0);
    const inUse = mods.filter(m => m.lobbies.length || m.games.length);
    const asOf = lobbiesAt ? ` As of ${new Date(lobbiesAt).toISOString().slice(11, 16)} UTC.` : '';
    const lobbyLine = l => {
        const filled = (Array.isArray(l.players) ? l.players.length : 0) + (Number(l.aiSlots) || 0);
        const max = Number(l.maxPlayers) || 8;
        const action = l.isPasswordProtected ? '<span class="seo-tag">Password</span>'
            : l.isPlaying || filled >= max ? '<span class="seo-tag">Full</span>'
            : isMatchId(String(l.id)) ? `<a class="seo-join" href="aoe2de://0/${esc(l.id)}">Join</a>` : '';
        return `<li><span class="mod-live-dot" aria-hidden="true"></span>Lobby <span class="seo-lobby-title">${esc(clip(l.title || 'Age of Empires II Game', 70))}</span> <span class="seo-lobby-facts">${filled}/${max} players${l.map ? ` · ${esc(l.map)}` : ''}</span> ${action}</li>`;
    };
    const gameLine = g => {
        const mins = Math.max(0, Math.floor((Date.now() / 1000 - g.startTime) / 60));
        return `<li><span class="mod-live-dot mod-live-game" aria-hidden="true"></span>Game on ${esc(g.map)} <span class="seo-lobby-facts">${g.players} ${g.players === 1 ? 'player' : 'players'} · started ${mins < 1 ? 'just now' : `${mins} min ago`}</span> ` +
            `<a class="seo-join" href="aoe2de://1/${esc(g.id)}" title="Opens Age of Empires II: DE as a spectator">Spectate</a> <a href="/spectate/${esc(g.id)}">Details</a></li>`;
    };
    const card = (m, i) => {
        const link = esc(m.link);
        const live = [...m.lobbies.map(lobbyLine), ...m.games.map(gameLine)];
        const text = String(m.summary || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
        const facts = [m.tag, m.version && `v${m.version}`, m.fileSize ? `${(m.fileSize / 1048576).toFixed(1)} MB` : '',
            m.created && `created ${day(m.created)}`, `ID ${m.id}`].filter(Boolean).map(esc).join(' · ');
        return `                <article class="mod-card" id="mod-${m.id}">
                    ${m.thumb ? `<a class="mod-card-thumb" href="${link}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true"><img src="${esc(m.thumb)}" alt="" width="256" height="144"${i >= 4 ? ' loading="lazy"' : ''}></a>` : ''}
                    <div class="mod-card-body">
                        <h3 class="mod-card-name"><a href="${link}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a></h3>
                        <p class="mod-card-meta">${number(m.downloads)} ${m.downloads === 1 ? 'download' : 'downloads'} · ${number(m.installs)} ${m.installs === 1 ? 'install' : 'installs'}${m.ratings ? ` · ${number(m.ratings)} ${m.ratings === 1 ? 'rating' : 'ratings'}` : ''}${m.updated ? ` · updated ${day(m.updated)}` : ''}</p>
                        ${live.length ? `<ul class="mod-card-live">${live.join('')}</ul>` : ''}
                        <div class="mod-card-text">${text}</div>
                        <p class="mod-card-facts">${facts} · <a href="${link}" target="_blank" rel="noopener noreferrer">Open on ageofempires.com</a></p>
                    </div>
                </article>`;
    };
    const inUseSection = inUse.length
        ? `                <ul class="mod-card-live">
${inUse.flatMap(m => [...m.lobbies.map(l => lobbyLine(l).replace('<li>', `<li><a class="mod-in-use-name" href="#mod-${m.id}">${esc(m.name)}</a>: `)), ...m.games.map(g => gameLine(g).replace('<li>', `<li><a class="mod-in-use-name" href="#mod-${m.id}">${esc(m.name)}</a>: `))]).join('\n')}
                </ul>
                <p class="seo-note">${asOf} The <a href="/">lobby list</a> updates live.</p>`
        : `                <p>None of these mods is in an open lobby or a game in progress right now.${asOf}</p>`;
    const body = `${crumbs.html}
            <section class="glass-panel seo-panel">
                <h1>${esc(title)}</h1>
                <p class="seo-lead">Every Age of Empires II: DE mod ${esc(author)} has published on ageofempires.com, last updated first, with what each one changes and the lobbies and games using it right now. To play one, subscribe to it in the game's Mods menu, then pick it as the data mod when you host a lobby.</p>
                <p class="seo-stats"><span><strong>${number(mods.length)}</strong> mods</span><span><strong>${number(total)}</strong> downloads</span><span><strong>${number(inUse.length)}</strong> in use now</span></p>
            </section>
            <section class="glass-panel seo-panel">
                <h2>In use now</h2>
${inUseSection}
            </section>
            <section class="glass-panel seo-panel">
                <h2>All ${number(mods.length)} mods</h2>
                <div class="mod-cards">
${mods.map(card).join('\n')}
                </div>
                <p class="seo-note">Downloads and installs as listed on ageofempires.com${readAt ? ` on ${day(readAt)}` : ''}. A mod's page there needs a free sign-in.</p>
            </section>`;
    return page({
        title: `${title} – Age of Empires II: DE mods | ${SITE_NAME}`,
        description: clip(`${number(mods.length)} Age of Empires II: DE mods by ${author}: 2x2 farms, bigger houses, flying Trade Carts, passable military buildings and more. What each changes, downloads, and the lobbies using them now.`, 200),
        path,
        indexable: mods.length > 0,
        jsonLd: { '@context': 'https://schema.org', '@graph': [crumbs.jsonLd] },
        body,
        stylesHref
    });
}

function renderNotFound({ stylesHref }) {
    const body = `            <section class="glass-panel seo-panel">
                <h1>Map not found</h1>
                <p>No map has this address. It may have been renamed, or not been seen in a lobby yet.</p>
                <p><a href="/maps/">Every map</a> · <a href="/">Live lobbies</a></p>
            </section>`;
    return page({ title: `Map not found | ${SITE_NAME}`, description: 'No map has this address.', path: '/maps/', indexable: false, jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage' }, body, stylesHref });
}

// urls: [{ path, lastmod (ms or null) }]
function renderSitemap(urls) {
    const items = urls.map(u => `    <url>
        <loc>${esc(SITE_URL + u.path)}</loc>${u.lastmod ? `
        <lastmod>${isoDate(u.lastmod)}</lastmod>` : ''}
    </url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</urlset>
`;
}

// The home page's links to the busiest indexable maps (they read after "Each busy map has a page of its own")
function popularMapsHtml(list, slugOf, count = 12) {
    const maps = list.filter(m => isIndexable(m) && slugOf.has(m.name)).slice(0, count);
    if (maps.length < 2) return '';
    const links = maps.map(m => `<a href="${esc(mapPath(slugOf.get(m.name)))}">${esc(m.name)}</a>`);
    return `, such as ${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}`;
}

module.exports = {
    SITE_URL, INDEX_MIN_PLAYERS, INDEX_MIN_LOBBIES, TOP_PLAYERS,
    mapSlug, slugIndex, isIndexable, mapPath, mainLadder,
    renderMapsIndex, renderMapPage, renderModsPage, renderNotFound, renderSitemap, popularMapsHtml
};
