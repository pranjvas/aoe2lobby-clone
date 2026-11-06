// QA: lobby slots whose civ id isn't in the feed's own schema, and what our API shows for those players.
// Fails on "Unknown civ": a new id to add to FALLBACK_SCHEMA.civilization in scraper.js and NEW_CIVS in server.js.
// Usage: node qa/lobby-civ-check.js [ourApiUrl]   (default https://aoe2lobby.online/api/lobbies)
// Needs Node 22+ (global WebSocket).
const OUR_API = process.argv[2] || 'https://aoe2lobby.online/api/lobbies';

function snapshot() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://aoe2lobby.com/ws/lobby/');
        let schema = null;
        const timer = setTimeout(() => reject(new Error('timed out waiting for aoe2lobby.com')), 15000);
        ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
        ws.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.schema) schema = data.schema;
            if (data.lobby_match_all) {
                clearTimeout(timer);
                ws.close();
                resolve({ matches: data.lobby_match_all, schema });
            }
        };
    });
}

(async () => {
    const [{ matches, schema }, ours] = await Promise.all([snapshot(), fetch(OUR_API).then(r => r.json())]);
    const known = schema?.civilization;
    if (!known) throw new Error('the feed sent no schema');
    const ourCiv = new Map();
    for (const m of ours.matches || []) for (const p of m.players || []) ourCiv.set(`${m.id}:${p.id}`, p.civ);

    const tally = {};
    let slots = 0, unknown = 0;
    for (const [id, lobby] of Object.entries(matches)) {
        for (const slot of Object.values(lobby.slots || {})) {
            if (!slot || !slot.profileid || slot.civilization === null || slot.civilization === undefined) continue;
            slots++;
            if (Object.hasOwn(known, String(slot.civilization))) continue;
            const key = `${id}:${slot.profileid}`;
            // Blank or absent is usually timing: the site's list runs some seconds behind this read
            const shown = ourCiv.has(key) ? (ourCiv.get(key) || '(blank)') : '(not listed yet)';
            if (shown === 'Unknown civ') unknown++;
            const row = tally[slot.civilization] ||= {};
            row[shown] = (row[shown] || 0) + 1;
        }
    }
    console.log(`${Object.keys(matches).length} lobbies, ${slots} players with a civ id`);
    for (const [id, row] of Object.entries(tally)) console.log(`  ${id}: ${JSON.stringify(row)}`);
    if (!Object.keys(tally).length) console.log('  every id is in the schema right now, so nothing to compare');
    if (unknown) {
        console.error(`FAIL: ${unknown} player(s) show "Unknown civ"`);
        process.exit(1);
    }
    console.log('OK');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
