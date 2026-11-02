// QA: compare player ELO shown by our API with aoe2lobby.com's live websocket data.
// Usage: node qa/elo-compare.js [ourApiUrl]   (default https://aoe2lobby.online/api/lobbies)
// Needs Node 22+ (global WebSocket).
const OUR_API = process.argv[2] || 'https://aoe2lobby.online/api/lobbies';
const ELO_TYPES = ['0', '3', '4', '13', '14'];
const WAIT_MS = 15000;

function collectAoe2lobby() {
    return new Promise((resolve, reject) => {
        const matches = {};
        const elo = {}; // eloType -> profileId -> stats
        const ws = new WebSocket('wss://aoe2lobby.com/ws/lobby/');
        const timer = setTimeout(() => { ws.close(); resolve({ matches, elo }); }, WAIT_MS);
        ws.onerror = (e) => { clearTimeout(timer); reject(new Error('websocket error: ' + (e.message || e.type))); };
        ws.onopen = () => {
            ws.send(JSON.stringify({ action: 'subscribe', type: 'elotypes', context: 'lobby', ids: ELO_TYPES }));
        };
        ws.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            for (const key of Object.keys(data)) {
                if (key === 'lobby_match_all') Object.assign(matches, data[key]);
                if (key === 'lobby_match_update') Object.assign(matches, data[key]);
                if (key === 'lobby_elo_update') {
                    for (const type in data[key]) {
                        elo[type] = elo[type] || {};
                        Object.assign(elo[type], data[key][type]);
                    }
                }
            }
        };
    });
}

(async () => {
    const [{ matches, elo }, ours] = await Promise.all([
        collectAoe2lobby(),
        fetch(OUR_API).then(r => r.json()),
    ]);
    console.log(`aoe2lobby.com: ${Object.keys(matches).length} lobbies, elo types ${Object.keys(elo).map(t => `${t}:${Object.keys(elo[t]).length}`).join(' ')}`);
    console.log(`ours: ${ours.matches.length} lobbies`);

    const theirById = {};
    for (const m of Object.values(matches)) theirById[String(m.matchid)] = m;

    // What our "Auto" mode is meant to show: the lobby's ladder, else the ladder with the most games
    const intendedAuto = (pid, theirs, ladder) => {
        const own = elo[ladder]?.[pid];
        if (own) return own.rating;
        let best = null;
        for (const t of ELO_TYPES) {
            const st = elo[t]?.[pid];
            if (st && (!best || st.games > best.games)) best = st;
        }
        return best ? best.rating : null;
    };
    let vsUnranked = 0, vsAuto = 0, defaultViewMismatch = 0;
    let compared = 0, mismatched = 0, missingLobby = 0;
    const samples = [];
    for (const m of ours.matches) {
        const theirs = theirById[String(m.id)];
        if (!theirs) { missingLobby++; continue; }
        const slotsByName = {};
        for (const slot of Object.values(theirs.slots || {})) {
            if (slot.profileid && slot.name) slotsByName[slot.name.toLowerCase()] = slot;
        }
        const is1v1 = theirs.slots_total === 2;
        const rmType = is1v1 ? '3' : '4';
        const ewType = is1v1 ? '13' : '14';
        for (const p of m.players || []) {
            const slot = slotsByName[(p.name || '').toLowerCase()];
            if (!slot) continue;
            const pid = String(slot.profileid);
            const theirElo = {};
            for (const t of ELO_TYPES) theirElo[t] = elo[t]?.[pid]?.rating ?? null;
            const ourMatchType = m.matchType;
            const ladder = ourMatchType === 'Random Map' ? rmType : ourMatchType === 'Empire Wars' ? ewType : '0';
            const expectedType = ladder;
            const expected = intendedAuto(pid, theirs, ladder);
            if (String(p.elo) !== String(theirElo['0'])) vsUnranked++;
            // What the site shows by default (Elo Type = Unranked) comes from allStats['0']
            const ourDefault = p.allStats?.['0']?.rating ?? null;
            if (String(ourDefault) !== String(theirElo['0'])) {
                defaultViewMismatch++;
                if (samples.length < 25) samples.push({ kind: 'default-view', lobby: m.id, player: p.name, pid, ours: ourDefault, theirs: theirElo['0'] });
            }
            if (String(p.elo) !== String(expected)) vsAuto++;
            compared++;
            if (String(p.elo) !== String(expected)) {
                mismatched++;
                if (samples.length < 25) samples.push({
                    lobby: m.id, player: p.name, pid, slots: theirs.slots_total, mode: theirs.mode, ourMatchType: m.matchType,
                    ours: p.elo, expectedType, expected, all: theirElo,
                });
            }
        }
    }
    console.log(`compared ${compared} players | differs from aoe2lobby.com Unranked (their default): ${vsUnranked} | Auto rule mismatches: ${vsAuto} | default (Unranked) view mismatches: ${defaultViewMismatch} | our lobbies not on aoe2lobby.com: ${missingLobby}`);
    for (const s of samples) console.log(JSON.stringify(s));
})().catch(e => { console.error(e); process.exit(1); });
