# Player commands (op 1 actions) in AoE2 DE recorded games, save 67.2 / 68 / 68.9

- `actions.js`: the decoder. Browser-safe (no Node APIs); needs `Reader` from `../reader.js`, taken from the shared
  script scope or `require()`. Exposes one global, `ReplayActions` = { decodeAction, LAYOUTS, GAME_COMMANDS, ORDERS,
  RESOURCES, RELEASES, AI_ONLY_IDS }, which is also its `module.exports`.
- `test-actions.js`: the corpus check (default: every 68.9 file plus 40 each of 68 and 67.2 spread over builds, ~15 s;
  `all`: all 745 files, ~70 s). Prints per id and save: count, % exact, value ranges per field, then the invariants below.
- `walk.js`: harness only (Node). Corpus sample, a minimal body walker per the verified op layout, and a best-effort
  header peek (map size, lobby slots with type and civ) used to check coordinates and to tell AI slots apart. The
  walker follows op 5 (8 bytes; scenario/campaign files) and saved chapters as `../stream/SPEC.md` pins them down, so
  every corpus file is walked to its end: 661 reach the postgame and 84 stop cleanly at an operation boundary.
- `explore/`: the one-off scripts behind the conclusions below (each says what it looks at in its first line).
- `recheck/`: `run-checkers.sh` re-runs every script in `verify-robustness/` and `verify-semantics/`, with one log
  per script.
- `ref/aoc-reference-data-constants.json`: SiegeEngineers/aoc-reference-data `data/constants.json` (public GitHub raw;
  the repo root had no LICENSE file to fetch). Only its id-to-name tables are used: 117 orders, 103 commands,
  resources, stances, formations, diplomacy. Everything else here comes from mgz (MIT) and the local corpus.

## Verified across the whole corpus (745 files, 12,857,217 actions)

`node test-actions.js all` prints these; figures marked with a script name come from `explore/` instead.

| Invariant | Result |
|---|---|
| Record frame `[id u8][player u8][length u16][payload]`, length == record length - 4 | 12,857,217 / 12,857,217 |
| Layout for the id consumes the payload exactly (counts x 4 bytes etc.) | 12,857,217 / 12,857,217 (every id, every save, including the scenario/campaign and chapter files) |
| u32 after each record == running sum of op-2 sync increments | 12,857,217 / 12,857,217 |
| Player byte in 1..8 | all |
| Coordinates (x/y, wall ends, every used waypoint) inside [0, map size from header] | 13,400,460 / 13,400,460, after the sentinels listed below |
| Object ids listed in selections by more than one player | 611 / 8,670,952 (0.007%, conversions) |
| 103 `source` field == record player (all sub-commands but speed) | 261,499 / 261,499 |
| Flare shown to its own sender | 19,204 / 19,207 |
| Flare slot count == lobby players + 1 (gaia first) | 19,207 / 19,207 |
| Tribute recipient is another player 1..8 | 15,499 / 15,499 |
| 117 order 4 (unqueue) names only buildings that 129/101 queue at | 73,164 / 73,172 |
| 131's byte == record player | 387 / 387 |
| 129 `button` is the usual value for its (building type, unit) | 99.948% (125 of 130 pairs single-valued) |
| 129 with several ids listing a building of another type (types taken from single-building 129s) | 4,201 / 738,667 (0.57%): mixed selections, see 129 |
| 111 release type 1: the target field is the sender's player number or 0 | 15 / 15 |
| 102 `variant`: houses 0..2 / farms 0 | 236,535 / 236,535 houses; 514,591 / 517,128 farms (see 102) |
| AI-only ids (2, 10, 31, 35, 37, 100, 130, 131, 138, 103/11) from a non-AI lobby slot | 0 |
| Body walk ends at the postgame or cleanly between operations | 745 / 745 (4 files with op 5, 2 with a saved chapter) |

No layout differs between 67.2, 68 and 68.9: the same decoder is exact on all three. What changes between them is usage
(see "Version notes").

## Conventions

- **Player**: byte 1 of every record is the acting player (1..8). No spectator or gaia commands appear. Only 103 (u16 at
  payload offset 4) and 131 (u8 at offset 4) repeat it inside the payload; 196/108 `to`, 103/0 `to` and the flare slots
  name other players.
- **Trailing u32** (read by the body walker, not part of `bytes`): the world time in ms, equal to the sum of sync
  increments so far. Not a sequence number.
- **Selections**: a count followed by that many u32 object ids. Every object id and target in every kind is read as i32,
  because 0xFFFFFFFF appears as "none" (inside 111 lists, as 122/123's market, as the target of a target-less order).
  So `-1` means "no object" everywhere (`object`, `target`, `building`, list entries). The decoder never returns a
  player number in an object field: 111 release type 1 moves its player number to `targetPlayer` and sets `target` to -1.
- **Same selection**: only 0 (order) and 3 (move) use an i16 count, and there -1 means "no ids sent; the units are those
  of this player's last order/move that listed them" (`ids: null, sameSelection: true`). 1,290,644 such records; every
  one has an earlier listed order/move from the same player. Resolving instead to the player's last command of any kind
  would make 5,759 moves move production buildings (TCs, castles; `explore/samesel*.js`, before the op-5 and chapter files were walked); resolving to the last order/move does so 11 times
  (mixed unit+building selections). That rule and "last unit command of any kind" agree on 99.6% of -1 records. Senders also often resend an unchanged list
  explicitly, so -1 is an optimisation, not a rule to rely on in reverse.
- **Coordinates** are tile coordinates as f32 (u16 for walls and AI waypoints). Sentinels: -1,-1 = no point; 0,0 on 117
  unqueue; -0.5,-0.5 on 142 target-less orders (67.2, one 480-tile map).
- `unkN` fields in the decoder are named by payload offset; their observed values are listed so a later reader can tell
  if a new build changes them.

## Layouts

Offsets are into the payload (after the 4-byte frame). "ids" = `count` u32 object ids. Confidence: **V** = layout
verified by exact consumption plus the value checks named; **M** = meaning established from context in the data;
**G** = guess.

| id | kind | Payload layout | Meaning, evidence | Conf. |
|---|---|---|---|---|
| 0 | order | target i32 @0, x f32 @4, y f32 @8, count i16 @12 (-1 = same selection), 4 flag bytes @14, i16 @18 (-1; 104/105 in 24 records), ids | Right-click on a target (interact: gather, attack, build, garrison by right-click). In 30 files per save, 55% of order targets are objects another player commands, 40% objects nobody commands (gaia: resources, animals), 5% the player's own. Flags (unknown) mostly 0,0,1,1 or 0,1,1,1. | V layout, M meaning, G flags |
| 1 | stop | count u32 @0, ids | Stop. Counts up to 240 in 67.2, 60 later. | V |
| 2 | aiInteract | target i32, x f32, y f32, count u32, u32 (always 1), ids | AI only. | V layout, G meaning |
| 3 | move | as 0; target always -1, i16 @18 always 0 | Move to x,y. | V |
| 10 | aiOrder | count u32 @0, first unit i32 @4, target i32 @8, u32 0 @12, order type u32 @16 (700..724), x f32 @20, y f32 @24, f32 @28, f32 @32, 4 bytes @36, then all `count` ids only when count > 1 | AI only (540,443 records, all from computer slots of 67.2 files). The `count > 1` rule is exact on every record. | V layout, G fields |
| 11 | resign | u8 | 0 or 1 (1 in 18-33% per save); likely "disconnected" (mgz's name). | V, G meaning of the byte |
| 18 | stance | count u32, stance u32, ids | 0 aggressive, 1 defensive, 2 stand ground, 3 no attack. | V |
| 19 | guard | count u32, target i32, ids | | V |
| 20 | follow | count u32, target i32, ids | | V |
| 21 | patrol | count u32 @0, u8 @4 (0/1), u8 @5 (0), u8 @6 (0), waypoint count u8 @7 (1..10), x[10] f32 @8, y[10] f32 @48, ids, then 0..16 zero u32 words | Waypoints = first `waypoint count` x/y pairs: the count matches the filled slots in 100% of 21/33 records. The zero padding (0.6-1.2% of patrols per save) is extra id slots beyond `count`; reason unknown. | V |
| 23 | formation | count u32, formation u32, ids | 2 line, 4 box, 7 staggered, 8 flank. | V |
| 31 | aiWaypoints | count u32, n u32, ids, x[n] u16, y[n] u16 | AI only. Paths are smooth (x then y arrays). | V |
| 32 | chapter | empty | 2 records (68), one in each of the only 2 files with a saved chapter. In both, the body's saved chapter follows 1 or 3 ops later at the same world time (`explore/chapter32.js`): a player's "save game" request, after which the chapter is written. mgz also names it a chapter. | V, M |
| 33 | attackMove | as 21 with byte @6 = 1, byte @4 = 1 | | V |
| 35 | aiRetreat | as 2 | AI only, 3 records. mgz calls it retreat. | V, G |
| 37 | aiUnknown37 | i32, u8 | AI only; values like -1, 4, 6, 7, 24, 283, 492. | V, G |
| 38 | autoscout | count u32, ids | | V |
| 41 | transform | u32 value @0 (1650..1653), object i32 @4 | Not a player input. The client sends it in bursts of identical records (3 to about 40) for one object. That object is never selected or targeted by any command. It is the hidden per-player object of unit type 1649 that the game creates with every Town Center at the TC's id + 3 (the objects part names type 1649 "Trophy None"). Evidence: 839 of 840 starting type-1649 objects sit at the same player's starting TC id + 3; every 41 aimed at a starting object hits a type-1649 object owned by the sender (247/247 distinct objects in 122 files, `explore/obj41c.js`; 1,247/1,247 records in 152 files, `verify-semantics/owners.js`); 4,284 of 4,352 later 41 objects sit 3 ids above an object some command names, 3,420 of them first named as a TC by a 129 with building type 109 (`explore/obj41e.js`). The value is constant per player per game (465/465 players, 60 files per save) and not tied to civ. It is presumably the type the hidden object becomes, a per-player cosmetic. Never sent from AI slots. Exclude from APM. | V layout, M "automatic" and object, G value |
| 42 | unknown42 | u32 | 48 records in 68 (mostly one file), values 413..1792. | V, unknown |
| 43 | ability | count u32, ability i32 (153, 154, -1), ids | Military units only (they also get 0/3/23). mgz calls it the Ratha ability; a mode switch is a guess. | V, G |
| 44 | unknown44 | count u32, ids | Units are villagers (they also build). | V, unknown |
| 45 | multiGatherPoint | as 0 (count i16 never -1 here), flags always 0,1,1,0, i16 @18 always 0 | Gather point for several buildings. | V |
| 100 | aiQueue | building i32, i32 -1, unit u32 | AI only (67.2): train a unit at the building (decoded with ids = [building]). | V |
| 101 | research | building i32 @0, count i16 @4, tech i16 @6, i32 -1 @8, u8 0 @12, ids | Research. Ids are the building(s). AI sends count 1 with no list (859 records). In 68/68.9 research is rare because most corpus games of that period start with techs done (tech 408 Spies dominates), not because of a format change. | V |
| 102 | build | count i16 @0, u16 0 @2, x f32 @4, y f32 @8, unit u32 @12, i32 -1 @16 (AI: 0..309), i32 -1 @20, variant u16 @24, queued u8 @26, u8 @27, ids | `variant` (all 745 files, `explore/variant102.js`): houses 0, 1 or 2 in every record (236,535; about a third each, so probably the house graphic). Mills, fish traps and mule carts spread nearly evenly over 0..179 (mills: non-zero in 98-99%, 177 distinct values). Farms are 0 in 514,591 of 517,128; the 2,537 others come from 23 players in 20 files (67.2 and 68 only; mostly 1, 2 or 5). Stables, monasteries and universities are 0 except for a few players; every other building is 0. Never set by AI slots. Probably a client-chosen graphic variant or angle; meaning unconfirmed. `queued` = 1 on 94% of builds sent within 1 s of the same villagers' previous build (102/105), 87-89% within 3 s or 10 s, and 28% of other builds. Nearly every player mixes 0 and 1 (870 of 946 players with 20+ builds; 72 never set it), so it is per click, not a setting (`explore/queued102.js`, 142 files): the shift-queue flag (AI never sets it). | V layout, M queued, G variant |
| 103 | game | command u16 @0, u16 0 @2, source u16 @4 (== player, 0 for speed), then per command (16 bytes in all) | 0 diplomacy: to u16 @6, stance f32 @8, stance u8 @12 (0 ally, 1 neutral, 3 enemy). 1 speed: f32 @8 (1.0, 1.5, 1.69, 2.0). 6 cheat: id u16 @6 (101-104, 117-120). 10 spies: no fields. 11 strategic number (AI only, 248,580 records, 67.2): number u16 @6, value i32 @12. 13 farm queue / 14 farm unqueue: count u16 @6. 16 farm auto-queue, 19 fish-trap auto-queue (each player sends both at 0.5 s), 20 default stance: no fields. | V |
| 105 | wall | count u32, x1 u16, y1 u16, x2 u16, y2 u16, unit u32 (72 palisade, 117 stone), i32 -1, 4 bytes, ids | | V |
| 106 | delete | object i32 | | V |
| 107 | attackGround | count u32, x f32, y f32, 4 bytes (0,0,1,0), ids | | V |
| 108 | tribute | amount f32, fee rate f32, resource u8, u8 0, to u8 | Old-style tribute. 67.2 only, 2,057 from AI and 14 from humans. | V |
| 110 | repair | count u32, target i32, 4 bytes (0,0,0,1), ids | | V |
| 111 | ungarrison | count u32 @0, x f32, y f32 (-1 unless released at a point), unit i32 @12, release type u32 @16, u8 @20, ids | Release type 0 all (unit -1 in exactly those records), 3 selected, 4 same type, 5 not selected, 6 inverse (mgz names; their unit fields are object ids, the smallest 11,927). **Release type 1** (15 records; not in mgz): the field @12 is a player number, the sender's own in 11 records and 0 (gaia) in 4. Each 0 comes at the same instant as one naming the sender. The holder list is always 1 holder. The 15 records name 9 distinct holders. Earlier orders or garrisons sent units into 6 of them, and 4 of those 6 took units of another player (allied units). So "release the units owned by that player" (`ownedBy`) is our reading (`explore/release1.js`). The decoder returns that number as `targetPlayer` and sets `target` to -1, so it is never looked up as an object. Ids are the holders (TCs, castles, ...); may contain -1. The u8 is 0/1 in 67.2, always 1 later. | V layout, M type-1 field is a player, G type-1 name |
| 114 | gate | object i32 | Lock/unlock gate. | V |
| 115 | flare | target i32 (-1), x f32, y f32, n u8, n bytes | One byte per slot, gaia first, 1 = shown to that player; n = players + 1. | V |
| 117 | special | count u32 @0, target i32 @4, x f32 @8, y f32 @12, i32 @16, slot u32 @20, order u8 @24, 4 bytes @25, ids | Orders seen: **4 unqueue** (target -1, x,y 0, slot = 0-based queue position, byte @25 0/1 probably shift = remove up to 5), **1 pack trebuchet** (with the destination: target + x,y and @16 = 100, or x,y only and @16 = 0), **2 unpack trebuchet**, **5 garrison** (target = own building), **8** (mostly villagers, no target), **7** (67.2, 50 records). Names 1/2/4/5 from aoc-reference-data, consistent with the data. | V layout, M 4/5, G 1/2 detail, unknown 7/8 |
| 120 | gatherPoint | count u32, x f32, y f32, target i32, target unit type i32, u8 0, ids | target -1 exactly when target type -1. | V |
| 122 | sell | resource i16, lots i16 (1 or 5), market i32 | resource 0 food, 1 wood, 2 stone, 3 gold; amount = lots x 100 (5 = shift-click). Market -1 = none named. | V |
| 123 | buy | as 122 | | V |
| 126 | dropRelic | object i32 | | V |
| 127 | townBell | object i32 (TC), u8 on | | V |
| 128 | backToWork | object i32 (TC, castle) | | V |
| 129 | queue | count i16 @0, u32 0 @2, building type i16 @6, unit i16 @8, amount i16 @10, button u32 @12, ids (the selected buildings) | Train units (DE queue / multi-queue). **The ids are the whole selected group, not only buildings that can train the unit.** A mixed selection lists every selected building, and the unit goes only to those whose type is `buildingType`. 4,201 of 738,667 multi-building records list a building whose own single-building queues give it another type: barracks with stables, castles with TCs, stables with siege workshops, and so on. The header-object check finds 263 of 82,510 records listing a starting TC with a building type other than 109 (`verify-semantics/owners.js`, 152 files). A viewer should add the unit only to listed buildings of `buildingType`, where the object's type is known. Amount 1..15 (68.9: 1..5), always positive. **button** = the unit's train-button slot in that building (villager 1; militia 1, spear 2, eagle 4; archer 1, skirmisher 2, cav archer 3, hand cannon 4; scout 1, knight 2, camel 3, elephant/lancer/tarkan 4; ram 1, mangonel 2, scorpion 3, bombard 4; castle unique unit 1, trebuchet 2, petard 3), rarely 8..14, 0 from AI. | V layout, M button |
| 130 | aiUnknown130 | count u32, u8, ids | AI only. | V, unknown |
| 131 | aiUnknown131 | count u32, player u8, ids | AI only. | V, unknown |
| 138 | aiUnknown138 | u32 (5), u32 (903..955), u32 (10, 13), f32 (0.85, 1.15) | AI only, 6 records. | V, unknown |
| 140 | unknown140 | object i32 | One record per selected TC/castle at the same instant: a building toggle of some kind. | V, unknown |
| 196 | tribute | amounts f32 x4, fee rates f32 x4, resource ids u16 x4 (always 1,0,3,2 = wood, food, gold, stone), to u8 | One record per recipient; zero-amount records are sent too (the tribute panel's other rows), skip them for display. Fee rates 0, 0.2 or 0.3. | V |

## Answers to the key questions

- **Cancelling a queued unit or a research**: neither a negative amount (129's amount is always 1..15) nor a 129 flag. It
  is 117 with order 4 ("unqueue"): ids = the building, `slot` = 0-based position in its queue (0..14 seen), x,y = 0,0,
  target -1. 73,164 of 73,172 name only buildings that 129/101 queue at. In the queue/cancel sequences inspected
  (`explore/seq.js`), a cancel right after one research or unit on an idle building uses slot 0, and slot 1 when
  something was already in production there. Byte @25 is 1 in 52% (67.2), 83% (68) and 81% (68.9) of unqueues; that it
  is the shift modifier (remove 5) is a guess.
- **u32 after `amount` in 129**: the train button slot, fixed per (building type, unit) in 99.95% of human records,
  following the unit lines listed above; AI records carry 0.
- **Acting player**: byte 1 of every record, for every id (checks above). It is the only player field except in 103 and
  131, where the copy agrees.
- **Trailing u32**: world time in ms (equals the summed sync increments in every record), not a sequence number.
- **AI commands**: present. 12 files have computer slots (header type 4): 9 in 67.2 and 3 in 68.9. The 67.2 files are 8
  random-map games with computer opponents plus 1 campaign game (header game type 4). The 68.9 files are 3 scenario
  games (game type 3) of 2 or 3 actions each, all from the human (a resign and 103 preference syncs); their computer
  slot sends nothing. In the 9 67.2 files, computer slots send the AI-only ids listed above and ordinary ones too (0, 1,
  18, 21, 23, 43, 101, 102, 103, 106, 107, 108, 111, 115, 117, 120, 122, 123, 129): 1,309,699 records in all. APM must
  skip players whose lobby slot is a computer, not just the AI-only ids. Tells inside a record: 129 button 0, 101
  without a list, 102 with @16 != -1. The AI-only layouts are therefore checked on 67.2 only; no 68 or 68.9 file has a
  computer that sends commands.
- **Not inputs at all**: 41 (automatic, see above) and 32 (the save that precedes a chapter, a player request but not a
  game command). The 16/19 game sub-commands at 0.5 s are preference syncs, not clicks.

## Version notes (67.2 / 68 / 68.9)

- Layouts: identical; nothing found that needs a version switch for actions. All 745 files are walked to their end,
  including the 4 scenario/campaign files with op 5 (one 67.2, three 68.9) and the 2 files with a saved chapter (68).
- Computer slots that send commands occur only in 67.2 (9 files). The 3 68.9 files with a computer slot are scenarios
  where it sends nothing. So AI-only ids and 103/11 occur only in 67.2, and their layout in 68/68.9 is unverified (no
  data), not known to be unchanged. 108 also occurs only in 67.2.
- 111's u8 @20 is 0/1 in 67.2 and always 1 in 68 and 68.9.
- 129 amount reaches 15 in 67.2/68 but at most 5 in 68.9.
- 42 and 32 only seen in 68 (few records); 32 sits next to the only 2 saved chapters.
- 102 farm variants other than 0 appear only in 67.2 and 68.

## Not settled

- Flag bytes @14..17 of 0/3, @25..28 of 117, @27 of 102, the 4 bytes of 105/107/110: value spreads are in the test output.
- 102's `variant` on mills, fish traps, mule carts and the few non-zero farms/stables: graphic or angle, not confirmed.
- 111 release type 1's name (the field is a player number; "release that player's units" is a reading).
- 117 orders 7 and 8; ids 42, 44, 140, 130, 131, 37, 138; the meaning of 41's value (1650..1653) and 43's ability numbers.
- Why some patrols carry zero id slots past their count.
- Which earlier list a -1 selection names when the last order/move and the last unit command differ (0.4%).
