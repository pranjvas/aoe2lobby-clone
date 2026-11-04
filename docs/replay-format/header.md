# AoE2:DE header, start through map tiles (save 67.2, 68, 68.9)

Decoder: `header.js`, exporting `ReplayHeader = { parseHeader, isRealPlayer, PLAYER_TYPES, AGES }`
(`module.exports` under Node; a global `ReplayHeader` when loaded as a classic script after `reader.js`,
by script tags, `importScripts` or concatenation). `parseHeader(inflatedHeader)` takes a Uint8Array.
Checks: `node test-header.js [--all] [--saves]`. All 745 corpus files (67.2: 229, 68: 414, 68.9: 102,
every build) and the 159 local saved games parse and pass every invariant.

**The layout of this region is identical in 67.2, 68 and 68.9.** `header.js` has no per-version branch and
refuses saves below 67.2 (not in the corpus). Against mgz's save-66.6 rules, two things changed (marked NEW);
sizes elsewhere match mgz.

All integers little-endian. `str` = DE string: `60 0A`, u16 length, UTF-8 bytes. `SEP` = u32 `0x00025FA3`
(`a3 5f 02 00`), checked by the decoder at each of its 5 places.

## 1. Version (offset 0)

| off | type | field |
|---|---|---|
| 0 | 8 bytes | `"VER 9.4\0"` |
| 8 | f32 | -1 |
| 12 | u32 | save, 16.16 fixed point, rounded to 2 places: 67.2 = `0x00433333`, 68 = `0x00440000`, 68.9 = `0x0044E666` |

## 2. DE block (`offsets.de` = 16, mgz `parse_de`)

| type | field | notes |
|---|---|---|
| u32 | build | 170934 ... 188329 |
| u32 | timestamp | unix seconds, game start |
| f32, u32, u32 | version, interval version, options version | always 1123.0, 1000, 1 |
| u32 n, n x u32 | dlcIds | always the same 17 ids in the corpus |
| i32 | dataset ref | -1..3 |
| u32 | mapSize | lobby size. The map's real size can differ (one file: 220 here, 231 in the map) |
| u32 | selected map id | |
| i32 | rmsMapId | resolved map id; campaigns store -3 (mgz reads it unsigned) |
| u32 | revealMapId | 0 normal, 1 explored, 2 all visible (equals body meta[5] in every file) |
| u32 | victoryTypeId | |
| u32 | startingResourcesId | |
| u32 | starting age (`startingAgeRaw`) | see **Ages** below |
| u32 | ending age (`endingAgeRaw`) | 0 or 5 seen |
| u32 | game type | 0 RM, 2 DM, 3 scenario, 4 campaign, 13 EW ... |
| SEP, SEP | | |
| f32 | speed | 1.5, 1.69 or 2.0. Equals metadata speed in every file |
| u32 | treatyLength | minutes |
| u32 | populationLimit | |
| u32 | numPlayers | real players + absent (type 0) slots; Gaia not counted |
| u32, u8, i32 | unused colour, ?, victory amount | 9 bytes. The i32 is -1/0 in lobbies and 900 in one scenario, so the byte comes first (mgz has it after) |
| SEP | | |
| u8 | trade enabled | always 1 |
| u8 | difficultyId | mgz fast's name for save >= 61.5; mgz construct calls it team_bonus_disabled. Always 0, AI games too. **Unverified** |
| u8 x 13 | randomPositions, allTechs, (starting units), lockTeams, lockSpeed, multiplayer, cheats, recordGame, animals, predators, turbo, sharedExploration, teamPositions | positions fixed by the SEPs; names are mgz's, semantics **unverified** (`turbo` is 1 in most custom lobbies here, which looks wrong) |
| u32, u32, u8, u8 | sub game mode, battle royale time, handicap flag, ? | |
| SEP | | |
| 8 x player slot | see section 3 | 8 slots in every file, whatever numPlayers |
| 9 bytes | | zero |
| u8 x 3 | fog of war, cheat notifications, coloured chat | always 1 |
| SEP | | |
| u8 | rated | 1 in 3 files |
| u8 | allowSpecs | |
| u32 | visibility | always 0 |
| u8 | hiddenCivs | |
| u8 | matchmaking | 1 in exactly the 3 rated files, all with an empty lobby name; 0 elsewhere |
| u32 | specDelay | seconds: 0, 120, 180, 300, 600 |
| u8 | scenario civ | |
| string block | strings | block = repeat {u32 crc; if 0 < crc < 255 stop; str}. Strings split on `:` |
| 8 bytes | | two u32 (23/49/47 ...) |
| 20 x string block | strings (appended) | |
| u32 n, n x i32 | strategic numbers | n is 0, rarely 1 |
| u64 n, n x {u32, str, u32} | aiFiles | |
| 8 bytes | | zero |
| 16 bytes | guid | printed as stored, dashes 8-4-4-4-12 (as mgz's `uuid.UUID(bytes=)`). The lobby's match id, **not one per recording**: 3 pairs of files share one (restarts of the same lobby game, 947-5269 s apart, same players, civs and map). Key a recording by guid + timestamp, or by a hash of the file |
| str | lobby | |
| 8 bytes | | zero |
| str | mod | data mod name, often empty |
| DE tail | section 4 | |

`rmsModId`, `rmsFilename`: from the string `SUBSCRIBEDMODS:RANDOM_MAPS:<file>:<modid>_<name>:...` (mgz).

**Ages.** Stored values: 0 Standard (the game mode's own default), 2 Dark, 3 Feudal, 4 Castle, 5 Imperial,
6 Post-Imperial; 1 is never seen (mgz's construct calls 1 "unset"). `startingAgeId`/`endingAgeId` use mgz's
AgeEnum numbering, stored - 2 (0 dark .. 4 post-imperial), and are **null for Standard**: mgz fast maps 0 to
0 too, which reads as Dark but is Feudal in Empire Wars and whatever a scenario sets. `startingAge`/`endingAge`
give the names. Checked against each player's current-age stat (index 6 of the stats in the player block
after the map): stored 2-6 gives stat stored - 2 for every player (6 gives 3: post-imperial is the Imperial
Age with techs); Standard gives 0 in random map and regicide, 1 in Empire Wars, and 0, 1 or 2 in scenarios
and campaigns. For the age a game really starts in, read that stat.

## 3. Player slot (x 8)

| type | field | notes |
|---|---|---|
| u32 | dlc id | always 15 |
| i32 | colorId | lobby colour 0-7, unique per game. Empty slots: -1, or a leftover 4-7 (47 slots). Not tied to the number (= number - 1 in only 40% of players). The game's own colour (in the player block after the map) differs in 2 files: a campaign (reassigned) and a Regicide 1v1 (swapped); take the in-game colour from there |
| u8 | selected colour | |
| u8 | selectedTeamId | 6 = "?" (resolved below) |
| u8 | teamId | resolved: 1 = no team, 2-5 = teams 1-4, 0 in campaigns |
| 8 bytes | dat crc | |
| u8 | mp game version | |
| u32 | civId | 1-62 seen; each id maps to one civ name in the later player block |
| u32 n, n x u32 | customCivs | mgz `custom_civ_selection`: a saved custom-random list. Non-empty for 75% of players, and the civId is outside it for 46% of those, so it does not explain civId |
| str | ai type | e.g. "PromiDE" for AIs |
| u8 | ai civ name index | |
| str | aiName | |
| str | censoredName | |
| str | name | |
| u32 | type | 0 absent, 1 closed, 2 human, 3 eliminated, 4 computer, 5 cyborg, 6 spectator (mgz). Recordings: 0, 1, 2, 4. Saved games also 3 |
| i32 | profileId | -1 for AIs and empty slots; 0 for a human in single player |
| i32 | | 0 for humans, -1 for AIs and empty slots |
| i32 | number | 1..n for real players, -1 for empty slots |
| u8 | preferRandom | |
| u8 | custom ai | |
| u32, u32 | handicap block | first usually -1 (0 in some 67.2 slots); second = handicap (always 100) |
| u32 | | mgz unknown_de_64_3 |
| str | | **NEW** (not in mgz 66.6). Empty in every file |

**Real player vs empty slot:** real iff `number >= 1` (`isRealPlayer`: number >= 1 and type 2-5). In every
recording that is exactly type 2 (human) or 4 (computer). Empty slots are type 1 (closed), or once type 0
(absent: counted in DE `numPlayers`, missing from the metadata count), with number -1, profile -1 and no
name. Saved games also hold type 3 (eliminated: humans who left before the save), which keep their name,
profile, colour and number and are counted in the metadata, so a recording restored from a save may have
them; tell human from AI there by `aiName`/`profileId`. Real players always sit in slots 0..n-1 in number
order (slot index = number - 1, 5183 of 5183).

**What `number` is:** the game's player id. Checked in every file:
- it is the index of the player's block after the map (Gaia = 0): that block carries the same name and has
  stance 1 (self) at index `number`;
- every body action's player byte (action payload byte 1, all action ids seen) is a real `number`;
- the checksum sync's per-player id (u32 at +32 in each 44-byte row) set equals the set of numbers
  (16 files have no checksum sync: games abandoned at once or cut short);
- metadata `ownerId` is the recorder's number; in the 9 games the recording account did not play in, it is 1.

## 4. DE tail (between mod and metadata)

| type | notes |
|---|---|
| u32, u32, u32, u8, u32, u8, 9 x u8 | 27 bytes; the third u32 is the first 4 bytes of a slot's dat crc (371 of 373 files checked) |
| str | mgz skips it as fixed bytes; always empty |
| 61 bytes | 11 bytes, i32 -1, u32, 16 random bytes, `01 07`, 24 zero bytes |
| u32 n, u32, n x u32, u32, u32 | mgz: n, 12 bytes, n x 4. The n values are small ids |
| str x 3 | **NEW**: mgz reads 1 string + 8 bytes. All empty, so the size only changes if one isn't |
| u32, u32 | unknown, 0 |
| u32 | **NEW**: the timestamp again (744 files equal, 1 file 1 s earlier) |
| u32 | **NEW**: 0 |

mgz 66.6 ends here 8 bytes early (it takes the unknown u32 and the 0 as `timestamp, x`).

## 5. Metadata (`offsets.meta`, mgz `parse_metadata` and header/replay.py)

| type | field | notes |
|---|---|---|
| u32 | AI flag | 1 in the 12 files with AI players |
| (AI data) | | flag 1 only. Not decoded, 7 KB to 11.7 MB. The decoder finds its end from the map marker: the first `DEADDEAD 03000000` after the flag whose metadata start (marker - 74 - 4np) holds numPlayers = np at +47 and an owner < np at +45. mgz instead takes the end of the first run of 4096 zeros; that gives the same start in all 12 AI recordings, but costs 200-300 ms on the large ones (the marker search: about 10 ms) and fails on a local saved game with AI whose data has no such run |
| 24 bytes | times | zero at the start of a recording |
| f32 | speed | |
| u8, u32, i32, u32, u32 | pause, next object id, next reusable id (-2), seeds | 17 bytes |
| i16 | ownerId | recorder's player number |
| u8 | numPlayers | **includes Gaia** = real players + 1 |
| u8 | instant build | |
| u8 | cheats | equals DE cheats in multiplayer. In single player DE says 1 and this says 0 |
| u16, 4 x u32, u8, u8, u32 | game mode (0 MP, 1 SP), campaign fields, player turn | 24 bytes |
| numPlayers x u32 | per-player time delta | |

Metadata length after any AI data is 74 + 4 x numPlayers, then the map marker.

## 6. Map (`offsets.map`, mgz `parse_map`)

| type | field | notes |
|---|---|---|
| u32, u32 | `0xDEADDEAD`, 3 | in every file; mgz's "DE padding" at the end of the replay struct |
| u32, u32 | size x, size y | equal; 64-480 seen |
| u32 z | zones | 0-9 seen, mostly 5 |
| z x {2048 + 2 x tiles bytes, u32 f, f x f32, u32} | zones | |
| u8 | allVisible | mgz's name. 0 in every file, All Visible lobbies included: meaning **unverified** |
| u8 | fogOfWar | 0 exactly in the 2 All Visible lobbies (revealMapId 2), 1 in the other 743. For visibility use `de.revealMapId` or `fogOfWar`, not `allVisible` |
| tiles x 10 bytes | tiles, row-major | u8 terrain, u8 `0xFF`, u8 terrain again, u8 elevation, u16 `0xFFFF`, u16, u16 |
| u32 n, u32, n x u32, n x {u32 k, k x 8 bytes} | obstructions | |
| u32, u32 | size x, size y again | equal to the first pair in every file |
| 2 x tiles x u32 | visibility grids | |
| u32 | restoreTime | 0 in every recording; non-zero in saved games |

Tile byte 2 equals byte 0 except where byte 0 is 7 (farm) or 6/27 (foundation dirt), so it is probably the
terrain underneath. `terrain` is byte 0. Bytes 1, 4, 5 are `0xFF` in every tile of every file. Terrain ids
seen are up to 126, elevation up to 7.

## 7. After the map (`offsets.afterMap`, start of mgz `parse_players`)

u32 particle count n, 27n bytes, u32 identifier, then one block per player, Gaia first:
u8 type (Gaia 2, human 1, computer 3: not the DE slot type), u8, np x u8, np x i32 stances (index = player
number; 0 Gaia, 1 self, 2 ally, 3 neutral, 4 enemy), u32 allied LOS, u8 allied victory, u16 name length
(including the 0), name, u8, u32 stat count, u8, f32 stats (food, wood, stone, gold, headroom, conversion
range, current age, ...). np = metadata numPlayers.
Gaia's name length `05 00` (mgz's anchor `05 00 'Gaia' 00`) sits exactly at
afterMap + 4 + 27n + 4 + 2 + np + 4np + 5 in every file. mgz finds it by searching instead.
Observations for the next part: stances toward other teams are mostly 2 at this point, so take teams from
the DE `teamId`, as mgz does. Further on, the block holds the civ name as a DE string ("BRITONS-CIV"), then
6 zero bytes and `0b <colour> 0b`: the in-game colour (found that way for 4334 of 5183 players).

## Verified and guessed

Verified across all 745 files: every read in bounds; the 5 SEPs; the map marker; both map size pairs equal;
exactly dimension^2 tiles with the per-tile byte pattern above; metadata and DE player counts; speed equal in
both places; Gaia at the computed offset; numbers against later header blocks, body actions and syncs;
humans named, AIs with an AI name; colours 0-7 unique, teams 0-5, civs 1-62; timestamp within 2 days of the
file date and equal to its tail copy; stored starting age 2-6 against the current-age stat; `fogOfWar`
against revealMapId; `matchmaking` only in rated games without a lobby name; guid + timestamp unique;
header.js loaded as classic scripts next to reader.js (separately and concatenated) gives the same result.
Saved games (`--saves`, 159 files): parse, real-player rule, metadata count, owner.

Guessed or unverified: the meaning of the lobby flags (`turbo`, `animals`, `predators`, `sharedExploration`,
`teamPositions`, `randomPositions`, `allTechs`), of `difficultyId` and of `allVisible`. These are mgz's names
at byte positions the SEPs pin down. Also unverified: what the NEW strings hold (always empty), the tail's
unknown u32 and id list, tile byte 2 as the terrain underneath, the 9-byte group before the third SEP, and
the ending age (no in-game check possible; 0 presumably means the mode's default, Imperial).
