// Builds replay-data.json (the unit, building, tech, civ, map and terrain tables the replay viewer needs) from
// SiegeEngineers/aoe2techtree's data, MIT licence, plus the tables below for what that data has no entry for.
//   node tools/build-replay-data.js        fetches the pinned commit below from GitHub
//   node tools/build-replay-data.js <dir>  reads <dir>/data.json and <dir>/strings.json (data/locales/en/strings.json)
// Rerun after a game update, with COMMIT and GAME_UPDATE bumped. node qa/replay-check.js checks the file's shape on a
// running server, and node qa/replay-check.js parse <savegame folder> reports ids this data doesn't name. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'SiegeEngineers/aoe2techtree';
const COMMIT = 'e56728e76b7d08301fba7b18d5f16bc8554c109a';
const GAME_UPDATE = '188329';
const LICENCE = 'MIT License, Copyright (c) 2018 HSZemi';
// aoe2techtree's LICENSE at that commit, shipped in full with the data taken from it
const LICENCE_TEXT = `MIT License

Copyright (c) 2018 HSZemi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const OUT = path.join(__dirname, '..', 'replay-data.json');

// ---- what aoe2techtree has no entry for ----
// Units the replays train that aoe2techtree lacks (the Chronicles civs' units) and their Elite versions:
// [name, game unit class, cost, train time], read from the unit type records in save 68.9 replay headers (the most
// common value over ~800 records per unit; extract-extras.js). Names are the records' own, costs before civ bonuses.
const EXTRA_UNITS = {
    2101: ['Immortal', 6, { food: 50, gold: 20 }, 12],
    2102: ['Elite Immortal', 6, { food: 50, gold: 20 }, 10],
    2104: ['Strategos', 6, { food: 55, gold: 25 }, 16],
    2105: ['Elite Strategos', 6, { food: 55, gold: 25 }, 16],
    2107: ['Hippeus', 6, { food: 60, gold: 30 }, 19],
    2108: ['Elite Hippeus', 6, { food: 60, gold: 30 }, 17],
    2110: ['Hoplite', 6, { food: 55, gold: 30 }, 28],
    2111: ['Elite Hoplite', 6, { food: 55, gold: 30 }, 25],
    2150: ['War Chariot', 12, { wood: 65, gold: 65 }, 24],
    2151: ['Elite War Chariot', 12, { wood: 65, gold: 65 }, 24],
    2174: ['Immortal Ranged', 0, { food: 50, gold: 20 }, 12],
    2175: ['Elite Immortal Ranged', 0, { food: 50, gold: 20 }, 10],
    2187: ['Hoplite with Xyphos', 6, { food: 55, gold: 30 }, 24],
    2188: ['Elite Hoplite with Xyphos', 6, { food: 55, gold: 30 }, 21],
    2227: ['Strategos with Taxiarchs', 6, { food: 55, gold: 25 }, 16],
    2228: ['Elite Strategos with Taxiarchs', 6, { food: 55, gold: 25 }, 16],
    2382: ['Companion Cavalry', 12, { food: 70, gold: 65 }, 26],
    2383: ['Elite Companion Cavalry', 12, { food: 70, gold: 65 }, 26],
    2384: ['Phalangite', 6, { food: 50, gold: 40 }, 19],
    2385: ['Elite Phalangite', 6, { food: 50, gold: 40 }, 15],
    2386: ['Rhomphaia Warrior', 6, { food: 50, gold: 40 }, 13],
    2387: ['Elite Rhomphaia Warrior', 6, { food: 50, gold: 40 }, 13],
    2388: ['Pattiyodha Longbowman', 0, { wood: 60, gold: 35 }, 16],
    2389: ['Elite Pattiyodha Longbowman', 0, { wood: 60, gold: 35 }, 16],
    2390: ['Sannahya', 12, { food: 90, gold: 80 }, 26],
    2391: ['Elite Sannahya', 12, { food: 90, gold: 80 }, 22],
    2485: ['Scythian Horse Archer', 36, { wood: 45, gold: 65 }, 34],
    2486: ['Elite Scythian Horse Archer', 36, { wood: 45, gold: 65 }, 27],
    // The Spartans' leader, trained at the Town Center; its record has no cost block, so cost and time are unknown (0)
    2162: ['Polemarch 1', 6, {}, 0]
};
// Units players own at the start (header objects) that aoe2techtree lacks: [name, the start of the records' name
// (SHEEP is SHEEPG in some games), game class, cls]. Livestock is class 58, the herdable horse 61, the King 59
const START_UNITS = {
    305: ['Llama', 'LLAMAA', 58, 'other'], 434: ['King', 'KINGX', 59, 'hero'], 594: ['Sheep', 'SHEEP', 58, 'other'],
    1060: ['Goat', 'GOAT', 58, 'other'], 1243: ['Goose', 'GOOSE', 58, 'other'], 1245: ['Pig', 'PIG', 58, 'other'],
    1606: ['Horse', 'HORSEWBR', 61, 'other'], 1963: ['Llama', 'LLAMAB', 58, 'other'], 2590: ['Capybara', 'CAPYBARA', 58, 'other']
};
// A villager changes unit id with its task (builder, farmer, ...); every id below is a class 4 (civilian) record
// named V[MF]<task> in the replay headers. They take the Villager's (83) data.
const VILLAGER_IDS = [56, 57, 118, 120, 122, 123, 124, 156, 212, 214, 216, 218, 220, 222, 259, 293, 354, 579, 581, 590,
    592, 1891, 1892, 2333, 2334, 2714, 2715];
// Same unit, other state: a loaded Trade Cart
const UNIT_ALIASES = { 204: 128 };

// Building ids the replays use that aoe2techtree lacks: the other gate orientations (build commands), and the gate
// pieces some maps place in the header as players' starting objects, with no gate of their own: GTAA/GTAB/GTAC
// (64, 78, 81) and GTBA/GTBB/GTBC (88, 91, 95)
const EXTRA_BUILDINGS = {
    490: 487, 665: 487, 673: 487, 796: 792, 800: 792, 804: 792,
    64: 487, 78: 487, 81: 487, 88: 487, 91: 487, 95: 487
};
// A building's later-age looks are units of their own; an upgraded building's record carries one of these as its
// current id (the replay headers' records give the base id each belongs to)
const BUILDING_ALIASES = {
    10: 87, 14: 87, 18: 103, 19: 103, 20: 12, 30: 104, 31: 104, 32: 104, 47: 45, 51: 45, 86: 101, 105: 103, 116: 84,
    129: 68, 130: 68, 131: 68, 132: 12, 133: 45, 137: 84, 141: 109, 142: 109, 150: 49, 153: 101, 210: 209, 463: 70,
    464: 70, 465: 70, 484: 621, 488: 487, 491: 490, 498: 12, 563: 562, 564: 562, 565: 562, 585: 584, 586: 584,
    587: 584, 597: 621, 617: 621, 666: 665, 674: 673, 2558: 2556, 2560: 2556,
    // A built pasture (and its mangrove look); 1889 is the id build commands place
    1893: 1889, 1897: 1889,
    // The gate pieces' earlier-age looks
    63: 64, 67: 78, 80: 81, 85: 88, 90: 91, 92: 95
};
// Footprint in tiles, [width, height] where not square, in the standard game: twice the collision box of the replay
// headers' records. Checked three ways on 745 replays: against each game's own records, against the build commands'
// positions (a building of odd side is placed on a tile centre, x.5; even on a corner, x.0), and against their
// spacing (a player's placements never overlap at the real side). A game's own records can differ (farms are 1x1 in
// 115 corpus games and 2x2 in 15, the latter under a data mod for it), so the viewer should prefer building-sizes.js
// and use these when a game has no record. Pasture (1889) is the
// one id whose own box (1.0) is not its footprint: it places a built Pasture (1897, box 2.0), and pastures pack 4
// tiles apart. Gates and palisade gates are 4 x 1 one way, 1 x 4 the other; the diagonal ones' records give 2 x 2.
const SIZES = {
    12: 3, 45: 3, 49: 4, 50: 3, 68: 2, 70: 2, 71: 4, 72: 1, 79: 1, 82: 4, 84: 4, 87: 3, 101: 3, 103: 3, 104: 3, 109: 4,
    117: 1, 155: 1, 199: 1, 209: 4, 234: 1, 235: 1, 236: 1, 276: 5, 487: [4, 1], 490: [1, 4], 562: 2, 584: 2, 598: 1,
    621: 4, 665: 2, 673: 2, 792: [4, 1], 796: [1, 4], 800: 2, 804: 2, 1021: 5, 1189: 3, 1251: 3, 1665: 2, 1734: 3,
    1754: 4, 1806: 3, 1808: 1, 1889: 4, 2556: 3,
    64: [2, 1], 78: [2, 1], 81: 1, 88: [1, 2], 91: [1, 2], 95: 1
};
// Objects that are pieces of another building in the header: part id -> building id, so the viewer draws the
// building only. Every Town Center stands with RTWC*A/B/C (618-620), "Trophy None" (1649) and in some games "Empty
// TC annex" (890) at fixed offsets from its centre.
const PARTS = { 618: 109, 619: 109, 620: 109, 890: 109, 1649: 109 };
// Header objects that are neither units nor buildings: the start flares (FLARE3, FLARE4) and scenario flags (ESFLAG,
// FEFLAG). id -> what to call them
const MARKERS = { 332: 'Flare', 697: 'Flare', 851: 'Flag', 1285: 'Flag' };

// Game unit class (the replay headers' records) -> the viewer's class, for the classes the corpus's records give the
// table's units: 0 archer, 2 trade boat, 4 civilian, 6 infantry, 12 cavalry, 13 siege weapon, 18 monk, 19 trade cart,
// 20 transport, 21 fishing boat, 22 warship, 23 conquistador, 35 petard, 36 cavalry archer, 44 hand cannoneer,
// 47 scout cavalry, 55 scorpion, 58 livestock, 59 king and scenario heroes, 61 herdables (horses, camels, alpacas;
// the 68.9 repairer villagers carry it too). Used for EXTRA_UNITS.
const GAME_CLASS = {
    0: 'archer', 2: 'trade', 4: 'villager', 6: 'infantry', 12: 'cavalry', 13: 'siege', 18: 'monk', 19: 'trade',
    20: 'ship', 21: 'ship', 22: 'ship', 23: 'archer', 35: 'siege', 36: 'archer', 44: 'archer', 47: 'cavalry',
    55: 'siege', 58: 'other', 59: 'hero', 61: 'other'
};
// aoe2techtree has no unit class, so unitClass() derives one from armour classes. CLASS_OVERRIDES holds the units
// where that rule and the game disagree and the game is followed: castle units take the game's class, others their
// training building's line (a Flaming Camel is a siege workshop unit, game class 35 petard). Still differing from the
// game by choice: Armored/Siege Elephant, Mounted Trebuchet and the Shu War Chariot (game class cavalry, but siege
// workshop units in the corpus), Warrior Priest (infantry, but a monk trained at the Fortified Church), the three
// Three Kingdoms heroes (armour class 36) and the Spartan Polemarch (a leader unit).
const CLASS_OVERRIDES = { 1120: 'cavalry', 1122: 'cavalry', 1263: 'siege', 1738: 'cavalry', 1740: 'cavalry', 2162: 'hero' };

// Replay civilization_id = aoe2techtree's name_string_id - 10270 (Britons 10271 -> 1 ... Danes 10332 -> 62), checked
// against the units each civ trains in the corpus. The Chronicles civs fill the gaps in that string range
// (10316-10318, 10324-10326) and are not in aoe2techtree.
const CIV_STRING_BASE = 10270;
const OTHER_CIVS = { 0: 'Gaia', 46: 'Achaemenids', 47: 'Athenians', 48: 'Spartans', 54: 'Macedonians', 55: 'Thracians', 56: 'Puru' };

// rms_map_id of the DE header (mgz parse_de) -> name, for the built-in maps. The header's own 'Location: <name>' text
// says the same in the game's language, and is the only name a custom map has (CUSTOM_MAP_IDS).
const MAPS = {
    9: 'Arabia', 10: 'Archipelago', 11: 'Baltic', 12: 'Black Forest', 13: 'Coastal', 14: 'Continental',
    15: 'Crater Lake', 16: 'Fortress', 17: 'Gold Rush', 18: 'Highland', 19: 'Islands', 20: 'Mediterranean',
    21: 'Migration', 22: 'Rivers', 23: 'Team Islands', 25: 'Scandinavia', 26: 'Mongolia', 27: 'Yucatan',
    28: 'Salt Marsh', 29: 'Arena', 31: 'Oasis', 32: 'Ghost Lake', 33: 'Nomad', 49: 'Iberia', 50: 'Britain',
    51: 'Mideast', 52: 'Texas', 53: 'Italy', 54: 'Central America', 55: 'France', 56: 'Norse Lands',
    57: 'Sea of Japan (East Sea)', 58: 'Byzantium', 67: 'Acropolis', 68: 'Budapest', 69: 'Cenotes', 70: 'City of Lakes',
    71: 'Golden Pit', 72: 'Hideout', 73: 'Hill Fort', 74: 'Lombardia', 75: 'Steppe', 76: 'Valley', 77: 'MegaRandom',
    78: 'Hamburger', 79: 'CtR Random', 80: 'CtR Monsoon', 81: 'CtR Pyramid Descent', 82: 'CtR Spiral',
    83: 'Kilimanjaro', 84: 'Mountain Pass', 85: 'Nile Delta', 86: 'Serengeti', 87: 'Socotra', 88: 'Amazon',
    89: 'China', 90: 'Horn of Africa', 91: 'India', 92: 'Madagascar', 93: 'West Africa', 94: 'Bohemia', 95: 'Earth',
    96: 'Canyons', 97: 'Enemy Archipelago', 98: 'Enemy Islands', 99: 'Far Out', 100: 'Front Line', 101: 'Inner Circle',
    102: 'Motherland', 103: 'Open Plains', 104: 'Ring of Water', 105: 'Snakepit', 106: 'The Eye', 107: 'Australia',
    108: 'Indochina', 109: 'Indonesia', 110: 'Strait of Malacca', 111: 'Philippines', 112: 'Bog Islands',
    113: 'Mangrove Jungle', 114: 'Pacific Islands', 115: 'Sandbank', 116: 'Water Nomad', 117: 'Jungle Islands',
    118: 'Holy Line', 119: 'Border Stones', 120: 'Yin Yang', 121: 'Jungle Lanes', 122: 'Alpine Lakes', 123: 'Bogland',
    124: 'Mountain Ridge', 125: 'Ravines', 126: 'Wolf Hill', 132: 'Antarctica', 133: 'Aral Sea', 134: 'Black Sea',
    135: 'Caucasus', 136: 'Siberia', 139: 'Golden Swamp', 140: 'Four Lakes', 141: 'Land Nomad', 147: 'Amazon Tunnel',
    148: 'Coastal Forest', 149: 'African Clearing', 150: 'Atacama', 151: 'Seize the Mountain', 152: 'Crater',
    153: 'Crossroads', 154: 'Michi', 155: 'Team Moats', 156: 'Volcanic Island', 157: 'Acclivity', 158: 'Eruption',
    159: 'Frigid Lake', 160: 'Greenland', 161: 'Lowland', 162: 'Marketplace', 163: 'Meadow', 164: 'Mountain Range',
    165: 'Northern Isles', 166: 'Ring Fortress', 167: 'Runestones', 168: 'Aftermath', 169: 'Enclosed', 170: 'Haboob',
    171: 'Kawasan', 172: 'Land Madness', 173: 'Sacred Springs', 174: 'Wade', 175: 'Morass', 176: 'Shoals',
    196: 'QS Black Forest'
};
// Custom map (59), custom map pool (137), custom deathmatch map (138): the id names no map, the Location text does
const CUSTOM_MAP_IDS = [59, 137, 138];

// DE terrain ids: name, kind (what it is for movement and the minimap) and a colour of our own choosing for the
// minimap. Kinds: land, forest, water (ships only), shallows (land units and ships), beach (land units, and ships
// and water buildings too: docks and fish traps stand on it in the corpus), farm, road, ice, other. The
// non-navigable beaches (79-82) are land. Kinds of the ids the corpus maps use were checked against
// the gaia objects on them (trees, fish) and against where players place land and water buildings.
const TERRAIN = {
    0: ['Grass 1', 'land', '#5b8f3b'], 1: ['Water, Shallow', 'water', '#3c78b4'], 2: ['Beach', 'beach', '#dcc58f'],
    3: ['Dirt 3', 'land', '#a07b4f'], 4: ['Shallows', 'shallows', '#6fa7c6'], 5: ['Underbush', 'land', '#6d6b37'],
    6: ['Dirt 1', 'land', '#ad8a5c'], 7: ['Farm', 'farm', '#c9a95b'], 8: ['Farm, Dead', 'farm', '#8e7a53'],
    9: ['Grass 3', 'land', '#7aa24b'], 10: ['Forest, Oak', 'forest', '#2e5a23'], 11: ['Dirt 2', 'land', '#b9976b'],
    12: ['Grass 2', 'land', '#6a9a41'], 13: ['Forest, Palm Desert', 'forest', '#5e7b37'],
    14: ['Desert, Sand', 'land', '#d9c58b'], 15: ['Water, Old', 'water', '#3a71ad'],
    16: ['Grass, Other', 'land', '#608b3d'], 17: ['Forest, Jungle', 'forest', '#285f2b'],
    18: ['Forest, Bamboo', 'forest', '#4b7b2f'], 19: ['Forest, Pine', 'forest', '#24502b'],
    20: ['Forest, Oak Bush', 'forest', '#3a6529'], 21: ['Forest, Snow Pine', 'forest', '#3f5e4b'],
    22: ['Water, Deep', 'water', '#234c87'], 23: ['Water, Medium', 'water', '#2e62a2'], 24: ['Road', 'road', '#b39d77'],
    25: ['Road, Broken', 'road', '#a8946e'], 26: ['Ice, Navigable', 'water', '#b5d5e5'],
    27: ['Foundation', 'land', '#9f8b6b'], 28: ['Water, Bridge', 'water', '#3a71ad'],
    29: ['Farm, Construction 1', 'farm', '#b39963'], 30: ['Farm, Construction 2', 'farm', '#b8a066'],
    31: ['Farm, Construction 3', 'farm', '#bea86b'], 32: ['Snow', 'land', '#eef1f3'], 33: ['Snow, Dirt', 'land', '#d8d3cb'],
    34: ['Snow, Grass', 'land', '#dee6db'], 35: ['Ice', 'ice', '#cfe2eb'], 36: ['Snow, Foundation', 'land', '#e3e3df'],
    37: ['Ice, Beach', 'beach', '#d7e3e9'], 38: ['Road, Snow', 'road', '#c8c2b7'], 39: ['Road, Fungus', 'road', '#8f8465'],
    40: ['Rock 1', 'land', '#8a8277'], 41: ['Dirt, Savannah', 'land', '#c2a867'], 42: ['Dirt 4', 'land', '#8e7250'],
    43: ['Road, Gravel', 'road', '#a29987'], 45: ['Desert, Cracked', 'land', '#c8ad77'],
    46: ['Desert, Quicksand', 'land', '#ccb37d'], 47: ['Black', 'other', '#111111'],
    48: ['Forest, Dragon Tree', 'forest', '#3a6a3b'], 49: ['Forest, Baobab', 'forest', '#566b30'],
    50: ['Forest, Acacia', 'forest', '#6b7a36'], 51: ['Beach, White Vegetation', 'beach', '#e6dcae'],
    52: ['Beach, Vegetation', 'beach', '#c7be85'], 53: ['Beach, White', 'beach', '#ede1b9'],
    54: ['Shallows, Mangrove', 'shallows', '#5b8e85'], 55: ['Forest, Mangrove', 'forest', '#2f5a3b'],
    56: ['Forest, Rainforest', 'forest', '#1f5428'], 57: ['Water, Deep Ocean', 'water', '#1c3e74'],
    58: ['Water, Azure', 'water', '#2f85c1'], 59: ['Shallows, Azure', 'shallows', '#5eafd5'],
    60: ['Grass, Jungle', 'land', '#4f8936'], 63: ['Rice Farm', 'farm', '#8fad5a'], 64: ['Rice Farm, Dead', 'farm', '#8a8a5a'],
    65: ['Rice Farm, Construction 1', 'farm', '#99a862'], 66: ['Rice Farm, Construction 2', 'farm', '#94aa5e'],
    67: ['Rice Farm, Construction 3', 'farm', '#90ac5b'], 70: ['Gravel, Default', 'land', '#9a9284'],
    71: ['Underbush, Leaves', 'land', '#75683a'], 72: ['Underbush, Snow', 'land', '#c8cbc1'],
    73: ['Snow, Light', 'land', '#e5eaed'], 74: ['Snow, Strong', 'land', '#f6f8fa'], 75: ['Road, Fungus', 'road', '#8b8263'],
    76: ['Moorland', 'land', '#6c7b49'], 77: ['Underbush, Jungle', 'land', '#5b6a31'],
    78: ['Road, Gravel (Desert)', 'road', '#bead87'], 79: ['Beach (Non-Navigable)', 'land', '#d8c18b'],
    80: ['Beach, Wet (Non-Navigable)', 'land', '#bfae80'], 81: ['Beach, Wet Gravel (Non-Navigable)', 'land', '#a69c87'],
    82: ['Beach, Wet Rock (Non-Navigable)', 'land', '#8f8a7f'], 83: ['Grass, Jungle (Rainforest)', 'land', '#4a8233'],
    88: ['Forest, Mediterranean', 'forest', '#3f6a31'], 89: ['Forest, Bush', 'forest', '#567a36'],
    90: ['Forest, Reeds (Shallows)', 'forest', '#6a8c58'], 91: ['Forest, Reeds (Beach)', 'forest', '#8a9a5a'],
    92: ['Forest, Reeds', 'forest', '#6e8a45'], 95: ['Water, Green', 'water', '#3c7e79'],
    96: ['Water, Brown', 'water', '#5d6e5b'], 100: ['Grass, Dry', 'land', '#9b9f53'],
    101: ['Swamp, Bogland', 'land', '#4f5a3a'], 102: ['Gravel, Desert', 'land', '#b8a47d'],
    104: ['Forest, Autumn', 'forest', '#8a5a2b'], 105: ['Forest, Autumn Snow', 'forest', '#a38a71'],
    106: ['Forest, Dead', 'forest', '#5e5547'], 107: ['Beach, Wet', 'beach', '#c4b384'],
    108: ['Beach, Wet Gravel', 'beach', '#a89f8a'], 109: ['Beach, Wet Rock', 'beach', '#918c82'],
    // Named from the corpus: the gaia trees standing on every tile of them (BIRCH, FPAL, FLBAM records)
    110: ['Forest, Birch', 'forest', '#4f7b3b'], 112: ['Forest, Palm', 'forest', '#4f7a2f'],
    113: ['Forest, Lush Bamboo', 'forest', '#3f7a2b'],
    // Name unknown: open land on one winter coastal map (gold, stone, deer and snow cliffs on it)
    126: ['Terrain 126', 'land', '#c9c4b5']
};

// The age-up research ids (aoe2techtree: 101 "Feudal Age", 102 "Castle Age", 103 "Imperial Age")
const AGES = { feudal: 101, castle: 102, imperial: 103 };

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'aoe2lobby.online replay-data build' } }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

async function load(dir) {
    if (dir) {
        return [JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, 'strings.json'), 'utf8'))];
    }
    const raw = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/data`;
    return Promise.all([get(`${raw}/data.json`).then(JSON.parse), get(`${raw}/locales/en/strings.json`).then(JSON.parse)]);
}

// Names are small HTML at times ("Throwing<br>\nAxeman")
function plain(html) {
    return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function cost(c = {}) {
    return { food: c.Food || c.food || 0, wood: c.Wood || c.wood || 0, gold: c.Gold || c.gold || 0, stone: c.Stone || c.stone || 0 };
}

// Armour classes (aoe2techtree's Armours): 1 infantry, 5 elephants, 8 cavalry, 15 archers, 16 ships, 17 rams and
// siege towers, 20 siege weapons, 25 monks, 27 spearmen, 28 cavalry archers, 29 eagles, 30 camels, 34 fishing ships,
// 36 heroes. Checked in this order: a unit with several (a Ballista Elephant: 5, 8, 20) takes the first that fits.
function unitClass(u) {
    if (CLASS_OVERRIDES[u.ID]) return CLASS_OVERRIDES[u.ID];
    if (u.internal_name === 'VMBAS') return 'villager';
    if (u.internal_name === 'TCART' || u.internal_name === 'COGXX') return 'trade';
    const a = new Set((u.Armours || []).map(x => x.Class));
    if (a.has(36)) return 'hero';
    if (a.has(25)) return 'monk';
    if (a.has(16) || a.has(34)) return 'ship';
    if (a.has(17) || a.has(20) || u.internal_name === 'PETARD') return 'siege';
    if (a.has(15) || a.has(28)) return 'archer';
    if (a.has(8) || a.has(30) || a.has(5)) return 'cavalry';
    if (a.has(1) || a.has(27) || a.has(29)) return 'infantry';
    return 'other';
}

// A unit's English name is string LanguageNameId + 9000, or for a few newer units LanguageNameId itself
// ("Ratha (Ranged)"); a tech's is LanguageNameId + 10000; two removed techs have none and keep their internal name
function unitName(u, strings) {
    return plain(strings[String(u.LanguageNameId + 9000)]) || plain(strings[String(u.LanguageNameId)]) || u.internal_name;
}

function techName(t, strings) {
    return plain(strings[String(t.LanguageNameId + 10000)]) || t.internal_name;
}

function byId(obj) {
    return Object.fromEntries(Object.entries(obj).sort((a, b) => a[0] - b[0]));
}

function buildUnits(data, strings, problems) {
    const units = {};
    for (const u of Object.values(data.data.Unit)) {
        units[u.ID] = { name: unitName(u, strings), cost: cost(u.Cost), time: u.TrainTime, cls: unitClass(u) };
    }
    for (const [id, [name, gameClass, c, time]] of Object.entries(EXTRA_UNITS)) {
        if (units[id]) { problems.push(`unit ${id} is in aoe2techtree now: drop it from EXTRA_UNITS`); continue; }
        units[id] = { name, cost: cost(c), time, cls: CLASS_OVERRIDES[id] || GAME_CLASS[gameClass] || 'other' };
    }
    for (const [id, [name, , , cls]] of Object.entries(START_UNITS)) {
        if (units[id]) { problems.push(`unit ${id} is in aoe2techtree now: drop it from START_UNITS`); continue; }
        units[id] = { name, cost: cost(), time: 0, cls };
    }
    for (const id of VILLAGER_IDS) if (!units[id]) units[id] = { ...units[83] };
    for (const [id, base] of Object.entries(UNIT_ALIASES)) if (!units[id]) units[id] = { ...units[base] };
    return byId(units);
}

function buildBuildings(data, strings, problems) {
    const buildings = {};
    const add = (id, name, c, time) => {
        const size = SIZES[id];
        if (size === undefined) problems.push(`building ${id} ${name}: no size`);
        buildings[id] = { name, cost: cost(c), time, size: size === undefined ? null : size };
    };
    for (const b of Object.values(data.data.Building)) add(b.ID, unitName(b, strings), b.Cost, b.TrainTime);
    for (const [id, base] of Object.entries(EXTRA_BUILDINGS)) {
        const b = buildings[base];
        add(Number(id), b.name, b.cost, b.time);
    }
    for (const [id, base] of Object.entries(BUILDING_ALIASES)) {
        if (buildings[id]) { problems.push(`building alias ${id} is a building of its own`); continue; }
        buildings[id] = { ...buildings[base] };
    }
    return byId(buildings);
}

function buildTechs(data, strings, units) {
    const techs = {};
    for (const t of Object.values(data.data.Tech)) techs[t.ID] = { name: techName(t, strings), cost: cost(t.Cost), time: t.ResearchTime };
    // Unit upgrades (Elite Skirmisher, Crossbowman, ...) are keyed by the unit they make; their name is that unit's
    for (const [unitId, t] of Object.entries(data.data.unit_upgrades)) {
        if (techs[t.ID]) continue;
        techs[t.ID] = { name: units[unitId] ? units[unitId].name : t.internal_name, cost: cost(t.Cost), time: t.ResearchTime };
    }
    return byId(techs);
}

function buildCivs(data, problems) {
    const civs = { ...OTHER_CIVS };
    for (const [key, c] of Object.entries(data.civs)) {
        const id = c.name_string_id - CIV_STRING_BASE;
        // Keyed like civ-info.json (the data's civ key, the lobby feeds' name: "Incas" where the text says "Inca")
        if (civs[id] !== undefined) problems.push(`civ id ${id} for ${key} is already ${civs[id]}`);
        if (!(id > 0 && id < 100)) problems.push(`civ ${key}: id ${id} out of range`);
        civs[id] = key;
    }
    return byId(civs);
}

function buildTerrain() {
    const out = {};
    for (const [id, [name, kind, color]] of Object.entries(TERRAIN)) out[id] = { name, color, kind };
    return out;
}

async function main() {
    const [data, strings] = await load(process.argv[2]);
    const problems = [];
    const units = buildUnits(data, strings, problems);
    const buildings = buildBuildings(data, strings, problems);
    const techs = buildTechs(data, strings, units);
    for (const [age, id] of Object.entries(AGES)) {
        if (!techs[id] || !techs[id].name.toLowerCase().startsWith(age)) problems.push(`age ${age}: tech ${id} is ${techs[id] && techs[id].name}`);
    }
    const out = {
        source: `${REPO} at ${COMMIT.slice(0, 7)} (game update ${GAME_UPDATE}), ${LICENCE}; extra units, sizes, civ ids, maps and terrain: aoe2lobby.online, checked against recorded games of saves 67.2 to 68.9`,
        licence: LICENCE_TEXT,
        // What the numbers are, since a game's own data can differ
        values: {
            cost: `the standard game (Turbo Mode off) of update ${GAME_UPDATE}, save 68.9, before civ bonuses`,
            time: `seconds, the standard game (Turbo Mode off) of update ${GAME_UPDATE}, save 68.9. Turbo games' own unit records hold other times (villagers 62 s, castles 500 s) and, in 68.9, cheaper ships; saves 67.2 and 68 differ for 22 to 29 units`,
            size: 'tiles, the standard game; prefer the game\'s own records (building-sizes.js): farms are 1x1 or 2x2 in some games, and a Poles player\'s mill is a 3x3 Folwark'
        },
        units,
        buildings,
        techs,
        ages: AGES,
        parts: PARTS,
        markers: MARKERS,
        civs: buildCivs(data, problems),
        maps: MAPS,
        customMapIds: CUSTOM_MAP_IDS,
        terrain: buildTerrain()
    };
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    const n = k => Object.keys(out[k]).length;
    console.log(`Wrote ${path.basename(OUT)}: ${n('units')} units, ${n('buildings')} buildings, ${n('techs')} techs, ${n('civs')} civs, ${n('maps')} maps, ${n('terrain')} terrains, ${fs.statSync(OUT).size} bytes`);
    for (const p of problems) console.log('  ' + p);
}

module.exports = { unitClass, GAME_CLASS, SIZES, EXTRA_UNITS, START_UNITS, PARTS, MARKERS, TERRAIN, MAPS };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
