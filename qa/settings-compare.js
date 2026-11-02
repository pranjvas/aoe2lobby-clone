// QA: compare lobby settings from our API with aoe2lobby.com's live data, using aoe2lobby.com's own labels.
// Usage: node qa/settings-compare.js [ourApiUrl]   (default https://aoe2lobby.online/api/lobbies)
// Needs Node 22+ (global WebSocket).
const OUR_API = process.argv[2] || 'https://aoe2lobby.online/api/lobbies';

// [our API field, aoe2lobby.com field, how to turn their raw value into what we should show]
const FIELDS = [
    ['matchType', 'mode', 'label'],
    ['mapSize', 'size', 'label'],
    ['population', 'population', 'raw'],
    ['speed', 'speed', 'label'],
    ['startingAge', 'starting_age', 'label'],
    ['resources', 'resources', 'label'],
    ['treaty', 'treaty_length', 'raw'],
    ['modInfo', 'data_mod', 'mod'],
    ['serverRegion', 'server', 'label'],
];

function snapshot() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://aoe2lobby.com/ws/lobby/');
        let schema = null;
        const timer = setTimeout(() => reject(new Error('timed out waiting for aoe2lobby.com')), 15000);
        ws.onerror = (e) => { clearTimeout(timer); reject(new Error('websocket error')); };
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
    const theirById = {};
    for (const m of Object.values(matches)) theirById[String(m.matchid)] = m;

    const expected = (kind, field, value) => {
        if (kind === 'mod') return value || 'No Mods';
        if (kind === 'label') return schema?.[field]?.[String(value)] ?? String(value);
        return String(value);
    };

    const tally = {};
    const problems = [];
    let compared = 0, missing = 0;
    for (const o of ours.matches) {
        const t = theirById[String(o.id)];
        if (!t) { missing++; continue; }
        compared++;
        for (const [ourKey, theirKey, kind] of FIELDS) {
            tally[ourKey] = tally[ourKey] || { same: 0, diff: 0 };
            const want = expected(kind, theirKey, t[theirKey]);
            if (String(o[ourKey]) === want) tally[ourKey].same++;
            else {
                tally[ourKey].diff++;
                if (problems.length < 30) problems.push({ lobby: o.id, title: (o.title || '').slice(0, 30), field: ourKey, ours: o[ourKey], theirs: want });
            }
        }
    }
    console.log(`compared ${compared} lobbies (ours not on aoe2lobby.com: ${missing})`);
    for (const k in tally) console.log(`  ${k.padEnd(12)} same ${tally[k].same}  diff ${tally[k].diff}`);
    for (const p of problems) console.log(JSON.stringify(p));
})().catch(e => { console.error(e); process.exit(1); });
