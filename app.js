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
const storedState = JSON.parse(localStorage.getItem('aoe2State')) || {};
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
// For a value placed inside a single-quoted JS string in an HTML attribute
function jsArg(value) {
    return esc(String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// Add a Steam friend: the steam:// link makes the Steam app send the request. Without the app, nothing takes
// focus, so after a moment open the player's Steam profile (its Add Friend button signs in first if needed).
window.addSteamFriend = function(e, steamId) {
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
};

const XBOX_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.202 15.967a8 8 0 0 1-3.552-1.26c-.898-.585-1.101-.826-1.101-1.306 0-.965 1.062-2.656 2.879-4.583C6.459 7.723 7.897 6.44 8.052 6.475c.302.068 2.718 2.423 3.622 3.531 1.43 1.753 2.088 3.189 1.754 3.829-.254.486-1.83 1.437-2.987 1.802-.954.301-2.207.429-3.239.33m-5.866-3.57C.589 11.253.212 10.127.03 8.497c-.06-.539-.038-.846.137-1.95.218-1.377 1.002-2.97 1.945-3.95.401-.417.437-.427.926-.263.595.2 1.23.638 2.213 1.528l.574.519-.313.385C4.056 6.553 2.52 9.086 1.94 10.653c-.315.852-.442 1.707-.306 2.063.091.24.007.15-.3-.319Zm13.101.195c.074-.36-.019-1.02-.238-1.687-.473-1.443-2.055-4.128-3.508-5.953l-.457-.575.494-.454c.646-.593 1.095-.948 1.58-1.25.381-.237.927-.448 1.161-.448.145 0 .654.528 1.065 1.104a8.4 8.4 0 0 1 1.343 3.102c.153.728.166 2.286.024 3.012a9.5 9.5 0 0 1-.6 1.893c-.179.393-.624 1.156-.82 1.404-.1.128-.1.127-.043-.148ZM7.335 1.952c-.67-.34-1.704-.705-2.276-.803a4 4 0 0 0-.759-.043c-.471.024-.45 0 .306-.358A7.8 7.8 0 0 1 6.47.128c.8-.169 2.306-.17 3.094-.005.85.18 1.853.552 2.418.9l.168.103-.385-.02c-.766-.038-1.88.27-3.078.853-.361.176-.676.316-.699.312a12 12 0 0 1-.654-.319Z"/></svg>';
const STEAM_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.009-8A8.006 8.006 0 0 0 0 7.468l.003.006 4.304 1.769A2.2 2.2 0 0 1 5.62 8.88l1.96-2.844-.001-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.044l-2.804 2a2.223 2.223 0 0 1-3.075 2.11 2.22 2.22 0 0 1-1.312-1.568L.33 10.333Z"/><path d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.7 1.7 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-.99-.41a1.7 1.7 0 0 0 .882.84Zm3.726-6.687a2.03 2.03 0 0 0 2.027 2.029 2.03 2.03 0 0 0 2.027-2.029 2.03 2.03 0 0 0-2.027-2.027 2.03 2.03 0 0 0-2.027 2.027m2.03-1.527a1.524 1.524 0 1 1-.002 3.048 1.524 1.524 0 0 1 .002-3.048"/></svg>';

// Profile links for a player: AoE2Insights, the official Age of Empires (Microsoft) stats page, and Steam when on Steam
function playerLinksHtml(p) {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id <= 0) return '';
    let html = `<a class="player-link" href="https://www.aoe2insights.com/user/relic/${id}" target="_blank" rel="noopener" title="AoE2Insights profile">AoE2Insights</a>`;
    html += `<a class="player-link" href="https://www.ageofempires.com/stats/?profileId=${id}&game=age2" target="_blank" rel="noopener" title="Official Age of Empires stats (Microsoft)">${XBOX_ICON}</a>`;
    if (typeof p.steamProfile === 'string' && /^https:\/\/steamcommunity\.com\/(profiles|id)\/[\w-]+\/?$/.test(p.steamProfile)) {
        html += `<a class="player-link" href="${p.steamProfile}" target="_blank" rel="noopener" title="Steam profile">${STEAM_ICON}</a>`;
        const steamId = /\/profiles\/(\d{17})\/?$/.exec(p.steamProfile);
        if (steamId) {
            html += `<a class="player-link" href="steam://friends/add/${steamId[1]}" onclick="return addSteamFriend(event, '${steamId[1]}')" title="Add friend on Steam">+ Friend</a>`;
        }
    }
    return `<span class="player-links">${html}</span>`;
}

function parseRelicLobby(match) {
    let title = match.title || "Age of Empires II Game";
    try { title = decodeURIComponent(escape(title)); } catch(e) {}
    
    let map = match.map || "Unknown Map";
    if (map.toLowerCase() === "my map" || map.toLowerCase() === "custom map" || map === "") {
        map = "Custom Scenario";
        const tLower = title.toLowerCase();
        if (tLower.includes('michi') || tLower.includes('mici')) map = 'Michi';
        else if (tLower.includes('cba')) map = 'CBA';
        else if (tLower.includes('diplo')) map = 'Diplomacy';
        else if (tLower.includes('rtd') || tLower.includes('roll')) map = 'Roll the Dice';
        else if (tLower.includes('dodge')) map = 'Dodgeball';
    }

    const known = (v) => (v !== undefined && v !== null && v !== '' && v !== 'Unknown') ? v : null;
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
    let modInfo = match.modInfo || "No Mods";
    let population = known(match.population);
    let speed = known(match.speed);
    let startingAge = match.startingAge && match.startingAge !== 'Unknown' ? match.startingAge : null;
    let resources = match.resources && match.resources !== 'Unknown' ? match.resources : null;
    let treaty = parseInt(match.treaty) || 0;

    let currentPlayers = match.players ? match.players.length : 1;
    let maxPlayers = match.maxPlayers || 8; // joinable slots; closed and AI slots aren't counted
    let aiSlots = match.aiSlots || 0;
    
    let playersHtml = '';
    if (match.players && match.players.length > 0) {
        // First mutate the players based on eloType
        match.players.forEach(p => {
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
        });

        match.players.sort((a,b) => a.team - b.team);
        playersHtml = match.players.map(p => {
            let statsHtml = `${p.displayGames} Games, ${p.displayWR ? (String(p.displayWR).endsWith('%') ? p.displayWR : p.displayWR + '%') : 'N/A'} WR`;
            
            // If we have literally 0 games and 0 winrate (meaning not yet fully scraped or new account)
            if (p.displayGames === 0 && (!p.displayWR || p.displayWR === '0%' || p.displayWR === '0.0%')) {
                statsHtml = `<div class="spinner-inline" title="Loading player stats..."></div>`;
            }

            return `
            <div class="player-item" style="display: flex; align-items: center; justify-content: space-between;">
                <span class="player-name" style="display: flex; align-items: center; gap: 6px;">
                    T${p.team} - ${esc(p.name)}
                    ${p.civ ? `<span class="civ-chip" title="Civilization">${esc(p.civ)}</span>` : ''}
                    <button onclick="copyPlayerHandle(event, this, '${jsArg(p.name)}')" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex; align-items: center;" title="Copy Handle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <span class="player-stats">${statsHtml}</span>
                    ${playerLinksHtml(p)}
                </span>
                <span class="player-elo">${p.displayElo != null ? p.displayElo : '&mdash;'}</span>
            </div>
            `;
        }).join('');
    } else {
        playersHtml = `<div class="player-item">No player data available.</div>`;
    }

    return {
        id: match.id,
        steamLobbyId: match.steamLobbyId,
        host: match.players && match.players.length > 0 ? match.players[0].name : `Unknown`,
        elo: match.players && match.players.length > 0 ? match.players[0].displayElo : null,
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
        server: match.server || null, 
        currentPlayers: currentPlayers,
        maxPlayers: maxPlayers,
        aiSlots: aiSlots,
        ping: Math.floor(Math.random() * 50) + 20,
        playersHtml: playersHtml,
        isPlaying: match.isPlaying,
        lastSeen: match.lastSeen,
        rawPlayers: match.players || []
    };
}

async function fetchRealLobbies() {
    try {
        const response = await fetch('/api/lobbies?t=' + Date.now());
        const data = await response.json();
        
        let hasUnknownMap = false;

        if (data && data.matches) {
            state.rawMatches = data.matches;
            lobbies = data.matches.map(parseRelicLobby);
            
            // Dynamically populate Mod Filter
            const modFilter = document.getElementById('modFilter');
            if (modFilter) {
                const currentModSelection = modFilter.value;
                const uniqueMods = [...new Set(lobbies.map(l => l.modInfo).filter(m => m && m !== 'No Mods'))].sort();
                
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
                
                if (uniqueMods.includes(currentModSelection) || ['all', 'No Mods', 'Mods Enabled'].includes(currentModSelection)) {
                    modFilter.value = currentModSelection;
                } else {
                    modFilter.value = 'all';
                    state.mod = 'all';
                }
            }

            if (serverFilter) {
                const servers = [...new Set(lobbies.map(l => l.server).filter(Boolean))].sort();
                if (state.server !== 'all' && !servers.includes(state.server)) servers.push(state.server);
                serverFilter.innerHTML = '<option value="all">All Servers</option>' +
                    servers.map(sv => `<option value="${sv}">${sv}</option>`).join('');
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
            lobbies = lobbies.map(l => {
                const rawMatch = state.rawMatches.find(rm => rm.id === l.id);
                return rawMatch ? parseRelicLobby(rawMatch) : l;
            });
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
            lobby.map.toLowerCase().includes(state.search);
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

function applyFiltersAndRender() {
    const { rawMatches, ...saved } = state; // the lobby list itself is not worth saving
    localStorage.setItem('aoe2State', JSON.stringify(saved));
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
    let emptyState = document.getElementById('emptyStatePlayers');
    
    if (isInitialLoad) {
        playerGrid.innerHTML = `
            <div class="loader-container">
                <div class="spinner"></div>
                <p>Loading Players...</p>
            </div>
        `;
        return;
    }

    if(players.length === 0) {
        if(!emptyState) {
            emptyState = document.createElement('div');
            emptyState.id = 'emptyStatePlayers';
            emptyState.className = 'empty-state';
            emptyState.innerHTML = `<h3>No Players Found</h3><p>There are no open lobbies with players currently.</p>`;
            playerGrid.appendChild(emptyState);
        }
        emptyState.style.display = 'block';
    } else {
        if(emptyState) emptyState.style.display = 'none';
    }

    playerGrid.innerHTML = ''; // Clear grid before re-rendering

    players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'lobby-card'; // Reuse the card styling for consistency
        div.style.animation = "fadeIn 0.5s ease-out";
        div.innerHTML = `
            <div class="card-header">
                <div class="host-info">
                    <div class="host-name" style="display: flex; align-items: center; gap: 8px;">
                        ${esc(p.name)}
                        <button onclick="copyPlayerHandle(event, this, '${jsArg(p.name)}')" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex;" title="Copy Handle">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        ${p.displayElo !== null ? `<span class="elo-badge">${p.displayElo}</span>` : '<span class="elo-badge" style="background: rgba(138, 155, 178, 0.2); color: var(--text-secondary); border-color: transparent;">Unranked</span>'}
                    </div>
                    <div class="game-title" style="font-size: 0.8em; color: var(--text-secondary);">In lobby: ${esc(p.lobbyTitle)}${p.civ ? ` · Civ: ${esc(p.civ)}` : ''}</div>
                    ${playerLinksHtml(p)}
                </div>
            </div>
            
            <div class="card-body">
                <div class="game-details">
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F3C6;</span>
                        Win Rate: ${p.displayWR ? (String(p.displayWR).endsWith('%') ? p.displayWR : p.displayWR + '%') : 'N/A'}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F4CA;</span>
                        Total Games: ${p.displayGames || '0'}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F5FA;</span>
                        Map: ${esc(p.lobbyMap)}
                    </div>
                    <div class="tags-row" style="margin-top: 10px;">
                        <span class="badge status-badge" style="background: ${p.isPlaying ? 'rgba(212, 175, 55, 0.2)' : 'rgba(46, 160, 67, 0.2)'}; color: ${p.isPlaying ? '#d4af37' : '#2ea043'}; border-color: ${p.isPlaying ? '#d4af37' : '#2ea043'}">${p.isPlaying ? '&#x1F512; Full lobby' : '&#x23F3; Waiting'}</span>
                        ${p.server ? `<span class="badge server-badge" title="Server">&#x1F310; ${p.server}</span>` : ''}
                        ${renderInfoBadges(p)}
                    </div>
                </div>
            </div>
            
            <div class="player-list">
                ${p.playersHtml}
            </div>
            
            ${p.isPlaying ? '' : `
            <div class="card-footer">
                <a href="aoe2de://0/${p.lobbyId}" class="btn-join" style="margin-left: auto;">Join Lobby</a>
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
    if (item.matchType) html += `<span class="badge match-type-badge">${item.matchType}</span>`;
    if (item.mapSize) html += `<span class="badge map-size-badge" title="Map Size">&#x1F5FA; ${item.mapSize}</span>`;
    if (item.population) html += `<span class="badge pop-badge" title="Population">&#x1F465; ${item.population}</span>`;
    if (item.speed) html += `<span class="badge speed-badge" title="Speed">&#x23E9; ${item.speed}</span>`;
    html += `<span class="badge mod-info-badge" title="Mod Info">&#x2699; ${esc(item.modInfo || 'No Mods')}</span>`;
    return html;
}

// Everything shown on a card except the live player list / count / status, which update in place
function lobbyDetailsKey(lobby) {
    return JSON.stringify([lobby.host, lobby.elo, lobby.title, lobby.map, lobby.type, lobby.matchType, lobby.mapSize,
        lobby.population, lobby.speed, lobby.modInfo, lobby.startingAge, lobby.resources, lobby.treaty, lobby.isPlaying, lobby.server]);
}

function renderSettingBadges(lobby) {
    let html = '';
    if (lobby.treaty > 0) {
        html += `<span class="badge treaty-badge" title="Treaty Length">&#x1F91D; Treaty ${lobby.treaty} min</span>`;
    }
    if (lobby.startingAge) {
        const custom = lobby.startingAge !== 'Standard' && lobby.startingAge !== 'Dark Age' ? ' custom-setting' : '';
        html += `<span class="badge age-badge${custom}" title="Starting Age">&#x1F3F0; ${lobby.startingAge === 'Standard' ? 'Standard Age' : lobby.startingAge}</span>`;
    }
    if (lobby.resources) {
        const custom = lobby.resources !== 'Standard' && lobby.resources !== 'Low' ? ' custom-setting' : '';
        html += `<span class="badge resources-badge${custom}" title="Starting Resources">&#x1FA99; ${lobby.resources === 'Standard' ? 'Standard Res' : lobby.resources + ' Res'}</span>`;
    }
    return html;
}

function playerCountText(lobby) {
    return `&#x1F464; ${lobby.currentPlayers}/${lobby.maxPlayers}` +
        (lobby.aiSlots ? ` <span class="ai-count" title="Slots filled by AI">· ${lobby.aiSlots} AI</span>` : '');
}

function lobbyCardHtml(lobby) {
    const fillPercentage = (lobby.currentPlayers / lobby.maxPlayers) * 100;
    const joinLink = (!lobby.isPlaying) 
        ? `aoe2de://0/${lobby.id}`
        : '#';
    const joinText = joinLink === '#' ? (lobby.isPlaying ? 'Lobby Full' : 'Cannot Join') : 'Join Game';
    const joinClass = joinLink === '#' ? 'btn-join disabled' : 'btn-join';
    
    const statusIndicator = lobby.isPlaying ? 
        '<span style="color: #d4af37">&#x1F512; Full</span> ' + (lobby.server || '') : 
        '<span style="color: #2ea043">&#x23F3; Waiting</span> ' + (lobby.server || '');

    return `
        <div class="card-header">
            <div class="host-info">
                <div class="host-name">
                    ${esc(lobby.host)}
                    ${lobby.elo ? `<span class="elo-badge">${lobby.elo}</span>` : ''}
                </div>
                <div class="game-title" title="${esc(lobby.title)}">${esc(lobby.title)}</div>
            </div>
            <div class="server-badge">
                ${statusIndicator}
            </div>
        </div>
        
        <div class="card-body">
            <div class="map-icon-wrapper" style="position: relative;">
                <div class="map-icon">${lobby.mapIcon}</div>
                ${lobby.map === 'Unknown Map' ? '<div class="map-spinner" title="Resolving map..."></div>' : ''}
            </div>
            <div class="game-details">
                <div class="detail-row">
                    <span class="detail-icon" style="opacity: 0.7;">⚔️</span> <span style="font-weight: 500;">${lobby.type}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-icon" style="opacity: 0.7;">🗺️</span> <span style="font-weight: 500;">${esc(lobby.map)}</span>
                </div>
                <div class="tags-row">
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
            <a href="${joinLink}" class="${joinClass}">${joinText}</a>
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
            ? `<h3>No lobbies match your filters</h3><p>${lobbies.length} lobbies are open, but none match: ${active.map(a => `<strong>${a}</strong>`).join(' · ')}</p><button class="btn clear-filters-btn" onclick="clearLobbyFilters()">Clear all filters</button>`
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
            
            if(countText && progress) {
                countText.innerHTML = playerCountText(lobby);
                progress.style.width = `${fillPercentage}%`;
            }
            if(pList && pList.innerHTML !== lobby.playersHtml) {
                pList.innerHTML = lobby.playersHtml;
            }
            if (sBadge) {
                sBadge.innerHTML = lobby.isPlaying ? 
                    '<span style="color: #d4af37">&#x1F512; Full</span> ' + (lobby.server || '') : 
                    '<span style="color: #2ea043">&#x23F3; Waiting</span> ' + (lobby.server || '');
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

window.copyPlayerHandle = function(e, btn, handle) {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(handle).then(() => {
        const originalIcon = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2ea043" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            btn.innerHTML = originalIcon;
        }, 1000);
    });
};

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

function showView(view) {
    state.currentView = view;
    for (const [name, v] of Object.entries(VIEWS)) {
        const on = name === view;
        const btn = document.getElementById(v.btn);
        btn.style.background = on ? 'rgba(88, 101, 242, 0.2)' : 'transparent';
        btn.style.border = on ? '1px solid var(--accent)' : '1px solid transparent';
        btn.style.color = on ? 'white' : 'var(--text-secondary)';
        document.getElementById(v.grid).style.display = on ? (state.layout === 'list' ? 'flex' : 'grid') : 'none';
        const filters = v.filters();
        if (filters) filters.style.display = on ? 'flex' : 'none';
    }
    viewTitleText.textContent = VIEWS[view].title;
    countLabel.textContent = VIEWS[view].count;
    if (view === 'spectate') fetchSpectate();
    applyFiltersAndRender();
}

// ---------------------------------------------------------------- Spectate: games in progress
const SPECTATE_PAGE = 60;
let spectateGames = [];
let spectateLoaded = false;
let spectateTimer = null;
let spectateLimit = SPECTATE_PAGE;

async function fetchSpectate() {
    clearTimeout(spectateTimer);
    if (state.currentView !== 'spectate') return;
    try {
        const data = await fetch('/api/spectate?t=' + Date.now()).then(r => r.json());
        spectateGames = data.games || [];
        spectateLoaded = true;
        const serverSelect = document.getElementById('spectateServer');
        const servers = [...new Set(spectateGames.map(g => g.server).filter(Boolean))].sort();
        if (state.spectateServer !== 'all' && !servers.includes(state.spectateServer)) servers.push(state.spectateServer);
        serverSelect.innerHTML = '<option value="all">All Servers</option>' + servers.map(sv => `<option value="${esc(sv)}">${esc(sv)}</option>`).join('');
        serverSelect.value = state.spectateServer;
        if (state.currentView === 'spectate') applyFiltersAndRender();
    } catch (e) {
        console.warn('Failed to fetch games in progress:', e);
    }
    // The server refreshes its copy at most once a minute; polling only while this view is open
    if (state.currentView === 'spectate') spectateTimer = setTimeout(fetchSpectate, 30000);
}

function spectateRating(p) {
    return state.eloType === 'auto' ? p.rating : (p.ratings ? p.ratings[state.eloType] ?? null : null);
}

function spectateAverage(players) {
    const r = players.map(spectateRating).filter(v => v != null);
    return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
}

function filterSpectate() {
    const q = state.spectateSearch;
    const games = spectateGames.filter(g => {
        if (q && !(`${g.map} ${g.title} ${g.players.map(p => p.name).join(' ')}`).toLowerCase().includes(q)) return false;
        if (state.spectateType === '1v1' && g.players.length !== 2) return false;
        if (state.spectateType === 'team' && g.players.length <= 2) return false;
        if (state.spectateKind === 'ranked' && !g.isRanked) return false;
        if (state.spectateKind === 'custom' && g.isRanked) return false;
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
    const teams = new Map();
    for (const p of g.players) {
        if (!teams.has(p.team)) teams.set(p.team, []);
        teams.get(p.team).push(p);
    }
    const teamsHtml = [...teams.entries()].sort((a, b) => a[0] - b[0]).map(([, players], i) => {
        const avg = spectateAverage(players);
        return `
            <div class="spectate-team">
                <div class="spectate-team-head">Team ${i + 1}${avg != null ? ` <span class="player-elo">${avg}</span>` : ''}</div>
                ${players.map(p => {
                    const r = spectateRating(p);
                    return `
                    <div class="player-item">
                        <span class="player-name" style="display: flex; align-items: center; gap: 6px;">
                            ${esc(p.name)}
                            ${p.civ ? `<span class="civ-chip" title="Civilization">${esc(p.civ)}</span>` : ''}
                            ${playerLinksHtml(p)}
                        </span>
                        <span class="player-elo">${r != null ? r : '&mdash;'}</span>
                    </div>`;
                }).join('')}
            </div>`;
    }).join('');
    const avg = spectateAverage(g.players);
    const readyAt = g.startTime + g.observerDelay * 60;
    const wait = countdownText(readyAt);
    return `
        <div class="card-header">
            <div class="host-info">
                <div class="host-name">
                    ${esc(g.map)}
                    ${avg != null ? `<span class="elo-badge">${avg}</span>` : ''}
                </div>
                <div class="game-title" title="${esc(g.title)}">${esc(g.title)}</div>
            </div>
            <div class="server-badge"><span title="Spectators">&#x1F441; ${g.observers}</span> ${esc(g.server || '')}</div>
        </div>
        <div class="card-body">
            <div class="game-details">
                <div class="tags-row">
                    ${g.isRanked ? '<span class="badge treaty-badge">Ranked</span>' : ''}
                    ${renderInfoBadges(g)}
                </div>
                <div class="detail-row spectate-started" data-start="${g.startTime}">${minutesAgo(g.startTime)}</div>
            </div>
        </div>
        <div class="spectate-teams">${teamsHtml}</div>
        <div class="card-footer">
            <div class="players-count"><span class="players-count-text">&#x1F464; ${g.players.length} players</span></div>
            <a href="aoe2de://1/${g.id}" class="btn-join spectate-btn${wait ? ' waiting' : ''}" title="Opens Age of Empires II: DE as a spectator">
                &#x1F441; Spectate<span class="spectate-countdown" data-ready-at="${readyAt}">${wait ? ' &#x23F3; ' + wait : ''}</span>
            </a>
        </div>`;
}

function renderSpectate(games) {
    if (!spectateLoaded) {
        spectateGrid.innerHTML = `<div class="loader-container"><div class="spinner"></div><p>Fetching games in progress...</p></div>`;
        return;
    }
    if (!games.length) {
        spectateGrid.innerHTML = `<div class="empty-state"><h3>No games match</h3><p>${spectateGames.length} games are in progress, but none match your spectate filters.</p></div>`;
        return;
    }
    const shown = games.slice(0, spectateLimit);
    spectateGrid.innerHTML = shown.map(g => `<div class="lobby-card spectate-card" id="game-${g.id}">${spectateCardHtml(g)}</div>`).join('') +
        (games.length > shown.length
            ? `<div class="spectate-more"><button type="button" class="clear-filters-btn" onclick="showMoreSpectate()">Show more (${games.length - shown.length} more)</button></div>`
            : '');
}

window.showMoreSpectate = function() {
    spectateLimit += SPECTATE_PAGE;
    applyFiltersAndRender();
};

// Tick the spectate countdowns and "started" times once a second
setInterval(() => {
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
