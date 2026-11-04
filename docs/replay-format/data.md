# Replay data tables: notes

Part: the game data tables the replay viewer needs (`replay-data.json`), a small browser reader for each game's own building sizes (`building-sizes.js`), and what the corpus says about both.

## Files

| File | What |
| --- | --- |
| `build-replay-data.js` | Node, no dependencies, house style of `tools/build-civ-info.js`. Fetches aoe2techtree at the pinned commit `e56728e` (or reads `<dir>/data.json` and `<dir>/strings.json`), adds the tables aoe2techtree lacks, writes `replay-data.json`. Built from GitHub and from the local copy, the output is byte-identical. |
| `replay-data.json` | 81 KB: 321 units, 103 buildings, 308 techs, `ages`, `parts`, `markers`, 63 civs, 132 maps, `customMapIds`, 99 terrains, and `values` (what the numbers are). aoe2techtree's MIT licence text is shipped inside, as in `civ-info.json`. |
| `building-sizes.js` | Browser-compatible (no Node APIs). `buildingSizes(headerBytes, ids?)` returns `[ { id: size } ]`, one object per player index (0 gaia, then the player numbers the commands use), read from the game's own unit type records. About 20 ms per header in Node. |
| `test-data.js` | The checks below. `node test-data.js` runs on the sample (all 102 files of 68.9, plus 42 of 67.2 and 40 of 68 spread over their builds), and `--all` runs on all 745 files. It exits 1 when a hard check fails. |
| `scan.js`, `sample.js` | Test-only. They extract just what the checks need from each replay and cache it in `cache/`: numbers and game data, with no player names and no chat. |
| `extract-extras.js` | One-off script that read the `EXTRA_UNITS` values (name, class, cost, time) from 68.9 headers. |
| `explore/` | One-off probes from the review round (counts only), and `checkers/`, the output of the reviewers' scripts rerun on the fixed data. |

Both runs pass all 31 hard checks: `node test-data.js` and `node test-data.js --all` (745 files, about 1 s once cached; a cold scan takes about 160 s).

## JSON shape

- `values`: one sentence each on what `cost`, `time` and `size` mean (see "What the numbers are").
- `units[id] = { name, cost: { food, wood, gold, stone }, time, cls }`. `cls` is one of villager, infantry, archer, cavalry, siege, monk, ship, trade, hero or other.
- `buildings[id] = { name, cost, time, size }`. `size` is the side in tiles, or `[w, h]` for gates and gate pieces.
- `techs[id] = { name, cost, time }`, and `ages = { feudal: 101, castle: 102, imperial: 103 }`.
- `parts = { partId: buildingId }`: header objects that are pieces of a Town Center (618, 619, 620, 890, 1649 → 109). The viewer draws the building and skips these.
- `markers = { id: name }`: header objects that are neither units nor buildings: start flares (332, 697) and scenario flags (851, 1285).
- `civs[replayCivId] = name`. The names are aoe2techtree's civ keys, which `civ-info.json` uses too ("Incas", "Mayans"). 0 is Gaia.
- `maps[rmsMapId] = name`. `customMapIds = [59, 137, 138]`: for these ids only the header's Location text names the map.
- `terrain[id] = { name, color, kind }`. `kind` is what the terrain is for movement:
  - land, forest, road, farm, ice, other;
  - water: ships only;
  - shallows: land units and ships;
  - beach: land units, and ships and water buildings too (navigable). Docks and fish traps stand on Beach (2) and Beach, Vegetation (52) in the corpus.
  - The non-navigable beaches (79 to 82) are land.

## What the numbers are

- **cost and time** are the standard game (Turbo Mode off) of update 188329, save 68.9, before civ bonuses. They are **not** right for most of the corpus:
  - **Turbo Mode.** 673 of 745 games have Turbo Mode on (mgz `parse_de` `turbo_enabled`, 25 bytes after `num_players`). Their own unit records hold other values. The villager's record time is 62 in every Turbo game and 25 in every standard one (744/745 files; the 745th is a data-mod game whose villager record has no cost block where the reader looks). The checkers' comparison of Turbo and standard games of the same save found these differences:
    - times about 2.5 times the standard: castle 500 against 200, towers 200 against 80, donjon 312 against 125, wonder 8750 against 3500, trade cart 127 against 51, fishing ship 100 against 40;
    - in 68.9, ships cost 80% of the wood and take about two-thirds of the time (galleon 72 wood and 18 against 90 and 27).
  - **Older saves.** In standard games of saves 67.2 and 68, 29 and 22 unit ids respectively have other costs or times than the table in most files: Slinger, Grenadier, Missionary, Eagle Scout, Conquistador, Organ Gun, Ratha, Fortified Church and others. In the 4 standard 68.9 games, 359 of 366 unit and building records equal the table; the other 7 are livestock records in one file, which the table gives cost 0.
  - For the viewer: show the table's values as "standard game, update 188329", and label Turbo games (the header part decodes the flag). Reading each game's own cost and time needs the full unit record layout (see fact 5); I didn't ship a reader for it.
- **size** is the standard game's footprint. Each game's own records give the real one, and `building-sizes.js` reads them:
  - Farms are 1x1 in 115 games, 2x2 in 15 and 3x3 in 615. The 15 2x2-farm games all name a data mod for 2x2 farms in the header. For the 1x1 games, 111 list subscribed mods and 4 list none; I couldn't find the cause in the header.
  - A Poles player's Mill record (68, and its later looks 129 to 131) is the 3x3 Folwark: 20/20 Poles players.
  - No other building's size differs between games or players in the corpus.

## Format facts found (verified across the corpus)

1. **Player slots, saves 67.2, 68 and 68.9.** The layout is mgz `parse_de` for save 66.3 or later, with 8 slots. Each slot now ends with one more DE string (`60 0A 00 00`, empty in all 5,960 slots), which mgz 66.6 doesn't have. A slot reads: u32, i32 color, u16, i8 team, 9 bytes, u32 civilization_id, u32 n plus n u32 custom civ pool, DE string, u8, DE string ai name, DE string censored name, DE string name, u32 type (2 human, 4 AI, 1 closed, 0 empty), u32 profile, 4 bytes, i32 number, i8, u8, 8 bytes, 4 bytes, DE string. *Invariant:* after the 8th slot, the string block's DE string marker is exactly 33 bytes on. This holds in 745/745 files. `num_players` can count an empty slot (one 67.2 game says 8 with 7 players).
2. **civilization_id = aoe2techtree `name_string_id` − 10270.** Britons are 1 and Danes are 62. Players' castle units and unique techs agree with that civ for 3,981/3,981 players across 55 civ ids, all of them. The Cumans' mercenary Kipchak (1260) is left out because their allies can train it. The Chronicles civs aren't in aoe2techtree. They fill the gaps in the string range: 46 Achaemenids (they train Immortal and War Chariot), 47 Athenians (Strategos, Hoplite), 48 Spartans (Hippeus, Hoplite, Polemarch), 54 Macedonians (Companion Cavalry, Phalangite), 55 Thracians (no player in the corpus) and 56 Puru (Sannahya, Pattiyodha Longbowman).
3. **The site's civ ids.** `server.js` NEW_CIVS equals `scraper.js` FALLBACK_SCHEMA.civilization. Their negative lobby ids are −(replay id + 1). This is checked by corpus players for Puru −57 = 56 (7 players), Saxons −61 = 60 (3), Varangians −62 = 61 (9) and Danes −63 = 62 (15). For Thracians it is assumed: −56 = 55, with no player in the corpus, so their replay id rests only on the string-id gap. The lobby schema's positive ids are a different table that includes Return of Rome civs; it isn't in the repo, so I didn't compare it.
4. **Map tiles.** The tile block follows mgz `parse_map`: [size][size][zones], zones × (2048 + 2·tiles, u32 n, n floats, 4 bytes), u8 all_visible, u8, then tiles, u32 n, 4 bytes, n·4, n obstruction lists, then [size][size] again. **Scenario maps have 0 zones**, so the header parser must allow `zones = 0`. *Invariant:* walking from the first pair lands on the second, in 745/745 files, 6 of them with 0 zones (120², 240², 200² and three 64² maps). Each tile is 10 bytes:
   - byte 0: terrain.
   - byte 1: always 0xFF, in 54.6 M tiles.
   - byte 2: the terrain beneath. It differs from byte 0 only under foundation 27 and farm 7, and where dirt 6 lies over snow 32.
   - byte 3: elevation, 0 to 7.
   - bytes 4 to 9: three i16.

   The block is usually 1 to 2 KB after the slots. Embedded AI scripts push it megabytes on (4.4 MB and 11.6 MB in two AI games). The header's `map_dimension` can also differ from the real size: a custom map was 178 against a lobby size of 240. So the search tries the header's size first, then any size.
5. **Unit type records in the header.** There is one list per player: gaia first, then players 1 to n. Here n is the number of players with a type, not `num_players`. Each list holds about 2,000 records in ascending id order, which is most of the header's 17 MB. A record starts `21 16`, then:
   - the head: u8 type (10 to 90; 70 unit, 80 building), u16 slot id, u16 current id, u16 base id (equal to the slot id), u16 current id, u16 game unit class, 2 bytes, u16 hp, f32 line of sight, u8 garrison, f32 collision x, f32 collision y;
   - the current id is the look the slot has now. A Barracks slot 12 holds 20 in a Castle Age start, and an Archer slot holds the Arbalester when the game starts with the upgrade.

   *Invariants:*
   - splitting building heads where the id drops gives exactly players + 1 lists in 745/745 files;
   - the only per-player size difference is the Poles player's Mill, and the list index equals that player's number for 20/20 Poles players.

   The internal name, a DE string, sits 129 bytes from the type byte, or 141 for most buildings. The cost block lies 150 to 260 bytes after the name:
   - 3 × (i16 resource 0 food / 1 wood / 2 stone / 3 gold / 4 pop, i16 amount, i16 paid flag), i16 1, i16 train time, i16 train location;
   - it comes after variable-length attack and armour lists (u16 count plus 4-byte entries, visible about 98 bytes after a unit's name), which is why its distance varies;
   - a full parser should read through those lists rather than search for it, as `test-data.js` and the checkers do.

   The footprint is twice the collision box, except that PASTURE_BUILD (1889) is 1.0 while the PASTURE it places (1897, and 1893 for mangrove) is 2.0, so pastures are 4 tiles across. Game unit classes seen: 58 livestock, 59 King and scenario heroes, and 61 herdables (horses, camels, alpacas), which the 68.9 repairer villagers carry too.
6. **Ids reused across builds.** Ids 2700 to 2715 are new in 68.9: Mounted Crossbowman, Varangian Guard, Hearth Troop, Jarl, Jomsviking and the repairer villagers. One 67.2 game with a data mod defines its own units under some of those ids, plus 3011 and 3012 ("(II) Call of Battle", queued at its TC). The checks drop records found in only a minority of a build's files.
7. **Build positions.** `BUILD` (102) x and y are the building's centre. An odd side gives x.5 and an even side x.0, per axis. *Invariant:* this holds for 1,762,307/1,762,307 build commands, using each game's and player's own sizes. That covers the 2x2 farms, which are the integer farm coordinates seen in 68.9, and the Poles' 3x3 Folwarks, which are placed with the Mill's id.
8. **Spacing.** The game refuses overlapping foundations. Drawn at each game's size, at most 31.5% of a player's distinct placements overlap another of theirs (houses, where some are rebuilt next to a lost one), across 30 id-and-size pairs with 100+ placements. For the buildings players pack edge to edge, nearly all overlap one tile wider:

   | Building, size | Overlap at the size | One tile wider |
   | --- | --- | --- |
   | Farm, 1 | 0.0% | 97.2% |
   | Farm, 2 | 15.4% | 98.6% |
   | Farm, 3 | 10.3% | 98.7% |
   | House, 2 | 31.5% | 95.3% |
   | Fish Trap, 1 | 0.0% | 88.5% |
   | Pasture, 4 | 1.0% | 97.3% |

   The other buildings stand apart, so spacing only bounds them from above.
9. **Two map id spaces.** The replay `rms_map_id` (mgz `parse_de`) and the ids in `map_names.json` are different spaces. `map_names.json` holds the lobby feed's map ids, which look like the map-name string ids. For example, QS Black Forest is rms 196 in a replay and 11007 in `map_names.json`. None of the 28 lobby ids appears as an rms id. The replay's `Location: <name>` text agrees with the table for 735/735 files with a built-in map id (11 distinct maps). Ids 59, 137 and 138 are custom (mgz `lookup_name`), and only the Location text names those maps.
10. **For the body parser.** `RESEARCH` (101) is sometimes 17 bytes with selected = 1 and no id list (859 commands, all in 4 build-170934 files). The tech id at +10 is still right: 101 is Feudal Age. `DE_QUEUE` (129) matches 20 + 4·selected bytes everywhere. 7/745 bodies are truncated.

## How each table is made

- **units.** aoe2techtree has 255 units. The name is string `LanguageNameId + 9000`, falling back to `LanguageNameId`. The rest are added:
  - `EXTRA_UNITS`: 29 units from the 68.9 header records, the Chronicles units and their Elite versions, plus the Polemarch (cost unknown, shown as 0). Their costs and times are the same in standard and Turbo 68.9 games.
  - `START_UNITS`: 9 units players own at the start that aoe2techtree lacks: Sheep, Goat, Goose, Pig, Capybara, two Llamas, Horse and the regicide King. Cost and time are 0.
  - `VILLAGER_IDS`: 27 villager task ids (class 4 records named `V[MF]<task>`), each a copy of Villager 83.
  - 204, the loaded Trade Cart, a copy of 128.
- **cls.** Derived from aoe2techtree's armour classes, checked in this order: 36 hero, 25 monk, 16/34 ship, 17/20 siege, 15/28 archer, 8/30/5 cavalry, 1/27/29 infantry, else other. Villager and Trade Cart/Cog are matched by internal name. I checked it two ways:
  - Against the game unit class in the headers' records: 306/318 agree. The other 12 differ on purpose (they're listed in the build script): castle units follow the game, the rest follow their training building, and the heroes, Polemarch and repairer villagers keep their own classes. 7 `CLASS_OVERRIDES` apply the game's class.
  - Against the building each queue command trains at (`DE_QUEUE` building type): 3,099,321/3,099,321 commands at TC/barracks/range/stable/workshop/monastery/dock/market agree. A few villagers, Trade Carts and the Polemarch are trained elsewhere and allowed.
- **buildings.** aoe2techtree has 40 buildings. The rest are added:
  - 6 gate orientations: 490, 665, 673, 796, 800 and 804;
  - 6 gate pieces (64, 78, 81 and 88, 91, 95), which some maps place as players' starting objects with no gate of their own: [2,1], [2,1], 1 and [1,2], [1,2], 1;
  - 51 later-age or built-state ids copied from their base, such as barracks 20/132/498, the gate pieces' earlier looks and the built pastures 1893/1897, so that header objects get a name.

  `size` is checked three ways:
  - the most common per-game record gives it, for 103/103 ids;
  - build positions fit it, for 1,762,307/1,762,307;
  - spacing bounds it.

  Fish Trap is 1 and Pasture is 4, both now checked (see facts 5 and 8).
- **parts and markers.** Every Town Center has RTWC*A/B/C (618 to 620) and "Trophy None" (1649) at fixed offsets from its centre, in 130/130 TCs checked: 618 at (+1, −1), 619 at (−0.5, +0.5), 620 at (−1, +1), 1649 at (+0.3, −0.3). In some games "Empty TC annex" (890) stands at (−1, +1). Flares FLARE3/FLARE4 (332, 697) stand at each start, and ESFLAG/FEFLAG (851, 1285) are scenario flags. *Invariant:* every players' starting object id that occurs in 3 or more files is named in units, buildings, parts or markers (39/39). 33 ids seen in only 1 or 2 games are not.
- **techs.** aoe2techtree's 201 techs (name is string `LanguageNameId + 10000`), plus its 120 unit upgrades, which take the upgraded unit's name. `ages` holds 101, 102 and 103; the corpus has 591, 579 and 498 research commands for them.
- **civs.** As in fact 2.
- **maps.** Built-in DE ids from my knowledge. The 11 that occur in the corpus are verified against the Location text.
- **terrain.** I chose all the colours myself. The names come from my knowledge of the game's terrain list, cross-checked against aoc-reference-data's DE dataset (public on GitHub, but with no licence file). I used it only to check names and the map and civ lists; nothing was copied programmatically, its colours weren't looked at for ours, and I deleted the local copy. The corpus maps use 60 terrain ids (54 on the random maps and 6 more on the scenario maps), and all of them are covered. Kinds were checked against the gaia objects on each terrain and against where players build:
  - Every forest kind has a tree (unit class 15) on more than 90% of its tiles, except the savannah Baobab (25%) and Acacia (52%) forests.
  - No other kind has trees on more than 5% of its tiles.
  - Fish (classes 5, 31, 33) appear only on water.
  - Docks and fish traps are centred on water, shallows or beach in 577/577 placements: 352 water, 209 beach (206 on Beach 2, 3 on Beach, Vegetation 52) and 16 shallows.
  - Land buildings are centred on a water kind in 0 of 1,649,937 placements.
  - 110, 112 and 113 are named from the trees on them (BIRCH, FPAL, FLBAM).
  - 126 is unnamed ("Terrain 126"): it is open land on one winter coastal map.

## Verified vs guessed

- **Verified by corpus invariants:**
  - the player slot layout, the Turbo flag's offset and the civ_id rule (all 55 civs with evidence);
  - the lobby offset of −(id + 1) for Puru, Saxons, Varangians and Danes;
  - every unit id in a queue command and every building id in a build or wall command is in the table (100%, except two ids defined by a data mod);
  - building sizes against per-game records, positions and spacing, including Fish Trap 1, Pasture 4 and the farm sizes;
  - the per-player record lists and `building-sizes.js`;
  - cls against the game class and the training building;
  - the map tile layout, including 0-zone scenario maps, and terrain coverage;
  - terrain kinds for the 60 terrain ids the corpus uses, including navigable beaches;
  - the TC parts and the named starting objects;
  - the 11 maps that occur;
  - the age tech ids;
  - EXTRA_UNITS and START_UNITS names and classes;
  - that cost and time equal the standard 68.9 game's records, and that Turbo games and the older saves differ.
- **Read from records but not otherwise checked:** EXTRA_UNITS costs and times, which are the most common value over about 800 records each and are the same in standard and Turbo 68.9 games.
- **Guessed from knowledge:**
  - terrain names for ids outside the corpus;
  - maps outside the 11 that occur;
  - 47 Athenians (seen twice, training Strategos and Hoplite) and 55 Thracians (string-id gap plus the site's NEW_CIVS);
  - "Hippeus" being infantry (that is what the records say, class 6);
  - King's cls, hero.
- **Not covered:** 10% of research commands use tech ids aoe2techtree lacks: 568 ids, with 1270 the most used (113 times). They include the Chronicles civs' techs (1110 to 1324) and id pairs from 1530 to 2933 that many civs research in a few games, which look like a mod's.

## Corrections in this round (after review)

- **Farm size.** The farm size varies by game (1, 2 or 3), as above. The old claim that the farm box "shrank in 68.9" was wrong: 1x1 farms already occur in save 68 (49 files), and 3x3 farms in 21 save-68.9 files. The old open question about integer farm coordinates is answered: those are the 2x2-farm games, the centre of an even side. No half-tile shift is needed.
- **Fish Trap** is 1, not 3, and **Pasture** is 4, not 2. Neither is a "walkable exception".
- **Villager time.** The villager's 62 s is the Turbo game's own value, not an unexplained field. `values` now says what cost and time are.
- **Map locator.** The "6 scenario games without a tile block" were the locator rejecting 0 zones.
- **Beach kinds.** The non-navigable beaches are now land, and the beach kind is documented as navigable.
- **Thracians.** Their lobby offset is reported as assumed.
- **Header objects.** `parts`, `markers`, gate pieces, built pastures and livestock were added.

## Open questions

- In Turbo games, the records' times are about 2.5 times the standard ones, yet Turbo players queue a median of 252 villagers in the first 8 minutes. A TC kept busy at 62 s makes about 8. So the game must apply a speed factor the records don't show, and what a record's time means in real seconds is not established. Until it is, the viewer shouldn't predict training durations in Turbo games.
- Should the header parser read each game's own cost and time? It would have to decode the unit record through its attack and armour lists (fact 5); the heuristic search used in the tests is not exact.
- What makes farms 1x1 in 115 games? Four of them list no subscribed mod.
- The map names outside the 11 in the corpus, and the terrain names outside the 60 corpus ids, are from my knowledge, checked against aoc-reference-data, which has no licence file. Keep them in the shipped table, or reduce it to corpus-verified entries and fall back to the header's Location text?
- Unit 2162 (Polemarch 1) has no cost block in its record, so its cost and time are 0. The Chronicles civs' techs stay unnamed.
