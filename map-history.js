// Map history (the Maps view): how many of each map's lobbies each player has been in, kept for good in a SQLite file.
// scraper.js writes it (MapHistoryWriter, one transaction per 15 s snapshot) and server.js reads it (MapHistoryReader,
// read-only). Uses Node's built-in node:sqlite (Node 22.13+ needs no flag); without it the Maps view is just empty.
// Nothing is ever dropped: the file grows by roughly one row per player and map they have joined.
'use strict';
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'map_history.sqlite'); // deploy/push.sh keeps it (and its -wal/-shm files)
// The JSON file the first version kept (capped and pruned); imported once, then renamed
const LEGACY_JSON_PATH = path.join(__dirname, 'scraped_map_players_v2.json');
// Names that say nothing about the map
const GENERIC_MAPS = new Set(['unknown map', 'my map', 'custom map', '']);
// A lobby gone from the feed this long has closed; a shorter gap (a snapshot that missed it) isn't counted twice
const LIVE_KEEP_MS = 2 * 60 * 1000;

let sqlite;
function sqliteModule() {
    if (sqlite === undefined) {
        try {
            sqlite = require('node:sqlite');
        } catch (e) {
            sqlite = null;
            console.error(`Map history is off: node:sqlite is unavailable (${e.message}); Node 22.13+ has it`);
        }
    }
    return sqlite;
}

// The feed's map name as stored: text (a Steam mod map's number too), trimmed; null for a generic or missing name
function mapKey(name) {
    if (typeof name === 'number' && Number.isFinite(name)) name = String(name);
    if (typeof name !== 'string') return null;
    const key = name.trim().slice(0, 120);
    return GENERIC_MAPS.has(key.toLowerCase()) ? null : key;
}

// The four numbers per ladder the Maps view shows, as JSON; null when there are none
function statsJson(stats) {
    const out = {};
    for (const ladder of Object.keys(stats && typeof stats === 'object' ? stats : {})) {
        const s = stats[ladder];
        if (!/^\d+$/.test(ladder) || !s || typeof s !== 'object') continue;
        out[ladder] = { rating: s.rating, games: s.games, wins: s.wins, winp: s.winp };
    }
    return Object.keys(out).length ? JSON.stringify(out) : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maps (name TEXT PRIMARY KEY, lobbies INTEGER NOT NULL, last INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, steam TEXT, stats TEXT, last INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS map_players (
    map TEXT NOT NULL, player INTEGER NOT NULL, n INTEGER NOT NULL, last INTEGER NOT NULL,
    PRIMARY KEY (map, player)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS map_players_top ON map_players (map, n DESC, last DESC);
`;

class MapHistoryWriter {
    constructor(file = DB_PATH, legacyJson = LEGACY_JSON_PATH) {
        this.db = null;
        this.live = new Map(); // `${matchId}|${map}` -> { last, players: Set<id> }: lobbies already counted
        const m = sqliteModule();
        if (!m) return;
        this.db = new m.DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(SCHEMA);
        this.getMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');
        this.setMeta = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        this.upMap = this.db.prepare(`INSERT INTO maps (name, lobbies, last) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET lobbies = lobbies + excluded.lobbies, last = MAX(last, excluded.last)`);
        this.upPair = this.db.prepare(`INSERT INTO map_players (map, player, n, last) VALUES (?, ?, ?, ?)
            ON CONFLICT(map, player) DO UPDATE SET n = n + excluded.n, last = MAX(last, excluded.last)`);
        this.upPlayer = this.db.prepare(`INSERT INTO players (id, name, steam, stats, last) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, steam = COALESCE(excluded.steam, steam),
            stats = COALESCE(excluded.stats, stats), last = MAX(last, excluded.last)`);
        if (!this.getMeta.get('since')) this.start(legacyJson);
        // Lobbies counted before a restart, so a restart doesn't count them again
        try {
            for (const [key, last, players] of JSON.parse(this.getMeta.get('live')?.value || '[]')) {
                this.live.set(String(key), { last: Number(last) || 0, players: new Set((players || []).map(Number)) });
            }
        } catch (e) { /* a bad value only means those lobbies may count once more */ }
        const count = this.db.prepare('SELECT (SELECT COUNT(*) FROM maps) AS maps, (SELECT COUNT(*) FROM players) AS players').get();
        console.log(`Map history: ${count.maps} maps, ${count.players} players, counting since ${new Date(this.since()).toISOString()}`);
    }

    since() {
        return Number(this.getMeta.get('since')?.value) || null;
    }

    // A new file: start counting now, or from the first version's JSON file, imported whole (then renamed)
    start(legacyJson) {
        let since = Date.now();
        let d = null;
        try { d = JSON.parse(fs.readFileSync(legacyJson, 'utf8')); } catch (e) { /* none: a fresh start */ }
        this.db.exec('BEGIN');
        try {
            if (d && d.version === 1 && Array.isArray(d.maps)) {
                if (Number.isSafeInteger(d.since) && d.since > 0) since = d.since;
                for (const p of Array.isArray(d.players) ? d.players : []) {
                    const id = Number(Array.isArray(p) && p[0]);
                    if (Number.isSafeInteger(id) && id > 0) this.upPlayer.run(id, String(p[1] ?? ''), p[2] || null, statsJson(p[4]), Number(p[3]) || 0);
                }
                for (const m of d.maps) {
                    const map = Array.isArray(m) ? mapKey(m[0]) : null;
                    if (!map || !Array.isArray(m[3])) continue;
                    this.upMap.run(map, Number(m[1]) || 0, Number(m[2]) || 0);
                    for (const p of m[3]) {
                        const id = Number(Array.isArray(p) && p[0]);
                        if (Number.isSafeInteger(id) && id > 0) this.upPair.run(map, id, Number(p[1]) || 0, Number(p[2]) || 0);
                    }
                }
                if (Array.isArray(d.live)) this.setMeta.run('live', JSON.stringify(d.live));
            }
            this.setMeta.run('since', String(since));
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        if (d) {
            try { fs.renameSync(legacyJson, legacyJson + '.imported'); } catch (e) { console.error('Could not rename ' + legacyJson + ':', e.message); }
            console.log(`Map history: imported ${path.basename(legacyJson)}`);
        }
    }

    // One snapshot: [{ matchId, map, players: [{ profileId, name, steamProfile, stats }] }]. A player counts once per
    // lobby (match id + map, so a host changing the map counts again), when they first appear in it.
    recordSnapshot(lobbies, now) {
        if (!this.db) return;
        // Restored if the transaction fails, so the lobbies it counted aren't taken as counted (a few dozen entries)
        const liveBefore = new Map([...this.live].map(([key, l]) => [key, { last: l.last, players: new Set(l.players) }]));
        this.db.exec('BEGIN');
        try {
            for (const lobby of lobbies) {
                const map = mapKey(lobby.map);
                if (!map) continue;
                const key = `${lobby.matchId}|${map}`;
                let live = this.live.get(key);
                const newLobby = !live;
                if (!live) this.live.set(key, live = { last: now, players: new Set() });
                live.last = now;
                this.upMap.run(map, newLobby ? 1 : 0, now);
                for (const p of lobby.players) {
                    const id = Number(p.profileId);
                    if (!Number.isSafeInteger(id) || id <= 0) continue;
                    const first = !live.players.has(id);
                    live.players.add(id);
                    this.upPair.run(map, id, first ? 1 : 0, now);
                    this.upPlayer.run(id, String(p.name ?? '').slice(0, 64), p.steamProfile || null, statsJson(p.stats), now);
                }
            }
            for (const [key, live] of this.live) if (now - live.last > LIVE_KEEP_MS) this.live.delete(key);
            this.setMeta.run('live', JSON.stringify([...this.live].map(([key, l]) => [key, l.last, [...l.players]])));
            this.db.exec('COMMIT');
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch (_) { }
            this.live = liveBefore;
            throw e;
        }
    }

    close() {
        if (this.db) this.db.close();
        this.db = null;
    }
}

class MapHistoryReader {
    constructor(file = DB_PATH) {
        this.file = file;
        this.db = null;
        this.byCount = new Map(); // number of map names -> prepared statement
    }

    // Opened on first use: until scraper.js has created the file there is nothing to read
    open() {
        if (this.db) return this.db;
        const m = sqliteModule();
        if (!m || !fs.existsSync(this.file)) return null;
        try {
            this.db = new m.DatabaseSync(this.file, { readOnly: true });
            this.db.exec('PRAGMA busy_timeout = 2000;');
            this.metaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
            this.mapsStmt = this.db.prepare('SELECT m.name, m.lobbies, m.last, (SELECT COUNT(*) FROM map_players p WHERE p.map = m.name) AS players FROM maps m');
        } catch (e) {
            console.error('Map history: cannot open ' + this.file + ':', e.message);
            this.db = null;
        }
        return this.db;
    }

    since() {
        if (!this.open()) return null;
        return Number(this.metaStmt.get('since')?.value) || null;
    }

    // Every stored map name: [{ name, lobbies, last, players }]
    maps() {
        if (!this.open()) return [];
        return this.mapsStmt.all();
    }

    // The players of these stored map names (one shown map can be several), most appearances first
    players(names, limit) {
        if (!this.open() || !names.length) return [];
        let stmt = this.byCount.get(names.length);
        if (!stmt) {
            stmt = this.db.prepare(`SELECT mp.player AS id, SUM(mp.n) AS count, MAX(mp.last) AS lastSeen, p.name, p.steam, p.stats
                FROM map_players mp JOIN players p ON p.id = mp.player
                WHERE mp.map IN (${names.map(() => '?').join(', ')})
                GROUP BY mp.player ORDER BY count DESC, lastSeen DESC LIMIT ?`);
            this.byCount.set(names.length, stmt);
        }
        return stmt.all(...names, limit);
    }

    close() {
        if (this.db) this.db.close();
        this.db = null;
        this.byCount.clear();
    }
}

module.exports = { MapHistoryWriter, MapHistoryReader, mapKey, DB_PATH };
