// App State
let lobbies = [];
const defaultState = {
    search: '',
    gameType: 'all',
    map: 'all',
    minElo: 0,
    status: 'all',
    mod: 'all',
    startAge: 'all',
    resources: 'all',
    treaty: 'all',
    server: 'all',
    spectateSearch: '',
    spectateType: 'all',
    spectateKind: 'all',
    spectateServer: 'all',
    spectateSort: 'newest',
    currentView: 'lobbies',
    playerSort: 'elo-desc',
    playerSearch: '',
    eloType: '0' // Unranked, the same default rating aoe2lobby.com shows
};
// Saved filters; blocked storage or a corrupt value must never stop the page from loading
let storedState = {};
try {
    const v = JSON.parse(localStorage.getItem('aoe2State'));
    if (v && typeof v === 'object' && !Array.isArray(v)) storedState = v;
} catch (e) {}
// Drop saved values of the wrong type (they would break filtering), keeping the defaults instead
for (const key of Object.keys(defaultState)) {
    if (key in storedState && typeof storedState[key] !== typeof defaultState[key]) delete storedState[key];
}
// 'auto' used to be the default; move those visitors to the new default once
if (storedState.eloType === 'auto' && !storedState.eloDefaultV2) storedState.eloType = '0';
const state = { ...defaultState, ...storedState, eloDefaultV2: true };

// Filters that narrow the lobby list: [state key, DOM select id or null, label]
const LOBBY_FILTERS = [
    ['gameType', 'gameTypeFilter', 'Game Type'], ['map', 'mapFilter', 'Map'], ['minElo', 'eloFilter', 'Min ELO'],
    ['status', 'statusFilter', 'Status'], ['mod', 'modFilter', 'Mods'], ['startAge', 'startAgeFilter', 'Start Age'],
    ['resources', 'resourcesFilter', 'Resources'], ['treaty', 'treatyFilter', 'Treaty'], ['server', 'serverFilter', 'Server']
];

function activeLobbyFilters() {
    const active = [];
    if (state.search) active.push(`Search "${state.search}"`);
    for (const [key, id, label] of LOBBY_FILTERS) {
        if (state[key] === defaultState[key]) continue;
        const el = document.getElementById(id);
        active.push(`${label}: ${el && el.selectedOptions[0] ? el.selectedOptions[0].textContent : state[key]}`);
    }
    return active;
}

function clearLobbyFilters() {
    state.search = '';
    if (searchInput) searchInput.value = '';
    for (const [key, id] of LOBBY_FILTERS) {
        state[key] = defaultState[key];
        const el = document.getElementById(id);
        if (el) el.value = String(defaultState[key]);
    }
    applyFiltersAndRender();
}

// DOM Elements
const lobbyGrid = document.getElementById('lobbyGrid');
const playerGrid = document.getElementById('playerGrid');
const itemCount = document.getElementById('itemCount');
const countLabel = document.getElementById('countLabel');
const searchInput = document.getElementById('searchInput');
const gameTypeFilter = document.getElementById('gameTypeFilter');
const mapFilter = document.getElementById('mapFilter');
const eloFilter = document.getElementById('eloFilter');
const statusFilter = document.getElementById('statusFilter');
const modFilter = document.getElementById('modFilter');
const eloTypeFilter = document.getElementById('eloTypeFilter');
const startAgeFilter = document.getElementById('startAgeFilter');
const resourcesFilter = document.getElementById('resourcesFilter');
const treatyFilter = document.getElementById('treatyFilter');
const serverFilter = document.getElementById('serverFilter');

const LATER_AGES = ['Feudal Age', 'Castle Age', 'Imperial Age', 'Post-Imperial Age'];
const MORE_RESOURCES = ['Medium', 'High', 'Ultra High', 'Infinite'];

// New UI Elements
const viewLobbiesBtn = document.getElementById('viewLobbiesBtn');
const viewPlayersBtn = document.getElementById('viewPlayersBtn');
const playerFilters = document.getElementById('playerFilters');
const lobbyFilters = document.querySelector('.filters-section:not(#playerFilters)');
const playerSort = document.getElementById('playerSort');
const playerSearch = document.getElementById('playerSearch');
const viewTitleText = document.getElementById('viewTitleText');

// Initialize
let pollTimer;
let isInitialLoad = true;

function init() {
    // Every page: civ details for the civ chips, and alerts for followed players
    loadFollows();
    loadCivInfo();
    scheduleFollowPoll(0);
    // A match page (/spectate/<id>) shows that one game in place of the lists, and never polls the lobby list
    if (matchPageId && matchView) {
        initMatchPage();
        return;
    }
    setupEventListeners();
    
    // Restore DOM inputs from state
    if(searchInput) searchInput.value = state.search;
    if(gameTypeFilter) gameTypeFilter.value = state.gameType;
    if(mapFilter) mapFilter.value = state.map;
    if(eloFilter) eloFilter.value = state.minElo;
    if(statusFilter) statusFilter.value = state.status;
    if(modFilter) modFilter.value = state.mod;
    if(eloTypeFilter) eloTypeFilter.value = state.eloType;
    if(startAgeFilter) startAgeFilter.value = state.startAge;
    if(resourcesFilter) resourcesFilter.value = state.resources;
    if(treatyFilter) treatyFilter.value = state.treaty;
    if(serverFilter) serverFilter.value = state.server;
    if(playerSort) playerSort.value = state.playerSort;
    if(playerSearch) playerSearch.value = state.playerSearch;

    if(state.layout === 'list') {
        const layoutListBtn = document.getElementById('layoutListBtn');
        if (layoutListBtn) layoutListBtn.click();
    } else {
        const layoutGridBtn = document.getElementById('layoutGridBtn');
        if (layoutGridBtn) layoutGridBtn.click();
    }
    
    showView(['lobbies', 'players', 'spectate'].includes(state.currentView) ? state.currentView : 'lobbies');
    
    fetchRealLobbies();
}

// Names, titles and maps come from the game's lobby feed: escape before putting them in HTML
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only a numeric id is a real match id (aoe2de:// links); anything else is never put in a link
function isMatchId(id) {
    return /^\d+$/.test(String(id ?? ''));
}

// Buttons inside cards carry data-action instead of inline onclick handlers (so the page can run under a CSP)
document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
        case 'copy-handle': copyPlayerHandle(e, el, el.dataset.handle || ''); break;
        case 'steam-friend': if (addSteamFriend(e, el.dataset.steamId) === false) e.preventDefault(); break;
        case 'clear-filters': clearLobbyFilters(); break;
        case 'show-more-spectate': showMoreSpectate(); break;
        case 'copy-match-link': copyMatchLink(el); break;
        case 'open-view': rememberView(el.dataset.view); break; // a link to '/': the home page then opens this view
        case 'civ-info': toggleCivPopover(el); break;
        case 'toggle-follow': toggleFollow(el); break;
        case 'unfollow': unfollow(el); break;
        case 'desktop-alerts': toggleDesktopAlerts(el); break;
        case 'show-followed-games': showFollowedGames(); break;
        case 'open-followed-games': openFollowedGames(); break; // a link to '/', like open-view
        case 'dismiss-toast': dismissToast(el); break;
        case 'caster-score': casterScore(el); break;
        case 'caster-reset': casterReset(); break;
        case 'caster-copy': copyCasterUrl(el); break;
    }
});

// Add a Steam friend: the steam:// link makes the Steam app send the request. Without the app, nothing takes
// focus, so after a moment open the player's Steam profile (its Add Friend button signs in first if needed).
function addSteamFriend(e, steamId) {
    if (!/^\d{17}$/.test(String(steamId))) return false;
    e.preventDefault();
    e.stopPropagation();
    let appOpened = false;
    const markOpened = () => { appOpened = true; };
    window.addEventListener('blur', markOpened, { once: true });
    document.addEventListener('visibilitychange', markOpened, { once: true });
    window.location.href = `steam://friends/add/${steamId}`;
    setTimeout(() => {
        window.removeEventListener('blur', markOpened);
        document.removeEventListener('visibilitychange', markOpened);
        if (!appOpened) window.open(`https://steamcommunity.com/profiles/${steamId}`, '_blank', 'noopener');
    }, 1500);
    return false;
}

const XBOX_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.202 15.967a8 8 0 0 1-3.552-1.26c-.898-.585-1.101-.826-1.101-1.306 0-.965 1.062-2.656 2.879-4.583C6.459 7.723 7.897 6.44 8.052 6.475c.302.068 2.718 2.423 3.622 3.531 1.43 1.753 2.088 3.189 1.754 3.829-.254.486-1.83 1.437-2.987 1.802-.954.301-2.207.429-3.239.33m-5.866-3.57C.589 11.253.212 10.127.03 8.497c-.06-.539-.038-.846.137-1.95.218-1.377 1.002-2.97 1.945-3.95.401-.417.437-.427.926-.263.595.2 1.23.638 2.213 1.528l.574.519-.313.385C4.056 6.553 2.52 9.086 1.94 10.653c-.315.852-.442 1.707-.306 2.063.091.24.007.15-.3-.319Zm13.101.195c.074-.36-.019-1.02-.238-1.687-.473-1.443-2.055-4.128-3.508-5.953l-.457-.575.494-.454c.646-.593 1.095-.948 1.58-1.25.381-.237.927-.448 1.161-.448.145 0 .654.528 1.065 1.104a8.4 8.4 0 0 1 1.343 3.102c.153.728.166 2.286.024 3.012a9.5 9.5 0 0 1-.6 1.893c-.179.393-.624 1.156-.82 1.404-.1.128-.1.127-.043-.148ZM7.335 1.952c-.67-.34-1.704-.705-2.276-.803a4 4 0 0 0-.759-.043c-.471.024-.45 0 .306-.358A7.8 7.8 0 0 1 6.47.128c.8-.169 2.306-.17 3.094-.005.85.18 1.853.552 2.418.9l.168.103-.385-.02c-.766-.038-1.88.27-3.078.853-.361.176-.676.316-.699.312a12 12 0 0 1-.654-.319Z"/></svg>';
const STEAM_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.009-8A8.006 8.006 0 0 0 0 7.468l.003.006 4.304 1.769A2.2 2.2 0 0 1 5.62 8.88l1.96-2.844-.001-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.044l-2.804 2a2.223 2.223 0 0 1-3.075 2.11 2.22 2.22 0 0 1-1.312-1.568L.33 10.333Z"/><path d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.7 1.7 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-.99-.41a1.7 1.7 0 0 0 .882.84Zm3.726-6.687a2.03 2.03 0 0 0 2.027 2.029 2.03 2.03 0 0 0 2.027-2.029 2.03 2.03 0 0 0-2.027-2.027 2.03 2.03 0 0 0-2.027 2.027m2.03-1.527a1.524 1.524 0 1 1-.002 3.048 1.524 1.524 0 0 1 .002-3.048"/></svg>';

// Profile links for a player: AoE2Insights, the official Age of Empires (Microsoft) stats page, and Steam when on Steam
function playerLinksHtml(p) {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id <= 0) return '';
    let html = `<a class="player-link" href="https://www.aoe2insights.com/user/relic/${id}" target="_blank" rel="noopener" title="AoE2Insights profile">AoE2Insights</a>`;
    html += `<a class="player-link" href="https://www.ageofempires.com/stats/?profileId=${id}&game=age2" target="_blank" rel="noopener" title="Official Age of Empires stats (Microsoft)">${XBOX_ICON}</a>`;
    if (typeof p.steamProfile === 'string' && /^https:\/\/steamcommunity\.com\/(profiles|id)\/[\w-]+\/?$/.test(p.steamProfile)) {
        html += `<a class="player-link" href="${esc(p.steamProfile)}" target="_blank" rel="noopener" title="Steam profile">${STEAM_ICON}</a>`;
        const steamId = /\/profiles\/(\d{17})\/?$/.exec(p.steamProfile);
        if (steamId) {
            html += `<a class="player-link" href="steam://friends/add/${steamId[1]}" data-action="steam-friend" data-steam-id="${steamId[1]}" title="Add friend on Steam">+ Friend</a>`;
        }
    }
    return `<span class="player-links">${html}</span>`;
}

function parseRelicLobby(match) {
    let title = (typeof match.title === 'string' && match.title) ? match.title : "Age of Empires II Game";
    try { title = decodeURIComponent(escape(title)); } catch(e) {}

    // Only a string is a map name; anything else (e.g. {} from a bad feed entry) must not break the list
    let map = (typeof match.map === 'string' && match.map) ? match.map : "Unknown Map";
    if (map.toLowerCase() === "my map" || map.toLowerCase() === "custom map" || map === "") {
        map = "Custom Scenario";
        const tLower = title.toLowerCase();
        if (tLower.includes('michi') || tLower.includes('mici')) map = 'Michi';
        else if (tLower.includes('cba')) map = 'CBA';
        else if (tLower.includes('diplo')) map = 'Diplomacy';
        else if (tLower.includes('rtd') || tLower.includes('roll')) map = 'Roll the Dice';
        else if (tLower.includes('dodge')) map = 'Dodgeball';
    }

    if (typeof match.id !== 'number' && typeof match.id !== 'string') throw new Error('lobby without an id');
    // Plain text or numbers only: an object here (bad feed entry) would break the card
    const known = (v) => ((typeof v === 'string' || typeof v === 'number') && v !== '' && v !== 'Unknown') ? v : null;
    let matchType = known(match.matchType);

    let type = "Random Map";
    if (title.toLowerCase().includes("death")) type = "Death Match";
    if (title.toLowerCase().includes("empire")) type = "Empire Wars";
    if (matchType === 'Custom Scenario') type = 'Custom';
    else if (matchType) type = matchType;

    let mapIcon = '&#x1F5FA;';
    if(map.toLowerCase().includes('arabia')) mapIcon = '&#x1F3DC;';
    if(map.toLowerCase().includes('black forest')) mapIcon = '&#x1F332;';
    if(map.toLowerCase().includes('nomad')) mapIcon = '&#x26FA;';
    if(map.toLowerCase().includes('arena')) mapIcon = '&#x1F3F0;';
    
    let mapSize = known(match.mapSize);
    let modInfo = (typeof match.modInfo === 'string' && match.modInfo) ? match.modInfo : "No Mods";
    let population = known(match.population);
    let speed = known(match.speed);
    let startingAge = known(match.startingAge);
    let resources = known(match.resources);
    let treaty = parseInt(match.treaty) || 0;

    // Work on copies: the raw feed is parsed again when the Elo Type changes. players[0] is the host (the server puts it first).
    const players = (Array.isArray(match.players) ? match.players : [])
        .filter(p => p && typeof p === 'object')
        .map(p => ({ ...p, name: typeof p.name === 'string' ? p.name : String(p.name ?? '') }));
    let currentPlayers = Array.isArray(match.players) ? players.length : 1;
    let maxPlayers = Number(match.maxPlayers) || 8; // joinable slots; closed and AI slots aren't counted
    let aiSlots = Number(match.aiSlots) || 0;

    let playersHtml = '';
    if (players.length > 0) {
        // First set each player's shown stats based on eloType
        players.forEach(p => {
            if (state.eloType !== 'auto' && p.allStats && p.allStats[state.eloType]) {
                const stat = p.allStats[state.eloType];
                p.displayElo = stat.rating;
                p.displayGames = stat.games;
                p.displayWR = stat.winp + '%';
            } else if (state.eloType !== 'auto') {
                p.displayElo = null;
                p.displayGames = 0;
                p.displayWR = '0%';
            } else {
                p.displayElo = p.elo;
                p.displayGames = p.totalGames;
                p.displayWR = p.winRate;
            }
            // Shown, sorted and filtered on: plain text or numbers only
            for (const key of ['displayElo', 'displayGames', 'displayWR']) {
                if (typeof p[key] !== 'string' && typeof p[key] !== 'number') p[key] = null;
            }
        });

        // Sort a copy by team for display, so players[0] stays the host
        playersHtml = [...players].sort((a,b) => a.team - b.team).map(p => {
            const wr = p.displayWR ? (String(p.displayWR).endsWith('%') ? p.displayWR : p.displayWR + '%') : 'N/A';
            let statsHtml = `${esc(p.displayGames)} Games, ${esc(wr)} WR`;

            // No games on this ladder: either the server is still fetching the profile, or the player hasn't played it
            if (!Number(p.displayGames) && (!p.displayWR || p.displayWR === '0%' || p.displayWR === '0.0%')) {
                statsHtml = p.statsPending === true
                    ? `<div class="spinner-inline" title="Loading player stats..."></div>`
                    : 'No games on this ladder';
            }

            return `
            <div class="player-item" style="display: flex; align-items: center; justify-content: space-between;">
                <span class="player-name" style="display: flex; align-items: center; gap: 6px;">
                    T${esc(p.team)} - ${esc(p.name)}
                    ${civChipHtml(p)}
                    <button type="button" data-action="copy-handle" data-handle="${esc(p.name)}" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex; align-items: center;" title="Copy Handle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <span class="player-stats">${statsHtml}</span>
                    ${playerLinksHtml(p)}
                </span>
                <span class="player-elo">${p.displayElo != null ? esc(p.displayElo) : '&mdash;'}</span>
            </div>
            `;
        }).join('');
    } else {
        playersHtml = `<div class="player-item">No player data available.</div>`;
    }

    return {
        id: match.id,
        steamLobbyId: match.steamLobbyId,
        host: players.length > 0 ? players[0].name : `Unknown`,
        elo: players.length > 0 ? players[0].displayElo : null,
        title: title,
        map: map,
        mapIcon: mapIcon,
        type: type,
        matchType: matchType,
        mapSize: mapSize,
        modInfo: modInfo,
        population: population,
        speed: speed,
        startingAge: startingAge,
        resources: resources,
        treaty: treaty,
        server: (typeof match.server === 'string' && match.server) ? match.server : null,
        isPasswordProtected: match.isPasswordProtected === true,
        currentPlayers: currentPlayers,
        maxPlayers: maxPlayers,
        aiSlots: aiSlots,
        ping: Math.floor(Math.random() * 50) + 20,
        playersHtml: playersHtml,
        isPlaying: !!match.isPlaying,
        lastSeen: match.lastSeen,
        createdTime: intIn(match.createdTime, 1, Number.MAX_SAFE_INTEGER),
        rawPlayers: players
    };
}

// One bad lobby is skipped (and logged) instead of blanking the whole list
function parseLobbies(matches) {
    return matches.flatMap(m => {
        try { return [parseRelicLobby(m)]; }
        catch (e) { console.warn('Skipping a lobby that could not be shown:', m && m.id, e); return []; }
    });
}

async function fetchRealLobbies() {
    try {
        const response = await fetch('/api/lobbies?t=' + Date.now());
        const data = await response.json();
        
        let hasUnknownMap = false;

        if (data && Array.isArray(data.matches)) {
            state.rawMatches = data.matches;
            lobbies = parseLobbies(data.matches);

            // Dynamically populate Mod Filter
            const modFilter = document.getElementById('modFilter');
            if (modFilter) {
                // Keep the saved choice even while no open lobby uses that mod, like the server filter does
                const currentModSelection = String(state.mod ?? 'all');
                const uniqueMods = [...new Set(lobbies.map(l => l.modInfo).filter(m => m && m !== 'No Mods'))].sort();
                if (!['all', 'No Mods', 'Mods Enabled'].includes(currentModSelection) && !uniqueMods.includes(currentModSelection)) {
                    uniqueMods.push(currentModSelection);
                }

                modFilter.innerHTML = `
                    <option value="all">All Mods</option>
                    <option value="No Mods">No Mods</option>
                    <option value="Mods Enabled">Any Mods Enabled</option>
                `;
                uniqueMods.forEach(mod => {
                    const opt = document.createElement('option');
                    opt.value = mod;
                    opt.textContent = mod;
                    modFilter.appendChild(opt);
                });
                modFilter.value = currentModSelection;
            }

            if (serverFilter) {
                const servers = [...new Set(lobbies.map(l => l.server).filter(Boolean))].sort();
                if (state.server !== 'all' && !servers.includes(state.server)) servers.push(state.server);
                serverFilter.innerHTML = '<option value="all">All Servers</option>' +
                    servers.map(sv => `<option value="${esc(sv)}">${esc(sv)}</option>`).join('');
                serverFilter.value = state.server;
            }

            hasUnknownMap = lobbies.some(lobby => lobby.map === "Unknown Map");
            if (isInitialLoad) {
                isInitialLoad = false;
            }
            applyFiltersAndRender();
        }
        
        clearTimeout(pollTimer);
        pollTimer = setTimeout(fetchRealLobbies, hasUnknownMap ? 5000 : 10000);
    } catch (error) {
        console.warn("Failed to fetch real lobbies:", error);
        clearTimeout(pollTimer);
        pollTimer = setTimeout(fetchRealLobbies, 10000);
    }
}

function setupEventListeners() {
    searchInput.addEventListener('input', (e) => {
        state.search = e.target.value.toLowerCase();
        applyFiltersAndRender();
    });
    playerSearch.addEventListener('input', (e) => {
        state.playerSearch = e.target.value.toLowerCase();
        applyFiltersAndRender();
    });
    gameTypeFilter.addEventListener('change', (e) => {
        state.gameType = e.target.value;
        applyFiltersAndRender();
    });
    mapFilter.addEventListener('change', (e) => {
        state.map = e.target.value;
        applyFiltersAndRender();
    });
    eloFilter.addEventListener('change', (e) => {
        state.minElo = parseInt(e.target.value);
        applyFiltersAndRender();
    });
    statusFilter.addEventListener('change', (e) => {
        state.status = e.target.value;
        applyFiltersAndRender();
    });
    modFilter.addEventListener('change', (e) => {
        state.mod = e.target.value;
        applyFiltersAndRender();
    });
    startAgeFilter.addEventListener('change', (e) => {
        state.startAge = e.target.value;
        applyFiltersAndRender();
    });
    resourcesFilter.addEventListener('change', (e) => {
        state.resources = e.target.value;
        applyFiltersAndRender();
    });
    treatyFilter.addEventListener('change', (e) => {
        state.treaty = e.target.value;
        applyFiltersAndRender();
    });
    serverFilter.addEventListener('change', (e) => {
        state.server = e.target.value;
        applyFiltersAndRender();
    });
    document.getElementById('clearFiltersBtn').addEventListener('click', clearLobbyFilters);
    if (eloTypeFilter) {
        eloTypeFilter.addEventListener('change', (e) => {
            state.eloType = e.target.value;
            const spectateElo = document.getElementById('spectateEloType');
            if (spectateElo) spectateElo.value = state.eloType;
            // We need to re-parse all lobbies so the UI updates
            if (state.rawMatches) lobbies = parseLobbies(state.rawMatches);
            applyFiltersAndRender();
        });
    }

    // View Toggles
    viewLobbiesBtn.addEventListener('click', () => showView('lobbies'));
    viewPlayersBtn.addEventListener('click', () => showView('players'));
    document.getElementById('viewSpectateBtn').addEventListener('click', () => showView('spectate'));

    // Spectate filters
    const spectateSearch = document.getElementById('spectateSearch');
    spectateSearch.value = state.spectateSearch;
    spectateSearch.addEventListener('input', (e) => {
        state.spectateSearch = e.target.value.toLowerCase();
        spectateLimit = SPECTATE_PAGE;
        applyFiltersAndRender();
    });
    for (const [id, key] of [['spectateType', 'spectateType'], ['spectateKind', 'spectateKind'], ['spectateServer', 'spectateServer'], ['spectateSort', 'spectateSort'], ['spectateEloType', 'eloType']]) {
        const el = document.getElementById(id);
        el.value = state[key];
        el.addEventListener('change', (e) => {
            state[key] = e.target.value;
            if (key === 'eloType' && eloTypeFilter) eloTypeFilter.value = state.eloType;
            spectateLimit = SPECTATE_PAGE;
            applyFiltersAndRender();
        });
    }

    // Layout Toggles
    const layoutGridBtn = document.getElementById('layoutGridBtn');
    const layoutListBtn = document.getElementById('layoutListBtn');

    layoutGridBtn.addEventListener('click', () => {
        state.layout = 'grid';
        layoutGridBtn.style.background = 'rgba(88, 101, 242, 0.2)';
        layoutGridBtn.style.border = '1px solid var(--accent)';
        layoutGridBtn.style.color = 'white';
        layoutListBtn.style.background = 'transparent';
        layoutListBtn.style.border = '1px solid transparent';
        layoutListBtn.style.color = 'var(--text-secondary)';
        lobbyGrid.classList.remove('list-layout');
        playerGrid.classList.remove('list-layout');
        spectateGrid.classList.remove('list-layout');
        showView(state.currentView);
    });

    layoutListBtn.addEventListener('click', () => {
        state.layout = 'list';
        layoutListBtn.style.background = 'rgba(88, 101, 242, 0.2)';
        layoutListBtn.style.border = '1px solid var(--accent)';
        layoutListBtn.style.color = 'white';
        layoutGridBtn.style.background = 'transparent';
        layoutGridBtn.style.border = '1px solid transparent';
        layoutGridBtn.style.color = 'var(--text-secondary)';
        lobbyGrid.classList.add('list-layout');
        playerGrid.classList.add('list-layout');
        spectateGrid.classList.add('list-layout');
        showView(state.currentView);
    });

    // Player Sorting
    playerSort.addEventListener('change', (e) => {
        state.playerSort = e.target.value;
        applyFiltersAndRender();
    });
}

function filterLobbies() {
    return lobbies.filter(lobby => {
        const matchesSearch =
            lobby.host.toLowerCase().includes(state.search) ||
            lobby.title.toLowerCase().includes(state.search) ||
            lobby.map.toLowerCase().includes(state.search) ||
            lobby.rawPlayers.some(p => p.name.toLowerCase().includes(state.search));
        const matchesType = state.gameType === 'all' || lobby.type === state.gameType;
        const matchesMap = state.map === 'all' || lobby.map.toLowerCase().includes(state.map.toLowerCase());
        const matchesStatus = state.status === 'all' || 
            (state.status === 'open' && !lobby.isPlaying) || 
            (state.status === 'playing' && lobby.isPlaying);
        const matchesMod = state.mod === 'all' || 
            (state.mod === 'Mods Enabled' ? lobby.modInfo !== 'No Mods' : lobby.modInfo === state.mod);
        const matchesElo = state.minElo === 0 || (lobby.elo && parseInt(lobby.elo) >= state.minElo);
        const matchesStartAge = state.startAge === 'all' ||
            (state.startAge === 'later' ? LATER_AGES.includes(lobby.startingAge) : lobby.startingAge === state.startAge);
        const matchesResources = state.resources === 'all' ||
            (state.resources === 'more' ? MORE_RESOURCES.includes(lobby.resources) : lobby.resources === state.resources);
        const matchesTreaty = state.treaty === 'all' ||
            (state.treaty === 'any' ? lobby.treaty > 0 : lobby.treaty === 0);
        return matchesSearch && matchesType && matchesMap && matchesStatus && matchesMod && matchesElo &&
            matchesStartAge && matchesResources && matchesTreaty &&
            (state.server === 'all' || lobby.server === state.server);
    });
}

function saveState() {
    const { rawMatches, ...saved } = state; // the lobby list itself is not worth saving
    try { localStorage.setItem('aoe2State', JSON.stringify(saved)); } catch (e) {} // blocked or full storage: just don't remember
}

function applyFiltersAndRender() {
    saveState();
    // Outline every filter that is narrowing the list, so remembered filters are easy to spot
    for (const [key, id] of LOBBY_FILTERS) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('filter-active', String(state[key]) !== String(defaultState[key]));
    }
    if (searchInput) searchInput.classList.toggle('filter-active', !!state.search);
    const clearBtn = document.getElementById('clearFiltersBtn');
    if (clearBtn) clearBtn.hidden = state.currentView !== 'lobbies' || activeLobbyFilters().length === 0;
    if (state.currentView === 'lobbies') {
        const filteredLobbies = filterLobbies();
        itemCount.textContent = filteredLobbies.length;
        renderLobbies(filteredLobbies);
    } else if (state.currentView === 'spectate') {
        const games = filterSpectate();
        itemCount.textContent = games.length;
        renderSpectate(games);
    } else {
        const aggregatedPlayers = aggregatePlayers();
        itemCount.textContent = aggregatedPlayers.length;
        renderPlayers(aggregatedPlayers);
    }
    reanchorCivPopover();
}

function aggregatePlayers() {
    let allPlayers = [];
    
    // Grab players from all lobbies to show accurate Lobby Status
    lobbies.forEach(lobby => {
        if (lobby.rawPlayers && lobby.rawPlayers.length > 0) {
            lobby.rawPlayers.forEach(p => {
                // Ensure valid player data
                if (p.name && p.name.toLowerCase() !== 'open' && p.name.toLowerCase() !== 'closed') {
                    allPlayers.push({
                        ...p,
                        lobbyId: lobby.id,
                        lobbyTitle: lobby.title,
                        lobbyMap: lobby.map,
                        isPlaying: lobby.isPlaying,
                        isPasswordProtected: lobby.isPasswordProtected,
                        matchType: lobby.matchType,
                        mapSize: lobby.mapSize,
                        population: lobby.population,
                        speed: lobby.speed,
                        modInfo: lobby.modInfo || 'No Mods',
                        server: lobby.server,
                        lastSeen: lobby.lastSeen || 0,
                        playersHtml: lobby.playersHtml
                    });
                }
            });
        }
    });
    
    // Apply Player Search Filter
    if (state.playerSearch) {
        allPlayers = allPlayers.filter(p => 
            p.name.toLowerCase().includes(state.playerSearch) || 
            (p.lobbyMap && p.lobbyMap.toLowerCase().includes(state.playerSearch))
        );
    }
    
    // Sorting logic
    allPlayers.sort((a, b) => {
        if (state.playerSort === 'elo-desc') return (parseInt(b.displayElo) || 0) - (parseInt(a.displayElo) || 0);
        if (state.playerSort === 'elo-asc') return (parseInt(a.displayElo) || 0) - (parseInt(b.displayElo) || 0);
        if (state.playerSort === 'active-desc') return (b.lastSeen || 0) - (a.lastSeen || 0);
        if (state.playerSort === 'wr-desc') return (parseFloat(b.displayWR) || 0) - (parseFloat(a.displayWR) || 0);
        if (state.playerSort === 'games-desc') return (parseInt(b.displayGames) || 0) - (parseInt(a.displayGames) || 0);
        return 0;
    });
    
    return allPlayers;
}

function renderPlayers(players) {
    if (isInitialLoad) {
        playerGrid.innerHTML = `
            <div class="loader-container">
                <div class="spinner"></div>
                <p>Loading Players...</p>
            </div>
        `;
        return;
    }

    playerGrid.innerHTML = ''; // Clear grid before re-rendering

    if (players.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.id = 'emptyStatePlayers';
        emptyState.className = 'empty-state';
        emptyState.innerHTML = state.playerSearch
            ? `<h3>No players match your search</h3><p>No player or map matches <strong>${esc(state.playerSearch)}</strong>.</p>`
            : `<h3>No Players Found</h3><p>There are no open lobbies with players currently.</p>`;
        playerGrid.appendChild(emptyState);
        return;
    }

    players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'lobby-card'; // Reuse the card styling for consistency
        div.style.animation = "fadeIn 0.5s ease-out";
        div.innerHTML = `
            <div class="card-header">
                <div class="host-info">
                    <div class="host-name" style="display: flex; align-items: center; gap: 8px;">
                        <span class="host-label">${esc(p.name)}</span>
                        <button type="button" data-action="copy-handle" data-handle="${esc(p.name)}" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex;" title="Copy Handle">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        ${p.displayElo != null ? `<span class="elo-badge">${esc(p.displayElo)}</span>` : '<span class="elo-badge" style="background: rgba(138, 155, 178, 0.2); color: var(--text-secondary); border-color: transparent;">Unranked</span>'}
                    </div>
                    <div class="game-title" style="font-size: 0.8em; color: var(--text-secondary);">In lobby: ${esc(p.lobbyTitle)}${p.civ ? ` · Civ: ${esc(p.civ)}` : ''}</div>
                    ${playerLinksHtml(p)}
                </div>
            </div>
            
            <div class="card-body">
                <div class="game-details">
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F3C6;</span>
                        Win Rate: ${esc(p.displayWR ? (String(p.displayWR).endsWith('%') ? p.displayWR : p.displayWR + '%') : 'N/A')}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F4CA;</span>
                        Total Games: ${esc(p.displayGames || '0')}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F5FA;</span>
                        Map: ${esc(p.lobbyMap)}
                    </div>
                    <div class="tags-row" style="margin-top: 10px;">
                        <span class="badge status-badge" style="background: ${p.isPlaying ? 'rgba(212, 175, 55, 0.2)' : 'rgba(46, 160, 67, 0.2)'}; color: ${p.isPlaying ? '#d4af37' : '#2ea043'}; border-color: ${p.isPlaying ? '#d4af37' : '#2ea043'}">${p.isPlaying ? '&#x1F512; Full lobby' : '&#x23F3; Waiting'}</span>
                        ${p.server ? `<span class="badge server-badge" title="Server">&#x1F310; ${esc(p.server)}</span>` : ''}
                        ${passwordBadge(p)}
                        ${renderInfoBadges(p)}
                    </div>
                </div>
            </div>

            <div class="player-list">
                ${p.playersHtml}
            </div>

            ${p.isPlaying ? '' : `
            <div class="card-footer">
                ${isMatchId(p.lobbyId)
                    ? `<a href="aoe2de://0/${esc(p.lobbyId)}" class="btn-join" style="margin-left: auto;">Join Lobby</a>`
                    : '<span class="btn-join disabled" style="margin-left: auto;">Cannot Join</span>'}
            </div>
            `}
        `;
        
        div.onclick = (e) => {
            if(e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.closest('button')) return;
            div.classList.toggle('expanded');
        };
        
        playerGrid.appendChild(div);
    });
}

// Badges for values we actually know; unknown values are left out rather than guessed
function renderInfoBadges(item) {
    let html = '';
    if (item.matchType) html += `<span class="badge match-type-badge">${esc(item.matchType)}</span>`;
    if (item.mapSize) html += `<span class="badge map-size-badge" title="Map Size">&#x1F5FA; ${esc(item.mapSize)}</span>`;
    if (item.population) html += `<span class="badge pop-badge" title="Population">&#x1F465; ${esc(item.population)}</span>`;
    if (item.speed) html += `<span class="badge speed-badge" title="Speed">&#x23E9; ${esc(item.speed)}</span>`;
    html += `<span class="badge mod-info-badge" title="Mod Info">&#x2699; ${esc(item.modInfo || 'No Mods')}</span>`;
    return html;
}

// Password lobbies can still be joined (the game asks for the password), so this is only a label
function passwordBadge(item) {
    return item.isPasswordProtected ? '<span class="badge password-badge" title="The game asks for a password when you join">&#x1F511; Password</span>' : '';
}

// Everything shown on a card except the live player list / count / status, which update in place
function lobbyDetailsKey(lobby) {
    return JSON.stringify([lobby.host, lobby.elo, lobby.title, lobby.map, lobby.type, lobby.matchType, lobby.mapSize,
        lobby.population, lobby.speed, lobby.modInfo, lobby.startingAge, lobby.resources, lobby.treaty, lobby.isPlaying, lobby.server,
        lobby.isPasswordProtected, lobby.createdTime]);
}

function renderSettingBadges(lobby) {
    let html = '';
    if (lobby.treaty > 0) {
        html += `<span class="badge treaty-badge" title="Treaty Length">&#x1F91D; Treaty ${lobby.treaty} min</span>`;
    }
    if (lobby.startingAge) {
        const custom = lobby.startingAge !== 'Standard' && lobby.startingAge !== 'Dark Age' ? ' custom-setting' : '';
        html += `<span class="badge age-badge${custom}" title="Starting Age">&#x1F3F0; ${lobby.startingAge === 'Standard' ? 'Standard Age' : esc(lobby.startingAge)}</span>`;
    }
    if (lobby.resources) {
        const custom = lobby.resources !== 'Standard' && lobby.resources !== 'Low' ? ' custom-setting' : '';
        html += `<span class="badge resources-badge${custom}" title="Starting Resources">&#x1FA99; ${lobby.resources === 'Standard' ? 'Standard Res' : esc(lobby.resources) + ' Res'}</span>`;
    }
    return html;
}

function playerCountText(lobby) {
    return `&#x1F464; ${esc(lobby.currentPlayers)}/${esc(lobby.maxPlayers)}` +
        (lobby.aiSlots ? ` <span class="ai-count" title="Slots filled by AI">· ${esc(lobby.aiSlots)} AI</span>` : '');
}

// How long ago a lobby was made, in the largest unit that fits: "Created 12 mins ago", "3 hrs ago", "2 days ago"
function lobbyAgeText(createdTime) {
    const mins = Math.max(0, Math.floor((Date.now() / 1000 - createdTime) / 60));
    const ago = (n, unit) => `Created ${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (mins < 1) return 'Created just now';
    if (mins < 60) return ago(mins, 'min');
    if (mins < 1440) return ago(Math.floor(mins / 60), 'hr');
    return ago(Math.floor(mins / 1440), 'day');
}

// "Full" / "Waiting" plus the server region, top right of a lobby card
function lobbyStatusHtml(lobby) {
    return (lobby.isPlaying
        ? '<span style="color: #d4af37">&#x1F512; Full</span> '
        : '<span style="color: #2ea043">&#x23F3; Waiting</span> ') + esc(lobby.server || '');
}

function lobbyCardHtml(lobby) {
    const fillPercentage = (lobby.currentPlayers / lobby.maxPlayers) * 100;
    // Only a numeric lobby id can be joined; a lobby known only from aoe2lobby.com has none
    const joinable = !lobby.isPlaying && isMatchId(lobby.id);
    const joinLink = joinable ? `aoe2de://0/${lobby.id}` : '#';
    const joinText = joinLink === '#' ? (lobby.isPlaying ? 'Lobby Full' : 'Cannot Join') : 'Join Game';
    const joinClass = joinLink === '#' ? 'btn-join disabled' : 'btn-join';

    return `
        <div class="card-header">
            <div class="host-info">
                <div class="host-name">
                    <span class="host-label">${esc(lobby.host)}</span>
                    ${lobby.elo ? `<span class="elo-badge">${esc(lobby.elo)}</span>` : ''}
                </div>
                <div class="game-title" title="${esc(lobby.title)}">${esc(lobby.title)}</div>
            </div>
            <div class="server-badge">
                ${lobbyStatusHtml(lobby)}
            </div>
        </div>
        
        <div class="card-body">
            <div class="map-icon-wrapper" style="position: relative;">
                <div class="map-icon">${lobby.mapIcon}</div>
                ${lobby.map === 'Unknown Map' ? '<div class="map-spinner" title="Resolving map..."></div>' : ''}
            </div>
            <div class="game-details">
                <div class="detail-row">
                    <span class="detail-icon" style="opacity: 0.7;">⚔️</span> <span style="font-weight: 500;">${esc(lobby.type)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-icon" style="opacity: 0.7;">🗺️</span> <span style="font-weight: 500;">${esc(lobby.map)}</span>
                </div>
                ${lobby.createdTime ? `<div class="detail-row">
                    <span class="detail-icon" style="opacity: 0.7;">🕒</span> <span class="lobby-age" title="${esc(new Date(lobby.createdTime * 1000).toLocaleString())}">${lobbyAgeText(lobby.createdTime)}</span>
                </div>` : ''}
                <div class="tags-row">
                    ${passwordBadge(lobby)}
                    ${renderInfoBadges(lobby)}
                    ${renderSettingBadges(lobby)}
                </div>
            </div>
        </div>
        
        <div class="player-list">
            ${lobby.playersHtml}
        </div>
        
        <div class="card-footer">
            <div class="players-count">
                <span class="players-count-text">${playerCountText(lobby)}</span>
                <div class="fill-bar">
                    <div class="fill-progress" style="width: ${fillPercentage}%"></div>
                </div>
            </div>
            <a href="${esc(joinLink)}" class="${joinClass}">${joinText}</a>
        </div>
    `;
}

function renderLobbies(filteredLobbies) {
    let emptyState = document.getElementById('emptyState');
    
    if (isInitialLoad) {
        lobbyGrid.innerHTML = `
            <div class="loader-container">
                <div class="spinner"></div>
                <p>Fetching Lobbies...</p>
            </div>
        `;
        return;
    }

    if(filteredLobbies.length === 0) {
        if(!emptyState) {
            emptyState = document.createElement('div');
            emptyState.id = 'emptyState';
            emptyState.className = 'empty-state';
            lobbyGrid.appendChild(emptyState);
        }
        const active = activeLobbyFilters();
        const html = active.length
            ? `<h3>No lobbies match your filters</h3><p>${lobbies.length} lobbies are open, but none match: ${active.map(a => `<strong>${esc(a)}</strong>`).join(' · ')}</p><button type="button" class="btn clear-filters-btn" data-action="clear-filters">Clear all filters</button>`
            : `<h3>No open lobbies right now</h3><p>New lobbies appear here automatically.</p>`;
        if (emptyState.dataset.html !== html) { emptyState.innerHTML = html; emptyState.dataset.html = html; }
        emptyState.style.display = 'block';
    } else {
        if(emptyState) emptyState.style.display = 'none';
    }

    const existingNodes = new Map();
    Array.from(lobbyGrid.children).forEach(child => {
        if(child.id !== 'emptyState') {
            existingNodes.set(child.id, child);
        }
    });

    const filteredIds = new Set(filteredLobbies.map(l => 'lobby-' + l.id));
    for (const [id, node] of existingNodes.entries()) {
        if (!filteredIds.has(id)) {
            lobbyGrid.removeChild(node);
            existingNodes.delete(id);
        }
    }

    filteredLobbies.forEach(lobby => {
        const id = 'lobby-' + lobby.id;
        const fillPercentage = (lobby.currentPlayers / lobby.maxPlayers) * 100;

        if (existingNodes.has(id) && existingNodes.get(id).dataset.details !== lobbyDetailsKey(lobby)) {
            const node = existingNodes.get(id);
            node.innerHTML = lobbyCardHtml(lobby);
            node.dataset.details = lobbyDetailsKey(lobby);
        } else if (existingNodes.has(id)) {
            const node = existingNodes.get(id);
            const countText = node.querySelector('.players-count-text');
            const progress = node.querySelector('.fill-progress');
            const pList = node.querySelector('.player-list');
            const sBadge = node.querySelector('.server-badge');
            const age = node.querySelector('.lobby-age');
            
            if (age) age.textContent = lobbyAgeText(lobby.createdTime);
            if(countText && progress) {
                countText.innerHTML = playerCountText(lobby);
                progress.style.width = `${fillPercentage}%`;
            }
            if(pList && pList.innerHTML !== lobby.playersHtml) {
                pList.innerHTML = lobby.playersHtml;
            }
            if (sBadge) {
                sBadge.innerHTML = lobbyStatusHtml(lobby);
            }
        } else {
            const div = document.createElement('div');
            div.id = id;
            div.className = 'lobby-card';
            div.style.animation = "fadeIn 0.5s ease-out";
            
            div.onclick = (e) => {
                if (e.target.closest('a, button')) return;
                div.classList.toggle('expanded');
            };
            
            div.innerHTML = lobbyCardHtml(lobby);
            div.dataset.details = lobbyDetailsKey(lobby);
            
            lobbyGrid.appendChild(div);
        }
    });
}

document.addEventListener('DOMContentLoaded', init);

function copyPlayerHandle(e, btn, handle) {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(handle).then(() => {
        const originalIcon = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2ea043" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            btn.innerHTML = originalIcon;
        }, 1000);
    });
}

window.viewLobby = function(id) {
    document.getElementById('viewLobbiesBtn').click();
    state.search = '';
    document.getElementById('searchInput').value = '';
    applyFiltersAndRender();
    setTimeout(() => {
        const card = document.getElementById('lobby-' + id);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (!card.classList.contains('expanded')) card.classList.add('expanded');
            
            const originalShadow = card.style.boxShadow;
            card.style.boxShadow = '0 0 30px rgba(212, 175, 55, 0.8)';
            card.style.transition = 'box-shadow 0.3s ease-out';
            setTimeout(() => {
                card.style.boxShadow = originalShadow;
            }, 1500);
        }
    }, 100);
};

window.togglePlayerCard = function(e, btn) {
    if (e) e.stopPropagation();
    const card = btn.closest('.lobby-card');
    if (card) {
        card.classList.toggle('expanded');
    }
};

// ---------------------------------------------------------------- Views
const spectateGrid = document.getElementById('spectateGrid');
const VIEWS = {
    lobbies: { btn: 'viewLobbiesBtn', grid: 'lobbyGrid', filters: () => lobbyFilters, title: 'Lobbies', count: 'lobbies' },
    players: { btn: 'viewPlayersBtn', grid: 'playerGrid', filters: () => playerFilters, title: 'Players', count: 'players' },
    spectate: { btn: 'viewSpectateBtn', grid: 'spectateGrid', filters: () => document.getElementById('spectateFilters'), title: 'Games', count: 'games in progress' }
};

function markViewButton(view) {
    for (const [name, v] of Object.entries(VIEWS)) {
        const on = name === view;
        const btn = document.getElementById(v.btn);
        btn.style.background = on ? 'rgba(88, 101, 242, 0.2)' : 'transparent';
        btn.style.border = on ? '1px solid var(--accent)' : '1px solid transparent';
        btn.style.color = on ? 'white' : 'var(--text-secondary)';
    }
}

// Remember a view so the home page opens it (the Lobbies/Players/Spectate buttons and "All games" on a match page)
function rememberView(view) {
    if (!Object.keys(VIEWS).includes(view)) return;
    state.currentView = view;
    saveState();
}

function showView(view) {
    state.currentView = view;
    markViewButton(view);
    for (const [name, v] of Object.entries(VIEWS)) {
        const on = name === view;
        document.getElementById(v.grid).style.display = on ? (state.layout === 'list' ? 'flex' : 'grid') : 'none';
        const filters = v.filters();
        if (filters) filters.style.display = on ? 'flex' : 'none';
    }
    viewTitleText.textContent = VIEWS[view].title;
    countLabel.textContent = VIEWS[view].count;
    closeCivPopover(false);
    renderFollowPanel();
    if (view === 'spectate') fetchSpectate();
    applyFiltersAndRender();
}

// ---------------------------------------------------------------- Spectate: games in progress
const SPECTATE_PAGE = 60;
let spectateGames = [];
let spectateLoaded = false;
let spectateTimer = null;
let spectateLimit = SPECTATE_PAGE;
let spectateUpdatedAt = 0; // unix seconds of the server's snapshot
let spectateStale = false; // the server says its snapshot is too old to show

// A whole number in [min, max] (display team 1-4, colour 1-8, counts), or null
function intIn(v, min, max) {
    return (Number.isSafeInteger(v) && v >= min && v <= max) ? v : null;
}

function finiteOrNull(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// One slot: a human (with a profile id) or an AI. Team null means "no team"; civ null means hidden or unknown
function normalizeSpectatePlayer(p, civsHidden) {
    const ai = p.kind === 'ai';
    const id = ai ? 0 : (intIn(p.id, 1, Number.MAX_SAFE_INTEGER) ?? 0);
    let name = typeof p.name === 'string' ? p.name : String(p.name ?? '');
    if (!name) name = ai ? 'AI' : (id ? `Player ${id}` : 'Player');
    return {
        ...p,
        kind: ai ? 'ai' : 'human',
        id,
        name,
        team: intIn(p.team, 1, 4),
        color: intIn(p.color, 1, 8),
        // A lobby that hides civs must not reveal them here either, whatever the data says
        civ: (!civsHidden && typeof p.civ === 'string' && p.civ) ? p.civ : null,
        civRor: p.civRor === true,
        country: (!ai && typeof p.country === 'string' && /^[a-z]{2}$/i.test(p.country)) ? p.country.toLowerCase() : null,
        rating: ai ? null : finiteOrNull(p.rating),
        ratings: (!ai && p.ratings && typeof p.ratings === 'object') ? p.ratings : {}
    };
}

// Plain text and numbers for what is searched, sorted and shown; a game that can't be read is skipped
function normalizeSpectateGame(g) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.players)) return null;
    const text = (v, fallback) => (typeof v === 'string' && v) ? v : fallback;
    const civsHidden = g.civsHidden === true;
    return {
        ...g,
        map: text(g.map, 'Unknown Map'),
        title: text(g.title, 'Age of Empires II Game'),
        isRanked: g.isRanked === true,
        isQuickPlay: g.isQuickPlay === true,
        matchType: text(g.matchType, null),
        mapSize: text(g.mapSize, null),
        speed: text(g.speed, null),
        population: intIn(g.population, 1, 10000),
        server: text(g.server, null),
        modInfo: text(g.modInfo, 'No Mods'),
        ladder: text(g.ladder, null),
        startTime: intIn(g.startTime, 0, Number.MAX_SAFE_INTEGER) ?? 0,
        observerDelay: intIn(g.observerDelay, 0, 600) ?? 0,
        observers: intIn(g.observers, 0, Number.MAX_SAFE_INTEGER) ?? 0,
        civsHidden,
        record: typeof g.record === 'boolean' ? g.record : null,
        endedAt: intIn(g.endedAt, 1, Number.MAX_SAFE_INTEGER),
        players: g.players.filter(p => p && typeof p === 'object').map(p => normalizeSpectatePlayer(p, civsHidden))
    };
}

async function fetchSpectate() {
    clearTimeout(spectateTimer);
    if (state.currentView !== 'spectate') return;
    try {
        const data = await fetch('/api/spectate?t=' + Date.now()).then(r => r.json());
        spectateGames = (data && Array.isArray(data.games) ? data.games : []).flatMap(g => {
            try { const game = normalizeSpectateGame(g); return game ? [game] : []; }
            catch (e) { console.warn('Skipping a game that could not be shown:', e); return []; }
        });
        spectateUpdatedAt = (data && Number(data.updatedAt)) || 0;
        spectateStale = !!(data && data.stale === true);
        spectateLoaded = true;
        const serverSelect = document.getElementById('spectateServer');
        const servers = [...new Set(spectateGames.map(g => g.server).filter(Boolean))].sort();
        if (state.spectateServer !== 'all' && !servers.includes(state.spectateServer)) servers.push(state.spectateServer);
        serverSelect.innerHTML = '<option value="all">All Servers</option>' + servers.map(sv => `<option value="${esc(sv)}">${esc(sv)}</option>`).join('');
        serverSelect.value = state.spectateServer;
        if (state.currentView === 'spectate') applyFiltersAndRender();
    } catch (e) {
        console.warn('Failed to fetch games in progress:', e);
        // Keep the last games on screen; rendering again lets the "unavailable since" notice appear once they're old
        if (spectateLoaded && state.currentView === 'spectate') applyFiltersAndRender();
    }
    // The server refreshes its copy at most once a minute; polling only while this view is open
    if (state.currentView === 'spectate') spectateTimer = setTimeout(fetchSpectate, 30000);
}

function spectateRating(p) {
    return finiteOrNull(state.eloType === 'auto' ? p.rating : (p.ratings ? p.ratings[state.eloType] : null));
}

// Average of the humans' ratings (AI players have none)
function ratingAverage(players, ratingOf) {
    const r = players.filter(p => p.kind === 'human').map(ratingOf).filter(v => v !== null);
    return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
}

function spectateAverage(players) {
    return ratingAverage(players, spectateRating);
}

// Teams in order (display team 1-4); each player without a team gets a group of their own (free-for-all, custom games)
function groupTeams(players) {
    const teams = new Map();
    const solo = [];
    for (const p of players) {
        if (p.team === null) { solo.push({ team: null, players: [p] }); continue; }
        if (!teams.has(p.team)) teams.set(p.team, []);
        teams.get(p.team).push(p);
    }
    return [...teams.entries()].sort((a, b) => a[0] - b[0]).map(([team, list]) => ({ team, players: list })).concat(solo);
}

// Player colour 1-8 (styled in styles.css); a player without one keeps the row aligned with an empty swatch
function colorSwatchHtml(color) {
    return color !== null
        ? `<span class="player-color player-color-${color}" role="img" aria-label="Player colour ${color}" title="Player colour ${color}"></span>`
        : '<span class="player-color player-color-none" aria-hidden="true"></span>';
}

function filterSpectate() {
    const q = state.spectateSearch;
    const games = spectateGames.filter(g => {
        if (q && !(`${g.map} ${g.title} ${g.players.map(p => p.name).join(' ')}`).toLowerCase().includes(q)) return false;
        if (state.spectateType === '1v1' && g.players.length !== 2) return false;
        if (state.spectateType === 'team' && g.players.length <= 2) return false;
        if (state.spectateKind === 'ranked' && !g.isRanked) return false;
        if (state.spectateKind === 'quickplay' && !g.isQuickPlay) return false;
        if (state.spectateKind === 'custom' && (g.isRanked || g.isQuickPlay)) return false;
        if (state.spectateKind === 'following' && !g.players.some(p => p.kind === 'human' && follows.has(p.id))) return false;
        if (state.spectateServer !== 'all' && g.server !== state.spectateServer) return false;
        return true;
    });
    if (state.spectateSort === 'rating') games.sort((a, b) => (spectateAverage(b.players) ?? -1) - (spectateAverage(a.players) ?? -1));
    else if (state.spectateSort === 'spectators') games.sort((a, b) => b.observers - a.observers || b.startTime - a.startTime);
    else games.sort((a, b) => b.startTime - a.startTime);
    return games;
}

function minutesAgo(startTime) {
    const mins = Math.max(0, Math.floor((Date.now() / 1000 - startTime) / 60));
    if (mins < 1) return 'Started just now';
    if (mins < 60) return `Started ${mins} min ago`;
    return `Started ${Math.floor(mins / 60)} h ${mins % 60} min ago`;
}

function countdownText(readyAt) {
    const left = Math.ceil(readyAt - Date.now() / 1000);
    if (left <= 0) return '';
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function spectateCardHtml(g) {
    const teamsHtml = groupTeams(g.players).map(({ team, players }) => {
        const avg = team !== null ? spectateAverage(players) : null;
        return `
            <div class="spectate-team">
                <div class="spectate-team-head">${team !== null ? `Team ${team}` : 'No team'}${avg != null ? ` <span class="player-elo">${avg}</span>` : ''}</div>
                ${players.map(p => {
                    const r = spectateRating(p);
                    return `
                    <div class="player-item">
                        <span class="player-name" style="display: flex; align-items: center; gap: 6px;">
                            ${colorSwatchHtml(p.color)}
                            ${esc(p.name)}
                            ${followButtonHtml(p)}
                            ${civChipHtml(p)}
                            ${p.kind === 'human' ? playerLinksHtml(p) : ''}
                        </span>
                        <span class="player-elo">${r != null ? esc(r) : '&mdash;'}</span>
                    </div>`;
                }).join('')}
            </div>`;
    }).join('');
    const avg = spectateAverage(g.players);
    const start = g.startTime, delay = g.observerDelay;
    const readyAt = start + delay * 60;
    const wait = countdownText(readyAt);
    const gid = isMatchId(g.id) ? String(g.id) : '';
    const ai = g.players.filter(p => p.kind === 'ai').length;
    const humans = g.players.length - ai;
    return `
        <div class="card-header">
            <div class="host-info">
                <div class="host-name">
                    <span class="host-label">${gid ? `<a class="match-link" href="/spectate/${gid}" title="Game details">${esc(g.map)}</a>` : esc(g.map)}</span>
                    ${avg != null ? `<span class="elo-badge">${avg}</span>` : ''}
                </div>
                <div class="game-title" title="${esc(g.title)}">${esc(g.title)}</div>
            </div>
            <div class="server-badge"><span title="Spectators">&#x1F441; ${esc(g.observers)}</span> ${esc(g.server || '')}</div>
        </div>
        <div class="card-body">
            <div class="game-details">
                <div class="tags-row">
                    ${g.isRanked ? '<span class="badge treaty-badge">Ranked</span>' : g.isQuickPlay ? '<span class="badge quickplay-badge">Quick Play</span>' : ''}
                    ${renderInfoBadges(g)}
                    ${g.civsHidden ? '<span class="badge civs-hidden-badge" title="This lobby hides civilizations">Civs hidden</span>' : ''}
                </div>
                <div class="detail-row spectate-started" data-start="${start}">${minutesAgo(start)}</div>
            </div>
        </div>
        <div class="spectate-teams">${teamsHtml}</div>
        <div class="card-footer">
            <div class="players-count"><span class="players-count-text">&#x1F464; ${humans} player${humans === 1 ? '' : 's'}${ai ? ` <span class="ai-count" title="Slots played by the AI">· ${ai} AI</span>` : ''}</span></div>
            <div class="spectate-actions">
                ${gid ? `<a href="/spectate/${gid}" class="btn-view" title="This game's own page, with a link you can share">Details</a>` : ''}
                ${gid ? `<a href="aoe2de://1/${gid}" class="btn-join spectate-btn${wait ? ' waiting' : ''}" title="Opens Age of Empires II: DE as a spectator">
                    &#x1F441; Spectate<span class="spectate-countdown" data-ready-at="${readyAt}">${wait ? ' &#x23F3; ' + wait : ''}</span>
                </a>` : `<span class="btn-join spectate-btn disabled">Cannot Spectate</span>`}
            </div>
        </div>`;
}

// HH:MM in the visitor's time zone, from unix seconds
function clockTime(seconds) {
    const d = new Date(seconds * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// "Live game data unavailable since HH:MM" when the server's snapshot is over 3 minutes old or marked stale
function unavailableText(at, stale) {
    if (!stale && !(at > 0 && Date.now() / 1000 - at > 180)) return '';
    if (!(at > 0)) return 'Live game data unavailable right now';
    return `Live game data unavailable since ${clockTime(at)}`;
}

function spectateUnavailableText() {
    return unavailableText(spectateUpdatedAt, spectateStale);
}

function renderSpectate(games) {
    if (!spectateLoaded) {
        spectateGrid.innerHTML = `<div class="loader-container"><div class="spinner"></div><p>Fetching games in progress...</p></div>`;
        return;
    }
    const unavailable = spectateUnavailableText();
    const notice = unavailable ? `<div class="spectate-notice" role="status">${esc(unavailable)}</div>` : '';
    if (!games.length) {
        spectateGrid.innerHTML = notice + (unavailable && !spectateGames.length
            ? `<div class="empty-state"><h3>No live game data</h3><p>Games in progress show up here again as soon as the live data is back.</p></div>`
            : `<div class="empty-state"><h3>No games match</h3><p>${spectateGames.length} games are in progress, but none match your spectate filters.</p></div>`);
        return;
    }
    const shown = games.slice(0, spectateLimit);
    spectateGrid.innerHTML = notice + shown.map(g => {
        // One game that can't be shown is skipped rather than blanking the list
        try { return `<div class="lobby-card spectate-card"${isMatchId(g.id) ? ` id="game-${g.id}"` : ''}>${spectateCardHtml(g)}</div>`; }
        catch (e) { console.warn('Skipping a game that could not be shown:', g && g.id, e); return ''; }
    }).join('') +
        (games.length > shown.length
            ? `<div class="spectate-more"><button type="button" class="clear-filters-btn" data-action="show-more-spectate">Show more (${games.length - shown.length} more)</button></div>`
            : '');
}

function showMoreSpectate() {
    spectateLimit += SPECTATE_PAGE;
    applyFiltersAndRender();
}

// Tick the spectate countdowns and "started" times once a second
setInterval(() => {
    if (matchPageId) { tickMatch(); return; }
    if (state.currentView !== 'spectate') return;
    for (const el of spectateGrid.querySelectorAll('.spectate-countdown[data-ready-at]')) {
        const wait = countdownText(Number(el.dataset.readyAt));
        el.innerHTML = wait ? ' &#x23F3; ' + wait : '';
        el.closest('.spectate-btn')?.classList.toggle('waiting', !!wait);
    }
    for (const el of spectateGrid.querySelectorAll('.spectate-started[data-start]')) {
        el.textContent = minutesAgo(Number(el.dataset.start));
    }
}, 1000);

// ---------------------------------------------------------------- Match page: /spectate/<matchId>
// One game in progress (or just ended), linked from every Spectate card. It asks /api/spectate/<id> every 30 s while
// the game is live and every 20 s while its result is pending, and stops once there is nothing more to wait for.
const matchPageId = (/^\/spectate\/(\d{1,15})\/?$/.exec(location.pathname) || [])[1] || null;
const matchView = document.getElementById('matchView');
const MATCH_POLL_LIVE_MS = 30000;
const MATCH_POLL_PENDING_MS = 20000;
const LADDER_NAMES = Object.assign(Object.create(null), { '0': 'Unranked', '3': 'RM 1v1', '4': 'RM Team', '13': 'EW 1v1', '14': 'EW Team' });
let matchData = null; // the last answer that could be read; a failed refresh keeps it on screen
let matchOkAt = 0; // when that answer arrived (ms)
let matchRefreshFailed = false;
let matchTimer = null;
let matchInFlight = false;
let matchLastFetchAt = 0;
let matchCopyTimer = null;
let countryNames = null;
const matchParts = Object.create(null); // each part's last HTML: a poll replaces only what changed, so focus stays put

function initMatchPage() {
    document.body.classList.add('match-mode');
    // One h1 per page: here the map name is the page's heading, not the site name
    const siteHeading = document.querySelector('.nav-logo h1');
    if (siteHeading) siteHeading.setAttribute('role', 'none');
    for (const el of [lobbyFilters, playerFilters, document.getElementById('spectateFilters'), lobbyGrid, playerGrid, spectateGrid,
        document.querySelector('.lobbies-title'), document.querySelector('.layout-toggles'), document.querySelector('.lobbies-stats'),
        document.getElementById('about')]) {
        if (el) el.style.display = 'none';
    }
    // The view buttons go back to the home page, which then opens the chosen view
    markViewButton('spectate');
    for (const [view, v] of Object.entries(VIEWS)) {
        document.getElementById(v.btn).addEventListener('click', () => {
            rememberView(view);
            location.href = '/';
        });
    }
    // The note and result areas are live regions: they stay in the page (empty when there is nothing to say)
    matchView.innerHTML = `
        <div class="match-header glass-panel">
            <div data-part="head"></div>
            <div data-part="timing" class="match-timing"></div>
            <div data-part="actions" class="match-actions"></div>
            <p class="match-copy-status sr-only" role="status"></p>
            <div class="match-copy-fallback" hidden>
                <label for="matchLinkInput">Link to this game</label>
                <input id="matchLinkInput" type="text" readonly>
                <p class="match-note">The link is selected: press Ctrl+C (&#x2318;C on a Mac) to copy it.</p>
            </div>
            <div data-part="note" class="match-notes" role="status"></div>
        </div>
        <div data-part="result" aria-live="polite"></div>
        <div data-part="teams" class="match-teams"></div>
        <div data-caster></div>`;
    matchView.hidden = false;
    renderMatch();
    fetchMatch();
    // Polling pauses while the tab is hidden; coming back refreshes straight away
    document.addEventListener('visibilitychange', () => {
        if (document.hidden || matchInFlight || !matchPollDelay()) return;
        if (Date.now() - matchLastFetchAt >= 5000) fetchMatch();
    });
}

// The detail API's answer, or null when it can't be read
function normalizeMatch(data) {
    if (!data || typeof data !== 'object' || !['live', 'ended', 'unknown'].includes(data.status)) return null;
    const d = { status: data.status, updatedAt: finiteOrNull(data.updatedAt) ?? 0, stale: data.stale === true, relay: data.relay === true, game: null, result: null };
    if (d.status === 'unknown') return d;
    d.game = normalizeSpectateGame(data.game);
    if (!d.game) return null;
    if (d.status === 'ended') d.result = normalizeMatchResult(data.result);
    return d;
}

// Only a found result carries data; anything unreadable counts as still pending
function normalizeMatchResult(r) {
    if (!r || typeof r !== 'object' || r.state !== 'found') return { state: (r && r.state === 'unavailable') ? 'unavailable' : 'pending' };
    const players = (Array.isArray(r.players) ? r.players : [])
        .filter(p => p && typeof p === 'object' && intIn(p.id, 1, Number.MAX_SAFE_INTEGER) !== null)
        .map(p => ({ id: p.id, won: p.won === true, oldRating: finiteOrNull(p.oldRating), newRating: finiteOrNull(p.newRating) }));
    const replay = (r.replay && typeof r.replay === 'object') ? r.replay : {};
    const replayBy = replay.available === true ? intIn(replay.profileId, 1, Number.MAX_SAFE_INTEGER) : null;
    const duration = finiteOrNull(r.duration);
    return {
        state: 'found',
        completedAt: intIn(r.completedAt, 1, Number.MAX_SAFE_INTEGER),
        duration: duration !== null && duration >= 0 ? duration : null,
        winningTeam: intIn(r.winningTeam, 1, 4),
        noWinner: r.noWinner === true,
        aiWon: r.aiWon === true,
        ratingKind: ['ranked', 'quickplay', 'unranked'].includes(r.ratingKind) ? r.ratingKind : null,
        players,
        replay: { available: replayBy !== null, profileId: replayBy }
    };
}

// The server has no usable live data (feed down, or its snapshot too old), so it can't tell whether the game is still
// on: shown as a wait, never as live or as not found
function matchWaiting(d) {
    return !!d && d.stale && (d.status === 'unknown' || d.status === 'live');
}

function matchPollDelay() {
    if (!matchData || matchData.status === 'live') return MATCH_POLL_LIVE_MS; // nothing read yet: keep trying
    if (matchData.status === 'ended' && matchData.result.state === 'pending') return MATCH_POLL_PENDING_MS;
    // "Unknown" from a server without usable live data (feed down, or the snapshot too old) only means it can't
    // tell yet, so keep asking until it can
    if (matchData.status === 'unknown' && matchData.stale) return MATCH_POLL_LIVE_MS;
    return null; // result found or unavailable, or a game the server doesn't know: nothing more to wait for
}

async function fetchMatch() {
    clearTimeout(matchTimer);
    matchTimer = null;
    if (matchInFlight) return;
    matchInFlight = true;
    try {
        const r = await fetch(`/api/spectate/${matchPageId}`, { cache: 'no-store' });
        // An id the server refuses is a game it doesn't know; any other failure is retried
        const data = (r.status === 400 || r.status === 404) ? normalizeMatch({ status: 'unknown' })
            : r.ok ? normalizeMatch(await r.json()) : null;
        if (!data) throw new Error(r.ok ? 'unreadable game data' : 'HTTP ' + r.status);
        // While the server can't tell, a game already on screen stays there as it was last seen live
        if (data.status === 'unknown' && data.stale && matchData && matchData.game && matchData.status !== 'ended') {
            data.game = matchData.game;
            data.lastLiveAt = matchData.status === 'live' ? matchData.updatedAt : matchData.lastLiveAt;
        }
        matchData = data;
        matchOkAt = Date.now();
        matchRefreshFailed = false;
    } catch (e) {
        console.warn("Couldn't refresh the game:", e);
        matchRefreshFailed = true;
    }
    matchInFlight = false;
    matchLastFetchAt = Date.now();
    try { renderMatch(); } catch (e) { console.warn('Could not show the game:', e); }
    const delay = matchPollDelay();
    // While the tab is hidden the timer does nothing; becoming visible refreshes (see initMatchPage)
    if (delay) matchTimer = setTimeout(() => { if (!document.hidden) fetchMatch(); }, delay);
}

function renderMatch() {
    const d = matchData;
    const parts = {
        head: matchHeadHtml(d),
        timing: d && d.game ? matchTimingHtml(d) : '',
        actions: matchActionsHtml(d),
        note: matchNoteHtml(d),
        result: matchResultHtml(d),
        teams: d && d.game ? matchTeamsHtml(d.game) : ''
    };
    for (const [name, html] of Object.entries(parts)) {
        if (matchParts[name] === html) continue;
        const el = matchView.querySelector(`[data-part="${name}"]`);
        if (!el) continue;
        // A rebuilt part gives focus back to the same control (or the part's first one, when it is gone, as the Watch
        // link is once the game ends), so keyboard and screen-reader users keep their place. A player's follow star or
        // civ chip is found again by its player id or civ.
        const focused = el.contains?.(document.activeElement) ? document.activeElement : null;
        el.innerHTML = html;
        if (focused) {
            const action = focused.getAttribute('data-action');
            const same = focused.dataset.id ? `[data-action="${action}"][data-id="${focused.dataset.id}"]`
                : focused.dataset.civ !== undefined ? civChipSelector(focused) : null;
            const next = (same && el.querySelector(same)) || (action && el.querySelector(`[data-action="${action}"]`))
                || el.querySelector('a[href], button');
            if (next) next.focus();
        }
        if (name !== 'note' && name !== 'result') el.hidden = !html; // live regions stay, so later changes are announced
        matchParts[name] = html;
    }
    reanchorCivPopover();
    if (d && d.game) buildCasterTools(d.game);
    if (caster) casterChanged();
    if (d) document.title = d.game
        ? `${matchWaiting(d) ? '' : d.status === 'live' ? 'Live: ' : 'Ended: '}${d.game.map} – ${d.game.title} | AoE2Lobby.online`
        : matchWaiting(d) ? `Game ${matchPageId} | AoE2Lobby.online` : 'Game not found | AoE2Lobby.online';
    tickMatch();
}

function matchHeadHtml(d) {
    if (!d || !d.game) {
        // The server can't tell yet, not found, or nothing read yet (still loading, or the first request failed)
        if (matchWaiting(d)) return `
            <div class="match-topline"><span class="match-status match-status-unknown">No live data</span></div>
            <h1 class="match-title">Game ${esc(matchPageId)}</h1>
            <p class="match-subtitle">This game can't be checked until the live game data is back. Trying again shortly&hellip;</p>`;
        if (d) return `
            <div class="match-topline"><span class="match-status match-status-unknown">Not found</span></div>
            <h1 class="match-title">Game not found</h1>
            <p class="match-subtitle">Match ${esc(matchPageId)}</p>`;
        return `
            <h1 class="match-title">Game ${esc(matchPageId)}</h1>
            ${matchRefreshFailed
                ? '<p class="match-subtitle">Couldn\'t load this game right now. Trying again shortly&hellip;</p>'
                : '<p class="match-subtitle match-loading"><span class="spinner-inline" aria-hidden="true"></span>Loading the game&hellip;</p>'}`;
    }
    const g = d.game, waiting = matchWaiting(d), live = d.status === 'live' && !waiting;
    const ladder = (g.ladder && LADDER_NAMES[g.ladder]) || null; // named on the page: the Spectate cards follow Elo Type instead
    return `
        <div class="match-topline">
            ${live ? '<span class="match-status match-status-live"><span class="pulse-indicator" aria-hidden="true"></span>LIVE</span>'
                : waiting ? '<span class="match-status match-status-unknown" title="Live game data is unavailable, so the game may have ended">No live data</span>'
                : '<span class="match-status match-status-ended">ENDED</span>'}
            ${g.isRanked ? '<span class="badge treaty-badge">Ranked</span>' : g.isQuickPlay ? '<span class="badge quickplay-badge">Quick Play</span>' : '<span class="badge mod-info-badge">Unranked</span>'}
            ${live ? `<span class="match-spectators" title="Spectators watching now">&#x1F441; ${g.observers} spectator${g.observers === 1 ? '' : 's'}</span>` : ''}
        </div>
        <h1 class="match-title">${esc(g.map)}</h1>
        <p class="match-subtitle">${esc(g.title)}</p>
        <div class="tags-row">
            ${ladder ? `<span class="badge ladder-badge" title="The ladder of the player ratings on this page">Ratings: ${esc(ladder)}</span>` : ''}
            ${renderInfoBadges(g)}
            ${g.server ? `<span class="badge server-badge" title="Server">&#x1F310; ${esc(g.server)}</span>` : ''}
            ${g.civsHidden ? '<span class="badge civs-hidden-badge" title="This lobby hides civilizations">Civs hidden</span>' : ''}
        </div>`;
}

function matchTimingHtml(d) {
    const g = d.game, items = [];
    // A running game's start ticks ("Started 12 min ago"); once it has ended, or may have, it is a clock time
    if (g.startTime > 0) items.push(d.status === 'live' && !matchWaiting(d)
        ? `<span class="match-started" data-start="${g.startTime}">${minutesAgo(g.startTime)}</span>`
        : `<span>Started at ${clockTime(g.startTime)}</span>`);
    if (matchWaiting(d)) {
        // No delay or countdown: the game may have ended since
        const seen = d.status === 'live' ? d.updatedAt : d.lastLiveAt;
        if (seen > 0) items.push(`<span>Last seen live at ${clockTime(seen)}</span>`);
    } else if (d.status === 'live') {
        items.push(g.observerDelay > 0
            ? `<span>Spectators watch about ${g.observerDelay} min behind the live game</span>`
            : '<span>No spectator delay</span>');
        if (g.observerDelay > 0 && g.startTime > 0) {
            // Until the delay has passed since the start, the delayed stream has nothing to show yet
            const readyAt = g.startTime + g.observerDelay * 60;
            const wait = countdownText(readyAt);
            items.push(`<span class="match-countdown" data-ready-at="${readyAt}"${wait ? '' : ' hidden'}>${wait ? `Delayed stream starts in ${wait}` : ''}</span>`);
        }
    } else if (d.result.state === 'found' && d.result.completedAt) {
        items.push(`<span>Ended at ${clockTime(d.result.completedAt)}</span>`);
    } else if (g.endedAt) {
        items.push(`<span>Left the live list at ${clockTime(g.endedAt)}</span>`);
    }
    return items.join('');
}

function matchActionsHtml(d) {
    if (d && !d.game && !matchWaiting(d)) return ''; // not found: its message links to the list instead
    // aoe2de:// needs the visitor's click: it is never opened on its own (and only offered while the game is known to be on)
    const watch = d && d.game && d.status === 'live' && !matchWaiting(d) && isMatchId(d.game.id)
        ? `<a class="btn-join match-watch" href="aoe2de://1/${d.game.id}" title="Opens Age of Empires II: DE as a spectator">&#x1F441; Watch in game</a>`
        : '';
    // Someone is sharing this game from their own spectating client: followed here, with no game needed. It can
    // still be running there after the real game has ended.
    const followHere = d && d.game && d.relay && isMatchId(d.game.id)
        ? `<a class="btn-join" href="/replay?live=${d.game.id}">Watch live here</a>`
        : '';
    return `${followHere}${watch}
        <button type="button" class="btn-view match-copy" data-action="copy-match-link">Copy link</button>
        <a class="match-back" href="/" data-action="open-view" data-view="spectate">&larr; All games</a>`;
}

function matchNoteHtml(d) {
    let html = '';
    if (d && d.status !== 'ended') {
        const unavailable = unavailableText(d.updatedAt, d.stale);
        if (unavailable) html += `<p class="spectate-notice">${esc(unavailable)}</p>`;
    }
    if (d && matchRefreshFailed) html += `<p class="match-refresh-note">Couldn't refresh. Showing the game as of ${clockTime(matchOkAt / 1000)}.</p>`;
    return html;
}

function matchResultHtml(d) {
    if (d && !d.game && matchWaiting(d)) return ''; // the heading says it can't be checked yet
    if (d && !d.game) return `
        <section class="match-result glass-panel">
            <p>This game isn't in the live list. It may have ended a while ago, or the link is wrong.</p>
            <p><a class="btn-view" href="/" data-action="open-view" data-view="spectate">See games in progress</a></p>
        </section>`;
    if (!d || d.status !== 'ended') return '';
    const r = d.result;
    const body = r.state === 'pending'
        ? '<p class="match-result-pending"><span class="spinner-inline" aria-hidden="true"></span>Game over &mdash; getting the result&hellip;</p>'
        : r.state === 'unavailable' ? '<p>The result couldn\'t be found in the game\'s match history.</p>' : matchFoundHtml(d.game, r);
    return `<section class="match-result glass-panel"><h2>Result</h2>${body}</section>`;
}

function matchFoundHtml(g, r) {
    const humans = new Map(g.players.filter(p => p.kind === 'human').map(p => [p.id, p]));
    const names = (list) => `<span class="match-winner-names">${list.map(p => esc(p.name)).join(', ')}</span>`;
    // A team only when the winners form one; otherwise the winning players by name (AI players have no rows, so an AI
    // win is the AI's team, or just "the AI")
    let winner = 'No result reported';
    if (!r.noWinner && r.winningTeam !== null) {
        const team = g.players.filter(p => p.team === r.winningTeam);
        winner = team.length && team.every(p => p.kind === 'ai') ? `Team ${r.winningTeam} (AI) won`
            : `Team ${r.winningTeam} won${team.length ? `: ${names(team)}` : ''}`;
    } else if (r.aiWon) {
        winner = 'The AI won';
    } else if (!r.noWinner) {
        const won = r.players.filter(p => p.won && humans.has(p.id)).map(p => humans.get(p.id));
        if (won.length) winner = `${names(won)} won`;
    }
    const rows = groupTeams(g.players).flatMap(t => t.players).filter(p => p.kind === 'human').map(p => {
        const row = r.players.find(x => x.id === p.id);
        return row ? `
            <li class="match-result-player">
                ${colorSwatchHtml(p.color)}
                <span class="match-result-name">${esc(p.name)}</span>
                <span class="result-tag ${row.won ? 'result-won' : 'result-lost'}">${row.won ? 'Won' : 'Lost'}</span>
                ${ratingChangeHtml(row, r.ratingKind)}
            </li>` : '';
    }).join('');
    // The aoe.ms link redirects to the official replay download. A lobby set not to record is only the host's setting:
    // other players' uploads still count
    const replay = (r.replay.available && isMatchId(g.id))
        ? `<p class="match-replay"><a class="btn-join" href="/replay?match=${g.id}">Watch this game</a>
                <a class="btn-view" href="https://aoe.ms/replay/?gameId=${g.id}&amp;profileId=${r.replay.profileId}" rel="noopener">Download replay</a>
                <span class="match-note">Plays the game back here: the map, buildings, where units were sent, resources, ages and chat. Download replay gives you the official ZIP (an .aoe2record file).</span></p>`
        : g.record === false ? '<p class="match-note">This lobby didn\'t record a replay.</p>'
            : '<p class="match-note">No replay was uploaded for this game.</p>';
    return `
        <p class="match-winner"><span aria-hidden="true">&#x1F3C6;</span> ${winner}</p>
        ${r.duration !== null ? `<p class="match-length">Game length: ${durationText(r.duration)}</p>` : ''}
        ${rows ? `<ul class="match-result-players">${rows}</ul>` : ''}
        ${replay}`;
}

// +17 / −15, labelled with the rating it changed (unranked lobbies and Quick Play each change a rating of their own)
function ratingChangeHtml(row, kind) {
    if (row.oldRating === null || row.newRating === null) return '';
    const diff = Math.round(row.newRating - row.oldRating);
    const label = kind === 'unranked' ? 'unranked rating' : kind === 'quickplay' ? 'Quick Play rating' : kind === 'ranked' ? 'ranked' : 'rating';
    return `<span class="rating-change${diff > 0 ? ' rating-up' : diff < 0 ? ' rating-down' : ''}" title="${esc(`${row.oldRating} → ${row.newRating}`)}">${diff > 0 ? '+' + diff : diff < 0 ? '&minus;' + -diff : '&plusmn;0'}</span>
        <span class="rating-kind">${label}</span>`;
}

function durationText(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 1) return 'under a minute';
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function matchTeamsHtml(g) {
    const ladder = (g.ladder && LADDER_NAMES[g.ladder]) || null;
    const ratingTitle = ladder ? `${ladder} rating` : g.isQuickPlay ? 'Quick Play ratings are not in the live data' : 'Rating';
    return groupTeams(g.players).map(({ team, players }) => {
        const avg = team !== null ? ratingAverage(players, p => p.rating) : null;
        return `
            <section class="match-team glass-panel">
                <h2 class="match-team-head">
                    <span>${team !== null ? `Team ${team}` : 'No team'}</span>
                    ${avg !== null ? `<span class="match-team-avg" title="Average rating of the team's players">avg <span class="player-elo">${avg}</span></span>` : ''}
                </h2>
                <ul class="match-players">${players.map(p => matchPlayerHtml(p, g, ratingTitle)).join('')}</ul>
            </section>`;
    }).join('');
}

function matchPlayerHtml(p, g, ratingTitle) {
    const human = p.kind === 'human';
    const civ = g.civsHidden ? '<span class="civ-chip civ-hidden" title="This lobby hides civilizations">Hidden</span>' : civChipHtml(p);
    return `
        <li class="match-player">
            ${colorSwatchHtml(p.color)}
            <span class="match-player-main">
                <span class="match-player-name">${esc(p.name)}${followButtonHtml(p)}</span>
                <span class="match-player-meta">${civ}${human && p.country ? countryBadgeHtml(p.country) : ''}${human ? playerLinksHtml(p) : ''}</span>
            </span>
            <span class="player-elo"${human ? ` title="${esc(ratingTitle)}"` : ''}>${p.rating !== null ? esc(p.rating) : '&mdash;'}</span>
        </li>`;
}

// Uppercase code with the full name as a tooltip (flag emoji don't render on Windows)
function countryBadgeHtml(code) {
    const upper = code.toUpperCase();
    let name = '';
    try {
        countryNames = countryNames || new Intl.DisplayNames(['en'], { type: 'region' });
        name = countryNames.of(upper) || '';
    } catch (e) {}
    return `<abbr class="country-badge" title="${esc(name || upper)}">${esc(upper)}</abbr>`;
}

function tickMatch() {
    if (!matchView) return;
    for (const el of matchView.querySelectorAll('.match-started[data-start]')) el.textContent = minutesAgo(Number(el.dataset.start));
    for (const el of matchView.querySelectorAll('.match-countdown[data-ready-at]')) {
        const wait = countdownText(Number(el.dataset.readyAt));
        el.textContent = wait ? `Delayed stream starts in ${wait}` : '';
        el.hidden = !wait;
    }
}

// Copy this page's link; without the Clipboard API (or when it is refused) select it in a read-only box instead
function copyMatchLink(btn) {
    const url = location.href;
    const status = matchView.querySelector('.match-copy-status');
    const fallback = () => {
        const box = matchView.querySelector('.match-copy-fallback');
        const input = box && box.querySelector('input');
        if (!input) return;
        input.value = url;
        box.hidden = false;
        input.focus();
        input.select();
    };
    const copied = () => {
        btn.textContent = 'Copied';
        if (status) status.textContent = 'Link copied';
        clearTimeout(matchCopyTimer);
        matchCopyTimer = setTimeout(() => {
            btn.textContent = 'Copy link';
            if (status) status.textContent = '';
        }, 2000);
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(copied, fallback);
        else fallback();
    } catch (e) {
        fallback();
    }
}

// ---------------------------------------------------------------- Civ details on hover (civ-info.json)
// Built by tools/build-civ-info.js from SiegeEngineers/aoe2techtree (MIT). Loaded once; until it arrives, and for civs
// it doesn't cover (the Chronicles civs, Return of Rome's), a civ is a plain chip. A civ chip with details is a button:
// hovering shows them, and a click or tap (or Enter) keeps them open until Escape or a click elsewhere.
let civInfo = null;
let civPopover = null;
let civPopoverFor = null; // the chip the popover was opened from
let civPopoverCard = null; // id of the card (or match view) holding that chip, to find it again after a redraw
let civPopoverPinned = false;
let civHoverTimer = null;
let civPressInside = false; // the current mouse press began inside the popover

function loadCivInfo() {
    // Not versioned: a rebuilt civ-info.json reaches visitors within a day (the server caches unversioned files a day)
    fetch('/civ-info.json').then(r => r.ok ? r.json() : null).then(data => {
        if (!data || !data.civs || typeof data.civs !== 'object') return;
        civInfo = data.civs;
        // Lobby cards pick the buttons up with the next poll; the others are drawn again now
        if (matchPageId) renderMatch();
        else if (state.currentView === 'spectate') applyFiltersAndRender();
    }).catch(e => console.warn('Civ details unavailable:', e));
}

function civDetails(name) {
    return (civInfo && typeof name === 'string' && Object.prototype.hasOwnProperty.call(civInfo, name)) ? civInfo[name] : null;
}

// p: a player with civ (and civRor for a Return of Rome civ that shares a DE civ's name). data-player tells apart two
// players on the same civ, so a redraw finds the chip that was open (or focused) again
function civChipHtml(p) {
    if (!p.civ) return '';
    if (p.civRor === true || !civDetails(p.civ)) return `<span class="civ-chip" title="Civilization">${esc(p.civ)}</span>`;
    const player = p.kind === 'ai' ? `ai-${p.color ?? ''}` : String(intIn(Number(p.id), 1, Number.MAX_SAFE_INTEGER) ?? '');
    return `<button type="button" class="civ-chip civ-chip-info" data-action="civ-info" data-civ="${esc(p.civ)}" data-player="${esc(player)}" aria-expanded="false" aria-controls="civPopover" title="${esc(p.civ)}: bonuses and unique units">${esc(p.civ)}</button>`;
}

function civChipSelector(chip) {
    return `.civ-chip-info[data-civ="${CSS.escape(chip.dataset.civ || '')}"][data-player="${CSS.escape(chip.dataset.player || '')}"]`;
}

const RESOURCE_ORDER = ['food', 'wood', 'gold', 'stone'];

function unitStatsHtml(s) {
    if (!s || typeof s !== 'object') return '';
    const n = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const cost = s.cost && typeof s.cost === 'object'
        ? RESOURCE_ORDER.filter(r => n(s.cost[r])).map(r => `${n(s.cost[r])} ${r}`).join(', ') : '';
    const parts = [
        cost,
        n(s.hp) !== null && `${n(s.hp)} HP`,
        n(s.attack) !== null && `${n(s.attack)} attack`,
        n(s.meleeArmor) !== null && n(s.pierceArmor) !== null && `${n(s.meleeArmor)}/${n(s.pierceArmor)} armour`,
        n(s.range) > 0 && `range ${n(s.range)}`,
        n(s.speed) !== null && `speed ${n(s.speed)}`
    ].filter(Boolean);
    return parts.length ? `<span class="civ-pop-stats">${esc(parts.join(' · '))}</span>` : '';
}

function civPopoverHtml(name, c) {
    const list = (items, fn) => Array.isArray(items) && items.length ? `<ul>${items.map(fn).join('')}</ul>` : '';
    const str = v => typeof v === 'string' ? v : '';
    return `
        <div class="civ-pop-head"><h3 class="civ-pop-name">${esc(name)}</h3><span class="civ-pop-type">${esc(str(c.type))}</span></div>
        ${list(c.bonuses, b => `<li>${esc(str(b))}</li>`)}
        ${Array.isArray(c.uniqueUnits) && c.uniqueUnits.length ? `<h4>Unique unit${c.uniqueUnits.length > 1 ? 's' : ''}</h4>
            ${list(c.uniqueUnits, u => `<li><strong>${esc(str(u.name))}</strong>${u.kind ? ` <span class="civ-pop-kind">${esc(str(u.kind))}</span>` : ''}
                ${unitStatsHtml(u.stats)}${u.statsOf ? `<span class="civ-pop-kind">Stats in ${esc(str(u.statsOf).replace(/^.*\(|\)$/g, '').toLowerCase())} mode</span>` : ''}</li>`)}` : ''}
        ${Array.isArray(c.uniqueTechs) && c.uniqueTechs.length ? `<h4>Unique techs</h4>
            ${list(c.uniqueTechs, t => `<li><strong>${esc(str(t.name))}</strong>${t.effect ? `: ${esc(str(t.effect))}` : ''}</li>`)}` : ''}
        ${c.teamBonus ? `<h4>Team bonus</h4><p>${esc(str(c.teamBonus))}</p>` : ''}
        <p class="civ-pop-source">Unit stats are base stats, before upgrades. Data: aoe2techtree</p>`;
}

// Opened by hover it is a preview; opened by a click, tap or Enter it is pinned and takes focus, so a keyboard can
// scroll a long one, and Escape (or Tab) goes back to the chip
function openCivPopover(chip, pinned) {
    clearTimeout(civHoverTimer);
    const name = chip.dataset.civ;
    const c = civDetails(name);
    if (!c) return;
    if (!civPopover) {
        civPopover = document.createElement('div');
        civPopover.id = 'civPopover';
        civPopover.className = 'civ-popover';
        civPopover.setAttribute('role', 'region');
        civPopover.tabIndex = -1;
        civPopover.addEventListener('mouseenter', () => clearTimeout(civHoverTimer));
        civPopover.addEventListener('mouseleave', () => { if (!civPopoverPinned) scheduleCivClose(); });
        // Pressing inside a hover preview (to select text, say) pins it, so it doesn't vanish on mouse-out; and a
        // press that began inside never counts as a click outside, even when the drag ends past its edge
        civPopover.addEventListener('pointerdown', () => { clearTimeout(civHoverTimer); civPopoverPinned = true; civPressInside = true; });
        // Tab leaves the popover from its chip: on to the control after it, or (Shift+Tab) back onto the chip
        civPopover.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            if (e.shiftKey) e.preventDefault();
            closeCivPopover(true);
        });
        document.body.appendChild(civPopover);
    }
    if (civPopoverFor && civPopoverFor !== chip) civPopoverFor.setAttribute('aria-expanded', 'false');
    // Another chip's details (or a reopened popover) start at the top; only the same open popover keeps its place
    const reopened = civPopover.hidden || civPopoverFor !== chip;
    civPopover.setAttribute('aria-label', `${name} details`);
    civPopover.innerHTML = civPopoverHtml(name, c);
    civPopover.hidden = false;
    if (reopened) civPopover.scrollTop = 0;
    civPopoverFor = chip;
    civPopoverCard = chip.closest('[id]')?.id || null;
    civPopoverPinned = pinned;
    chip.setAttribute('aria-expanded', 'true');
    positionCivPopover(chip);
    if (pinned) civPopover.focus({ preventScroll: true });
}

// Below the chip, or above it when there is more room there; always inside the viewport, in page coordinates so it
// stays with the chip while the page scrolls
function positionCivPopover(chip) {
    const r = chip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    // Measuring without the height cap resets the popover's own scroll: keep the reader's place across redraws
    const scrolled = civPopover.scrollTop;
    civPopover.style.maxHeight = '';
    const w = civPopover.offsetWidth, h = civPopover.offsetHeight;
    const below = vh - r.bottom - 8, above = r.top - 8;
    const room = Math.max(below, above);
    if (h > room) civPopover.style.maxHeight = `${Math.max(120, room - 6)}px`;
    const shown = Math.min(h, Math.max(120, room - 6));
    const top = (h <= below || below >= above) ? r.bottom + 6 : r.top - 6 - shown;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    civPopover.style.left = `${left + window.scrollX}px`;
    civPopover.style.top = `${top + window.scrollY}px`;
    civPopover.scrollTop = scrolled;
}

// A chip scrolled out of its scrolling box (a lobby card's player list) or not laid out at all can't anchor a popover
function chipShown(chip) {
    if (!chip.getClientRects().length) return false;
    const r = chip.getBoundingClientRect();
    for (let el = chip.parentElement; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
        const box = el.getBoundingClientRect();
        if (r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right) return false;
    }
    return true;
}

function closeCivPopover(returnFocus) {
    clearTimeout(civHoverTimer);
    if (!civPopover || civPopover.hidden) return;
    const hadFocus = civPopover.contains(document.activeElement);
    civPopover.hidden = true;
    civPopoverPinned = false;
    if (civPopoverFor) {
        civPopoverFor.setAttribute('aria-expanded', 'false');
        // A popover that had focus never leaves it on the hidden popover. The chip is next to it, so the page
        // doesn't need to scroll (a pointer may have scrolled the chip away meanwhile)
        if ((returnFocus || hadFocus) && civPopoverFor.isConnected) civPopoverFor.focus({ preventScroll: true });
    }
    civPopoverFor = null;
}

function scheduleCivClose() {
    clearTimeout(civHoverTimer);
    civHoverTimer = setTimeout(() => { if (!civPopoverPinned) closeCivPopover(false); }, 250);
}

// The lists and the match page draw their cards again on every refresh, and cards move as games come and go: an
// open popover follows its chip (found again by card, civ and player), and closes when the chip is gone or hidden
function reanchorCivPopover() {
    if (!civPopover || civPopover.hidden || !civPopoverFor) return;
    if (!civPopoverFor.isConnected) {
        const card = civPopoverCard && document.getElementById(civPopoverCard);
        const chip = card && card.querySelector(civChipSelector(civPopoverFor));
        if (!chip) { closeCivPopover(false); return; }
        civPopoverFor = chip;
        chip.setAttribute('aria-expanded', 'true');
    }
    if (!chipShown(civPopoverFor)) { closeCivPopover(false); return; }
    positionCivPopover(civPopoverFor);
}

function toggleCivPopover(chip) {
    if (civPopoverFor === chip && civPopover && !civPopover.hidden && civPopoverPinned) closeCivPopover(true);
    else openCivPopover(chip, true);
}

// Hover previews with a mouse. A tap fires mouseover too, and its click then pins the popover: the pending preview
// never opens over a pinned one
document.addEventListener('mouseover', (e) => {
    const chip = e.target.closest && e.target.closest('.civ-chip-info');
    if (!chip) return;
    clearTimeout(civHoverTimer);
    if (civPopoverPinned || (civPopoverFor === chip && civPopover && !civPopover.hidden)) return;
    civHoverTimer = setTimeout(() => { if (!civPopoverPinned && chip.isConnected) openCivPopover(chip, false); }, 150);
});
document.addEventListener('mouseout', (e) => {
    const chip = e.target.closest && e.target.closest('.civ-chip-info');
    if (chip && !chip.contains(e.relatedTarget) && !civPopoverPinned) scheduleCivClose();
});
// Escape closes it; focus goes back to the chip only from the popover, the chip itself, or nowhere (focus must never
// be pulled out of a field being typed in, pinned popover or not)
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !civPopover || civPopover.hidden) return;
    const at = document.activeElement;
    closeCivPopover(at === civPopoverFor || civPopover.contains(at) || ((!at || at === document.body) && civPopoverPinned));
});
// A click outside the popover and the civ chips closes it. A drag that began inside (selecting text) and ended
// outside fires its click on <body>: that one doesn't count.
document.addEventListener('pointerdown', (e) => {
    if (!civPopover || !civPopover.contains(e.target)) civPressInside = false;
}, true);
document.addEventListener('click', (e) => {
    if (!civPopover || civPopover.hidden) return;
    const pressedInside = civPressInside;
    civPressInside = false;
    if (pressedInside || civPopover.contains(e.target) || (e.target.closest && e.target.closest('.civ-chip-info'))) return;
    closeCivPopover(false);
});
window.addEventListener('resize', () => reanchorCivPopover());

// ---------------------------------------------------------------- Followed players (kept in this browser only)
// The star next to a player follows them. While the site is open in a tab, it checks the games in progress every
// minute (/api/spectate/index: ids only, matched here, so the follow list never leaves the browser) and shows an alert
// when a followed player is in a game this tab hasn't announced yet, plus a desktop notification if turned on.
// The feed itself is a snapshot taken at most once a minute, so an alert comes 1-2 minutes after the game starts.
const FOLLOW_KEY = 'aoe2Follows';
const FOLLOW_MAX = 100;
const ALERTED_KEY = 'aoe2Alerted'; // sessionStorage: games this tab has announced
const FOLLOW_POLL_MS = 60000;
let follows = new Map(); // profile id -> name when followed
let desktopAlerts = false;
let followGames = []; // [{ id, startTime, map, players: [profile ids] }] from the last index
let followIndexLoaded = false;
let followTimer = null;
let followInFlight = false;
let followCheckedAt = 0; // ms, the last index fetched
// Players just followed (here or in another tab) -> until when (ms) the next check treats the games they're in as
// announced, since the alert is for their next game (the index we hold may be older than the list the star was
// pressed on). It expires, so a tab that checks much later (hidden, or the feed down) still announces a new game.
const followQuiet = new Map();
const FOLLOW_QUIET_MS = 3 * 60 * 1000;
let notificationsUnsupported = false; // the browser has Notification but can't show one from a page (Chrome on Android)

function loadFollows() {
    follows = new Map();
    desktopAlerts = false;
    try {
        const v = JSON.parse(localStorage.getItem(FOLLOW_KEY));
        if (v && typeof v === 'object' && Array.isArray(v.players)) {
            for (const f of v.players.slice(0, FOLLOW_MAX)) {
                const id = f && intIn(f.id, 1, Number.MAX_SAFE_INTEGER);
                if (id !== null) follows.set(id, typeof f.name === 'string' && f.name ? f.name.slice(0, 64) : `Player ${id}`);
            }
            desktopAlerts = v.desktop === true;
        }
    } catch (e) {}
}

function saveFollows() {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify({ players: [...follows].map(([id, name]) => ({ id, name })), desktop: desktopAlerts })); } catch (e) {}
}

function followButtonHtml(p) {
    if (p.kind !== 'human' || !(p.id > 0)) return '';
    const on = follows.has(p.id);
    return `<button type="button" class="follow-btn${on ? ' following' : ''}" data-action="toggle-follow" data-id="${p.id}" data-name="${esc(p.name)}" aria-pressed="${on}" title="${on ? 'Following: you get an alert when they start a game. Click to unfollow' : 'Follow: get an alert when they start a game'}"><span aria-hidden="true">${on ? '&#x2605;' : '&#x2606;'}</span><span class="sr-only">Follow ${esc(p.name)}</span></button>`;
}

function toggleFollow(btn) {
    const id = intIn(Number(btn.dataset.id), 1, Number.MAX_SAFE_INTEGER);
    if (id === null) return;
    if (follows.has(id)) follows.delete(id);
    else if (follows.size >= FOLLOW_MAX) { showToast(`<p>You can follow up to ${FOLLOW_MAX} players. Unfollow someone first.</p>`); return; }
    else {
        follows.set(id, (btn.dataset.name || `Player ${id}`).slice(0, 64));
        quietenFollowed([id]);
    }
    saveFollows();
    followsChanged(btn);
}

// The games these newly followed players are in now aren't announced: those we know of at once (this match page's
// game, the held index, the Spectate list), and the rest at the next check, which followsChanged starts straight away.
// None of this counts as the tab's first check, so that one still sums up games already on.
function quietenFollowed(ids) {
    if (!ids.length) return;
    const until = Date.now() + FOLLOW_QUIET_MS;
    for (const id of ids) followQuiet.set(id, until);
    const known = followGames.filter(g => g.players.some(p => ids.includes(p))).map(g => g.id);
    if (matchPageId) known.push(Number(matchPageId));
    else known.push(...spectateGames.filter(g => g.players.some(p => p.kind === 'human' && ids.includes(p.id))).map(g => g.id));
    markAlerted(known);
}

// Draw the follow buttons and the panel again, keeping focus on the same button
function followsChanged(focusFrom) {
    const card = focusFrom && focusFrom.closest('[id]');
    const cardId = card && card.id;
    const selector = focusFrom ? `[data-action="${focusFrom.dataset.action}"][data-id="${focusFrom.dataset.id}"]` : null;
    if (matchPageId) renderMatch();
    else {
        renderFollowPanel();
        if (state.currentView === 'spectate') applyFiltersAndRender();
    }
    if (selector && !(focusFrom.isConnected && document.activeElement === focusFrom)) {
        const scope = (cardId && document.getElementById(cardId)) || document;
        const next = scope.querySelector(selector) || document.querySelector(selector);
        if (next) next.focus();
    }
    scheduleFollowPoll(follows.size ? 0 : null);
}

// The games this tab has announced, and when it last checked (only a check sets that). Kept in memory, so blocked
// storage can't make a game be announced again on every check; session storage carries both over a reload, and over
// a page of the same tab coming back from the back/forward cache (see the pageshow listener).
// A check after a long gap (hidden tab, another site, a reload hours later) counts as a first check again: the games
// it finds may have started long ago, so they are "in a game", summed up when there are several.
const FOLLOW_RECHECK_MS = 5 * 60 * 1000;
let alerted = null;

function readAlerted(into) {
    try {
        const v = JSON.parse(sessionStorage.getItem(ALERTED_KEY));
        if (v && typeof v === 'object' && Array.isArray(v.ids)) {
            if (Number.isFinite(v.checkedAt) && v.checkedAt > into.checkedAt) into.checkedAt = v.checkedAt;
            for (const id of v.ids) if (intIn(id, 1, Number.MAX_SAFE_INTEGER) !== null) into.set.add(id);
        }
    } catch (e) {}
}

function alertedState() {
    if (!alerted) {
        alerted = { set: new Set(), checkedAt: 0 };
        readAlerted(alerted);
    }
    return alerted;
}

function markAlerted(ids, checked = false) {
    const a = alertedState();
    for (const id of ids) a.set.add(id);
    if (checked) a.checkedAt = Date.now();
    // The newest 500 are plenty: a game only lasts an hour or so
    if (a.set.size > 500) a.set = new Set([...a.set].slice(-500));
    try { sessionStorage.setItem(ALERTED_KEY, JSON.stringify({ checkedAt: a.checkedAt, ids: [...a.set] })); } catch (e) {}
}

function scheduleFollowPoll(delay) {
    clearTimeout(followTimer);
    followTimer = null;
    if (delay === null || !follows.size) return;
    followTimer = setTimeout(pollFollows, delay);
}

async function pollFollows() {
    if (followInFlight || !follows.size) return;
    // A hidden tab only checks when it can show a desktop notification
    if (document.hidden && !(desktopAlerts && notificationsGranted())) { scheduleFollowPoll(FOLLOW_POLL_MS); return; }
    followInFlight = true;
    followCheckedAt = Date.now();
    try {
        const data = await fetch('/api/spectate/index', { cache: 'no-store' }).then(r => r.json());
        // A stale index (the feed is down) has no games: keep the last ones and wait for live data
        if (data && data.stale !== true && Array.isArray(data.games)) {
            followGames = data.games.flatMap(g => {
                const id = g && intIn(g.id, 1, Number.MAX_SAFE_INTEGER);
                if (id === null || !Array.isArray(g.players)) return [];
                return [{ id, startTime: intIn(g.startTime, 0, Number.MAX_SAFE_INTEGER) ?? 0, map: typeof g.map === 'string' && g.map ? g.map : 'Unknown Map',
                    players: g.players.filter(p => intIn(p, 1, Number.MAX_SAFE_INTEGER) !== null) }];
            });
            followIndexLoaded = true;
            const now = Date.now();
            const quiet = new Set([...followQuiet].filter(([, until]) => until > now).map(([id]) => id));
            followQuiet.clear();
            if (quiet.size) markAlerted(followGames.filter(g => g.players.some(p => quiet.has(p))).map(g => g.id));
            announceFollowedGames();
            renderFollowPanel();
        }
    } catch (e) {
        console.warn('Followed players check failed:', e);
    }
    followInFlight = false;
    scheduleFollowPoll(FOLLOW_POLL_MS);
}

function followedIn(game) {
    return game.players.filter(id => follows.has(id));
}

const ALERT_MAX = 3; // alerts at once; more new games in one check get a summary line

// "See their games": Spectate with only followed players' games, whatever other spectate filters were saved. On a
// match page a link home that saves that choice first; on the home page a button that switches the view.
function seeFollowedGamesHtml() {
    if (matchPageId) return '<p class="toast-actions"><a href="/" data-action="open-followed-games">See their games</a></p>';
    return state.currentView !== 'spectate' || state.spectateKind !== 'following'
        ? '<p class="toast-actions"><button type="button" class="toast-link" data-action="show-followed-games">See their games</button></p>' : '';
}

function followedGamesFilters() {
    Object.assign(state, { spectateKind: 'following', spectateType: 'all', spectateServer: 'all', spectateSearch: '' });
}

function showFollowedGames() {
    followedGamesFilters();
    for (const [id, key] of [['spectateKind', 'spectateKind'], ['spectateType', 'spectateType'], ['spectateServer', 'spectateServer'], ['spectateSearch', 'spectateSearch']]) {
        const el = document.getElementById(id);
        if (el) el.value = state[key];
    }
    spectateLimit = SPECTATE_PAGE;
    showView('spectate');
}

// From a match page: the home page then opens Spectate with those filters
function openFollowedGames() {
    followedGamesFilters();
    rememberView('spectate');
}

function announceFollowedGames() {
    const a = alertedState();
    const { set } = a;
    const recent = a.checkedAt > 0 && Date.now() - a.checkedAt <= FOLLOW_RECHECK_MS;
    // The game this match page shows is never announced: its page is open
    if (matchPageId) markAlerted([Number(matchPageId)]);
    // Newest first, so a check that finds many new games announces the latest ones
    const fresh = followGames.filter(g => !set.has(g.id) && String(g.id) !== matchPageId && followedIn(g).length)
        .sort((a, b) => b.startTime - a.startTime);
    markAlerted(fresh.map(g => g.id), true); // also records when this tab checked
    if (!fresh.length) return;
    // A first check (or one after a long gap) finds games that were already on: one summary for several players
    // instead of an alert each (one player listed in two games, as the feed does after they leave a team game, gets
    // the alerts instead)
    const names = [...new Set(fresh.flatMap(followedIn))].map(id => follows.get(id));
    if (!recent && names.length > 1) {
        showToast(`<p><strong>${names.length} followed players</strong> are in games now: ${esc(names.slice(0, 5).join(', '))}${names.length > 5 ? '&hellip;' : ''}</p>
            ${seeFollowedGamesHtml()}`);
        return;
    }
    // The summary goes in first, so the newest game's alert ends up last (nearest the corner) and is the last to be
    // pushed out by later alerts
    const notify = desktopAlerts && notificationsGranted() && document.hidden;
    if (fresh.length > ALERT_MAX) {
        const more = fresh.length - ALERT_MAX;
        const text = `Followed players ${recent ? 'started' : 'are in'} ${more} more game${more === 1 ? '' : 's'}`;
        showToast(`<p>${esc(text)}.</p>${seeFollowedGamesHtml()}`);
        if (notify) showNotification(text, 'Open AoE2Lobby.online to see them', 'aoe2-games-more', () => { if (matchPageId) { openFollowedGames(); location.href = '/'; } else showFollowedGames(); });
    }
    for (const g of fresh.slice(0, ALERT_MAX).reverse()) {
        const players = followedIn(g).map(id => follows.get(id));
        const who = players.length > 2 ? `${players.slice(0, 2).join(', ')} and ${players.length - 2} more` : players.join(' and ');
        const verb = recent ? 'started a game' : (players.length > 1 ? 'are in a game' : 'is in a game');
        showToast(`<p><strong>${esc(who)}</strong> ${verb} on ${esc(g.map)}</p>
            <p class="toast-actions"><a href="/spectate/${g.id}">Open game</a><a href="aoe2de://1/${g.id}" title="Opens Age of Empires II: DE as a spectator">Watch in game</a></p>`);
        if (notify) showNotification(`${who} ${verb}`, `${g.map}: open the game on AoE2Lobby.online`, `aoe2-game-${g.id}`, () => { location.href = `/spectate/${g.id}`; });
    }
}

function notificationsGranted() {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted' && !notificationsUnsupported;
}

// null when the browser refuses to show a notification from a page (Chrome on Android needs a service worker).
// onOpen runs when it is clicked, in this tab, which comes to the front
function showNotification(title, body, tag, onOpen) {
    try {
        const n = new Notification(title, { body, tag, icon: '/icon-192.png' });
        if (onOpen) n.onclick = () => { window.focus(); n.close(); onOpen(); };
        return n;
    } catch (e) {
        notificationsUnsupported = true;
        return null;
    }
}

// Follows what the button shows (it may be out of date: permission changed in another tab, or in the browser's
// site settings): showing on, it turns them off; otherwise it asks for permission if needed and sends a test
async function toggleDesktopAlerts(btn) {
    if (typeof Notification === 'undefined') return;
    const shownOn = btn ? btn.getAttribute('aria-pressed') === 'true' : (desktopAlerts && notificationsGranted());
    if (shownOn) desktopAlerts = false;
    else {
        let permission = Notification.permission;
        try { if (permission === 'default') permission = await Notification.requestPermission(); } catch (e) {}
        // One notification right away shows that they work (and finds the browsers where they can't)
        const test = permission === 'granted' ? showNotification('Desktop notifications are on', 'You get one here when a followed player starts a game, while AoE2Lobby.online is open in a tab.', 'aoe2-notifications-on') : null;
        if (test) setTimeout(() => test.close(), 5000);
        desktopAlerts = !!test;
    }
    saveFollows();
    // The permission prompt doesn't block the page: focus comes back here only if it is still on this control (a
    // poll may have redrawn it meanwhile) or was lost, never from wherever the visitor moved on to
    const at = document.activeElement;
    const stay = at === btn || !at || at === document.body || (at.dataset && at.dataset.focusKey === 'desktop');
    renderFollowPanel();
    if (stay) followPanel?.querySelector('[data-focus-key="desktop"]')?.focus({ preventScroll: true });
}

// The button, or a note in its place (focusable, so focus that was on the button lands on it and it gets read)
function desktopAlertsHtml() {
    if (typeof Notification === 'undefined') return '';
    if (notificationsUnsupported) return '<p class="follow-note" data-focus-key="desktop" tabindex="-1">This browser can\'t show desktop notifications from a web page: alerts appear on the page.</p>';
    if (Notification.permission === 'denied') return '<p class="follow-note" data-focus-key="desktop" tabindex="-1">Desktop notifications are blocked for this site in your browser settings.</p>';
    const on = desktopAlerts && notificationsGranted();
    return `<button type="button" class="btn-view follow-desktop" data-action="desktop-alerts" data-focus-key="desktop" aria-pressed="${on}">Desktop notifications${on ? ': on' : ''}</button>`;
}

const followPanel = document.getElementById('followPanel');

// The Spectate view's panel: who is followed, and who of them is in a game now
function renderFollowPanel() {
    if (!followPanel || matchPageId) return;
    followPanel.hidden = state.currentView !== 'spectate';
    if (followPanel.hidden) return;
    let html;
    if (!follows.size) {
        html = `<p class="follow-note"><span aria-hidden="true">&#x2606;</span> Follow players with the star next to their name: while this site is open in a tab, you get an alert when they start a game.</p>`;
    } else {
        // Each followed player's newest game in the last index
        const gameOf = new Map();
        for (const g of followGames) for (const id of followedIn(g)) if (!gameOf.has(id) || g.startTime > gameOf.get(id).startTime) gameOf.set(id, g);
        const rows = [...follows].sort((a, b) => (gameOf.has(b[0]) - gameOf.has(a[0])) || a[1].localeCompare(b[1])).map(([id, name]) => {
            const g = gameOf.get(id);
            return `<li class="follow-item${g ? ' follow-live' : ''}" data-row="${id}">
                <span class="follow-name">${esc(name)}</span>
                ${g ? `<a class="follow-game" href="/spectate/${g.id}" data-focus-key="game-${id}" title="Open the game"><span class="pulse-indicator" aria-hidden="true"></span>${esc(g.map)}</a>`
                    : `<span class="follow-idle">${followIndexLoaded ? 'Not in a game' : '&hellip;'}</span>`}
                <button type="button" class="follow-remove" data-action="unfollow" data-id="${id}" data-focus-key="unfollow-${id}" aria-label="Unfollow ${esc(name)}" title="Unfollow">&times;</button>
            </li>`;
        }).join('');
        html = `
            <div class="follow-head">
                <h2 class="follow-title">Followed players <span class="follow-count">${gameOf.size ? `${gameOf.size} of ${follows.size} in a game` : follows.size}</span></h2>
                ${desktopAlertsHtml()}
            </div>
            <ul class="follow-list">${rows}</ul>`;
    }
    if (followPanel.dataset.html === html) return; // unchanged: leave focus and hover alone
    // Focus stays on the same control; when that is gone (its game ended, the player was unfollowed), on that row's
    // other control, the next row's, or the panel itself
    const focused = followPanel.contains(document.activeElement) ? document.activeElement : null;
    const key = focused && focused.dataset.focusKey;
    const row = focused && focused.closest('[data-row]');
    const near = row ? [row, row.nextElementSibling, row.previousElementSibling].filter(Boolean).map(r => r.dataset.row) : [];
    followPanel.innerHTML = html;
    followPanel.dataset.html = html;
    if (!focused) return;
    const target = (key && followPanel.querySelector(`[data-focus-key="${key}"]`))
        || near.map(r => followPanel.querySelector(`[data-row="${r}"] [data-focus-key]`)).find(Boolean)
        || followPanel.querySelector('[data-focus-key]');
    // Without scrolling: a poll can redraw the panel while the visitor reads the list far below it
    if (target) target.focus({ preventScroll: true });
    else { followPanel.tabIndex = -1; followPanel.focus({ preventScroll: true }); }
}

function unfollow(btn) {
    const id = intIn(Number(btn.dataset.id), 1, Number.MAX_SAFE_INTEGER);
    if (id === null) return;
    follows.delete(id);
    saveFollows();
    // The panel's redraw moves focus to the next row (or the one before, or the panel)
    followsChanged(null);
}

// Another tab changed the follows: pick them up here too. Players it just followed are quiet here as well, or this
// tab would announce the game they're in now.
window.addEventListener('storage', (e) => {
    if (e.key !== FOLLOW_KEY) return;
    const before = new Set(follows.keys());
    loadFollows();
    quietenFollowed([...follows.keys()].filter(id => !before.has(id)));
    followsChanged(null);
});

// A page back from the back/forward cache missed what other pages of this tab did meanwhile: the games they
// announced, follows changed, caster settings saved. Pick those up (keeping what this page knew), then check.
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    readAlerted(alertedState());
    const before = new Set(follows.keys());
    loadFollows();
    quietenFollowed([...follows.keys()].filter(id => !before.has(id)));
    const box = matchPageId && matchView.querySelector('[data-caster]');
    if (box) {
        // Built again from the saved settings by the redraw below
        caster = null;
        casterKeptChoice = null;
        delete box.dataset.built;
        box.innerHTML = '';
    }
    followsChanged(null);
});

document.addEventListener('visibilitychange', () => {
    // Back on the tab: check now if a check is overdue (a hidden tab skips them unless it can notify)
    if (!document.hidden && follows.size && !followInFlight && Date.now() - followCheckedAt >= FOLLOW_POLL_MS) scheduleFollowPoll(0);
});

// ---------------------------------------------------------------- Toasts (alerts)
let toastRegion = null;

function showToast(html) {
    if (!toastRegion) {
        toastRegion = document.createElement('div');
        toastRegion.className = 'toasts';
        toastRegion.setAttribute('role', 'status');
        toastRegion.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastRegion);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `${html}<button type="button" class="toast-close" data-action="dismiss-toast" aria-label="Dismiss alert">&times;</button>`;
    toastRegion.appendChild(t);
    // At most four at a time: the oldest goes
    while (toastRegion.children.length > 4) toastRegion.firstElementChild.remove();
}

function dismissToast(btn) {
    const t = btn.closest('.toast');
    const next = t && (t.nextElementSibling || t.previousElementSibling);
    if (t) t.remove();
    next?.querySelector('[data-action="dismiss-toast"]')?.focus();
}

// ---------------------------------------------------------------- Caster tools (match page)
// Builds the overlay link (overlay.html) for an OBS browser source. The settings stay in this browser
// (aoe2Caster), so after each game the caster only changes the score and copies the link again.
const CASTER_KEY = 'aoe2Caster';
const CASTER_BO = [1, 3, 5, 7, 9, 11, 13, 15];
let caster = null;
let casterKeptChoice = null; // the saved mode and player, while this page shows its own game instead
let casterCopyTimer = null;

function loadCaster() {
    const c = { bo: 3, score: [0, 0], names: ['', ''], title: '', swap: false, mode: 'match', followId: null };
    try {
        const v = JSON.parse(localStorage.getItem(CASTER_KEY));
        if (v && typeof v === 'object') {
            if (CASTER_BO.includes(v.bo)) c.bo = v.bo;
            if (Array.isArray(v.score)) c.score = [0, 1].map(i => intIn(v.score[i], 0, 8) ?? 0);
            if (Array.isArray(v.names)) c.names = [0, 1].map(i => typeof v.names[i] === 'string' ? v.names[i].slice(0, 40) : '');
            if (typeof v.title === 'string') c.title = v.title.slice(0, 60);
            c.swap = v.swap === true;
            c.mode = v.mode === 'player' ? 'player' : 'match';
            c.followId = intIn(v.followId, 1, Number.MAX_SAFE_INTEGER);
        }
    } catch (e) {}
    return c;
}

function saveCaster() {
    const saved = casterKeptChoice ? { ...caster, ...casterKeptChoice } : caster;
    try { localStorage.setItem(CASTER_KEY, JSON.stringify(saved)); } catch (e) {}
}

const casterNeed = () => Math.ceil(caster.bo / 2);

// The overlay's sides in its order (see overlay.js): a followed player's side on the left, then the swap
function casterSides(g) {
    let sides = groupTeams(g.players).map(t => t.players);
    if (caster.mode === 'player' && sides.length === 2 && sides[1].some(p => p.id === caster.followId)) sides = [sides[1], sides[0]];
    if (caster.swap && sides.length === 2) sides = [sides[1], sides[0]];
    return sides;
}

function casterAutoName(side) {
    if (!side) return '';
    if (side.length === 1) return side[0].name;
    return side[0].team !== null ? `Team ${side[0].team}` : side.map(p => p.name).join(' + ');
}

function casterUrl(preview) {
    const followed = caster.mode === 'player' && caster.followId;
    const q = new URLSearchParams();
    if (caster.bo > 1) { q.set('bo', caster.bo); q.set('s', `${caster.score[0]}-${caster.score[1]}`); }
    if (caster.names[0]) q.set('l', caster.names[0]);
    if (caster.names[1]) q.set('r', caster.names[1]);
    if (caster.title) q.set('t', caster.title);
    if (caster.swap) q.set('swap', '1');
    if (preview) q.set('preview', '1');
    const qs = q.toString();
    return `${location.origin}/overlay/${followed ? `player/${caster.followId}` : matchPageId}${qs ? '?' + qs : ''}`;
}

// Built once, the first time the game is known; after that only casterChanged() touches it, so typing isn't lost
function buildCasterTools(g) {
    const box = matchView.querySelector('[data-caster]');
    if (!box || box.dataset.built) return;
    box.dataset.built = '1';
    caster = caster || loadCaster();
    const humans = g.players.filter(p => p.kind === 'human' && p.id > 0);
    // A saved player who isn't in this game: this page offers its own players, showing this game. The saved choice
    // stays saved (other edits here keep it) until the caster picks what the overlay shows on this page.
    if (!humans.some(p => p.id === caster.followId)) {
        casterKeptChoice = { mode: caster.mode, followId: caster.followId };
        caster.followId = humans.length ? humans[0].id : null;
        caster.mode = 'match';
    }
    const side = i => i ? 'Right' : 'Left';
    box.innerHTML = `
        <details class="caster-tools glass-panel">
            <summary>Caster tools: scoreboard overlay for OBS</summary>
            <div class="caster-body">
                <fieldset class="caster-mode">
                    <legend>The overlay shows</legend>
                    <label class="caster-check"><input type="radio" name="casterMode" value="match"> This game</label>
                    ${humans.length ? `<span class="caster-check caster-follow">
                        <input type="radio" name="casterMode" value="player" id="casterModePlayer">
                        <label for="casterModePlayer">The game this player is in (it moves to their next game by itself):</label>
                        <select id="casterFollow" aria-label="Player the overlay follows">${humans.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
                    </span>` : ''}
                </fieldset>
                <div class="caster-row">
                    <label class="caster-field">Title <input id="casterTitle" type="text" maxlength="60" placeholder="Grand Final"></label>
                    <label class="caster-field">Best of <select id="casterBo">${CASTER_BO.map(n => `<option value="${n}">${n === 1 ? 'One game (no score)' : n}</option>`).join('')}</select></label>
                </div>
                <div class="caster-sides">
                    ${[0, 1].map(i => `
                    <div class="caster-side">
                        <label class="caster-field">${side(i)} side name <input id="casterName${i}" type="text" maxlength="40"></label>
                        <div class="caster-score" role="group" aria-labelledby="casterScoreLabel${i}">
                            <span id="casterScoreLabel${i}" class="caster-score-label">${side(i)} side wins</span>
                            <button type="button" class="caster-step" data-action="caster-score" data-side="${i}" data-step="-1" aria-label="${side(i)} side: one win fewer">&minus;</button>
                            <output id="casterScore${i}" class="caster-score-value">0</output>
                            <button type="button" class="caster-step" data-action="caster-score" data-side="${i}" data-step="1" aria-label="${side(i)} side: one win more">+</button>
                        </div>
                    </div>`).join('')}
                </div>
                <div class="caster-row">
                    <label class="caster-check"><input id="casterSwap" type="checkbox"> Swap sides</label>
                    <button type="button" class="btn-view" data-action="caster-reset">Reset score</button>
                </div>
                <p class="caster-multi match-note" hidden>This game has more than two sides: the overlay lists every player, without a score.</p>
                <label class="caster-url-label" for="casterUrl">Overlay link</label>
                <div class="caster-url">
                    <input id="casterUrl" type="text" readonly>
                    <button type="button" class="btn-join" data-action="caster-copy">Copy</button>
                    <a id="casterPreview" class="btn-view" target="_blank" rel="noopener">Preview</a>
                </div>
                <p class="caster-status sr-only" role="status"></p>
                <p class="match-note">In OBS, add a <strong>Browser</strong> source, paste the link as its URL and set it to 1920 &times; 1080: the page is transparent apart from the scoreboard at the top. The score never changes by itself: after a game, change it here, then copy the link again and paste it into the source's URL.</p>
            </div>
        </details>`;
    const $ = (id) => box.querySelector('#' + id);
    for (const r of box.querySelectorAll('input[name="casterMode"]')) {
        r.checked = r.value === caster.mode;
        r.addEventListener('change', () => { if (r.checked) { caster.mode = r.value; casterKeptChoice = null; casterEdited(); } });
    }
    const follow = $('casterFollow');
    if (follow) {
        follow.value = String(caster.followId);
        follow.addEventListener('change', () => {
            caster.followId = intIn(Number(follow.value), 1, Number.MAX_SAFE_INTEGER);
            caster.mode = 'player';
            casterKeptChoice = null;
            for (const r of box.querySelectorAll('input[name="casterMode"]')) r.checked = r.value === 'player';
            casterEdited();
        });
    }
    $('casterTitle').value = caster.title;
    $('casterTitle').addEventListener('input', (e) => { caster.title = e.target.value.slice(0, 60); casterEdited(); });
    $('casterBo').value = String(caster.bo);
    $('casterBo').addEventListener('change', (e) => { caster.bo = Number(e.target.value); casterEdited(); });
    for (const i of [0, 1]) {
        $('casterName' + i).value = caster.names[i];
        $('casterName' + i).addEventListener('input', (e) => { caster.names[i] = e.target.value.slice(0, 40); casterEdited(); });
    }
    $('casterSwap').checked = caster.swap;
    $('casterSwap').addEventListener('change', (e) => { caster.swap = e.target.checked; casterEdited(); });
    casterChanged();
}

// Everything in the panel that follows the settings
function casterChanged() {
    const box = matchView.querySelector('[data-caster]');
    if (!box || !box.dataset.built || !caster) return;
    const need = casterNeed();
    caster.score = caster.score.map(s => Math.min(s, need));
    const g = matchData && matchData.game;
    const sides = g ? casterSides(g) : [];
    for (const i of [0, 1]) {
        box.querySelector('#casterName' + i).placeholder = casterAutoName(sides[i]) || (i ? 'Right side' : 'Left side');
        box.querySelector('#casterScore' + i).textContent = caster.score[i];
        for (const b of box.querySelectorAll(`[data-action="caster-score"][data-side="${i}"]`)) {
            b.disabled = caster.bo === 1 || (b.dataset.step === '1' ? caster.score[i] >= need : caster.score[i] <= 0);
        }
    }
    box.querySelector('.caster-multi').hidden = !g || sides.length === 2;
    box.querySelector('#casterUrl').value = casterUrl(false);
    box.querySelector('#casterPreview').href = casterUrl(true);
}

// Only the caster's own edits are saved: opening a match page (or its polls) never changes the saved settings
function casterEdited() {
    casterChanged();
    saveCaster();
}

function casterScore(btn) {
    const i = btn.dataset.side === '1' ? 1 : 0;
    caster.score[i] = Math.max(0, Math.min(casterNeed(), caster.score[i] + (btn.dataset.step === '1' ? 1 : -1)));
    casterEdited();
    const status = matchView.querySelector('.caster-status');
    if (status) status.textContent = `Score ${caster.score[0]} to ${caster.score[1]}`;
    // A button that just became disabled loses focus: hand it to the other one of the pair
    if (btn.disabled) matchView.querySelector(`[data-action="caster-score"][data-side="${i}"][data-step="${btn.dataset.step === '1' ? -1 : 1}"]`)?.focus();
}

function casterReset() {
    caster.score = [0, 0];
    casterEdited();
    const status = matchView.querySelector('.caster-status');
    if (status) status.textContent = 'Score reset to 0 to 0';
}

function copyCasterUrl(btn) {
    const input = matchView.querySelector('#casterUrl');
    const status = matchView.querySelector('.caster-status');
    if (!input) return;
    const done = () => {
        btn.textContent = 'Copied';
        if (status) status.textContent = 'Overlay link copied';
        clearTimeout(casterCopyTimer);
        casterCopyTimer = setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    };
    const fallback = () => {
        input.focus();
        input.select();
        if (status) status.textContent = 'The link is selected: press Ctrl+C to copy it';
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
        else fallback();
    } catch (e) {
        fallback();
    }
}
