# Player records, starting objects and the map name (saves 67.2, 68, 68.9)

Part of the in-browser `.aoe2record` viewer work. Decoder: `objects.js`, plain JS with no Node APIs, exposing
`ReplayObjects` (load `../reader.js` first). Evidence: `test-objects.js` run over **all 745 local files**:
- 67.2: builds 170934, 174992, 175278
- 68: builds 177723, 178524, 179158, 180059
- 68.9: builds 185872, 188329

Result: **745 of 745 pass**. Classification: `gaia-classes.json`, built by `build-gaia-classes.js` from that run's
`census.json`.

Reference: mgz `fast/header.py` (`parse_players`, `parse_player`, `object_block`, `parse_object`, `parse_de`,
`parse_scenario`), `header/initial.py`, `header/objects.py`, `common/map.py`. mgz stops at save 66.6. Below,
*verified* means checked on this corpus, *mgz* means taken from mgz and consistent with the corpus, and *guess* means
unverified. The test checks the lobby settings and the map section's dimension against `../header/header.js`.

## API

```js
// Browser: <script src="reader.js"></script><script src="objects.js"></script>, then ReplayObjects.parsePlayers(...)
// Node: const ReplayObjects = require('./objects.js');
ReplayObjects.parsePlayers(header, save, n?)
    // [{ number, type, name, diplomacy, civId, colorId, start: {x, y}, objects }]; throws if the section is incomplete
ReplayObjects.parsePlayerSection(header, save, n?, { from, keepHelpers, layout })
    // { players, start, end, scenarioStart, n, complete, warnings }
ReplayObjects.findMapName(header, { from })
    // { name, sizeLabel, sizeTiles, language, source, customMap, randomMaps } | null
ReplayObjects.detectPlayerCount(header)   // players including gaia, from gaia's own record
ReplayObjects.lobbyMap(header)            // { size, mapId } from the lobby settings
```

**Loading.** The module is one IIFE. Its helpers stay private when it shares a script scope with `reader.js`,
`header.js` and `actions.js`. It takes `Reader`, `findBytes` and `utf8` from reader.js's globals, or from `require()`
under Node. *Verified* in the test: loaded as separate classic scripts, and as one concatenated script, in a bare VM
context (no `require`, no `module`), it gives the same result as `require()`.

**Inputs.**
- `header` is the inflated header (`Uint8Array`), and `save` is the save version (67.2, 68 or 68.9).
- `n` is the number of players including gaia. It is optional: if omitted, it is detected (see below); if passed, it is
  checked.

**Each player:**
- `number`: 0 is gaia.
- `type`: 1 human, 2 gaia, 3 computer. *Verified* against the lobby block's types 2 and 4.
- `name`: UTF-8.
- `diplomacy`: i32 per player. `theirDiplomacy`: u8 per player.
- `civId`, and `civName`: the internal name, e.g. `KOREAN-CIV`.
- `colorId`: 0-7.
- `resources`: `{food, wood, stone, gold}` at the start of the recording. Under infinite resources (lobby
  `startingResourcesId` 5, 3 files) these read 3.4e38. One file has a player at -1600 food and -250 wood, cause unknown.
- `start`: `{x, y}`, the starting camera point. For a player starting with a Town Center it is that TC's own position:
  the centre of its 4x4 footprint, so integer coordinates on a tile corner, not a tile centre (villagers sit on .5).
  *Verified*: equal to a TC's x, y for 5133 of the 5141 players with a TC within 3 tiles. The other 8 are the 8 players
  of one Cenotes game, whose TC sits at (-1.73, +1.73) from the start. Players with no TC have fractional starts
  (Nomad, the Empire Wars Steppe game, Earth, most scenario players) or integer ones (6 scenario and campaign players).
- `objects`, then `doppelgangers` (always empty in the corpus).

**Each object:** `{ classId, typeId, id, x, y }`, plus `garrisonedIn` (the container's instance id) for a unit inside a
transport or building. The main list comes first, then the sleeping list (trees, most decorations). `id` is the
instance id that player commands reference.

**parsePlayerSection.**
- `end` is where the player section ends, which is where the points blocks start. `scenarioStart` is where mgz's
  `parse_scenario` starts, after the points blocks. Pass `scenarioStart` to `findMapName` as `from`.
- `complete` is true when all `n` records were read to their trailer and the points version follows.
- On a cut header, `parsePlayerSection` returns what it read: fewer players, or a last player with part of its objects.
  It then sets `complete: false` and adds a warning that says where. `parsePlayers` throws in that case rather than
  return partial data.
- A cut inside the points blocks leaves the players whole (`complete: true`), with `scenarioStart: -1` and a warning.
- *Verified* on 30 files with 4 cut points each, and by the reviewers' `stress.js`.
- Options:
  - `opts.from` limits the gaia-anchor search. Pass the map section's end if known.
  - `opts.keepHelpers` also returns the type 647 helpers.
  - `opts.layout` adds byte offsets per player (tests only).

**Speed** (Node, this machine):
- About 85 ms per file for the section; headers inflate to 1-25 MB.
- `findMapName` from `scenarioStart`: 2 ms on average (23 ms max).
- `findMapName` over the whole header, with no `from`: 20 ms on average (67 ms max), with the same result in 745/745
  files.

## Finding the section and the player count

The section follows the map section and precedes the points blocks and the scenario section (mgz order: `parse_map`,
`parse_players`, `parse_scenario`).

**Anchor** (mgz): gaia's name field, the bytes `05 00 47 61 69 61 00` (u16 length 5, `Gaia\0`). For `n` players
including gaia, gaia's record starts at `anchor - 7 - 5n`. This holds for save >= 61.5, where the i32 diplomacy array
has `n` entries; mgz uses `rev = 7 + 4n` plus `n`.

**Player count**, independent of the header's metadata section: try `n` = 2..9 and keep the one where that start reads
as gaia's record:
- type byte 2, then 0x0b;
- `theirDiplomacy` = `[0, 3, 3, ...]`;
- `diplomacy` = `[1, 4, 4, ...]` (gaia is everyone's enemy, under a treaty too).

*Verified*: exactly one `n` validates in 745/745 files. It equals the number of used lobby slots + 1 in 745/745 (lobby
slots read with mgz's `parse_de` player loop, `lobbycivs.js`).

## Player record (repeated n times, contiguous)

| Field | Bytes | Notes |
|---|---|---|
| type | u8 | 1 human, 2 gaia, 3 computer (*verified*) |
| (constant) | u8 | 0x0b in every record (*verified* in all 5928 records: 745 gaia, 5183 players) |
| theirDiplomacy | n x u8 | 0 ally/self, 3 enemy, 4 treaty period (*mgz*). 1 appears with i32 3, so neutral (*inferred*) |
| diplomacy | n x i32 | 0 gaia, 1 self, 2 ally, 3 neutral, 4 enemy (*mgz*). Under a treaty every other player reads 2 |
| allied LOS, allied victory | u32, u8 | *mgz* |
| name | u16 length (incl. NUL), length-1 bytes | UTF-8 |
| (constant) | 2 bytes | 00 16 (*verified*) |
| resource count | u32 | 601 in every record (*verified*) |
| (constant) | u8 | 0x21 (*verified*) |
| resources | count x f32 | 0 food, 1 wood, 2 stone, 3 gold, ... (standard start 200/200/200/100: *verified*) |
| (second array) | count x 4 bytes | meaning unknown (mgz: 8 bytes per resource from 63) |
| (constant) | u8 | 0x0b (*verified*) |
| camera x, y | f32, f32 | = `start`. Players: the starting TC's position (above). Gaia: see below |
| saved views | i32 (+ n x 8 bytes if > 0) | gaia -1 (738) or -2 (7); players 0 (5130), -1 (47) or 1 (6 records, one 8-byte view follows; the colour check after it passes) |
| spawn tile | u16, u16 | players: the camera's tile in 5169 of 5183 (not in some scenarios); gaia: meaningless |
| culture | u8 | graphics set (2 W. European, 3 E. Asian, 4 Middle East, ...) |
| **civ name** | DE string `60 0a`, u16 length, text | **new in 67.2**: replaces mgz's civ byte; e.g. `SARACEN-CIV` |
| (constant) | 6 bytes | zero (*verified*) |
| colour | 0x0b, u8, 0x0b | colour id 0-7 (both 0x0b *verified*; the decoder throws if either is missing) |
| ... | ~0.9-1.4 MB | per-player tables (techs, unit types), skipped. See the note below |
| main list header | u32 capacity, u32 growth | follows a 0x0b; growth 512, capacity a multiple of it (*verified*) |
| main objects | | sleep flag 0 |
| | `00 0b` | list end |
| sleeping list header | u32, u32 | e.g. 16384/8192 for gaia, 64/128 for players |
| sleeping objects | | sleep flag (+15) = 1 exactly here (*verified*, every object) |
| | `00 0b` | |
| doppelganger list header | u32, u32 | 512/512 |
| doppelgangers | | doppelganger flag (+16) = 1 exactly here; none in the corpus |
| | `00 0b` | |
| trailer | 28 bytes | `00 0b`, then mgz's PLAYER_END: ff x8, 00, 16 x 00, 0b |

The per-player tables are not decoded. Unit type records start `21 16`, then u8 object class, u16 type id (x4), u16
unit class, and so on; the internal name is the first DE string after that (`unittypes.js`, used only by the census).

**Gaia's camera** is the centre of the lobby's map size in 740 of 745 files. The other 5: Earth (Real World, Regicide),
3 scenarios (84 on a 120 map, 240 and 60 on 64 maps) and 1 campaign. So it is not a map-size source; `findMapName`
does not use it.

**After the last record** come the points blocks (mgz). Per player:
- f32 version 2.1 (`66 66 06 40`);
- i32 e, then 5 + e x 44 bytes;
- i32 m, then 8 + m x 32 bytes.

After them comes the scenario section's f32 version: 1.57 (67.2), 1.58 (68), 1.59 (68.9). *Verified* in 229/414/102
files.

**Finding the lists** (mgz's regex `0b 00 ?? 00 00 00 02 00 00`): take the first such header after the civ name whose
list is well formed, meaning it starts with an object of this owner or is empty. The decoder allows capacities up to
2^24; mgz's pattern caps them at 65280.

## Objects

Every object starts with a fixed head (mgz `static`, `parse_object` `'<bxH14xIxff'`):

| Off | Field | Off | Field |
|---|---|---|---|
| 0 | u8 class (10 static, 20 animated, 30 moving, 70 unit, 80 building) | 15 | u8 sleep flag |
| 1 | u8 owner (player number) | 16 | u8 doppelganger flag |
| 2 | u16 type id | 17 | u8 go-to-sleep flag |
| 4 | u16 sprite | 18 | **u32 instance id** |
| 6 | i32 garrisoned in (-1 = none) | 22 | u8 facet |
| 10 | f32 hp | 23 / 27 / 31 | f32 x / y / z (tiles) |
| 14 | u8 state (2) | 43 / 45 | i16 resource type, f32 amount (*verified*: gold 3:800, stone 2:350, trees 1:100, berries 0:125) |

The rest is variable: sprite lists, particles such as the gold mine's `gold_shimmer`, actions, AI. It is not decoded.
The scanner finds each object head instead (mgz's method), and the tests prove the framing (below).

**Scanner** (mgz's regex, made linear-time). A match needs:
- an accepted class byte and this owner;
- a type that is not 0 or ffff;
- garrisoned-in -1;
- an hp whose low byte is not ff;
- (new) sleep, doppelganger and go-to-sleep flags of 0 or 1, which every real object has.

The search resumes 31 bytes after each match. A match preceded by `00 0b` + 8 bytes opens the next list; two such
steps back mean an empty list in between. The scan stops at the trailer, which must follow `00 0b`.

**Garrisoned units** (fixed here; mgz misses them). A unit inside a transport or building is stored inside its
container's record, so its garrisoned-in field is not -1. The scanner accepts such a head only right after its
container (class 70/80) or another unit inside it, and only when its garrisoned-in id equals the container's instance
id and its x, y bytes equal the container's. One scenario (`Western Europe Diplomacy 500 Pop - Smoke Edit`) starts
each player with 5 villagers in a transport ship: 40 objects in 1 file, all found. A looser rule (id only) gave false
positives in 36 files; this one gives none.

**Skipped, as mgz does:**
- Type 0 records: class 70, sprite ffff, hp 0. 10 objects in 2 files of build 170934, invisible placeholders.
- Type 647 `HRICH_D` helpers: hp -1, no sprite, on whole tiles near the starts, 25-30k per file, absent from every
  build 188329 file. They are scanned but not returned unless `keepHelpers` is set.

### Object lengths

Bytes from one head to the next head (*verified*, most common values):

| Object | 67.2 | 68 | 68.9 |
|---|---|---|---|
| static (class 10): trees, stone, berries, decorations, flares | 134 | 134 | 134 |
| gold mine 66 (static + `gold_shimmer` particle) | 184 | 184 | 184 |
| unit (class 70): villager, scout, sheep, deer | 708 | 717 | 730 |
| relic 285 / hawk 96 (class 70) | 568 / 520 | 577 / 529 | 590 / 542 |
| building (class 80): house, TC annex, `Trophy None` | 849 | 858 | 871 |
| Town Center 109 | 855 | 864 | 877 |
| helper 647 (class 30) | 264 | 264 | 269 |
| placeholder 1902 (class 20) | 139 | - | 140 |

So class 70/80 objects grew by 9 bytes from 67.2 to 68 and by 13 from 68 to 68.9. mgz's 66.x helper length is 252.

Variants:
- Many buildings also come in a length 17 bytes longer (e.g. house 866/875/888, TC 872/881/894).
- 16-40 trees per file are 327 bytes, because they carry an inline copy of a modified unit type (mgz's
  `de_has_object_props`).
- A few 68.9 objects are 1 byte longer.

None of these variants hides an object (the hidden-candidate check below).

## Map name: `findMapName(header, { from })`

`from` is where the searches start; pass `parsePlayerSection`'s `scenarioStart`. The lobby strings are searched from
the header's start up to the map section's marker (`DEADDEAD`, u32 3), so `from` does not affect them.

1. **The location line** (`source: 'instructions'`). The scenario instructions are `\n`-separated UTF-8 lines; the
   first line starting with a location marker is used. The marker is `Location: ` in English; for other languages the
   UTF-8 markers come from mgz `ENCODING_MARKERS` (*unverified*: the corpus is English only).
   - `name` is the rest of the line, with ".rms" dropped. `language` comes from the marker.
   - The size is read from the first of the next two lines that ends in `[N]`: `Map Size: Large (8 player) [220]` gives
     `sizeTiles` 220 and `sizeLabel` `Large`, with the player count dropped so that every source gives the same label
     format.
   - The location line is 5053-5106 bytes after `scenarioStart` in all 739 files that have one.
2. **The scenario file** (`source: 'scenario'`): the base name of the i16-length string ending `.aoe2scenario`, at or
   after `from`. Lobby strings that name a scenario continue past the extension, so the length check skips them.
3. **A custom random map from the lobby** (`source: 'customMap'`), only when two things hold: the lobby's map id is
   custom (mgz's 59, 137 or 138), and the lobby strings name exactly one random-map file. On whole headers this path
   is never reached in the corpus, because every custom-map game has a location line. It is checked only on headers
   cut before the instructions (below).
4. Else `null`.

**sizeTiles** is the lobby's map size: from the size line, or else from the lobby settings' u32 (`lobbyMap`, which is
mgz `parse_de` `map_dimension`). *Verified*: it equals header.js's `de.mapSize` in 745/745 files, and the map section's
dimension in 744. The exception is the Nomad game: lobby size 220, a 231x231 map, with objects up to 228.5. Draw a
minimap from the map section's dimension (header part), not from `sizeTiles`.

**sizeLabel** is DE's English name for the size. A non-English size line would give its localized word (*unverified*).
It is null for sizes with no name. Seen in the corpus:

| Size | Label | Files |
|---|---|---|
| 120 | Tiny | 3 |
| 144 | Small | 1 |
| 168 | Medium | 3 |
| 200 | Normal | 12 |
| 220 | Large | 113 |
| 240 | Huge | 533 |
| 480 | Ludicrous | 77 |
| 64 | null (scenarios) | 3 |

**randomMaps** lists every `<kind>:RANDOM_MAPS:<file>:...` lobby string's file, where kind is `SUBSCRIBEDMODS`, `USER`
or `BASE`. *Verified*: the same list as header.js's `de.strings` in 745/745 files. These are random maps the host's
lobby names, **not the map played**:
- 276 files carry at least one, and 71 of them carry two.
- In 267 of them the game was played on the built-in map that the location line and the lobby map id name (199 with
  one string, 68 with two). For example, 128 `Super Rich Michi.rms` games have exactly plain Michi's 19 gold and 12
  stone mines per player.
- In the 5 scenario games (one string each) they are stale settings.
- In the 4 custom-map games (one with one string, three with two), one of them is the map played.

**customMap** is the `randomMaps` file whose base name equals the location name, else null. *Verified*: that happens in
exactly the 4 files whose lobby map id is 59 (RM custom), whose location lines read `Michi With Fix v2` or
`Michi With Fix v3`. It never happens with a built-in map id.

*Verified* sources:
- 739 names from the location line, each file holding exactly one such line. All are RM, DM, Regicide or Empire Wars
  games.
- 6 from the scenario file: 5 Scenario games and 1 Campaign game (header.js `de.gameTypeId` 3 and 4). These are all the
  games without a location line.

A header cut at the section end, before the instructions, gives `null` in 744 of 745 files. The other one is the
custom-map game with a single random-map string: it gets that custom map's name, which is also its location name.

The previous version fell back to the first random-map string before the scenario file. That named all 5 scenario games
after an unrelated lobby string (e.g. "Open Michi 2" for the scenario `PV_COMBATM_cart_market_melee_ranged_64`), and it
took the size from gaia's camera.

## Civ ids and colours

67.2+ records carry the civ's internal name, not its id. `CIV_IDS` maps the 61 names seen to the lobby block's civ ids.
Each pair was checked in every resolved lobby record of the corpus, with no conflict (e.g. `INDIAN-CIV` 20 =
Hindustanis, `PURU-CIV` 56, `DANES-CIV` 62). Ids 55 and 63+ were not seen and are not guessed (`civId: null`).

40 lobby records are unresolved and are skipped: civ 0 (random), or team 30 with civ 15 and colour 1. The player
record has what the game used.

**Colours** match the lobby in 5136 records. 7 differ, in two games, cause unknown:
- 1 Regicide game on Earth (2 players, colours swapped);
- 1 campaign game (6 players, colours rotated).

The test tolerates differences only in Regicide, Scenario and Campaign games. Other Regicide games match (14 players).

## Invariants checked (test-objects.js, 745 files, all pass)

- The player count is unique and equals lobby slots + 1. Civ names map to ids consistently. Colours are as above.
- The section ends exactly on the points version; the points blocks parse; the scenario version 1.57/1.58/1.59
  follows; `complete` is true.
- Framing:
  - The last object's end is proven from the trailer chain (`lastLength`).
  - Every list that is not the last ends in `00 0b`, 10 bytes per list break before the next list's first object.
- Hidden objects: no object-shaped bytes sit inside any object's span, except the type 0 placeholders above.
  "Object-shaped" means any class 10-90, any garrison, type 0 included, flags 0/1, an id not yet seen and at most the
  largest id, and a position inside the map.
- Instance ids:
  - Unique across all players and lists.
  - Contiguous from 0 in 713 files.
  - The gaps in the other 32 are ids with no object anywhere (the hidden check finds nothing in them):
    - build 188329: 23 files, 2 runs each (the removed 647 helpers);
    - 170934: 6 files (4 RM games, the Earth Regicide game, the campaign);
    - 174992: 1 RM game;
    - 180059: 2 scenarios.
- The sleep flag is set exactly in the sleeping list, and the doppelganger flag exactly in the doppelganger list.
- Positions: every object lies inside the map section's grid (0..dimension). Objects lie beyond the lobby size only in
  the Nomad game.
- Garrisoned units sit exactly at their container.
- Town Centers: a Town Center (109/71/141/142) lies within 3 tiles of the start for 5141 of 5183 players. The other 42:
  - Nomad (RM, 8);
  - an Empire Wars game on Steppe (8);
  - Earth (Regicide: castle and king instead, 2);
  - Scenario games (21 without one, 1 with its TC 13.6 tiles away);
  - the campaign (2).

  One scenario player has 2 TCs.
- Starting scouts: each player with a TC at the start owns exactly one scout of its civ's type, except 5 players
  (Slavs 3, Magyars 1, Sicilians 1) with none. The types are listed under Classification below.
- `start` equals a TC's position for 5133 of 5141 players with a TC near (the Cenotes exception above).
- Gaia per file: gold 0-868, stone 0-564, trees 0-122859, relics 0-48. There are no mines at all in 3 Michi games (ids
  contiguous, so nothing was missed) and in 4 scenarios.
- Map name: as listed above. The search from `scenarioStart` and the whole-header search agree in 745/745 files.
- Cut headers (30 files x 4 cut points): `parsePlayers` throws on every cut inside the section, and returns the whole
  players for a cut inside the points blocks.
- Browser loading: as described under API.

**Diplomacy tallies** (pairs of players):

| Setting | Team | i32 / u8 | Pairs |
|---|---|---|---|
| no treaty | other team | 4 / 3 | 732 |
| no treaty | same team | 2 / 0 | 492 |
| treaty | other team | 2 / 4 | 17878 |
| treaty | same team | 2 / 0 | 12554 |

There are also some 2/0, 2/4 and 3/1 pairs in games without lobby teams. So for teams under a treaty, use
`theirDiplomacy` (0 = allied) or the lobby teams, not `diplomacy`.

## Classification: gaia-classes.json

For each type id the file records:
- the category, and a display name if certain (else null);
- the replay's internal names, object class and unit class (from the replay's own unit type table);
- the carried resource;
- count, files and maximum per file;
- the list it is in;
- clustering (the share with a same-type neighbour within 1.5 tiles) and the share within 20 tiles of a start.

**Gaia rule by unit class:**

| Unit class | Category |
|---|---|
| 32 | gold |
| 8 | stone |
| 42 | relic |
| 15 | tree (28 types, all carry wood) |
| 7 | forage |
| 58 | herdable |
| 9 | huntable if it carries food |
| 10 | huntable if it carries food (boar, javelina, rhino, elephant, tapir), else predator (wolves, bears, big cats, crocodiles, snakes) |
| 5 / 31 / 33 | fish (shore fish 69, `FISH1-4` 455-458, box turtles 1141, `DOLP3` 61) |
| anything else | other (birds, decorations, cliffs, placeholders, helpers) |

Oysters 2170 and Whale 2625 carry gold, not food, so they are classed other, not fish.

**Player start objects:**
- town_center;
- town_center_part (618-620 and 890, one each per TC);
- villager;
- scout: 448 Scout Cavalry; 751 Eagle Scout (Aztecs, Mayans); 1755 Camel Scout (Gurjaras); 2550 (Incas, Muisca and
  Tupi; internal name `CHAMPIR`, display name not certain). `startingScoutsByCiv` holds the per-civ evidence: every
  Aztec/Mayan, Gurjara or Inca/Muisca/Tupi player starts with exactly one of its type and no 448;
- house, building, military, unit, herdable;
- flare (332);
- hidden: 1649 `Trophy None` (one per player), 647, revealers;
- other.

## Changes found versus mgz (66.x)

- 67.2: the player record's civ byte became a DE string with the internal civ name, followed by 6 zero bytes, 0x0b,
  colour, 0x0b (mgz: civ, 3 bytes, colour, 1 byte). Units are 708 bytes, buildings 849+, and the 647 helper 264 (mgz:
  252).
- 68: class 70/80 objects are 9 bytes longer than in 67.2. The layout of the head and the lists is unchanged.
- 68.9: class 70/80 objects are 13 bytes longer than in 68, the class 30 helper is 269 and the class 20 placeholder 140.
  From build 188329 the 647 helpers are gone (their ids stay unused).
- All three:
  - Each record ends with `00 0b` + PLAYER_END (mgz handled the extra `00 0b` with a peek).
  - The diplomacy array has n entries (as in mgz for >= 61.5).
  - After the scenario file name, mgz's fixed 64 + 68 + 20 bytes to the instructions hold in the 739 standard files.
    In scenario games an extra string sits there, so the decoder searches for the location line instead of walking
    there.

## Not verified / open

- Other languages' location markers and size lines (the corpus is English only), and so the localized size labels.
- The meaning of the second 4-byte resource array, of the 6 zero bytes after the civ name, and of the +17-byte building
  variant.
- Doppelganger lists (always empty here). Restored games: mgz says their object lists are empty; whether any corpus
  file is one (6 records have a saved view) was not checked.
- Saves below 67.2: the civ-byte branch is mgz's layout and untested; the gaia anchor arithmetic assumes save >= 61.5.
- Display names for the fish types 455-458, most trees and 2550 are left null (internal names only).
- Why colours differ in the Regicide and campaign games. Which colour the game shows there would need the body (e.g.
  chat colours) to decide.
