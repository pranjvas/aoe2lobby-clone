// App State
let lobbies = [];
const defaultState = {
    search: '',
    gameType: 'all',
    map: 'all',
    minElo: 0,
    status: 'all',
    mod: 'all',
    currentView: 'lobbies',
    playerSort: 'elo-desc',
    playerSearch: ''
};
const storedState = JSON.parse(localStorage.getItem('aoe2State')) || {};
const state = { ...defaultState, ...storedState };

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

function init() {
    setupEventListeners();
    
    // Restore DOM inputs from state
    if(searchInput) searchInput.value = state.search;
    if(gameTypeFilter) gameTypeFilter.value = state.gameType;
    if(mapFilter) mapFilter.value = state.map;
    if(eloFilter) eloFilter.value = state.minElo;
    if(statusFilter) statusFilter.value = state.status;
    if(modFilter) modFilter.value = state.mod;
    if(playerSort) playerSort.value = state.playerSort;
    if(playerSearch) playerSearch.value = state.playerSearch;

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

    let type = "Random Map";
    if (title.toLowerCase().includes("death")) type = "Death Match";
    if (title.toLowerCase().includes("empire")) type = "Empire Wars";

    let mapIcon = '&#x1F5FA;';
    if(map.toLowerCase().includes('arabia')) mapIcon = '&#x1F3DC;';
    if(map.toLowerCase().includes('black forest')) mapIcon = '&#x1F332;';
    if(map.toLowerCase().includes('nomad')) mapIcon = '&#x26FA;';
    if(map.toLowerCase().includes('arena')) mapIcon = '&#x1F3F0;';
    
    let matchType = match.matchType || (match.ranked ? "Ranked" : "Unranked");
    let mapSize = match.mapSize || "Normal";
    let modInfo = match.modInfo || "No Mods";
    let population = match.population || "200";
    let speed = match.speed || "Normal";

    let currentPlayers = match.players ? match.players.length : 1;
    let maxPlayers = match.maxPlayers || 8;
    
    let playersHtml = '';
    if (match.players && match.players.length > 0) {
        match.players.sort((a,b) => a.team - b.team);
        playersHtml = match.players.map(p => `
            <div class="player-item">
                <span class="player-name">T${p.team} - ${p.name} <span class="player-stats">(${p.totalGames} Games, ${p.winRate ? (String(p.winRate).endsWith('%') ? p.winRate : p.winRate + '%') : 'N/A'} WR)</span></span>
                <span class="player-elo">${p.elo}</span>
            </div>
        `).join('');
    } else {
        playersHtml = `<div class="player-item">No player data available.</div>`;
    }

    return {
        id: match.id,
        steamLobbyId: match.steamLobbyId,
        host: match.players && match.players.length > 0 ? match.players[0].name : `Unknown`,
        elo: match.players && match.players.length > 0 ? match.players[0].elo : null,
        title: title,
        map: map,
        mapIcon: mapIcon,
        type: type,
        matchType: matchType,
        mapSize: mapSize,
        modInfo: modInfo,
        population: population,
        speed: speed,
        server: match.server || "Global", 
        currentPlayers: currentPlayers,
        maxPlayers: maxPlayers,
        ping: Math.floor(Math.random() * 50) + 20,
        playersHtml: playersHtml,
        isPlaying: match.isPlaying,
        rawPlayers: match.players || []
    };
}

async function fetchRealLobbies() {
    try {
        const response = await fetch('http://localhost:3001/api/lobbies?t=' + Date.now());
        const data = await response.json();
        
        let hasUnknownMap = false;

        if (data && data.matches) {
            lobbies = data.matches.map(parseRelicLobby);
            hasUnknownMap = lobbies.some(lobby => lobby.map === "Unknown Map");
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

    // View Toggles
    viewLobbiesBtn.addEventListener('click', () => {
        state.currentView = 'lobbies';
        viewLobbiesBtn.style.background = 'rgba(88, 101, 242, 0.2)';
        viewLobbiesBtn.style.border = '1px solid var(--accent)';
        viewLobbiesBtn.style.color = 'white';
        viewPlayersBtn.style.background = 'transparent';
        viewPlayersBtn.style.border = '1px solid transparent';
        viewPlayersBtn.style.color = '#8a9bb2';
        
        lobbyGrid.style.display = 'grid';
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
        viewLobbiesBtn.style.color = '#8a9bb2';
        
        lobbyGrid.style.display = 'none';
        playerGrid.style.display = 'grid';
        lobbyFilters.style.display = 'none';
        playerFilters.style.display = 'flex';
        viewTitleText.textContent = 'Players';
        countLabel.textContent = 'players';
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
        const matchesMod = state.mod === 'all' || lobby.modInfo === state.mod;
        const matchesElo = state.minElo === 0 || (lobby.elo && parseInt(lobby.elo) >= state.minElo);
        return matchesSearch && matchesType && matchesMap && matchesStatus && matchesMod && matchesElo;
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
                        matchType: lobby.matchType || 'Unknown',
                        mapSize: lobby.mapSize || 'Normal',
                        population: lobby.population || '200',
                        speed: lobby.speed || 'Normal',
                        modInfo: lobby.modInfo || 'No Mods',
                        server: lobby.server || 'Global'
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
        if (state.playerSort === 'elo-desc') return (parseInt(b.elo) || 0) - (parseInt(a.elo) || 0);
        if (state.playerSort === 'elo-asc') return (parseInt(a.elo) || 0) - (parseInt(b.elo) || 0);
        if (state.playerSort === 'wr-desc') return (parseFloat(b.winRate) || 0) - (parseFloat(a.winRate) || 0);
        if (state.playerSort === 'games-desc') return (parseInt(b.totalGames) || 0) - (parseInt(a.totalGames) || 0);
        return 0;
    });
    
    return allPlayers;
}

function renderPlayers(players) {
    let emptyState = document.getElementById('emptyStatePlayers');
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
                        <button onclick="copyPlayerHandle(this, '${p.name.replace(/'/g, "\\'")}')" style="background: none; border: none; cursor: pointer; color: #8a9bb2; padding: 0; display: flex;" title="Copy Handle">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        ${p.elo ? `<span class="elo-badge">${p.elo}</span>` : ''}
                    </div>
                    <div class="game-title" style="font-size: 0.8em; color: #8a9bb2;">In lobby: ${p.lobbyTitle}</div>
                </div>
            </div>
            
            <div class="card-body">
                <div class="game-details">
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F3C6;</span>
                        Win Rate: ${p.winRate ? (p.winRate.endsWith('%') ? p.winRate : p.winRate + '%') : 'N/A'}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F4CA;</span>
                        Total Games: ${p.totalGames || '0'}
                    </div>
                    <div class="detail-row">
                        <span class="detail-icon">&#x1F5FA;</span>
                        Playing: ${p.lobbyMap}
                    </div>
                    <div class="tags-row" style="margin-top: 10px;">
                        <span class="badge status-badge" style="background: ${p.isPlaying ? 'rgba(212, 175, 55, 0.2)' : 'rgba(46, 160, 67, 0.2)'}; color: ${p.isPlaying ? '#d4af37' : '#2ea043'}; border-color: ${p.isPlaying ? '#d4af37' : '#2ea043'}">${p.isPlaying ? '&#x1F3AE; Playing' : '&#x23F3; Waiting'}</span>
                        <span class="badge server-badge" title="Server">&#x1F310; ${p.server}</span>
                        <span class="badge match-type-badge">${p.matchType}</span>
                        <span class="badge map-size-badge" title="Map Size">&#x1F5FA; ${p.mapSize}</span>
                        <span class="badge pop-badge" title="Population">&#x1F465; ${p.population}</span>
                        <span class="badge speed-badge" title="Speed">&#x23E9; ${p.speed}</span>
                        <span class="badge mod-info-badge" title="Mod Info">&#x2699; ${p.modInfo}</span>
                    </div>
                </div>
            </div>
            
            <div class="card-footer">
                <a href="aoe2de://0/${p.lobbyId}" class="btn-join" style="width: 100%;">Join Lobby</a>
            </div>
        `;
        playerGrid.appendChild(div);
    });
}

function renderLobbies(filteredLobbies) {
    let emptyState = document.getElementById('emptyState');
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

        if (existingNodes.has(id)) {
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
            
            const joinLink = (!lobby.isPlaying) 
                ? `aoe2de://0/${lobby.id}`
                : '#';
            const joinText = joinLink === '#' ? (lobby.isPlaying ? 'In Progress' : 'Cannot Join') : 'Join Game';
            const joinClass = joinLink === '#' ? 'btn-join disabled' : 'btn-join';
            
            const statusIndicator = lobby.isPlaying ? 
                '<span style="color: #d4af37">&#x1F3AE; Playing</span> ' + lobby.server : 
                '<span style="color: #2ea043">&#x23F3; Waiting</span> ' + lobby.server;

            div.innerHTML = `
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
                            <span class="detail-icon">&#x2694;</span>
                            ${lobby.type}
                        </div>
                        <div class="detail-row">
                            <span class="detail-icon">&#x1F5FA;</span>
                            ${lobby.map}
                        </div>
                        <div class="tags-row">
                            <span class="badge match-type-badge">${lobby.matchType}</span>
                            <span class="badge map-size-badge" title="Map Size">&#x1F5FA; ${lobby.mapSize}</span>
                            <span class="badge pop-badge" title="Population">&#x1F465; ${lobby.population}</span>
                            <span class="badge speed-badge" title="Speed">&#x23E9; ${lobby.speed}</span>
                            <span class="badge mod-info-badge" title="Mod Info">&#x2699; ${lobby.modInfo}</span>
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
            
            lobbyGrid.appendChild(div);
        }
    });
}

document.addEventListener('DOMContentLoaded', init);

window.copyPlayerHandle = function(btn, handle) {
    navigator.clipboard.writeText(handle).then(() => {
        const originalIcon = btn.innerHTML;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2ea043" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            btn.innerHTML = originalIcon;
        }, 1000);
    });
};
