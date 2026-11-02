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
    currentView: 'lobbies',
    playerSort: 'elo-desc',
    playerSearch: '',
    eloType: '0' // Unranked, the same default rating aoe2lobby.com shows
};
const storedState = JSON.parse(localStorage.getItem('aoe2State')) || {};
// 'auto' used to be the default; move those visitors to the new default once
if (storedState.eloType === 'auto' && !storedState.eloDefaultV2) storedState.eloType = '0';
const state = { ...defaultState, ...storedState, eloDefaultV2: true };

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
    if(playerSort) playerSort.value = state.playerSort;
    if(playerSearch) playerSearch.value = state.playerSearch;

    if(state.layout === 'list') {
        const layoutListBtn = document.getElementById('layoutListBtn');
        if (layoutListBtn) layoutListBtn.click();
    } else {
        const layoutGridBtn = document.getElementById('layoutGridBtn');
        if (layoutGridBtn) layoutGridBtn.click();
    }
    
    if(state.currentView === 'players') {
        viewPlayersBtn.click();
    } else {
        viewLobbiesBtn.click();
    }
    
    fetchRealLobbies();
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
    let maxPlayers = match.maxPlayers || 8;
    
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
                    T${p.team} - ${p.name}
                    <button onclick="copyPlayerHandle(event, this, '${p.name.replace(/'/g, "\\'")}')" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex; align-items: center;" title="Copy Handle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <span class="player-stats">${statsHtml}</span>
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
        server: match.server || "Global", 
        currentPlayers: currentPlayers,
        maxPlayers: maxPlayers,
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
    if (eloTypeFilter) {
        eloTypeFilter.addEventListener('change', (e) => {
            state.eloType = e.target.value;
            // We need to re-parse all lobbies so the UI updates
            lobbies = lobbies.map(l => {
                const rawMatch = state.rawMatches.find(rm => rm.id === l.id);
                return rawMatch ? parseRelicLobby(rawMatch) : l;
            });
            applyFiltersAndRender();
        });
    }

    // View Toggles
    viewLobbiesBtn.addEventListener('click', () => {
        state.currentView = 'lobbies';
        viewLobbiesBtn.style.background = 'rgba(88, 101, 242, 0.2)';
        viewLobbiesBtn.style.border = '1px solid var(--accent)';
        viewLobbiesBtn.style.color = 'white';
        viewPlayersBtn.style.background = 'transparent';
        viewPlayersBtn.style.border = '1px solid transparent';
        viewPlayersBtn.style.color = 'var(--text-secondary)';
        
        lobbyGrid.style.display = state.layout === 'list' ? 'flex' : 'grid';
        playerGrid.style.display = 'none';
        lobbyFilters.style.display = 'flex';
        playerFilters.style.display = 'none';
        viewTitleText.textContent = 'Lobbies';
        countLabel.textContent = 'lobbies';
        applyFiltersAndRender();
    });

    viewPlayersBtn.addEventListener('click', () => {
        state.currentView = 'players';
        viewPlayersBtn.style.background = 'rgba(88, 101, 242, 0.2)';
        viewPlayersBtn.style.border = '1px solid var(--accent)';
        viewPlayersBtn.style.color = 'white';
        viewLobbiesBtn.style.background = 'transparent';
        viewLobbiesBtn.style.border = '1px solid transparent';
        viewLobbiesBtn.style.color = 'var(--text-secondary)';
        
        lobbyGrid.style.display = 'none';
        playerGrid.style.display = state.layout === 'list' ? 'flex' : 'grid';
        lobbyFilters.style.display = 'none';
        playerFilters.style.display = 'flex';
        viewTitleText.textContent = 'Players';
        countLabel.textContent = 'players';
        applyFiltersAndRender();
    });

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
        if (state.currentView === 'lobbies') {
            lobbyGrid.style.display = 'grid';
        } else {
            playerGrid.style.display = 'grid';
        }
        applyFiltersAndRender();
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
        if (state.currentView === 'lobbies') {
            lobbyGrid.style.display = 'flex';
        } else {
            playerGrid.style.display = 'flex';
        }
        applyFiltersAndRender();
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
            matchesStartAge && matchesResources && matchesTreaty;
    });
}

function applyFiltersAndRender() {
    localStorage.setItem('aoe2State', JSON.stringify(state));
    if (state.currentView === 'lobbies') {
        const filteredLobbies = filterLobbies();
        itemCount.textContent = filteredLobbies.length;
        renderLobbies(filteredLobbies);
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
                        server: lobby.server || 'Global',
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
                        ${p.name}
                        <button onclick="copyPlayerHandle(event, this, '${p.name.replace(/'/g, "\\'")}')" style="background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex;" title="Copy Handle">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        ${p.displayElo !== null ? `<span class="elo-badge">${p.displayElo}</span>` : '<span class="elo-badge" style="background: rgba(138, 155, 178, 0.2); color: var(--text-secondary); border-color: transparent;">Unranked</span>'}
                    </div>
                    <div class="game-title" style="font-size: 0.8em; color: var(--text-secondary);">In lobby: ${p.lobbyTitle}</div>
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
                        Playing: ${p.lobbyMap}
                    </div>
                    <div class="tags-row" style="margin-top: 10px;">
                        <span class="badge status-badge" style="background: ${p.isPlaying ? 'rgba(212, 175, 55, 0.2)' : 'rgba(46, 160, 67, 0.2)'}; color: ${p.isPlaying ? '#d4af37' : '#2ea043'}; border-color: ${p.isPlaying ? '#d4af37' : '#2ea043'}">${p.isPlaying ? '&#x1F3AE; Playing' : '&#x23F3; Waiting'}</span>
                        <span class="badge server-badge" title="Server">&#x1F310; ${p.server}</span>
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
    html += `<span class="badge mod-info-badge" title="Mod Info">&#x2699; ${item.modInfo || 'No Mods'}</span>`;
    return html;
}

// Everything shown on a card except the live player list / count / status, which update in place
function lobbyDetailsKey(lobby) {
    return JSON.stringify([lobby.host, lobby.elo, lobby.title, lobby.map, lobby.type, lobby.matchType, lobby.mapSize,
        lobby.population, lobby.speed, lobby.modInfo, lobby.startingAge, lobby.resources, lobby.treaty, lobby.isPlaying]);
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

function lobbyCardHtml(lobby) {
    const fillPercentage = (lobby.currentPlayers / lobby.maxPlayers) * 100;
    const joinLink = (!lobby.isPlaying) 
        ? `aoe2de://0/${lobby.id}`
        : '#';
    const joinText = joinLink === '#' ? (lobby.isPlaying ? 'In Progress' : 'Cannot Join') : 'Join Game';
    const joinClass = joinLink === '#' ? 'btn-join disabled' : 'btn-join';
    
    const statusIndicator = lobby.isPlaying ? 
        '<span style="color: #d4af37">&#x1F3AE; Playing</span> ' + lobby.server : 
        '<span style="color: #2ea043">&#x23F3; Waiting</span> ' + lobby.server;

    return `
        <div class="card-header">
            <div class="host-info">
                <div class="host-name">
                    ${lobby.host}
                    ${lobby.elo ? `<span class="elo-badge">${lobby.elo}</span>` : ''}
                </div>
                <div class="game-title" title="${lobby.title}">${lobby.title}</div>
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
                    <span class="detail-icon" style="opacity: 0.7;">🗺️</span> <span style="font-weight: 500;">${lobby.map}</span>
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
                <span class="players-count-text">&#x1F464; ${lobby.currentPlayers}/${lobby.maxPlayers}</span>
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
            emptyState.innerHTML = `<h3>No Lobbies Found</h3><p>Try adjusting your filters or search criteria.</p>`;
            lobbyGrid.appendChild(emptyState);
        }
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
                countText.innerHTML = `&#x1F464; ${lobby.currentPlayers}/${lobby.maxPlayers}`;
                progress.style.width = `${fillPercentage}%`;
            }
            if(pList && pList.innerHTML !== lobby.playersHtml) {
                pList.innerHTML = lobby.playersHtml;
            }
            if (sBadge) {
                sBadge.innerHTML = lobby.isPlaying ? 
                    '<span style="color: #d4af37">&#x1F3AE; Playing</span> ' + lobby.server : 
                    '<span style="color: #2ea043">&#x23F3; Waiting</span> ' + lobby.server;
            }
        } else {
            const div = document.createElement('div');
            div.id = id;
            div.className = 'lobby-card';
            div.style.animation = "fadeIn 0.5s ease-out";
            
            div.onclick = (e) => {
                if (e.target.closest('.btn-join')) return;
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
