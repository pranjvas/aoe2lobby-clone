// Reads Age of Empires II: DE recorded games (.aoe2record, or the official ZIP holding one) for the replay viewer.
// ReplayParse.parseFile(bytes, inflateRaw, onProgress) resolves to the model in docs/spectate-plan.md (Parser output).
// inflateRaw(bytes, maxBytes) is the caller's, because a browser inflates asynchronously. No dependencies and no
// network: replay-worker.js runs this in the page's worker, and qa/replay-check.js in Node.
// Reads save versions 67.2, 68 and 68.9. The layouts are written up in docs/replay-format/; after a game update,
// recheck them with `node qa/replay-check.js parse <savegame folder>`.
//
// The header, player and command decoders began as a port of mgz's fast path (happyleavesaoc/aoc-mgz), corrected for
// the save versions above, which mgz doesn't cover. mgz's licence:
//
// MIT License
//
// Copyright (c) 2021 happyleavesaoc
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
'use strict';


const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

class Reader {
    constructor(bytes, pos = 0) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = pos;
    }
    get left() { return this.bytes.length - this.pos; }
    need(n) {
        if (n < 0 || this.pos + n > this.bytes.length) throw new RangeError(`read of ${n} past end at ${this.pos} of ${this.bytes.length}`);
    }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    i8() { this.need(1); return this.view.getInt8(this.pos++); }
    u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    i16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    i32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
    f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
    f64() { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
    u64() { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return Number(v); }
    skip(n) { this.need(n); this.pos += n; return this; }
    take(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
    // DE string: 60 0A, u16 length, UTF-8 bytes
    deString() {
        const at = this.pos;
        if (this.u8() !== 0x60 || this.u8() !== 0x0a) throw new Error(`no DE string at ${at}`);
        return utf8(this.take(this.u16()));
    }
    // AoC string: i16 length, raw bytes (encoding depends on the game language)
    aocString() { return this.take(this.i16()); }
    // Index of `pattern` (array of bytes) in [from, to), or -1
    find(pattern, from = this.pos, to = this.bytes.length) {
        return findBytes(this.bytes, pattern, from, to);
    }
}

function utf8(bytes) { return utf8Decoder.decode(bytes); }

function findBytes(bytes, pattern, from = 0, to = bytes.length) {
    const first = pattern[0], last = to - pattern.length;
    for (let i = bytes.indexOf(first, from); i !== -1 && i <= last; i = bytes.indexOf(first, i + 1)) {
        let j = 1;
        while (j < pattern.length && bytes[i + j] === pattern[j]) j++;
        if (j === pattern.length) return i;
    }
    return -1;
}

// The file's parts: u32 header length (including these 8 bytes), u32 next chapter offset, raw-deflate header, body
function splitFile(fileBytes) {
    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    const headerLength = view.getUint32(0, true);
    return { compressedHeader: fileBytes.subarray(8, headerLength), bodyStart: headerLength };
}

// Decodes the inflated header of an AoE2:DE recorded game (.aoe2record) from its start through the map tiles.
// Ported from mgz (happyleavesaoc/aoc-mgz, MIT licence) fast/header.py parse_version, parse_de, string_block,
// parse_metadata and parse_map, then corrected for save 67.2, 68 and 68.9 against the local corpus (see docs/replay-format/).
// Plain JS, no Node APIs: ReplayHeader.parseHeader(headerBytes) takes the inflated header as a Uint8Array.
// Load reader.js first (script tag, importScripts or concatenation); under Node it is required instead.

// Wrapped so its helper names stay private when the parser pieces share one script scope
const ReplayHeader = (function () {
    const ReaderClass = Reader;

    // Written between groups of lobby settings; checking it catches a misaligned read early
    const SEPARATOR = 0x00025fa3;
    // The 8 bytes before the map are DEADDEAD then 3 in every 67.2-68.9 file
    const MAP_MARKER = 0xdeaddead;
    const MAP_MARKER_BYTES = [0xad, 0xde, 0xad, 0xde, 3, 0, 0, 0];
    const MIN_SAVE = 67.2;

    // Player slot type (u32 in the DE player block), names as in mgz enums.PlayerTypeEnum
    const PLAYER_TYPES = {
        0: 'absent', 1: 'closed', 2: 'human', 3: 'eliminated', 4: 'computer', 5: 'cyborg', 6: 'spectator',
    };
    // Lobby starting/ending age as stored. 0 is "Standard": the game mode's own default (Dark in RM, Feudal in
    // Empire Wars, whatever a scenario sets), so it has no age id
    const AGES = { 0: 'standard', 2: 'dark', 3: 'feudal', 4: 'castle', 5: 'imperial', 6: 'postimperial' };

    function check(cond, what, r) {
        if (!cond) throw new Error(`header: ${what} at ${r.pos}`);
    }

    function separator(r) {
        const at = r.pos;
        check(r.u32() === SEPARATOR, `missing separator (read from ${at})`, r);
    }

    function flag(r) { return r.u8() !== 0; }

    // "VER 9.4\0", f32 -1, then the save version as u32 16.16 fixed point (rounded to 2 places as mgz does)
    function parseVersion(r) {
        const game = String.fromCharCode(...r.take(7));
        r.skip(1);
        const old = r.f32();
        check(old === -1, `old save version ${old}, expected -1 (pre-DE file?)`, r);
        const save = Math.round(r.u32() / 65536 * 100) / 100;
        return { game, save };
    }

    // mgz AgeEnum numbering (0 dark .. 4 post-imperial) for stored 2..6; null for Standard and unknown values
    function ageId(raw) {
        return raw >= 2 && raw <= 6 ? raw - 2 : null;
    }

    // One DE player slot. All 8 slots are written whatever the player count. Empty ones are type 1 (closed), or
    // rarely 0 (absent, still counted in numPlayers), with profile id -1 and player number -1.
    function parsePlayer(r, unknown) {
        const p = {};
        r.skip(4); // dlc id
        p.colorId = r.i32(); // lobby colour; the game's own is in the player block after the map
        r.skip(1); // selected colour
        p.selectedTeamId = r.u8();
        p.teamId = r.u8();
        r.skip(8); // dat crc
        r.skip(1); // mp game version
        p.civId = r.u32();
        // mgz custom_civ_selection: a saved custom-random list, not necessarily where civId came from
        const customCount = r.u32();
        p.customCivs = [];
        for (let i = 0; i < customCount; i++) p.customCivs.push(r.u32());
        p.aiType = r.deString();
        r.skip(1); // ai civ name index
        p.aiName = r.deString();
        p.censoredName = r.deString();
        p.name = r.deString();
        p.typeId = r.u32();
        p.type = PLAYER_TYPES[p.typeId] || `unknown ${p.typeId}`;
        p.profileId = r.i32();
        r.skip(4); // 0 for humans, -1 for AIs and empty slots
        p.number = r.i32();
        p.preferRandom = flag(r);
        r.skip(1); // custom ai
        r.skip(4); // first half of mgz's 8-byte handicap block, usually -1
        p.handicap = r.u32();
        r.skip(4); // mgz unknown_de_64_3
        unknown.push(r.deString()); // added after mgz's 66.6
        return p;
    }

    // Strings like "SUBSCRIBEDMODS:RANDOM_MAPS:<file>.rms:<mod id>_<name>:false", each after a u32 crc.
    // A u32 between 1 and 254 ends the block.
    function stringBlock(r) {
        const strings = [];
        for (;;) {
            const crc = r.u32();
            if (crc > 0 && crc < 255) return strings;
            strings.push(r.deString().split(':'));
        }
    }

    function hexBytes(bytes) {
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    // mgz prints the guid with Python's uuid.UUID(bytes=...), so keep the byte order as stored
    function guidString(bytes) {
        const h = hexBytes(bytes);
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    function parseDe(r) {
        const de = {};
        // Strings at places whose meaning is unknown; empty in the corpus, collected so a change shows up
        const unknown = [];
        r.skip(4 + 4 + 4); // f32 version, interval version, game options version
        const dlcCount = r.u32();
        check(dlcCount < 256, `dlc count ${dlcCount}`, r);
        de.dlcIds = [];
        for (let i = 0; i < dlcCount; i++) de.dlcIds.push(r.u32());
        r.skip(4); // dataset ref
        de.mapSize = r.u32();
        r.skip(4); // selected map id (resolved below)
        de.rmsMapId = r.i32(); // mgz reads it unsigned; campaigns store -3
        de.revealMapId = r.u32();
        de.victoryTypeId = r.u32();
        de.startingResourcesId = r.u32();
        de.startingAgeRaw = r.u32();
        de.endingAgeRaw = r.u32();
        // mgz fast turns 0 into 0 (dark) too, which is wrong for Empire Wars and scenarios
        de.startingAgeId = ageId(de.startingAgeRaw);
        de.endingAgeId = ageId(de.endingAgeRaw);
        de.startingAge = AGES[de.startingAgeRaw] || `unknown ${de.startingAgeRaw}`;
        de.endingAge = AGES[de.endingAgeRaw] || `unknown ${de.endingAgeRaw}`;
        de.gameTypeId = r.u32();
        separator(r);
        separator(r);
        de.speed = r.f32();
        de.treatyLength = r.u32();
        de.populationLimit = r.u32();
        de.numPlayers = r.u32();
        // Unused player colour, a byte, i32 victory amount (-1 or 0 in lobbies, 900 in a scenario; mgz has the
        // byte after the amount, but that would make the scenario's amount 0x038400)
        r.skip(4 + 1 + 4);
        separator(r);
        r.skip(1); // trade enabled
        // mgz fast reads this byte as the difficulty for save >= 61.5; mgz's construct calls it team_bonus_disabled
        de.difficultyId = r.u8();
        de.randomPositions = flag(r);
        de.allTechs = flag(r);
        r.skip(1); // starting units
        de.lockTeams = flag(r);
        de.lockSpeed = flag(r);
        de.multiplayer = flag(r);
        de.cheats = flag(r);
        de.recordGame = flag(r);
        de.animals = flag(r);
        de.predators = flag(r);
        de.turbo = flag(r);
        de.sharedExploration = flag(r);
        de.teamPositions = flag(r);
        r.skip(4 + 4 + 1 + 1); // sub game mode, battle royale time, handicap flag, a flag
        separator(r);
        de.slots = [];
        for (let i = 0; i < 8; i++) de.slots.push(parsePlayer(r, unknown));
        de.players = de.slots.filter(isRealPlayer);
        r.skip(9);
        r.skip(3); // fog of war, cheat notifications, coloured chat
        separator(r);
        de.rated = flag(r);
        de.allowSpecs = flag(r);
        de.visibility = r.u32();
        de.hiddenCivs = flag(r);
        de.matchmaking = flag(r); // 1 in exactly the rated games, which have no lobby name
        de.specDelay = r.u32();
        r.skip(1); // scenario civ
        de.strings = stringBlock(r);
        r.skip(8);
        for (let i = 0; i < 20; i++) de.strings.push(...stringBlock(r));
        const strategicNumbers = r.u32();
        check(strategicNumbers < 1024, `strategic number count ${strategicNumbers}`, r);
        r.skip(strategicNumbers * 4);
        const aiFiles = r.u64();
        check(aiFiles < 64, `ai file count ${aiFiles}`, r);
        de.aiFiles = [];
        for (let i = 0; i < aiFiles; i++) {
            r.skip(4);
            de.aiFiles.push(r.deString());
            r.skip(4);
        }
        r.skip(8);
        // The lobby's match id: a restarted game keeps it, so it does not identify one recording
        de.guid = guidString(r.take(16));
        de.lobby = r.deString();
        r.skip(8);
        de.mod = r.deString();
        de.tailTimestamp = parseDeTail(r, unknown);
        de.unknownStrings = unknown.filter(s => s !== '');
        de.rmsModId = null;
        de.rmsFilename = null;
        for (const s of de.strings) {
            if (s[0] === 'SUBSCRIBEDMODS' && s[1] === 'RANDOM_MAPS') {
                de.rmsModId = s[3].split('_')[0];
                de.rmsFilename = s[2];
            }
        }
        return de;
    }

    // What sits between the mod name and the metadata. mgz skips most of it as fixed bytes; two of those are
    // DE strings, so they are read as strings here in case one is ever non-empty.
    function parseDeTail(r, unknown) {
        r.skip(27);
        unknown.push(r.deString());
        r.skip(11 + 4 + 4 + 16 + 2 + 24); // ..., i32 -1, u32, 16-byte id, 01 07, ...
        // u32 count, u32, count small u32 ids, u32, u32 (mgz: count, 12 bytes, count * 4)
        const count = r.u32();
        check(count < 1024, `tail count ${count}`, r);
        r.skip(12 + count * 4);
        // mgz reads one string and 8 bytes here; there are three strings, then u32, u32, u32 unix time, u32
        for (let i = 0; i < 3; i++) unknown.push(r.deString());
        r.skip(8);
        const time = r.u32();
        r.skip(4);
        return time;
    }

    // A real seat has a player number >= 1; empty slots (closed or absent) have number -1. Recordings hold only
    // human (2) and computer (4) seats, but saved games also have eliminated (3) players: humans who left, still
    // with their name, profile, colour and number, so a recording restored from a save may too
    function isRealPlayer(p) {
        return p.number >= 1 && p.typeId >= 2 && p.typeId <= 5;
    }

    // mgz's 'replay' struct, after a u32 that is 1 when AI scripts follow. Its fixed size puts the map marker
    // at start + 74 + 4 * numPlayers, which is how a start is confirmed.
    function parseMetadata(r) {
        const ai = r.u32();
        if (ai > 0) skipAi(r);
        check(metadataFits(r.bytes, r.pos), 'metadata not followed by the map marker', r);
        r.skip(24);
        const speed = r.f32();
        r.skip(17);
        const ownerId = r.i16();
        const numPlayers = r.u8(); // including gaia
        r.skip(1);
        const cheats = r.u8() === 1;
        r.skip(24 + numPlayers * 4);
        return { speed, ownerId, numPlayers, cheats };
    }

    function metadataFits(bytes, at) {
        if (at < 0 || at + 48 > bytes.length) return false;
        const end = at + 74 + 4 * bytes[at + 47];
        if (end + 4 > bytes.length) return false;
        return (bytes[end] | bytes[end + 1] << 8 | bytes[end + 2] << 16 | bytes[end + 3] << 24) >>> 0 === MAP_MARKER;
    }

    // The AI data is not decoded: its end is found from the map marker after the metadata. The first marker whose
    // metadata (74 + 4 * numPlayers bytes before it) holds that numPlayers and an owner below it is taken. mgz
    // instead looks for the first run of 4096 zero bytes: an order of magnitude slower on megabytes of AI data,
    // and some saved games with AI have no such run.
    function skipAi(r) {
        for (let at = r.find(MAP_MARKER_BYTES); at >= 0; at = r.find(MAP_MARKER_BYTES, at + 1)) {
            for (let np = 1; np <= 9; np++) {
                const start = at - 74 - 4 * np;
                if (start < r.pos || r.bytes[start + 47] !== np) continue;
                // The owner (i16 at +45) is a player number; checking it stops a seed byte from passing as the count
                if (r.bytes[start + 46] === 0 && r.bytes[start + 45] < np) {
                    r.pos = start;
                    return;
                }
            }
        }
        check(false, 'no metadata and map marker after the AI data', r);
    }

    function parseMap(r) {
        const marker = r.u32();
        check(marker === MAP_MARKER, `map marker ${marker.toString(16)}`, r);
        r.skip(4);
        const sizeX = r.u32();
        const sizeY = r.u32();
        check(sizeX === sizeY && sizeX > 0 && sizeX <= 512, `map size ${sizeX}x${sizeY}`, r);
        const tileCount = sizeX * sizeY;
        const zones = r.u32();
        check(zones < 64, `zone count ${zones}`, r);
        for (let i = 0; i < zones; i++) {
            r.skip(2048 + tileCount * 2);
            r.skip(r.u32() * 4);
            r.skip(4);
        }
        // mgz's all_visible byte is 0 in every corpus file, All Visible lobbies included. The next byte is the
        // one that follows the lobby: 0 exactly when revealMapId is 2 (All Visible), else 1
        const allVisible = flag(r);
        const fogOfWar = flag(r);
        r.need(tileCount * 10);
        // Tiles are 10 bytes: terrain, 0xff, terrain again (differs only where terrain is farm 7 or foundation 6/27,
        // so probably the terrain underneath), elevation, ff ff, then two u16
        const terrain = new Uint8Array(tileCount);
        const elevation = new Uint8Array(tileCount);
        const bytes = r.bytes;
        let at = r.pos;
        for (let i = 0; i < tileCount; i++, at += 10) {
            terrain[i] = bytes[at];
            elevation[i] = bytes[at + 3];
        }
        r.pos = at;
        const dataCount = r.u32();
        check(dataCount < 65536, `obstruction data count ${dataCount}`, r);
        r.skip(4 + dataCount * 4);
        for (let i = 0; i < dataCount; i++) r.skip(r.u32() * 8);
        const sizeX2 = r.u32();
        const sizeY2 = r.u32();
        check(sizeX2 === sizeX && sizeY2 === sizeY, `visibility size ${sizeX2}x${sizeY2}`, r);
        r.skip(tileCount * 4 * 2);
        const restoreTime = r.u32();
        return { dimension: sizeX, allVisible, fogOfWar, terrain, elevation, restoreTime };
    }

    function parseHeader(headerBytes) {
        const r = new ReaderClass(headerBytes);
        const { game, save } = parseVersion(r);
        check(save >= MIN_SAVE, `save ${save} is older than ${MIN_SAVE}`, r);
        // mgz's parse_de starts at the build
        const offsets = { de: r.pos };
        const build = r.u32();
        const timestamp = r.u32();
        const de = parseDe(r);
        offsets.meta = r.pos;
        const meta = parseMetadata(r);
        offsets.map = r.pos;
        const map = parseMap(r);
        offsets.afterMap = r.pos;
        return { game, save, build, timestamp, de, meta, map, offsets };
    }

    return { parseHeader, isRealPlayer, PLAYER_TYPES, AGES };
})();

// Players' starting state (the header's per-player records: attributes, then the object lists) and the map's name.
// A port of mgz/fast/header.py parse_players / parse_player / object_block / parse_object (MIT, happyleavesaoc/aoc-mgz),
// fixed for save versions 67.2, 68 and 68.9. Plain JS, no Node APIs: ReplayObjects.parsePlayers(headerBytes, ...) takes
// the inflated header as a Uint8Array. Load reader.js first (script tag, importScripts or concatenation); under Node it
// is required instead. See docs/replay-format/ for the layout and the evidence.

// Wrapped so its helper names stay private when the parser pieces share one script scope. reader.js's names are
// global bindings when it is loaded as a script, so they are picked up outside the wrapper, where nothing shadows them.
const ReplayObjects = (function (lib) {
    if (!lib) throw new Error('objects.js: load reader.js first');
    const { Reader, findBytes, utf8 } = lib;

    // u16 name length 5 + "Gaia\0": gaia's name field, the anchor mgz uses to find the first player record
    const GAIA_ANCHOR = [5, 0, 0x47, 0x61, 0x69, 0x61, 0];
    const MAX_PLAYERS = 9;
    // Object class bytes the scanner accepts (mgz CLASSES). No other class occurs at game start in the corpus.
    const SCAN_CLASS = new Uint8Array(256);
    for (const c of [10, 20, 30, 70, 80]) SCAN_CLASS[c] = 1;
    // The fixed head every object shares: class, owner, type, sprite, garrisoned-in id, hp, state, sleep, doppelganger,
    // go-to-sleep, instance id (+18), facet, x (+23), y (+27). The scanner only needs these 31 bytes.
    const OBJECT_HEAD = 31;
    // mgz's search window for the next object; only used when no player-end record is found
    const SEARCH_WINDOW = 10000;
    // Type 647 ("HRICH_D"): thousands of invisible RMS helpers (hp -1, no sprite) on whole tiles near the starts, gone
    // from build 188329 on. mgz drops them too; they are scanned (they keep the list framing honest) but not returned.
    const HELPER_TYPES = new Set([647]);
    // The 28 bytes closing each player record after its last list's 00 0b: 00 0b, then mgz's PLAYER_END (ff x8, one
    // byte, 16 zero bytes, 0b). The next player's record follows directly.
    const PLAYER_END_LENGTH = 28;
    // f32 2.1, the points (score) block version that follows the last player record (mgz parse_players, save >= 61.5)
    const POINTS_VERSION = [0x66, 0x66, 0x06, 0x40];

    // Internal civ name (67.2+ player records carry it instead of the civ byte) -> the civ id the lobby settings use.
    // Every pair is checked against those lobby ids across the whole local corpus (test-objects.js); civs not seen
    // there (55, 63+) are left out, not guessed.
    const CIV_IDS = {
        'BRITON-CIV': 1, 'FRANKISH-CIV': 2, 'GOTHIC-CIV': 3, 'TEUTONIC-CIV': 4, 'JAPANESE-CIV': 5, 'CHINESE-CIV': 6,
        'BYZANTINE-CIV': 7, 'PERSIAN-CIV': 8, 'SARACEN-CIV': 9, 'TURKISH-CIV': 10, 'VIKING-CIV': 11, 'MONGOL-CIV': 12,
        'CELTIC-CIV': 13, 'SPANISH-CIV': 14, 'AZTEC-CIV': 15, 'MAYAN-CIV': 16, 'HUN-CIV': 17, 'KOREAN-CIV': 18,
        'ITALIAN-CIV': 19, 'INDIAN-CIV': 20, 'INCAN-CIV': 21, 'MAGYAR-CIV': 22, 'SLAVIC-CIV': 23, 'PORTUGUESE-CIV': 24,
        'ETHIOPIAN-CIV': 25, 'MALIAN-CIV': 26, 'BERBERS-CIV': 27, 'KHMER-CIV': 28, 'MALAY-CIV': 29, 'BURMESE-CIV': 30,
        'VIETNAMESE-CIV': 31, 'BULGARIANS-CIV': 32, 'TATARS-CIV': 33, 'CUMANS-CIV': 34, 'LITHUANIANS-CIV': 35,
        'BURGUNDIANS-CIV': 36, 'SICILIANS-CIV': 37, 'POLES-CIV': 38, 'BOHEMIANS-CIV': 39, 'DRAVIDIANS-CIV': 40,
        'BENGALIS-CIV': 41, 'GURJARAS-CIV': 42, 'ROMANS-CIV': 43, 'ARMENIANS-CIV': 44, 'GEORGIANS-CIV': 45,
        'ACHAEMENIDS-CIV': 46, 'ATHENIANS-CIV': 47, 'SPARTANS-CIV': 48, 'SHU-CIV': 49, 'WU-CIV': 50, 'WEI-CIV': 51,
        'JURCHENS-CIV': 52, 'KHITANS-CIV': 53, 'MACEDONIANS-CIV': 54, 'PURU-CIV': 56, 'MUISCA-CIV': 57,
        'MAPUCHE-CIV': 58, 'TUPI-CIV': 59, 'SAXONS-CIV': 60, 'VARANGIANS-CIV': 61, 'DANES-CIV': 62,
    };

    function viewOf(d) {
        return new DataView(d.buffer, d.byteOffset, d.byteLength);
    }

    // --- player records -----------------------------------------------------------------------------------------

    // Gaia's record start for `n` players including gaia, or -1. Gaia's diplomacy is fixed (it is everyone's enemy),
    // so the right n is the one whose bytes before the anchor read as gaia's record.
    function gaiaStartFor(d, anchor, n) {
        const start = anchor - 7 - 5 * n;
        if (start < 0 || d[start] !== 2 || d[start + 1] !== 0x0b) return -1;
        const v = viewOf(d);
        if (d[start + 2] !== 0 || v.getInt32(start + 2 + n, true) !== 1) return -1;
        for (let i = 1; i < n; i++) {
            if (d[start + 2 + i] !== 3 || v.getInt32(start + 2 + n + 4 * i, true) !== 4) return -1;
        }
        return start;
    }

    // { start, n } of gaia's record. Pass n to check it; omit it to detect it (the only n in 2..9 that validates).
    function locateGaia(d, n, from = 0) {
        for (let anchor = findBytes(d, GAIA_ANCHOR, from); anchor !== -1; anchor = findBytes(d, GAIA_ANCHOR, anchor + 1)) {
            if (n) {
                const start = gaiaStartFor(d, anchor, n);
                if (start !== -1) return { start, n };
                continue;
            }
            const found = [];
            for (let k = 2; k <= MAX_PLAYERS; k++) {
                const start = gaiaStartFor(d, anchor, k);
                if (start !== -1) found.push({ start, n: k });
            }
            if (found.length === 1) return found[0];
        }
        return null;
    }

    // Players including gaia, read from gaia's record (independent of the header's metadata section)
    function detectPlayerCount(d, from = 0) {
        const g = locateGaia(d, null, from);
        return g ? g.n : null;
    }

    // The attributes that open a player record (mgz header/initial.py attributes, with the 67.2+ civ name string)
    function readAttributes(d, pos, n, save) {
        const r = new Reader(d, pos);
        const type = r.u8();
        r.u8(); // 0x0b
        const theirDiplomacy = Array.from(r.take(n));
        const diplomacy = [];
        for (let i = 0, reps = save >= 61.5 ? n : 9; i < reps; i++) diplomacy.push(r.i32());
        r.skip(5); // u32 allied LOS, u8 allied victory
        const name = utf8(r.take(r.u16() - 1));
        r.skip(2); // 00 (name terminator), 0x16
        const resourceCount = r.u32();
        r.u8(); // 0x21
        const resAt = r.pos;
        // 63+ stores two 4-byte values per resource: the amounts first, then a second array of the same length
        r.skip(resourceCount * (save >= 63 ? 8 : 4));
        const currentAge = resourceCount > 6 ? r.view.getFloat32(resAt + 24, true) : null; // 0 dark .. 3 imperial
        const resources = resourceCount >= 4 ? {
            food: r.view.getFloat32(resAt, true), wood: r.view.getFloat32(resAt + 4, true),
            stone: r.view.getFloat32(resAt + 8, true), gold: r.view.getFloat32(resAt + 12, true),
        } : null;
        r.u8(); // 0x0b
        const start = { x: r.f32(), y: r.f32() };
        const savedViews = r.i32();
        if (savedViews > 0) r.skip(savedViews * 8); // present in restored games (mgz)
        r.skip(5); // u16 spawn x, u16 spawn y (the same tile as the camera for players), u8 culture
        let civName = null, civId = null, colorId;
        if (d[r.pos] === 0x60 && d[r.pos + 1] === 0x0a) {
            // 67.2+: the civ's internal name replaces the civ byte; then 6 zero bytes, 0b, colour, 0b
            civName = r.deString();
            r.skip(6);
            if (r.u8() !== 0x0b) throw new Error(`player ${pos}: no 0b before the colour`);
            colorId = r.u8();
            if (r.u8() !== 0x0b) throw new Error(`player ${pos}: no 0b after the colour`);
            civId = Object.prototype.hasOwnProperty.call(CIV_IDS, civName) ? CIV_IDS[civName] : null;
        } else {
            // mgz layout up to 66.6 (not in the local corpus): civ, game status, resigned, pad, colour, pad
            civId = r.u8();
            r.skip(3);
            colorId = r.u8();
            r.skip(1);
        }
        return { type, name, diplomacy, theirDiplomacy, resources, currentAge, start, civName, civId, colorId, end: r.pos };
    }

    // --- object lists -------------------------------------------------------------------------------------------

    // mgz's object regex: an accepted class, this owner, a type that is not 0 or ffff, garrisoned-in id -1, and an hp
    // whose low byte is not ff. Also requires 0/1 sleep, doppelganger and go-to-sleep flags (true of every object in
    // the corpus), which rejects look-alikes inside object bodies. Unlike mgz it also accepts a unit garrisoned in one
    // of `containers` (offsets of the unit or building just found and of the units found inside it): a garrisoned
    // unit is stored inside its container's record, and carries the container's id and exactly its position.
    function objectAt(d, i, owner, containers) {
        if (SCAN_CLASS[d[i]] !== 1 || d[i + 1] !== owner || d[i + 10] === 255
            || (d[i + 2] === 255 && d[i + 3] === 255) || (d[i + 2] === 0 && d[i + 3] === 0)
            || d[i + 15] > 1 || d[i + 16] > 1 || d[i + 17] > 1) return false;
        if (d[i + 6] === 255 && d[i + 7] === 255 && d[i + 8] === 255 && d[i + 9] === 255) return true;
        if (!containers) return false;
        for (const c of containers) {
            let same = true;
            for (let k = 0; k < 4 && same; k++) same = d[i + 6 + k] === d[c + 18 + k];
            for (let k = 0; k < 8 && same; k++) same = d[i + 23 + k] === d[c + 23 + k];
            if (same) return true;
        }
        return false;
    }

    function nextObject(d, from, to, owner, containers) {
        const end = Math.min(to, d.length - OBJECT_HEAD);
        for (let i = from; i < end; i++) {
            if (d[i + 1] === owner && objectAt(d, i, owner, containers)) return i;
        }
        return -1;
    }

    // "00 0b" closes each object list; the next list opens with u32 capacity, u32 growth (8 bytes) before its objects
    function listBreakBefore(d, i, floor) {
        return i - 10 >= floor && d[i - 10] === 0 && d[i - 9] === 0x0b;
    }

    // The main list opens with u32 capacity (a multiple of the growth), u32 growth 512, right after a 0b (mgz's object
    // start regex 0b 00 ?? 00 00 00 02 00 00, which caps the capacity at 65280; this allows up to 2^24). The first
    // match whose list is well formed is taken: the list starts with an object of this owner, or is empty (00 0b).
    function findObjectLists(d, from, owner) {
        for (let s = d.indexOf(2, from + 6); s !== -1; s = d.indexOf(2, s + 1)) {
            if (d[s - 6] !== 0x0b || d[s - 5] !== 0 || (d[s - 4] & 1) !== 0 || d[s - 2] !== 0 || d[s - 1] !== 0
                || d[s + 1] !== 0 || d[s + 2] !== 0) continue;
            const start = s + 3;
            if (objectAt(d, start, owner) || (d[start] === 0 && d[start + 1] === 0x0b)) return start;
        }
        return -1;
    }

    // Start of the player-end record (see PLAYER_END_LENGTH) at or after `from` that directly follows a list
    // terminator, or -1
    function findPlayerEnd(d, from) {
        const ff8 = [255, 255, 255, 255, 255, 255, 255, 255];
        for (let i = findBytes(d, ff8, from + 4); i !== -1; i = findBytes(d, ff8, i + 1)) {
            if (d[i + 25] !== 0x0b || d[i - 2] !== 0 || d[i - 1] !== 0x0b || d[i - 4] !== 0 || d[i - 3] !== 0x0b) continue;
            let zeros = true;
            for (let k = 9; k < 25 && zeros; k++) zeros = d[i + k] === 0;
            if (zeros) return i - 2;
        }
        return -1;
    }

    function readObject(v, d, i) {
        const o = {
            classId: d[i], typeId: v.getUint16(i + 2, true), id: v.getUint32(i + 18, true),
            x: v.getFloat32(i + 23, true), y: v.getFloat32(i + 27, true),
        };
        const garrison = v.getInt32(i + 6, true);
        if (garrison !== -1) o.garrisonedIn = garrison;
        return o;
    }

    // Scans one player's three object lists (objects, sleeping objects, doppelgangers) from the main list's start.
    // Returns the lists, the player-end record's position, and the last object's byte length when the framing proves it.
    function scanObjectLists(d, start, owner) {
        const v = viewOf(d);
        const lists = [[], [], []];
        const at = [[], [], []];
        let list = 0, pos = start;
        // Empty lists at the start: 00 0b, then the next list's 8-byte header
        while (list < 2 && d[pos] === 0 && d[pos + 1] === 0x0b) { list++; pos += 10; }
        let playerEnd = findPlayerEnd(d, pos);
        let cursor = pos;
        // offsets of the last top-level unit or building and of the units found inside it since
        let containers = [];
        for (;;) {
            const limit = playerEnd !== -1 ? playerEnd : cursor + SEARCH_WINDOW;
            const m = nextObject(d, cursor, limit, owner, containers);
            if (m === -1) break;
            if (m !== pos) {
                // A list break 10 bytes before; another 10 before that means a list in between was empty
                let breaks = 0;
                while (listBreakBefore(d, m - 10 * breaks, cursor)) breaks++;
                list += breaks;
                if (list > 2) break;
            }
            const o = readObject(v, d, m);
            if (o.garrisonedIn === undefined) containers = [];
            if (o.classId === 70 || o.classId === 80) containers.push(m);
            lists[list].push(o);
            at[list].push(m);
            cursor = m + OBJECT_HEAD;
            if (playerEnd !== -1 && playerEnd < cursor) playerEnd = findPlayerEnd(d, cursor);
        }
        // The last object ends at the terminator chain before the player-end record: the doppelganger list's 00 0b,
        // then 8-byte header + 00 0b back per list after the last non-empty one
        let lastLength = null;
        let last = 2;
        while (last >= 0 && at[last].length === 0) last--;
        if (playerEnd !== -1 && last >= 0) {
            const lastAt = at[last][at[last].length - 1];
            let end = playerEnd - 2;
            for (let k = last; k < 2; k++) {
                if (d[end - 10] !== 0 || d[end - 9] !== 0x0b) { end = -1; break; }
                end -= 10;
            }
            if (end > lastAt) lastLength = end - lastAt;
        }
        return { lists, at, playerEnd, lastLength };
    }

    // --- section ------------------------------------------------------------------------------------------------

    // The points (score) blocks after the last player record, one per player (mgz parse_players): f32 version 2.1,
    // i32 n, 5 + n * 44 bytes, i32 m, 8 + m * 32 bytes. Returns where the scenario section starts, or -1.
    function skipPoints(d, pos, n) {
        const r = new Reader(d, pos);
        try {
            for (let i = 0; i < n; i++) {
                if (Math.abs(r.f32() - 2.1) > 1e-6) return -1;
                r.skip(5 + r.i32() * 44);
                r.skip(8 + r.i32() * 32);
            }
        } catch (e) {
            return -1;
        }
        return r.pos;
    }

    // The whole player section: every player's attributes and starting objects, where the section ends (the points
    // blocks start there) and where the scenario section starts after them. opts: { from: search start for the gaia
    // anchor, keepHelpers: also return the type 647 helpers, layout: add each player's byte offsets }.
    // complete is true when all n records were read to their trailer and the points version follows; a cut header
    // gives fewer players or a last player with part of its objects, complete false and a warning saying where.
    // Throws when gaia's record cannot be found, or when a record's attributes or list start cannot be read.
    function parsePlayerSection(d, save, numPlayersIncludingGaia, opts = {}) {
        const gaia = locateGaia(d, numPlayersIncludingGaia || null, opts.from || 0);
        if (!gaia) throw new Error('player records not found (no gaia record for that player count)');
        const n = gaia.n;
        const players = [];
        const warnings = [];
        let pos = gaia.start;
        for (let number = 0; number < n; number++) {
            const attrs = readAttributes(d, pos, n, save);
            const listStart = findObjectLists(d, attrs.end, number);
            if (listStart === -1) throw new Error(`player ${number}: object lists not found`);
            const scan = scanObjectLists(d, listStart, number);
            if (scan.playerEnd === -1) warnings.push(`player ${number}: no player-end record (header cut?)`);
            else if (scan.lastLength === null && scan.at.some(a => a.length)) warnings.push(`player ${number}: last object's end not proven`);
            const keep = o => opts.keepHelpers || !HELPER_TYPES.has(o.typeId);
            players.push({
                number,
                type: attrs.type,
                name: attrs.name,
                diplomacy: attrs.diplomacy,
                theirDiplomacy: attrs.theirDiplomacy,
                civId: attrs.civId,
                civName: attrs.civName,
                colorId: attrs.colorId,
                resources: attrs.resources,
                start: attrs.start,
                objects: scan.lists[0].filter(keep).concat(scan.lists[1].filter(keep)),
                doppelgangers: scan.lists[2],
            });
            if (opts.layout) {
                players[number].layout = { record: pos, lists: listStart, objectAt: scan.at, lastLength: scan.lastLength, trailer: scan.playerEnd };
            }
            if (scan.playerEnd === -1) { pos = -1; break; }
            pos = scan.playerEnd + PLAYER_END_LENGTH;
        }
        const pointsAt = pos !== -1 && findBytes(d, POINTS_VERSION, pos, pos + 4) === pos;
        if (pos !== -1 && !pointsAt) warnings.push(`section end ${pos} is not followed by the points version`);
        const complete = warnings.length === 0 && players.length === n;
        const scenarioStart = pointsAt ? skipPoints(d, pos, n) : -1;
        if (pointsAt && scenarioStart === -1) warnings.push(`points blocks at ${pos} do not parse (header cut?)`);
        return { players, start: gaia.start, end: pos, scenarioStart, n, complete, warnings };
    }

    // [{ number, type, name, diplomacy, civId, colorId, start: { x, y }, objects: [{ classId, typeId, id, x, y }] }],
    // gaia first. diplomacy is the i32 stance toward each player (0 gaia, 1 self, 2 ally, 3 neutral, 4 enemy; under a
    // treaty everyone reads 2). start is the starting camera point: for players the starting Town Center's centre,
    // which is a tile corner (integer coordinates). Extra fields: theirDiplomacy (u8 per player: 0 ally or self,
    // 3 enemy, 4 treaty), civName, resources { food, wood, stone, gold }, doppelgangers. Throws when the section is
    // incomplete (a cut header) rather than return part of it; parsePlayerSection returns the part with complete false.
    function parsePlayers(headerBytes, save, numPlayersIncludingGaia) {
        const section = parsePlayerSection(headerBytes, save, numPlayersIncludingGaia);
        if (!section.complete) throw new Error(`player section incomplete: ${section.warnings.join('; ')}`);
        return section.players;
    }

    // --- map name -----------------------------------------------------------------------------------------------

    function encode(text) {
        return Array.from(new TextEncoder().encode(text));
    }

    // The scenario instructions' location line, by game language (UTF-8 entries of mgz/common/map.py
    // ENCODING_MARKERS; DE writes UTF-8). Only English is in the local corpus; the others are mgz's word for them.
    const LOCATION_MARKERS = [
        ['Location: ', 'en'], ['Map Type: ', 'en'], ['Map type: ', 'en'], ['Ubicación: ', 'es'], ['Ubicaci: ', 'es'],
        ['Local: ', 'pt'], ['Karte: ', 'de'], ['Emplacement :', 'fr'], ['Emplacement: ', 'fr'], ['Posizione: ', 'it'],
        ['Lokalizacja: ', 'pl'], ['Konum: ', 'tr'], ['Расположение: ', 'ru'], ['マップ ', 'jp'], ['位置：', 'zh'],
        ['舞台: ', 'zh'], ['Vị trí: ', 'vi'], ['위치: ', 'kr'], ['Τύπος Χάρτη: ', 'gr'], ['Mapa: ', 'cs'], ['Plats: ', 'se'],
    ].map(([text, language]) => ({ bytes: encode(text), language }));
    // The markers' first bytes, so most line starts are rejected with one lookup
    const MARKER_FIRST = new Uint8Array(256);
    for (const m of LOCATION_MARKERS) MARKER_FIRST[m.bytes[0]] = 1;

    // DE's names for the lobby sizes, as its English size lines write them ("Huge [240]"); only sizes seen in the
    // corpus or certain (Small) are listed
    const SIZE_LABELS = { 120: 'Tiny', 144: 'Small', 168: 'Medium', 200: 'Normal', 220: 'Large', 240: 'Huge', 480: 'Ludicrous' };
    const RANDOM_MAPS_KEY = encode(':RANDOM_MAPS:');
    const SCENARIO_EXT = encode('.aoe2scenario');
    // u32 DEADDEAD, u32 3: the map section's start. The lobby settings and their strings all come before it.
    const MAP_MARKER = [0xad, 0xde, 0xad, 0xde, 3, 0, 0, 0];

    function startsWith(d, at, bytes) {
        if (at + bytes.length > d.length) return false;
        for (let k = 0; k < bytes.length; k++) if (d[at + k] !== bytes[k]) return false;
        return true;
    }

    function lineAt(d, from) {
        let end = from;
        while (end < d.length && d[end] !== 0x0a && d[end] !== 0) end++;
        return { text: utf8(d.subarray(from, Math.min(end, from + 256))).trim(), next: end + 1 };
    }

    // The first line at or after `from` that starts with a location marker (the instructions text is \n-separated;
    // the location line is never its first line in the corpus, so a line start means after a \n). One pass.
    function findLocationLine(d, from) {
        for (let i = d.indexOf(0x0a, from); i !== -1; i = d.indexOf(0x0a, i + 1)) {
            if (MARKER_FIRST[d[i + 1]] !== 1) continue;
            for (const m of LOCATION_MARKERS) {
                if (startsWith(d, i + 1, m.bytes)) return { at: i + 1 + m.bytes.length, language: m.language };
            }
        }
        return null;
    }

    // "Huge [240]", "Tiny (2 player) [120]": the label without its player count, and the tile count in the bracket
    function parseSizeLine(text) {
        if (text.length > 200) return null; // the longest real line is 33 characters
        const m = /^(?:[^:\n]*:\s*)?(.*?)\s*\[(\d{2,4})\]\s*$/.exec(text);
        if (!m) return null;
        return { label: m[1].replace(/\s*\([^)]*\)$/, '') || null, tiles: Number(m[2]) };
    }

    // The DE string (60 0a, u16 length, text) that contains offset `at`, or null. The kind before ":RANDOM_MAPS:" is
    // a short word, so the string starts at most 40 bytes back.
    function deStringAround(d, at) {
        for (let s = at - 4; s >= Math.max(0, at - 40); s--) {
            if (d[s] !== 0x60 || d[s + 1] !== 0x0a) continue;
            const end = s + 4 + (d[s + 2] | d[s + 3] << 8);
            if (end > at && end <= d.length) return utf8(d.subarray(s + 4, end));
        }
        return null;
    }

    // The <kind>:RANDOM_MAPS:<file>.rms:<mod>:<bool> strings of the lobby settings (mgz parse_de), kind SUBSCRIBEDMODS,
    // USER or BASE: random maps the host's lobby names. Often there are two, and most games carrying one were played
    // on the built-in map the instructions name, so a file here is not the map played unless the location says so.
    function findRandomMaps(d) {
        let end = findBytes(d, MAP_MARKER);
        if (end === -1) end = d.length;
        const files = [];
        for (let i = findBytes(d, RANDOM_MAPS_KEY, 0, end); i !== -1; i = findBytes(d, RANDOM_MAPS_KEY, i + 1, end)) {
            const text = deStringAround(d, i);
            const parts = text === null ? [] : text.split(':');
            if (parts[1] === 'RANDOM_MAPS' && parts[2]) files.push(parts[2]);
        }
        return files;
    }

    // The lobby's map settings (mgz parse_de): the DE block opens with u32 build, u32 time, 12 bytes, u32 dlc count,
    // the dlc ids, u32 dataset, u32 map size (mgz map_dimension), u32, i32 map id. { size, mapId } or null. The map
    // section's grid can be larger than the size (Nomad).
    function lobbyMap(d) {
        if (d.length < 16) return null;
        const v = viewOf(d);
        // "VER 9.4\0", f32 -1 and u32 save * 65536; an f32 save at +8 instead in older files
        const de = v.getFloat32(8, true) === -1 ? 16 : 12;
        if (de + 24 > d.length) return null;
        const dlcs = v.getUint32(de + 20, true);
        const at = de + 24 + 4 * dlcs + 4;
        if (dlcs > 255 || at + 12 > d.length) return null;
        const size = v.getUint32(at, true);
        return { size: size > 0 && size <= 1000 ? size : null, mapId: v.getInt32(at + 8, true) };
    }

    // mgz lookup_name: lobby map ids that mean the map is the custom one (59 RM custom, 137 custom map pool, 138 DM
    // custom)
    const CUSTOM_MAP_IDS = new Set([59, 137, 138]);

    // A scenario game's file name: the i16-length string ending ".aoe2scenario" (mgz parse_scenario
    // scenario_filename), usually a path. Its base name without the extension, or null. Lobby strings that name a
    // scenario do not end at the extension (":<mod>:<bool>" follows) and are skipped by the length check.
    function findScenarioFile(d, from) {
        for (let i = findBytes(d, SCENARIO_EXT, from); i !== -1; i = findBytes(d, SCENARIO_EXT, i + 1)) {
            const end = i + SCENARIO_EXT.length;
            // Walk back to the length prefix; text bytes read as u16 are far larger than any distance here
            for (let p = end - 3; p >= Math.max(0, end - 520); p--) {
                if (p + 2 + (d[p] | (d[p + 1] << 8)) !== end) continue;
                const path = utf8(d.subarray(p + 2, end));
                return path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1).replace(/\.aoe2scenario$/, '');
            }
        }
        return null;
    }

    function baseName(file) {
        return file.replace(/\.rms$/i, '');
    }

    // { name, sizeLabel, sizeTiles, language, source, customMap, randomMaps } or null.
    // name: the instructions' location line (source 'instructions'); else the scenario file (source 'scenario': every
    // game without a location line in the corpus is a scenario or campaign); else, when the lobby's map id says a
    // custom map was played and the lobby names exactly one random-map file, that file (source 'customMap', reached in
    // the corpus only on a header cut before the instructions). sizeTiles is the lobby's map size: the size line after the location ("[240]"), else the
    // lobby settings' u32. The map section's own dimension is the true grid and can differ (Nomad: 220 here, 231
    // there), so draw a minimap from that. sizeLabel is DE's English name for the size ("Large"; a localized one from
    // a non-English size line), or null for a size with no name. customMap is the lobby random-map file the location
    // names (a custom map was played), else null; randomMaps lists every such file, played or not.
    // opts.from: where to start looking for the instructions and the scenario file (parsePlayerSection's
    // scenarioStart); without it the whole header is searched, about 10 times slower, same result.
    function findMapName(headerBytes, opts = {}) {
        const d = headerBytes;
        const from = opts.from > 0 ? opts.from : 0;
        const lobby = lobbyMap(d);
        const randomMaps = findRandomMaps(d);
        const marker = findLocationLine(d, from);
        let name = null, sizeLabel = null, sizeTiles = null, language = null, source = null;
        if (marker) {
            const loc = lineAt(d, marker.at);
            name = loc.text.replace(/\.rms$/i, '') || null;
            language = marker.language;
            source = 'instructions';
            // The size line follows the location line in every language seen; check the next two lines for "[N]"
            let next = loc.next;
            for (let k = 0; k < 2 && sizeTiles === null; k++) {
                const line = lineAt(d, next);
                const size = parseSizeLine(line.text);
                if (size) ({ label: sizeLabel, tiles: sizeTiles } = size);
                next = line.next;
            }
        }
        if (!name) {
            name = findScenarioFile(d, from);
            source = 'scenario';
        }
        // The lobby strings name random maps the host's lobby knows; only a custom map id says one was played
        if (!name && lobby && CUSTOM_MAP_IDS.has(lobby.mapId) && randomMaps.length === 1) {
            name = baseName(randomMaps[0]);
            source = 'customMap';
        }
        if (!name) return null;
        if (sizeTiles === null && lobby) sizeTiles = lobby.size;
        if (sizeLabel === null && sizeTiles !== null) sizeLabel = SIZE_LABELS[sizeTiles] || null;
        const customMap = randomMaps.find(f => baseName(f) === name) || null;
        return { name, sizeLabel, sizeTiles, language, source, customMap, randomMaps };
    }

    return {
        parsePlayers, parsePlayerSection, findMapName, detectPlayerCount, locateGaia, readAttributes,
        findObjectLists, scanObjectLists, findPlayerEnd, skipPoints, lobbyMap, findRandomMaps,
        CIV_IDS, HELPER_TYPES, SIZE_LABELS, CUSTOM_MAP_IDS,
    };
})({ Reader, findBytes, utf8 });

// Decodes one player command (an op-1 action record) from an AoE2 DE recorded game, save versions 67.2, 68 and 68.9.
// decodeAction(bytes): bytes is the record as stored (first byte the action id). Since DE build 71094 every record is
// [id u8][player u8][payload length u16][payload]. Returns { id, kind, player, ok, ...fields }. ok is true when the
// layout consumed the payload exactly; otherwise error says why and the fields read so far are kept.
// The u32 that follows each record in the body is the world time in ms (the sum of sync increments); the caller reads it.
// Layouts are checked against the local corpus by test-actions.js; docs/replay-format/ says which fields are verified and which are guesses.

// Wrapped so its helper names stay private when the parser pieces share one script scope
const ReplayActions = (function () {
    const ReaderClass = Reader;

    const RESOURCES = ['food', 'wood', 'stone', 'gold'];
    const STANCES = ['aggressive', 'defensive', 'standGround', 'noAttack'];
    const FORMATIONS = { 2: 'line', 4: 'box', 7: 'staggered', 8: 'flank' };
    // 117 order ids: 1, 2, 4, 5 as named by aoc-reference-data (constants.json "orders"), checked against how they are used
    const ORDERS = { 1: 'packTrebuchet', 2: 'unpackTrebuchet', 4: 'unqueue', 5: 'garrison' };
    // 111 release types: 0 and 3..6 as in mgz's ReleaseTypeEnum. 1 is not in mgz; its target field holds a player number
    // (the sender or gaia), so the name is ours: release the units that player owns
    const RELEASES = { 0: 'all', 1: 'ownedBy', 3: 'selected', 4: 'sameType', 5: 'notSelected', 6: 'inverseType' };
    // 103 sub-commands, names from aoc-reference-data and mgz; only 0, 1, 6, 10, 11, 13, 14, 16, 19, 20 occur in the corpus
    const GAME_COMMANDS = {
        0: 'diplomacy', 1: 'speed', 2: 'instantBuild', 4: 'quickBuild', 5: 'alliedVictory', 6: 'cheat', 9: 'unknown9',
        10: 'spies', 11: 'strategicNumber', 13: 'farmQueue', 14: 'farmUnqueue', 16: 'farmAutoQueue',
        17: 'fishTrapQueue', 18: 'fishTrapUnqueue', 19: 'fishTrapAutoQueue', 20: 'defaultStance',
    };
    const DIPLOMACY = { 0: 'ally', 1: 'neutral', 3: 'enemy' };
    // Ids only AI players send (in this corpus); AI players also send most human ids, so APM must use the header's player type
    const AI_ONLY_IDS = new Set([2, 10, 31, 35, 37, 100, 130, 131, 138]);

    // Every object id and target is read as i32: 0xFFFFFFFF stands for "none" (ungarrison lists, a market-less buy, an
    // order with no target), so -1 means no object in every kind
    function ids(r, count) {
        // checked first so a corrupt count cannot allocate a huge array
        if (count < 0 || count * 4 > r.left) throw new RangeError(`${count} ids do not fit in the ${r.left} bytes left`);
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = r.i32();
        return out;
    }

    function round3(v) {
        return Math.round(v * 1000) / 1000;
    }

    function bytes(r, n) {
        return Array.from(r.take(n));
    }

    // Consumes trailing all-zero u32 words and returns how many there were
    function zeroWords(r) {
        let n = 0;
        while (r.left >= 4 && r.bytes[r.pos] === 0 && r.bytes[r.pos + 1] === 0 && r.bytes[r.pos + 2] === 0 && r.bytes[r.pos + 3] === 0) {
            r.skip(4);
            n++;
        }
        return n;
    }

    // Shared by order (0), move (3) and multi gather point (45): target i32, x f32, y f32, count i16, 4 flag bytes, i16, ids.
    // A count of -1 sends no ids: the units are those of this player's last order/move that listed them (sameSelection).
    function targeted(r) {
        const target = r.i32(), x = round3(r.f32()), y = round3(r.f32()), count = r.i16();
        const flags = bytes(r, 4), unk18 = r.i16();
        if (count === -1) return { target, x, y, ids: null, sameSelection: true, flags, unk18 };
        return { target, x, y, ids: ids(r, count), flags, unk18 };
    }

    // Patrol (21) and attack move (33): count u32, u8 0/1, u8 0, u8 (0 patrol, 1 attack move), waypoint count u8 (1..10),
    // 10 x slots, 10 y slots (f32; only the first `waypoint count` used), ids
    function waypointed(r) {
        const count = r.u32(), flags = bytes(r, 3), used = r.u8();
        const xs = [], ys = [];
        for (let i = 0; i < 10; i++) xs.push(round3(r.f32()));
        for (let i = 0; i < 10; i++) ys.push(round3(r.f32()));
        const waypoints = [];
        for (let i = 0; i < Math.min(used, 10); i++) waypoints.push({ x: xs[i], y: ys[i] });
        const out = { x: xs[0], y: ys[0], waypoints, flags, ids: ids(r, count) };
        // Some patrols carry more id slots than the count, zero-filled
        const padding = zeroWords(r);
        if (padding) out.padding = padding;
        return out;
    }

    // count u32, one 4-byte field (a target object, a stance or a formation), ids
    function countThen(r, name) {
        const count = r.u32(), value = r.i32();
        return { [name]: value, ids: ids(r, count) };
    }

    function idsOnly(r) {
        return { ids: ids(r, r.u32()) };
    }

    function objectOnly(r) {
        return { object: r.i32() };
    }

    // AI interact (2) and AI retreat (35): target i32, x f32, y f32, count u32, u32 (always 1), ids
    function aiTargeted(r) {
        const target = r.i32(), x = round3(r.f32()), y = round3(r.f32()), count = r.u32(), unk16 = r.u32();
        return { target, x, y, unk16, ids: ids(r, count) };
    }

    // Game (103): always 16 bytes. command u16, u16 0, source player u16 (0 for speed), then per command
    function game(r) {
        const command = r.u16(), unk2 = r.u16(), source = r.u16();
        const out = { command, commandName: GAME_COMMANDS[command] || `command${command}`, source };
        if (unk2) out.unk2 = unk2;
        if (command === 0) {
            out.to = r.u16();
            out.stanceFloat = r.f32();
            out.stance = r.u8();
            out.diplomacy = DIPLOMACY[out.stance] || `stance${out.stance}`;
            r.skip(3);
        } else if (command === 1) {
            r.skip(2);
            out.speed = round3(r.f32());
            r.skip(4);
        } else if (command === 11) {
            out.strategicNumber = r.u16();
            out.unk8 = r.u32();
            out.value = r.i32();
        } else {
            // farm / fish trap queue counts and cheat ids; 0 for the toggles
            out.value = r.u16();
            r.skip(8);
        }
        return out;
    }

    function market(r) {
        const resource = r.i16(), lots = r.i16(), object = r.i32();
        // one lot is 100 of the resource; shift-click sends 5
        return { resource, resourceName: RESOURCES[resource] || `resource${resource}`, amount: lots * 100, lots, object };
    }

    // id -> [kind, decoder(reader) returning the kind's fields]
    const LAYOUTS = {
        0: ['order', targeted],
        1: ['stop', idsOnly],
        2: ['aiInteract', aiTargeted],
        3: ['move', r => {
            const out = targeted(r);
            delete out.target; // always -1
            return out;
        }],
        // count u32, first unit u32, target i32, u32 0, order type u32, x, y, two f32, 4 bytes, then every id when count > 1
        10: ['aiOrder', r => {
            const count = r.u32(), unit = r.i32(), target = r.i32(), unk12 = r.u32(), orderType = r.u32();
            const x = round3(r.f32()), y = round3(r.f32()), param1 = round3(r.f32()), param2 = round3(r.f32());
            const flags = bytes(r, 4);
            return { orderType, target, x, y, param1, param2, unk12, flags, ids: count > 1 ? ids(r, count) : [unit] };
        }],
        11: ['resign', r => ({ disconnected: r.u8() })],
        18: ['stance', r => {
            const out = countThen(r, 'stance');
            out.stanceName = STANCES[out.stance] || `stance${out.stance}`;
            return out;
        }],
        19: ['guard', r => countThen(r, 'target')],
        20: ['follow', r => countThen(r, 'target')],
        21: ['patrol', waypointed],
        23: ['formation', r => {
            const out = countThen(r, 'formation');
            out.formationName = FORMATIONS[out.formation] || `formation${out.formation}`;
            return out;
        }],
        // count u32, waypoint count u32, ids, then x[] u16 and y[] u16 tiles
        31: ['aiWaypoints', r => {
            const count = r.u32(), n = r.u32(), list = ids(r, count);
            const xs = [], ys = [];
            for (let i = 0; i < n; i++) xs.push(r.u16());
            for (let i = 0; i < n; i++) ys.push(r.u16());
            const waypoints = xs.map((x, i) => ({ x, y: ys[i] }));
            return { x: xs[0], y: ys[0], waypoints, ids: list };
        }],
        // Empty: a save request, written just before a saved chapter in the body
        32: ['chapter', () => ({})],
        33: ['attackMove', waypointed],
        35: ['aiRetreat', aiTargeted],
        37: ['aiUnknown37', r => ({ value: r.i32(), unk4: r.u8() })],
        38: ['autoscout', idsOnly],
        // Sent by the client, not clicked: the object is the hidden per-player type-1649 object at a Town Center's id + 3
        // (see docs/replay-format/)
        41: ['transform', r => ({ unit: r.u32(), object: r.i32() })],
        42: ['unknown42', r => ({ value: r.u32() })],
        43: ['ability', r => {
            const count = r.u32(), ability = r.i32();
            return { ability, ids: ids(r, count) };
        }],
        44: ['unknown44', idsOnly],
        45: ['multiGatherPoint', targeted],
        // building u32, i32 -1, unit u32
        100: ['aiQueue', r => {
            const building = r.i32(), unk4 = r.i32(), unit = r.u32();
            return { unit, building, unk4, ids: [building] };
        }],
        // building u32, count i16, tech i16, i32 -1, u8 0, ids (the building again, or every selected building)
        101: ['research', r => {
            const building = r.i32(), count = r.i16(), tech = r.i16(), unk8 = r.i32(), unk12 = r.u8();
            // AI players send count 1 without the list
            if (count === 1 && r.left === 0) return { tech, building, unk8, unk12, ids: [building] };
            return { tech, building, unk8, unk12, ids: ids(r, count) };
        }],
        // count i16, u16 0, x f32, y f32, unit u32, i32 -1, i32 -1, variant u16, queued u8, u8, ids
        102: ['build', r => {
            const count = r.i16(), unk2 = r.u16(), x = round3(r.f32()), y = round3(r.f32()), unit = r.u32();
            const unk16 = r.i32(), unk20 = r.i32(), variant = r.u16(), queued = r.u8(), unk27 = r.u8();
            return { unit, x, y, variant, queued, unk27, unk2, unk16, unk20, ids: ids(r, count) };
        }],
        103: ['game', game],
        // count u32, x1 y1 x2 y2 u16 tiles, unit u32, i32 -1, 4 bytes, ids
        105: ['wall', r => {
            const count = r.u32(), x1 = r.u16(), y1 = r.u16(), x2 = r.u16(), y2 = r.u16(), unit = r.u32();
            const unk16 = r.i32(), flags = bytes(r, 4);
            return { unit, x1, y1, x2, y2, unk16, flags, ids: ids(r, count) };
        }],
        106: ['delete', objectOnly],
        // count u32, x f32, y f32, 4 bytes, ids
        107: ['attackGround', r => {
            const count = r.u32(), x = round3(r.f32()), y = round3(r.f32()), flags = bytes(r, 4);
            return { x, y, flags, ids: ids(r, count) };
        }],
        // Old-style tribute (mostly AI here): amount f32, fee rate f32, resource u8, u8 0, to u8
        108: ['tribute', r => {
            const amount = round3(r.f32()), fee = round3(r.f32()), resource = r.u8(), unk9 = r.u8(), to = r.u8();
            const out = { to, food: 0, wood: 0, stone: 0, gold: 0, fees: [fee, fee, fee, fee], resource, unk9 };
            if (RESOURCES[resource]) out[RESOURCES[resource]] = amount;
            return out;
        }],
        // count u32, target i32, 4 bytes, ids
        110: ['repair', r => {
            const count = r.u32(), target = r.i32(), flags = bytes(r, 4);
            return { target, flags, ids: ids(r, count) };
        }],
        // count u32, x f32, y f32 (-1 = no point), unit to release i32, release type u32, u8, ids (the garrisoned buildings/units)
        111: ['ungarrison', r => {
            const count = r.u32(), x = round3(r.f32()), y = round3(r.f32()), target = r.i32(), releaseType = r.u32(), unk20 = r.u8();
            const out = { x, y, target, releaseType, releaseName: RELEASES[releaseType] || `release${releaseType}`, unk20, ids: ids(r, count) };
            // Release type 1 puts a player number (the sender or 0 = gaia) where the others put a unit, so it must not
            // be looked up as an object
            if (releaseType === 1) {
                out.targetPlayer = target;
                out.target = -1;
            }
            return out;
        }],
        114: ['gate', objectOnly],
        // target i32 (-1), x f32, y f32, slot count u8, one byte per player slot (gaia first): 1 = flare shown to that player
        115: ['flare', r => {
            const target = r.i32(), x = round3(r.f32()), y = round3(r.f32()), n = r.u8();
            const slots = bytes(r, n);
            const targets = [];
            slots.forEach((v, i) => { if (v) targets.push(i); });
            return { target, x, y, targets, slots };
        }],
        // count u32, target i32, x f32, y f32, i32, queue slot u32, order u8, 4 bytes, ids
        117: ['special', r => {
            const count = r.u32(), target = r.i32(), x = round3(r.f32()), y = round3(r.f32()), unk16 = r.i32(), slot = r.u32();
            const order = r.u8(), flags = bytes(r, 4);
            const out = { order, orderName: ORDERS[order] || `order${order}`, target, x, y, slot, unk16, flags, ids: ids(r, count) };
            // unqueue: slot is the 0-based queue position; flags[0] is probably shift (remove up to 5)
            if (order === 4) out.shift = flags[0];
            return out;
        }],
        // count u32, x f32, y f32, target i32, target unit type i32, u8 0, ids
        120: ['gatherPoint', r => {
            const count = r.u32(), x = round3(r.f32()), y = round3(r.f32()), target = r.i32(), targetType = r.i32(), unk20 = r.u8();
            return { target, targetType, x, y, unk20, ids: ids(r, count) };
        }],
        122: ['sell', market],
        123: ['buy', market],
        126: ['dropRelic', objectOnly],
        127: ['townBell', r => ({ object: r.i32(), on: r.u8() })],
        128: ['backToWork', objectOnly],
        // count i16, u32 0, building type i16, unit i16, amount i16, train button u32 (0 from AI), ids. The ids are the
        // whole selection: in a mixed one only the buildings of buildingType train the unit
        129: ['queue', r => {
            const count = r.i16(), unk2 = r.u32(), buildingType = r.i16(), unit = r.i16(), amount = r.i16(), button = r.u32();
            return { unit, amount, buildingType, button, unk2, ids: ids(r, count) };
        }],
        // AI: count u32, u8, ids
        130: ['aiUnknown130', r => {
            const count = r.u32(), unk4 = r.u8();
            return { unk4, ids: ids(r, count) };
        }],
        // AI: count u32, player u8, ids
        131: ['aiUnknown131', r => {
            const count = r.u32(), unk4 = r.u8();
            return { unk4, ids: ids(r, count) };
        }],
        138: ['aiUnknown138', r => ({ a: r.u32(), b: r.u32(), c: r.u32(), d: round3(r.f32()) })],
        140: ['unknown140', objectOnly],
        // amounts f32 x4, fee rates f32 x4, the resource id of each slot u16 x4 (always 1, 0, 3, 2: wood food gold stone), to u8
        196: ['tribute', r => {
            const amounts = [r.f32(), r.f32(), r.f32(), r.f32()].map(round3);
            const fees = [r.f32(), r.f32(), r.f32(), r.f32()].map(round3);
            const resourceIds = [r.u16(), r.u16(), r.u16(), r.u16()];
            const to = r.u8();
            const out = { to, food: 0, wood: 0, stone: 0, gold: 0, fees, resourceIds };
            resourceIds.forEach((res, i) => { if (RESOURCES[res]) out[RESOURCES[res]] = amounts[i]; });
            return out;
        }],
    };

    function decodeAction(bytes) {
        const id = bytes[0];
        const player = bytes.length > 1 ? bytes[1] : null;
        const layout = LAYOUTS[id];
        const out = { id, kind: layout ? layout[0] : `unknown${id}`, player };
        if (bytes.length < 4) return Object.assign(out, { ok: false, error: 'record shorter than its 4-byte frame' });
        const length = bytes[2] | (bytes[3] << 8);
        if (length !== bytes.length - 4) return Object.assign(out, { ok: false, error: `length field ${length} but ${bytes.length - 4} payload bytes` });
        const r = new ReaderClass(bytes.subarray(4));
        if (!layout) return Object.assign(out, { ok: false, error: 'no layout for this id', payload: r.take(length) });
        try {
            Object.assign(out, layout[1](r));
        } catch (e) {
            return Object.assign(out, { ok: false, error: e.message });
        }
        out.ok = r.pos === length;
        if (!out.ok) out.error = `${length - r.pos} bytes left over`;
        return out;
    }

    return { decodeAction, LAYOUTS, GAME_COMMANDS, ORDERS, RESOURCES, RELEASES, AI_ONLY_IDS };
})();

// Walks the body of an AoE2 DE recorded game (.aoe2record, save 67.2 / 68 / 68.9): the 32-byte meta block, then every
// operation in order, handing each to the caller's handlers. Plain JS with no Node APIs, so it runs in browsers too.
// The layouts and field meanings are pinned down in docs/replay-format/.
const ReplayStream = (function () {
    const OP_ACTION = 1;
    const OP_SYNC = 2;
    const OP_VIEWLOCK = 3;
    const OP_CHAT = 4;
    const OP_5 = 5;                              // single-player scenario/campaign only; meaning unknown
    const OP_POSTGAME = 6;

    const META_LENGTH = 32;
    const CHECKSUM_LENGTH = 360;                 // the zero marker, 8 rows of 11 u32, then the clock
    const CHECKSUM_ROWS = 8;
    const CHECKSUM_ROW_VALUES = 11;
    const POSTGAME_MAGIC = [0xce, 0xa4, 0x59, 0xb1, 0x05, 0xdb, 0x7b, 0x43];
    const POSTGAME_WORLD_TIME = 1;
    const POSTGAME_LEADERBOARDS = 2;
    const CHAT_ALL_PLAYERS = 0x3fc;               // bits 2..9: players 1..8
    const CHANNEL_NAMES = ['default', 'all', 'team', 'enemy'];
    // The lobby chat is replayed into the recording at the first sync, about 0.1 s into the game
    const LOBBY_HISTORY_MS = 1000;

    // Sanity bounds far above anything in the corpus (largest sync step 250 ms, action 968 bytes, chat 328 bytes, 2
    // postgame blocks). Past them the bytes are damaged, so the walk stops as corrupt instead of trusting them.
    const MAX_SYNC_STEP = 10000;
    const MAX_ACTION_LENGTH = 65536;
    const MAX_CHAT_LENGTH = 65536;
    const MAX_POSTGAME_BLOCKS = 64;

    function readMeta(view, at) {
        const u = (i) => view.getUint32(at + i * 4, true);
        return {
            logVersion: u(0),
            checksumInterval: u(1),               // syncs between checksum blocks
            multiplayer: u(2) === 1,
            gameMode: u(3),                       // 1 RM, 2 turbo RM, 3 regicide, 4 deathmatch, 12 empire wars, 14 scenario, 15 campaign (see SPEC)
            recordingPlayer: u(4),                // player number of the recording client; 1 when the recorder was not a player
            revealMap: u(5),                      // 0 normal, 1 explored, 2 all visible (header reveal_map)
            unknown6: u(6),                       // always 0 in the corpus
            unknown7: u(7)                        // always 0 in the corpus
        };
    }

    // The 8 rows are player slots 1..8 in order; an unused slot is all zeros. Gaia has no row. The per-row sums run over
    // the same set of the player's objects (units, buildings, foundations, owned livestock; not decoration). docs/replay-format/ says
    // which meanings are verified and which are guesses; 'values' keeps all 11 raw.
    function decodeChecksum(view, at) {
        const rows = [];
        for (let i = 0; i < CHECKSUM_ROWS; i++) {
            const base = at + 4 + i * CHECKSUM_ROW_VALUES * 4;
            const values = new Array(CHECKSUM_ROW_VALUES);
            for (let j = 0; j < CHECKSUM_ROW_VALUES; j++) values[j] = view.getInt32(base + j * 4, true);
            rows.push({
                player: values[8],
                // bank: floor(food) + floor(wood) + floor(gold) + floor(stone), summed in i32; can go negative, and reads 0
                // with infinite resources (each 3.4e38 stockpile truncates to INT_MIN, and four of those wrap to 0)
                resources: values[1],
                unitTypeSum: values[2],           // sum of the objects' unit type ids (moves when villagers change task)
                spriteCount: values[3],           // guess: drawn objects; 2 per object at the start, foundations excluded
                heldResources: values[4],         // guess: resources inside objects (livestock food, villager loads)
                objectCount: values[6],
                positionSum: values[7],           // sum of 100 * (x + y), tile coordinates
                unknown9: values[9],
                // sum of the objects' instance ids modulo 2^32 (long games pass 2^31); the change between two blocks is
                // (b - a) | 0, which holds while the true change is under 2^31 either way
                idSum: values[10] >>> 0,
                values
            });
        }
        return { time: view.getUint32(at + CHECKSUM_LENGTH - 4, true), rows };
    }

    // A taunt's message starts with its number. AI chat lines (67.2) and a few typed lines carry a tauntNumber >= 0
    // without being taunts, so the field alone does not say.
    function tauntOf(message, tauntNumber) {
        if (typeof tauntNumber !== 'number' || tauntNumber < 0 || typeof message !== 'string') return null;
        const m = /^\s*(\d+)/.exec(message);
        return m && Number(m[1]) === tauntNumber ? tauntNumber : null;
    }

    // context (optional): { recordingPlayer, seats }. seats lists the seated player numbers; destinationMap also sets
    // the bits of closed slots, so recipients are cut down to the seats when they are known.
    // The audience (recipients, everyone, notForRecorder) is null where the file does not record it: no destinationMap,
    // or one with no recipient bits (destinationMap 1, a save-68 artefact). channelName still gives the intent then.
    function decodeChat(bytes, context = {}) {
        const text = utf8(bytes);
        let json;
        try { json = JSON.parse(text); } catch (e) { return { text, invalid: true }; }
        if (json === null || typeof json !== 'object' || Array.isArray(json)) return { text, invalid: true };
        const { player, channel, message, tauntNumber, messageAGP } = json;
        const map = json.destinationMap;
        const chat = {
            player,                               // for lobby history a lobby-time number, not the game player (see SPEC)
            channel,
            channelName: (Number.isInteger(channel) && CHANNEL_NAMES[channel]) || null,
            message,
            tauntNumber,
            taunt: tauntOf(message, tauntNumber),
            messageAGP,
            destinationMap: map,
            recipients: null,
            everyone: null,
            notForRecorder: null,
            history: null                         // set by markHistory: 'lobby', 'replay' or null
        };
        if (typeof map === 'number' && (map & CHAT_ALL_PLAYERS) !== 0) {
            const seats = context.seats;
            const recipients = [];
            for (let n = 1; n <= 8; n++) if ((map & (1 << (n + 1))) && (!seats || seats.includes(n))) recipients.push(n);
            chat.recipients = recipients;
            chat.everyone = (map & CHAT_ALL_PLAYERS) === CHAT_ALL_PLAYERS;
            chat.notForRecorder = (map & 1) === 1;
        } else if (context.recordingPlayer !== undefined && player === context.recordingPlayer) {
            chat.notForRecorder = false;           // the sender sees their own line
        }
        return chat;
    }

    // "@#" player digit, an optional <All>/<Team>/<Enemy> tag, colour digit, spaces, an optional platform icon, spaces,
    // then "Name: text" ("Name [suffix]: text" for some). Lines without the spaces are "@#" player digit + text, no name.
    const AGP_PREFIX = /^@#\d(?:<[A-Za-z]+>)?\s*\d\s{2,}(?:<platform_icon[^>]*>\s*)?/;

    // The sender's name as the game drew it in messageAGP, or null. With names (the header's player names) it returns
    // the longest one the line names; without, the text before the first ': '.
    function agpSender(messageAGP, names) {
        if (typeof messageAGP !== 'string') return null;
        const m = AGP_PREFIX.exec(messageAGP);
        if (!m) return null;
        const rest = messageAGP.slice(m[0].length);
        if (names) {
            let best = null;
            for (const n of names) {
                if (n && (best === null || n.length > best.length) && (rest.startsWith(n + ':') || rest.startsWith(n + ' ['))) best = n;
            }
            return best;
        }
        const colon = rest.indexOf(': ');
        return colon > 0 ? rest.slice(0, colon).replace(/ \[[^\]]*\]$/, '') : null;
    }

    // Marks the chat history the game replays into a recording, whose player numbers are lobby-time numbers:
    // 'lobby' for the burst at the start, 'replay' for a later re-send of it (after a rejoin), null for live chat.
    // entries: [{ chat, time }] in walk order, as the chat handler received them. A later chat is a re-send when its
    // messageAGP is empty (67.2/68 write none for history, while live lines have one) or when every field equals a line
    // of the first burst (68.9 fills messageAGP for history too). A re-send can begin with lines older than the first
    // burst kept, so once two chats at one instant are re-sends, every chat at that instant is.
    function markHistory(entries) {
        const lobby = new Set();
        for (const e of entries) {
            if (e.chat.invalid) continue;
            e.chat.history = e.time < LOBBY_HISTORY_MS ? 'lobby' : null;
            if (e.chat.history) lobby.add(chatKey(e.chat));
        }
        for (let i = 0; i < entries.length;) {
            let j = i + 1;
            while (j < entries.length && entries[j].time === entries[i].time) j++;
            if (entries[i].time >= LOBBY_HISTORY_MS) markReplayedInstant(entries, i, j, lobby);
            i = j;
        }
        return entries;
    }

    function chatKey(c) {
        return JSON.stringify([c.player, c.channel, c.message, c.tauntNumber, c.messageAGP, c.destinationMap]);
    }

    function markReplayedInstant(entries, from, to, lobby) {
        let replayed = 0;
        for (let i = from; i < to; i++) {
            const c = entries[i].chat;
            if (!c.invalid && (!c.messageAGP || lobby.has(chatKey(c)))) { c.history = 'replay'; replayed++; }
        }
        if (replayed >= 2) for (let i = from; i < to; i++) if (!entries[i].chat.invalid) entries[i].chat.history = 'replay';
    }

    // The postgame is laid out to be read from the end of the file: ... blocks, u32 block count, u32 version, magic.
    // Each block is its payload followed by u32 length and u32 id, so blocks are walked backwards from the count, and they
    // must tile the bytes between the op id and the count exactly.
    function decodePostgame(fileBytes, start, end) {
        if (end - start < 16) return { error: 'too short' };
        for (let i = 0; i < 8; i++) if (fileBytes[end - 8 + i] !== POSTGAME_MAGIC[i]) return { error: 'no magic' };
        const r = new Reader(fileBytes, end - 16);
        const count = r.u32(), version = r.u32();
        const out = { version, worldTime: null, leaderboards: [], unknownBlocks: [] };
        if (count > MAX_POSTGAME_BLOCKS || count * 8 > end - 16 - start) return { ...out, error: `block count ${count}` };
        const blocks = [];
        let p = end - 16;
        for (let i = 0; i < count; i++) {
            if (p - 8 < start) return { ...out, error: 'block table runs before the postgame op' };
            r.pos = p - 8;
            const length = r.u32(), id = r.u32();
            p -= 8 + length;
            if (p < start) return { ...out, error: 'block runs before the postgame op' };
            blocks.push({ id, at: p, length });
        }
        if (p !== start) return { ...out, error: `blocks start at ${p}, not at ${start}` };
        blocks.reverse();
        for (const block of blocks) {
            if (block.id === POSTGAME_WORLD_TIME && block.length === 4) out.worldTime = new Reader(fileBytes, block.at).u32();
            else if (block.id === POSTGAME_LEADERBOARDS) {
                const decoded = decodeLeaderboards(fileBytes.subarray(block.at, block.at + block.length));
                out.leaderboards = decoded.boards;
                if (decoded.error) return { ...out, error: `leaderboards: ${decoded.error}` };
            } else out.unknownBlocks.push(block);
        }
        return out;
    }

    // Board ids follow the public leaderboard numbering (3 RM 1v1, 4 RM team, 2 DM team, 14 EW team). Only players with a
    // rating on that board are listed. Returns { boards, error }, boards holding every board read in full.
    function decodeLeaderboards(bytes) {
        const r = new Reader(bytes);
        const boards = [];
        try {
            for (let i = r.u32(); i > 0; i--) {
                const id = r.u32(), unknown = r.u16();
                const players = [];
                for (let j = r.u32(); j > 0; j--) {
                    // index is 0-based (player number - 1); rank is -1 when the player has no rank on that board
                    players.push({ player: r.i32() + 1, rank: r.i32(), rating: r.i32() });
                }
                boards.push({ id, unknown, players });
            }
        } catch (e) {
            return { boards, error: e.message };
        }
        return { boards, error: r.left !== 0 ? `${r.left} bytes left in leaderboard block` : null };
    }

    // handlers (all optional):
    //   action(bytes, worldTime, at)        bytes: the L action bytes (bytes[0] is the action id), a view into fileBytes
    //   sync(increment, time, at)           time: game clock in ms after this increment
    //   checksum(block, time, at)           block: decodeChecksum result
    //   viewlock(x, y, player, time, at)    the recording player's camera
    //   chat(chat, time, at)                chat: decodeChat result; markHistory over the collected chats flags lobby lines
    //   op5(a, b, time, at)                 op 5 (i32, u32), seen only in single-player scenario/campaign files
    //   chapter(info, time, at)             a saved chapter embedded in the body: { at, end, next, compressedHeader }
    //   postgame(postgame, time, at)        only when the walk ends 'postgame'
    // options (optional): { seats } — the header's seated player numbers, used to cut chat recipients down to them.
    // Returns { meta, time, counts, chapters, postgame, end: { reason, at, detail } } with reason one of
    //   'postgame'   the postgame decoded and its world time equals the clock
    //   'eof'        stopped cleanly between operations
    //   'truncated'  the operation at end.at runs past the end of the data (or the postgame has no end magic)
    //   'corrupt'    the bytes at end.at break an invariant every clean file keeps: an unknown op id, a length or sync step
    //                past the sanity bounds, an action whose inner length is not L - 4, an action or checksum whose clock
    //                is not the sync clock, a chat without its -1, a postgame that does not tile or whose world time is
    //                not the clock
    // Everything read before the stop has already been handed to the handlers; end.at is the offset of the operation
    // that could not be read (never past the end of the data). result.postgame keeps a postgame that decoded with an
    // error, for inspection.
    function walkBody(fileBytes, bodyStart, handlers = {}, options = {}) {
        const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
        const size = fileBytes.length;
        const counts = { action: 0, sync: 0, checksum: 0, viewlock: 0, chat: 0, op5: 0, chapter: 0, postgame: 0 };
        const chapters = [];
        const result = { meta: null, time: 0, counts, chapters, postgame: null, end: null };
        let time = 0;
        const stop = (reason, at, detail) => { result.time = time; result.end = { reason, at, detail }; return result; };
        if (!Number.isInteger(bodyStart) || bodyStart < 0) return stop('corrupt', 0, `body start ${bodyStart}`);
        if (bodyStart + META_LENGTH > size) return stop('truncated', Math.min(bodyStart, size), 'meta');
        const meta = result.meta = readMeta(view, bodyStart);
        const chatContext = { recordingPlayer: meta.recordingPlayer, seats: options.seats || null };

        const { action, sync, checksum, viewlock, chat, op5, chapter, postgame } = handlers;
        let nextChapter = size >= 8 ? view.getUint32(4, true) : 0;
        let p = bodyStart + META_LENGTH;
        while (p < size) {
            const at = p;
            if (p + 4 > size) return stop('truncated', at, 'op id');
            const op = view.getUint32(p, true);
            p += 4;
            if (op === OP_SYNC) {
                if (p + 4 > size) return stop('truncated', at, 'sync');
                const increment = view.getUint32(p, true);
                if (increment > MAX_SYNC_STEP) return stop('corrupt', at, `sync step ${increment} ms`);
                time += increment;
                p += 4;
                counts.sync++;
                if (sync) sync(increment, time, at);
                // a zero where the next op id would be marks a checksum block
                if (p + 4 <= size && view.getUint32(p, true) === 0) {
                    if (p + CHECKSUM_LENGTH > size) return stop('truncated', p, 'checksum');
                    const blockTime = view.getUint32(p + CHECKSUM_LENGTH - 4, true);
                    if (blockTime !== time) return stop('corrupt', p, `checksum clock ${blockTime}, clock ${time}`);
                    counts.checksum++;
                    if (checksum) checksum(decodeChecksum(view, p), time, p);
                    p += CHECKSUM_LENGTH;
                }
            } else if (op === OP_VIEWLOCK) {
                if (p + 12 > size) return stop('truncated', at, 'viewlock');
                counts.viewlock++;
                if (viewlock) viewlock(view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getUint32(p + 8, true), time, at);
                p += 12;
            } else if (op === OP_ACTION) {
                if (p + 4 > size) return stop('truncated', at, 'action length');
                const length = view.getUint32(p, true);
                if (length < 4 || length > MAX_ACTION_LENGTH) return stop('corrupt', at, `action length ${length}`);
                if (p + 8 + length > size) return stop('truncated', at, 'action');
                // Every clean action repeats its payload length (L - 4) at byte 2 and carries the sync clock after it, so
                // a mismatch means a damaged length, op id or sync step. The inner length also catches a length that
                // swallows the next action at the same clock.
                const inner = view.getUint16(p + 6, true);
                if (inner !== length - 4) return stop('corrupt', at, `action length ${length}, inner length ${inner}`);
                const worldTime = view.getUint32(p + 4 + length, true);
                if (worldTime !== time) return stop('corrupt', at, `action world time ${worldTime}, clock ${time}`);
                counts.action++;
                if (action) action(fileBytes.subarray(p + 4, p + 4 + length), worldTime, at);
                p += 8 + length;
            } else if (op === OP_CHAT) {
                if (p + 8 > size) return stop('truncated', at, 'chat length');
                if (view.getInt32(p, true) !== -1) return stop('corrupt', at, 'chat without its -1');
                const length = view.getUint32(p + 4, true);
                if (length > MAX_CHAT_LENGTH) return stop('corrupt', at, `chat length ${length}`);
                if (p + 8 + length > size) return stop('truncated', at, 'chat');
                counts.chat++;
                if (chat) chat(decodeChat(fileBytes.subarray(p + 8, p + 8 + length), chatContext), time, at);
                p += 8 + length;
            } else if (op === OP_5) {
                if (p + 8 > size) return stop('truncated', at, 'op 5');
                counts.op5++;
                if (op5) op5(view.getInt32(p, true), view.getUint32(p + 4, true), time, at);
                p += 8;
            } else if (op === OP_POSTGAME) {
                // It runs to the end of the file and ends with a magic, so a missing magic means the file was cut
                const decoded = decodePostgame(fileBytes, p, size);
                result.postgame = decoded;
                if (decoded.error === 'no magic' || decoded.error === 'too short') return stop('truncated', at, `postgame: ${decoded.error}`);
                if (decoded.error) return stop('corrupt', at, `postgame: ${decoded.error}`);
                if (decoded.worldTime !== time) return stop('corrupt', at, `postgame world time ${decoded.worldTime}, clock ${time}`);
                counts.postgame++;
                if (postgame) postgame(decoded, time, at);
                return stop('postgame', at, null);
            } else if (at === nextChapter) {
                // A saved chapter, found only where the file prefix's (or the previous chapter's) next-chapter offset
                // points: u32 offset where the body resumes, u32 next chapter offset (0: none), then a raw-deflate header
                if (op <= at + 8) return stop('corrupt', at, `chapter resumes at ${op}`);
                if (op > size) return stop('truncated', at, 'chapter');
                const info = { at, end: op, next: view.getUint32(at + 4, true), compressedHeader: fileBytes.subarray(at + 8, op) };
                counts.chapter++;
                chapters.push({ at, end: op, next: info.next, time });
                if (chapter) chapter(info, time, at);
                nextChapter = info.next;
                p = op;
            } else {
                return stop('corrupt', at, `unknown op ${op}`);
            }
        }
        return stop('eof', p, null);
    }

    const stream = {
        walkBody, readMeta, decodeChecksum, decodeChat, decodePostgame, markHistory, agpSender, CHANNEL_NAMES,
        OP_ACTION, OP_SYNC, OP_VIEWLOCK, OP_CHAT, OP_5, OP_POSTGAME
    };

    return stream;
})();

// A game's own building footprints, read from the unit type records in its (inflated) replay header. Plain JS, no
// dependencies, runs in browsers and Node. replay-data.json's `size` is the standard game's; a game can differ
// (farms are 1x1 in 115 corpus games, 2x2 in 15 and 3x3 in the rest), and so can a civ (a Poles player's Mill
// record is the 3x3 Folwark), so prefer these sizes and fall back to the table.
//
// The header holds one unit type list per player (gaia first, then players 1..n), each in ascending id order. A
// record starts 21 16, then:
//   u8 type (80 building), u16 slot id, u16 current id, u16 base id (= slot id), u16 current id, u16 game class,
//   2 bytes, u16 hp, f32 line of sight, u8 garrison, f32 collision x, f32 collision y, ...
// The current id is the look the building has now (a Barracks slot 12 holds 20 in Castle Age); its box is the same.
// The footprint in tiles is twice the collision box. test-data.js checks all of this against the corpus.
const ReplaySizes = (function () {
    const HEAD = [0x21, 0x16];
    const BUILDING = 80;

    // PASTURE_BUILD (1889), the id build commands use, has a 1.0 box, but it places a PASTURE (1897), whose 2.0 box is
    // the real footprint: pastures pack exactly 4 tiles apart in the corpus
    const FOOTPRINT_OF = { 1889: 1897 };

    function plausibleBox(v) { return Number.isFinite(v) && v >= 0 && v <= 16; }

    // Calls fn(slotId, collisionX, collisionY) for every building record head in the header, in file order
    function eachBuildingHead(bytes, fn) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = bytes.indexOf(HEAD[0]); i >= 0 && i + 30 <= bytes.length; i = bytes.indexOf(HEAD[0], i + 1)) {
            const t = i + 2;
            if (bytes[i + 1] !== HEAD[1] || bytes[t] !== BUILDING) continue;
            const slot = view.getUint16(t + 1, true);
            if (view.getUint16(t + 5, true) !== slot || view.getUint16(t + 3, true) !== view.getUint16(t + 7, true)) continue;
            const cx = view.getFloat32(t + 20, true), cy = view.getFloat32(t + 24, true);
            if (!plausibleBox(cx) || !plausibleBox(cy)) continue;
            fn(slot, cx, cy);
        }
    }

    function side(box) { return Math.round(box * 200) / 100; }

    // [ { id: size } ] per player index (0 gaia, then the player numbers the commands use), for the wanted building ids
    // (all when ids is omitted). size is as in replay-data.json: the side in tiles, or [width, height] where they differ.
    function buildingSizes(bytes, ids) {
        const lists = [];
        let last = Infinity;
        eachBuildingHead(bytes, (slot, cx, cy) => {
            // ids ascend within a list, so a drop starts the next player's
            if (slot <= last) {
                if (lists.length >= 16) return;
                lists.push(new Map());
            }
            lists[lists.length - 1].set(slot, [cx, cy]);
            last = slot;
        });
        return lists.map(boxes => {
            const out = {};
            for (const id of ids ? ids.map(Number) : boxes.keys()) {
                const box = boxes.get(FOOTPRINT_OF[id] || id);
                if (!box) continue;
                const w = side(box[0]), h = side(box[1]);
                out[id] = w === h ? w : [w, h];
            }
            return out;
        });
    }

    return { buildingSizes };
})();

// ------------------------------------------------------------------ the file, and the model the viewer reads
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const MIN_SAVE = 67.2;
const NEWEST_SAVE = 68.9;
// Gaia object types by what the viewer draws (from a census of 745 replays; a new type is just not drawn)
const GAIA_TYPES = {
    gold: [66],
    stone: [102],
    relic: [285],
    tree: [302, 348, 349, 350, 351, 411, 413, 414, 1051, 1052, 1053, 1054, 1063, 1144, 1146, 1248, 1249, 1250, 1347, 1348, 1349, 1350, 1539, 1540, 1542, 1717, 1984, 2025],
    forage: [59, 1059, 1549, 2599, 2650],
    fish: [61, 69, 455, 456, 457, 458, 1141],
    herdable: [305, 594, 705, 833, 1060, 1142, 1243, 1245, 1596, 1598, 1600, 1963, 2083, 2085, 2087, 2590],
    huntable: [48, 65, 822, 1019, 1026, 1139, 1239, 1301, 1796, 1896, 2084, 2086, 2088, 2098, 2099, 2340, 2589, 2591, 2597]
};
const SPEEDS = { 100: 'Slow', 150: 'Casual', 169: 'Normal', 170: 'Normal', 200: 'Fast' };
const UNIT_ORDERS = new Set(['move', 'attackMove', 'patrol', 'attackGround', 'order']);
// One key press sends these once per selected object, so they count once per instant in actions per minute
const FAN_OUT = new Set(['delete', 'townBell', 'gate', 'backToWork', 'unknown140', 'tribute']);
// A queue holds 15 orders at most, so a cancel can't be for an order older than this: it finished long ago
const CANCEL_REACH_MS = 10 * 60 * 1000;
const MAX_STANDING_IDS = 512; // the longest action in 745 replays lists about 238
const AGE_TECHS = { feudal: 101, castle: 102, imperial: 103 };
const MIN_STEPS_TO_TELL = 10;
const TREASON = 408; // Regicide's one tech that can be bought again at the same building
// What the viewer loops over, far above any real game: [limit, largest of 745 replays]
const LIMITS = { startObjects: 20000 /* 921 */, drawnGaia: 20000 /* 2,009 */, gaia: 1000000 /* 123,417 */, placed: 100000 /* 7,757 */, events: 2000000 /* 159,463 */, chat: 200000 };
// The game announces an age-up as a line from that player, "<player_id,5,0> advanced to the Feudal Age.", in the
// recorder's language. Typed chat can hold that text too, but only the game's own line has it as messageAGP's tag.
// Ages then come by order, which doesn't depend on the language.
const AGE_LINE = /^@#\d+<player_id,(\d+),-?\d+>/;
const AGE_ORDER = ['dark', 'feudal', 'castle', 'imperial'];

// An error with a sentence the page can show as it is
function userError(message, cause) {
    const e = new Error(cause ? `${message} (${cause.message})` : message);
    e.userMessage = message;
    return e;
}

// The official download is a ZIP holding one .aoe2record, stored or deflated. Reads the central directory, because
// a streamed ZIP leaves the sizes out of its local headers.
async function unzipReplay(bytes, inflateRaw) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw userError('That ZIP file is damaged.');
    const count = view.getUint16(end + 10, true);
    let p = view.getUint32(end + 16, true);
    let found = null;
    for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw userError('That ZIP file is damaged.');
        const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), local = view.getUint32(p + 42, true);
        const nameLength = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
        const name = utf8(bytes.subarray(p + 46, p + 46 + nameLength));
        p += 46 + nameLength + extra + comment;
        // A lone file is taken whatever it's called
        if (/\.aoe2record$/i.test(name) || (count === 1 && !name.endsWith('/'))) { found = { method, size, local }; break; }
    }
    if (!found) throw userError('There\'s no .aoe2record file in that ZIP.');
    const { method, size, local } = found;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw userError('That ZIP file is damaged.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > bytes.length) throw userError('That ZIP file is damaged.');
    const data = bytes.subarray(start, start + size);
    if (method === 0) return data;
    if (method !== 8) throw userError('That ZIP file is packed in a way the viewer can\'t read.');
    return inflateRaw(data, MAX_INFLATED_BYTES);
}

// The save version alone, to explain a file the parser refuses
function peekSave(header) {
    try {
        const r = new Reader(header, 8);
        const f = r.f32();
        return Math.round((f === -1 ? r.u32() / 65536 : f) * 100) / 100;
    } catch (e) {
        return null;
    }
}

async function readHeader(bytes, inflateRaw) {
    const { compressedHeader, bodyStart } = splitFile(bytes);
    if (bodyStart <= 8) throw userError('That file isn\'t an AoE2: DE replay.');
    if (bodyStart > bytes.length) throw userError('That file is incomplete, or isn\'t an AoE2: DE replay.');
    let header;
    try {
        header = await inflateRaw(compressedHeader, MAX_INFLATED_BYTES);
    } catch (e) {
        throw e.userMessage ? e : userError('That file isn\'t an AoE2: DE replay.', e);
    }
    if (utf8(header.subarray(0, 4)) !== 'VER ') throw userError('That file isn\'t an AoE2: DE replay.');
    let head;
    try {
        head = ReplayHeader.parseHeader(header);
    } catch (e) {
        const save = peekSave(header);
        if (save !== null && save < MIN_SAVE) throw userError(`This replay is from an older version of the game (file version ${save}). The viewer reads version ${MIN_SAVE} and later, games from April 2026 on.`, e);
        if (save !== null && save > NEWEST_SAVE) throw userError(`This replay is from a newer version of the game (file version ${save}) than the viewer can read yet.`, e);
        throw userError('That replay couldn\'t be read: part of it isn\'t what the viewer expected.', e);
    }
    return { header, head, bodyStart };
}

function gaiaOf(objects) {
    const kind = new Map();
    for (const [name, ids] of Object.entries(GAIA_TYPES)) for (const id of ids) kind.set(id, name);
    const lists = Object.fromEntries(Object.keys(GAIA_TYPES).map(k => [k, []]));
    const resourceIds = new Set();
    for (const o of objects) {
        const k = kind.get(o.typeId);
        if (!k) continue;
        lists[k].push(o.x, o.y);
        if (k !== 'relic') resourceIds.add(o.id);
    }
    return { lists, resourceIds };
}

// The postgame lists ratings per leaderboard. Board 3 is the 1v1 ladder; a second board follows the game type (4 random
// map, 2 deathmatch, 14 empire wars). Only players with a rating on that board are listed.
function ratingsOf(postgame, oneVsOne) {
    const boards = (postgame && postgame.leaderboards) || [];
    const board = boards.find(b => b.id === 3 && oneVsOne) || boards.find(b => b.id !== 3) || boards[0];
    const ratings = new Map();
    for (const row of (board && board.players) || []) if (row.rating > 0) ratings.set(row.player, row.rating);
    return ratings;
}

// Who a line was for. Channel 0 has no tag: its recipients say whether it went to everyone or a few
function audienceOf(chat, teamOf) {
    if (chat.channelName === 'all' || chat.everyone === true) return 'all';
    if (chat.channelName === 'team') return 'team';
    if (chat.channelName === 'enemy') return 'enemies';
    if (!chat.recipients) return null;
    if (chat.recipients.length < 2) return 'private';
    const team = teamOf.get(chat.player) ?? null;
    if (team !== null && chat.recipients.every(n => teamOf.get(n) === team)) return 'team';
    return chat.recipients.length === 2 && chat.recipients.includes(chat.player) ? 'private' : 'selected';
}

// In-game chat, and the age-up events hidden among it
function splitChat(entries, startAges, teamOf) {
    ReplayStream.markHistory(entries);
    const rows = [], ages = [], step = new Map(), seen = new Set();
    for (const { chat, time } of entries) {
        // Lobby lines and their re-sends carry lobby-time player numbers, so they can't be credited: in-game chat only
        if (chat.invalid || chat.history || !chat.message) continue;
        const line = AGE_LINE.exec(chat.messageAGP || '');
        if (line) {
            const p = Number(line[1]), key = `${p}:${chat.message}`;
            if (!startAges.has(p) || seen.has(key)) continue;
            seen.add(key);
            // A start past Imperial, or a line after it, is no age the game has
            const at = step.get(p) ?? AGE_ORDER.indexOf(startAges.get(p));
            if (at < 0 || at >= AGE_ORDER.length - 1) continue;
            step.set(p, at + 1);
            const named = /advanced to the (.+?)\.?$/.exec(chat.message);
            ages.push({ t: time, p, k: 'age', age: AGE_ORDER[at + 1], label: named ? named[1] : null });
            continue;
        }
        if (startAges.has(chat.player)) rows.push({ t: time, p: chat.player, text: chat.message, audience: audienceOf(chat, teamOf) });
    }
    return { rows, ages };
}

const hasAmount = a => a.food > 0 || a.wood > 0 || a.gold > 0 || a.stone > 0;

// Turns the command stream into the events the viewer uses, and counts actions per minute. A cancel names only a
// building and a queue slot, so it takes back the newest order still standing at that building (an estimate); working
// out the slot instead did worse, because when an order leaves the queue isn't known. An age line then proves its
// click stood, so finish() undoes a cancel that took one.
function collectCommands(seats, humans, resourceIds) {
    const events = [], apm = {}, queues = new Map(), selected = new Map(), standing = new Map();
    let unreadable = 0, countedAt = -1;
    const counted = new Set();
    for (const p of humans) apm[p] = [];
    const stand = (ids, order) => {
        if (!ids || ids.length > MAX_STANDING_IDS) return;
        for (const id of ids) {
            if (!queues.has(id)) queues.set(id, []);
            queues.get(id).push(order);
        }
    };
    const cancelAt = (id, t) => {
        const list = queues.get(id);
        while (list && list.length) {
            const order = list.pop();
            if (t - order.t > CANCEL_REACH_MS) { list.length = 0; return; }
            if (order.k === 'research' && !order.cancelled) {
                order.cancelled = true;
                // The unit it passed over, in case the cancel was really for that
                for (let i = list.length - 1; i >= 0; i--) if (list[i].k === 'queue' && list[i].n > 0) { order.passedOver = list[i]; break; }
                return;
            }
            if (order.k === 'queue' && order.n > 0) { order.n--; if (order.n) list.push(order); return; }
        }
    };
    // The client sends some records by itself, and one key press can send many
    const isInput = (a, t) => {
        if (a.kind === 'transform' || a.kind === 'chapter') return false;
        if (a.kind === 'game' && t < 2000 && (a.commandName === 'farmAutoQueue' || a.commandName === 'fishTrapAutoQueue')) return false;
        if (a.kind === 'tribute' && !hasAmount(a)) return false;
        if (!FAN_OUT.has(a.kind)) return true;
        if (t !== countedAt) { counted.clear(); countedAt = t; }
        const key = `${a.player}:${a.kind}`;
        if (counted.has(key)) return false;
        counted.add(key);
        return true;
    };
    const add = (a, t) => {
        const p = a.player;
        const sel = a.ids ? a.ids.length : (selected.get(p) || 1);
        // "Same selection" means the units of the last order or move, whatever came between
        if (a.ids && (a.kind === 'order' || a.kind === 'move')) selected.set(p, a.ids.length);
        switch (a.kind) {
            case 'queue': { const e = { t, p, k: 'queue', unit: a.unit, n: a.amount }; events.push(e); stand(a.ids, e); break; }
            case 'aiQueue': { const e = { t, p, k: 'queue', unit: a.unit, n: 1 }; events.push(e); stand(a.ids, e); break; }
            case 'research': {
                const e = { t, p, k: 'research', tech: a.tech };
                // A double click sends the same order twice, and only one can run
                const key = `${p}:${a.tech}:${a.building}`, older = standing.get(key);
                if (older && a.tech !== TREASON) older.cancelled = true;
                standing.set(key, e);
                events.push(e);
                stand(a.building >= 0 ? [a.building] : a.ids, e);
                break;
            }
            case 'build': events.push({ t, p, k: 'build', unit: a.unit, x: a.x, y: a.y }); break;
            case 'wall': events.push({ t, p, k: 'wall', unit: a.unit, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }); break;
            case 'flare': events.push({ t, p, k: 'flare', x: a.x, y: a.y }); break;
            case 'buy': case 'sell': events.push({ t, p, k: a.kind, resource: a.resourceName, amount: a.amount }); break;
            // One tribute sends a record per row of the panel, most of them empty
            case 'tribute': if (hasAmount(a)) events.push({ t, p, k: 'tribute', to: a.to, food: a.food, wood: a.wood, gold: a.gold, stone: a.stone }); break;
            case 'resign': events.push({ t, p, k: 'resign' }); break;
            case 'special': if (a.orderName === 'unqueue') for (const id of a.ids || []) cancelAt(id, t); break;
            default:
                if (UNIT_ORDERS.has(a.kind) && (a.x > 0 || a.y > 0)) {
                    const e = { t, p, k: a.kind, x: a.x, y: a.y, n: sel };
                    if (a.kind === 'order' && resourceIds.has(a.target)) e.work = true;
                    events.push(e);
                }
        }
    };
    return {
        action(raw, t) {
            const a = ReplayActions.decodeAction(raw);
            if (!a.ok) { unreadable++; return; }
            if (!seats.has(a.player)) return;
            add(a, t);
            if (apm[a.player] && isInput(a, t)) {
                const m = Math.floor(t / 60000), row = apm[a.player];
                while (row.length <= m) row.push(0);
                row[m]++;
            }
        },
        finish(ages) {
            for (const line of ages) {
                const tech = AGE_TECHS[line.age];
                for (let i = events.length - 1; i >= 0; i--) {
                    const e = events[i];
                    if (e.k !== 'research' || e.p !== line.p || e.tech !== tech || e.t >= line.t) continue;
                    if (e.cancelled) {
                        e.cancelled = false;
                        if (e.passedOver && e.passedOver.n > 0) e.passedOver.n--;
                    }
                    break;
                }
            }
            const kept = events.filter(e => !e.cancelled && (e.k !== 'queue' || e.n > 0));
            for (const e of kept) delete e.passedOver;
            return { events: kept, apm, unreadable };
        }
    };
}

function endWarnings(end, time, unreadable) {
    const warnings = [];
    if (end.reason === 'eof') warnings.push('This recording stops without the game\'s closing record: whoever recorded it may have left before the end.');
    if (end.reason === 'truncated' || end.reason === 'corrupt') warnings.push(`This file is cut off or damaged: the game is shown up to ${Math.floor(time / 60000)} minutes in.`);
    if (unreadable) warnings.push(`${unreadable} orders in this file couldn't be read and are left out.`);
    return warnings;
}

// A forged file can pack millions of records into a few KB, and the page loops over these
function checkLimits(events, startObjects, gaia, chat) {
    const dots = gaia.gold.length + gaia.stone.length + gaia.forage.length + gaia.fish.length + gaia.relic.length;
    const points = Object.values(gaia).reduce((n, list) => n + list.length, 0);
    let placed = 0;
    for (const e of events) if (e.k === 'build' || e.k === 'wall') placed++;
    if (startObjects.length > LIMITS.startObjects || dots / 2 > LIMITS.drawnGaia || points / 2 > LIMITS.gaia
        || placed > LIMITS.placed || events.length > LIMITS.events || chat.length > LIMITS.chat) {
        throw userError('That file holds far more than a real game does.');
    }
}

async function parseFile(input, inflateRaw, onProgress = () => { }) {
    let bytes = input;
    // A replay starts with its header length, which can begin with these two bytes too
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) {
        onProgress('Unpacking the ZIP…');
        bytes = await unzipReplay(bytes, inflateRaw);
    }
    if (bytes.length < 64) throw userError('That file is too small to be a replay.');
    onProgress('Reading the map and players…');
    const { header, head, bodyStart } = await readHeader(bytes, inflateRaw);
    const de = head.de;
    let section;
    try {
        section = ReplayObjects.parsePlayerSection(header, head.save, head.meta.numPlayers, { from: head.offsets.afterMap });
    } catch (e) {
        throw userError('That replay couldn\'t be read: its players\' starting state isn\'t what the viewer expected.', e);
    }
    const mapName = section.scenarioStart >= 0 ? ReplayObjects.findMapName(header, { from: section.scenarioStart }) : null;
    const gaiaRecord = section.players.find(p => p.number === 0);
    const { lists: gaia, resourceIds } = gaiaOf(gaiaRecord ? gaiaRecord.objects : []);
    const seated = de.players;
    const seats = new Set(seated.map(p => p.number));
    const humans = seated.filter(p => p.type === 'human').map(p => p.number);

    onProgress('Reading the game…');
    const stats = Object.fromEntries(seated.map(p => [p.number, []]));
    const chat = [];
    const commands = collectCommands(seats, humans, resourceIds);
    // A player's client logs its camera at every step, from the first; a watching client logs none. That's what tells
    // the two apart: the recording player reads 1 for a watcher, and the file name holds the same number. A read can
    // land between a step and its camera record, so a file with only a few steps says neither (null).
    let steps = 0, cameras = 0;
    const walk = ReplayStream.walkBody(bytes, bodyStart, {
        action: commands.action,
        sync() { steps++; },
        viewlock() { cameras++; },
        chat: (line, time) => chat.push({ chat: line, time }),
        checksum(block, time) {
            for (const row of block.rows) if (stats[row.player]) stats[row.player].push([time, row.resources, row.objectCount]);
        }
    }, { seats: [...seats] });
    const records = new Map(section.players.map(p => [p.number, p]));
    // "Standard" says nothing about the age: Empire Wars starts in Feudal, and a campaign's players can differ
    const startAges = new Map(seated.map(p => {
        const record = records.get(p.number);
        return [p.number, de.startingAge === 'standard' ? AGE_ORDER[record && record.currentAge] || 'dark' : de.startingAge];
    }));
    const teamOf = new Map(seated.map(p => [p.number, p.teamId > 1 ? p.teamId : null]));
    const { rows: chatLines, ages } = splitChat(chat, startAges, teamOf);
    const { events, apm, unreadable } = commands.finish(ages);

    const sides = new Set(seated.map(p => p.teamId > 1 ? p.teamId : `solo${p.number}`));
    const ratings = ratingsOf(walk.postgame, seated.length === 2 && sides.size === 2);
    const players = seated.map(p => {
        const record = records.get(p.number);
        return {
            number: p.number,
            name: p.name || p.aiName || `Player ${p.number}`,
            profileId: p.profileId > 0 ? p.profileId : null,
            civId: p.civId,
            color: p.colorId + 1,
            team: p.teamId > 1 ? p.teamId - 1 : null,
            human: p.type === 'human',
            startingAge: startAges.get(p.number),
            start: record && record.start ? { x: record.start.x, y: record.start.y } : null,
            rating: ratings.get(p.number) ?? null
        };
    });
    const startObjects = [];
    for (const record of section.players) {
        if (record.number === 0) continue;
        for (const o of record.objects) startObjects.push({ player: record.number, unit: o.typeId, x: o.x, y: o.y });
    }
    const allEvents = events.concat(ages).sort((a, b) => a.t - b.t);
    checkLimits(allEvents, startObjects, gaia, chatLines);
    return {
        file: { game: head.game, save: head.save, build: head.build, complete: walk.end.reason === 'postgame', steps, watched: cameras ? false : steps >= MIN_STEPS_TO_TELL ? true : null },
        startedAt: head.timestamp || null,
        duration: walk.time,
        settings: {
            map: (mapName && mapName.name) || null,
            mapSize: (mapName && mapName.sizeLabel) || null,
            dimension: head.map.dimension,
            rmsMapId: de.rmsMapId,
            speed: SPEEDS[Math.round(de.speed * 100)] || null,
            population: de.populationLimit,
            infiniteResources: de.startingResourcesId === 5,
            turbo: !!de.turbo,
            treaty: de.treatyLength,
            lobby: de.lobby || null,
            mod: de.mod || null,
            rated: !!de.rated,
            hiddenCivs: !!de.hiddenCivs
        },
        players,
        map: { dimension: head.map.dimension, terrain: head.map.terrain, elevation: head.map.elevation },
        gaia,
        startObjects,
        sizes: ReplaySizes.buildingSizes(header),
        events: allEvents,
        apm,
        stats,
        chat: chatLines,
        warnings: endWarnings(walk.end, walk.time, unreadable)
    };
}

const ReplayParse = { parseFile };
if (typeof module !== 'undefined') module.exports = ReplayParse;
