# Body stream of AoE2 DE recorded games (save 67.2, 68, 68.9)

What `stream.js` decodes, and how sure each claim is. **Verified** means an invariant checked on the files named;
**strong** means several independent tests agree but no exact check exists; **guess** means a reading of the data
that fits what was seen. Corpus: the 745 local files in `../corpus.json` (save 67.2 builds 170934/174992/175278, 68
builds 177723-180059, 68.9 builds 185872/188329). Unless a count says otherwise, "all files" means all 745.
`node test-stream.js --all` re-checks every "harness" claim below (all held on the last run). The chat counts come
from `recheck/chat-eval.js` (all files) unless said otherwise.

All integers are little-endian. Offsets are absolute file offsets unless said otherwise.

## API in brief

- `walkBody(fileBytes, bodyStart, handlers, options)` walks the body. `options.seats` (the header's seated player
  numbers) is optional; when given, chat recipients are cut down to seated players (see Chat).
- `markHistory(entries)` runs over the collected `[{ chat, time }]` and flags the chat history the game replays
  into the file (`chat.history` = `'lobby'`, `'replay'` or null). Those lines carry lobby-time player numbers.
- `agpSender(messageAGP, names)` reads the sender's name out of `messageAGP`.
- `decodeChecksum`, `decodeChat`, `decodePostgame`, `readMeta` are the record decoders `walkBody` uses.

## Framing around the body

| What | Layout | Status |
|---|---|---|
| File prefix | u32 header end (absolute, = body start), u32 next chapter offset (0 = none), raw-deflate header | verified (given; chapter pointer verified below) |
| Body | 32-byte meta block, then operations until the end of the file | verified, harness |
| Saved chapter inside the body | u32 absolute offset where the body resumes, u32 next chapter offset (0 = none), raw-deflate header up to that offset | verified: 2 files (179158, 180059), each with one chapter exactly at the prefix's next-chapter offset; the walk resumes at the given offset and runs cleanly to the postgame; the action clock stays continuous across it |

There is no literal op id 7 in these files. mgz's "save" branch fires on any op id it does not know. `stream.js`
accepts a chapter only at the offset the prefix (or the previous chapter) points to: the prefix's next-chapter u32
is 0 in all 743 files without a chapter and equals the chapter's offset in both files with one. Any other large op
id is damage and ends the walk as `corrupt` (an earlier version accepted any in-file offset, which let a damaged op
id skip records silently). The checksum counter restarts at a chapter: the first checksum after it comes 500 syncs
after the chapter (harness).

## Meta block (8 × u32 at the body start)

| # | Field | Values seen | Status / evidence |
|---|---|---|---|
| 0 | log version | 5 | verified: 745/745 |
| 1 | checksum interval | 500 | verified: 745/745; a checksum block follows exactly every 500th sync (54,403 blocks, harness) |
| 2 | multiplayer | 0, 1 | verified: equals the header's multiplayer flag, 745/745 |
| 3 | game mode (engine numbering) | 1, 2, 3, 4, 12, 14, 15 | verified as a mapping: header game type 0 with turbo off → 1 (60/60), game type 0 with turbo on → 2 (492/492), regicide (1) → 3 (3/3), deathmatch (2) → 4 (180/180), empire wars (13) → 12 (4/4), scenario (3) → 14 (5/5), header type 4 (single-player campaign file) → 15 (1/1). Names beyond that mapping are guesses |
| 4 | recording player | 1..8 | verified: equals the player number of the replay owner's profile in 735/735 files the owner played; in the 10 files the owner only watched it is 1 |
| 5 | reveal map | 0, 1, 2 | verified: equals the header's reveal_map, 745/745 (0 normal, 1 explored, 2 all visible per mgz) |
| 6 | unknown | 0 | always 0, 745/745 |
| 7 | unknown | 0 | always 0, 745/745 |

mgz labels this block (checksum interval, multiplayer, rec owner, reveal map, sequence numbers, chapters); in DE the
game mode is inserted before the owner, so mgz's "rec_owner"/"reveal_map" sit one slot later.

## Operations

Every operation starts with a u32 op id.

| Op | Layout after the id | Status |
|---|---|---|
| 1 action | u32 L, L bytes, u32 world time | verified: the trailing u32 equals the running sync clock for all 12,857,217 actions; in every action, byte 0 is the action id, byte 1 the player and the u16 at byte 2 equals L - 4 (payload length), harness; `walkBody` enforces both. Largest L 968 |
| 2 sync | u32 increment (game ms); if the next u32 is 0, a 360-byte checksum block follows | verified, harness. Largest increment 250 |
| 3 viewlock | f32 x, f32 y, u32 player | verified: player = meta recording player in every viewlock (6.9 M); x, y are the camera centre in tiles, within 5 tiles of the map (a few files go to about -3) |
| 4 chat | i32 -1, u32 length, UTF-8 JSON object | verified: the -1 and a JSON object in all 45,640 chats; largest length 328 |
| 5 | i32 a, u32 b | only in 4 single-player files (scenario and campaign); (a, b) is (-1, 30/32/33) in triples about once a game second in the campaign file, and once (0, 1) or (0, 2) near 1 s in the scenario files. Meaning unknown. mgz calls op 5 "start", which does not fit these |
| 6 postgame | runs to the end of the file (below) | verified: decodes exactly in 661/661 files that have it |

A viewlock follows every sync in 732 of the 735 files the owner played; 9 of the 10 files the owner only watched have
no viewlocks at all. Ops 2/3 are by far the most common records (27.4 M syncs in the corpus).

### End of the stream, and how damage is reported

All 745 files walk cleanly: 661 end with a postgame, 84 stop exactly at an operation boundary with no postgame
(recordings that stopped early, including 5 that hold only the header and the meta block). None is cut mid-operation
and none is corrupt.

Because clean files keep these invariants without exception, `walkBody` enforces them, and a break ends the walk as
`corrupt` at the record that broke it (everything before has been dispatched):

- an action's trailing world time, a checksum block's clock, and the postgame world time must equal the sync clock
  (a damaged sync step or length shows here at the next record that carries the clock);
- an action's inner length (the u16 at its byte 2) must be L - 4, which also catches a length grown over the next
  action at the same clock, where the trailer still matches;
- a chat must start with its -1;
- sanity bounds far above the corpus maxima: sync step ≤ 10,000 ms (max seen 250), action length 4..65,536 (max 968),
  chat length ≤ 65,536 (max 328), postgame block count ≤ 64 (always 2);
- an op id must be 1..6, or the next-chapter offset at exactly that position;
- the postgame blocks must tile its bytes and the leaderboard block must decode exactly.

`truncated` is reserved for a record that runs past the end of the data (or a postgame without its end magic), and
`end.at` never lies past the end of the data. A bad `bodyStart` (not a non-negative integer) is `corrupt` at 0.

Evidence (all with the fixed code): on `--all` the harness damages one file in ten (75 files; the record-level damage
in the 73 with more than 10 actions, the leaderboard damage in the 65 with a postgame): it cuts each at 5 points,
and damages it by a forged op id 99, an op id forged to an in-file offset, an action
length of 2^30, a length grown over the next action at the same clock, a sync step with bit 16 flipped, a sync step
off by 1 ms, a viewlock's and a chat's op id forged to 1, and a broken leaderboard block. Every walk stops at the
expected record with the expected reason and keeps every earlier action. `verify-robustness/fuzz-v2.js` and
`cuts.js` repeat this at scale (results in "Harness results" below).

## Time base

Sync increments are **game** milliseconds, as the in-game clock shows (verified two ways):

- The increments take a few quantised values that are the game speed times a real step of 1000/N ms: at speed 2.0
  they are 250, 166, 124, 82, 62, 50, 40, 34, 30, 16 ms (= 2 × 125, 83, 62, 41, 31, 25, 20, 17, 15, 8); at speed 1.69
  211, 140, 104, 69, 52, 42, 33, 28, 25, 21 ms; the one speed-1.5 file uses 12 ms (= 1.5 × 8). Never above 250.
- Game clock / wall-clock duration (file mtime minus the header start timestamp) for finished games over 10 game
  minutes: median 1.973 at speed 2.0 (n 576), 1.658 at 1.69 (n 47), 1.488 at 1.5 (n 1). Slightly under the speed
  because wall time also covers loading and the score screen.
- The sum of increments equals the postgame world time in 661/661 files, the checksum block's own clock in every
  block, and every action's trailing world time.

A checksum block comes every 500 syncs, so its spacing in game time depends on the step length: p10/median/p90 about
11-17 s / 25-62 s / 84-125 s depending on the build (table at the end); at most 125 game seconds (500 × 250 ms).

## Checksum block (360 bytes)

`u32 0` (the marker), 8 rows of 11 i32, `u32 clock` (game ms). Same size in 67.2, 68 and 68.9: in all 54,403 blocks
the next u32 after 360 bytes is an op id or a chapter offset (harness). Row i is player i + 1 (the 9th value says so);
a row is non-empty exactly for the header's seated players (harness, every block of all 745 files); gaia has no row.

All the per-row sums run over one set of the player's objects ("counted objects"): units, buildings, building
foundations and owned livestock; not the header's class 0x0a and 0x14 records and not unit type 890 (one of the
pieces listed with the town centre). Evidence: at the first checkpoint, 55 of 409 sampled players match the header's
objects on three independent sums at once (count = value 6, unit-type sum = value 2, id sum = value 10); the others
had already built, trained or found sheep by then. Livestock joins the set when found (value 6 +2 and value 4 +300
when two 150-food animals were found).

| # | `stream.js` name | Meaning | Status / evidence |
|---|---|---|---|
| 0 | | always 0 | verified: 375,688 non-empty rows (all files) |
| 1 | `resources` | the bank: floor(food) + floor(wood) + floor(gold) + floor(stone), summed as i32 | **verified**, see below; reads 0 with infinite resources |
| 2 | `unitTypeSum` | sum of the counted objects' unit type ids | **verified** at the start (one of the three exact sums); it moves without any count change when villagers switch task, which changes their unit type |
| 3 | `spriteCount` | a count of drawn objects | **guess** (mgz: "displayable objects"): equals exactly 2 × value 6 in 40/40 of the exact-match starts; foundations do not add to it (one player who laid 9 wall foundations: value 6 rose by 9, value 3 stayed); later in the game it drifts from 2 × value 6 (corpses, projectiles?) |
| 4 | `heldResources` | resources inside the player's objects: food in owned livestock and carcasses, loads carried by villagers | **strong**: 400 at a standard start (4 sheep × 100), 0 in deathmatch-style starts with no livestock, rises in 100/150 steps when herdables are found; after a resignation it only falls, slowly (carcass decay) while everything else is frozen |
| 5 | | always 0 | verified, as value 0 |
| 6 | `objectCount` | number of counted objects | **verified** at the start (exact match with the header's objects); mgz agrees ("objects, including foundations"). 0 in 92 rows of 4 files (a defeated player with nothing left; the row still carries the player number) |
| 7 | `positionSum` | sum of 100 × (x + y) over the counted objects, tile coordinates | **verified**: exact in 18 of 25 exact-match starts (e.g. 158900, 575200; in the other 7 units were already walking); per-object mean matches the header positions within unit movement on every map size (v7/v6 ≈ 100 × map dimension on average); constant after a resignation, when nothing moves. Rounding of fractional positions unknown. Largest value 181,230,393, far from 2^31 |
| 8 | `player` | player number | verified, harness |
| 9 | `unknown9` | ? | unknown. About 930-1150 per counted object; differs between players with identical starts; keeps changing slowly while a resigned player's objects are frozen; slightly negative (down to -149) in 29 rows of 6 files. No sum of any header object field (f32/u8/u16/u32 at offsets 0-119, scales 1-1000) matches it, so it is not position, type, id or a stored field; not full hit points either |
| 10 | `idSum` | sum of the counted objects' instance ids, **modulo 2^32** | **verified** at the start (exact); in play, when value 6 rises by exactly 1, the value-10 delta is an id the same player later commands in 598/1085 cases, against 0.5-3 % for values 7 and 9 as controls. It wraps: as i32 it goes negative in 375 rows of 6 games of 170-298 game minutes with about 2,000-2,800 counted objects (115 jumps of about -3.5e9 between consecutive blocks, e.g. 1,694,981,317 → -1,876,630,639, which is +723,355,340 mod 2^32). `stream.js` decodes it as u32 (`values[10]` keeps the raw i32); take the change between two blocks as `(b - a) \| 0` |

### Value 1, the bank (the main question)

- **Rule.** Two saved chapters hold every player's exact float stockpile. Two players whose value 1 did not change
  across the chapter give the exact rule: (119910.094, 31282.879, 6.162, 179564.531) → 330762 and (170736.422,
  92809.852, 3594.950, 42287.051) → 309426, both equal to the sum of each resource truncated. Rounding would give
  330764 and 309428; truncating the float sum would give 330763 and 309428. So it is per-resource truncation, then
  the sum. Only food, wood, gold and stone: the exact matches leave no room for anything else.
- **Infinite resources** (verified, 3 files: builds 170934, 175278, 177723, starting resources id 5, game modes 1
  and 2): value 1 is 0 in every block for every player (252, 136 and 303 blocks) although objects grow to about 2,000
  and hundreds of build/queue/research commands are issued. The header stockpiles there are 3.3999999521443642e+38
  per resource; each truncates to INT_MIN as i32, and four INT_MIN sum to 0 mod 2^32. Truncating the float sum
  instead would give INT_MIN, not 0, so this is more evidence for per-resource i32 truncation. A viewer should hide
  or label the bank when the header stockpiles are about 3.4e38. (The one res-5 deathmatch file has normal
  20000/20000/5000/10000 stockpiles and normal values.)
- **Start.** The header's per-player attributes (601 floats after the 0x16, u32 count, 0x21 marker; food, wood, stone,
  gold first) give the start bank: 200/200/200/100 = 700 at standard, 20000/20000/5000/10000 = 55000 at starting
  resources id 4 (deathmatch-level). Value 1 at the first checkpoint equals that start minus everything queued, placed
  or researched before it (costs from aoe2techtree's data.json, each command applied only when affordable, since the
  game refuses the rest) for **455 of 506** players in all 68 standard-resource dark-age RM files. Of the rest, 18 are
  lower (two files where every player is exactly 50 short, likely a map script), 33 higher (+50/+100 refunds of
  cancelled queues, which this simple model ignores, or +7 to +27 from a first drop-off before the checkpoint).
- **Villagers.** Each queued villager takes exactly 50 off value 1 at the next checkpoint (e.g. 698 → 498 after a
  4-villager queue) – it is charged when queued, not when trained.
- **Tribute (196) and market (122/123).** Consistent but not exactly testable: in 473 isolated tributes the
  receiver's value 1 rose by at least the amount in 211 and the sender's fell by at least amount + fee in 155, the
  rest being masked by gathering and spending in the same 6-125 s interval. Market trades change it by the price
  difference, which the stream does not carry.
- **Sign.** It is signed: one custom-map file starts a player at -1550. Decode as i32.
- Resolution is the checksum spacing (6-125 game seconds), so a resource graph from it is coarse.

### Not in the block

No value is population, villager count, military/economy split, kills or score: value 6 counts buildings, foundations
and livestock too, and none of the values behaves like the score (which only rises from 0). Those need either a
command-level simulation or the chapter headers' attribute arrays (population is among the 601 floats), which exist
only where a chapter was saved. The DE postgame holds no achievements block (only blocks 1 and 2 in all 661 files).

## Chat (op 4)

JSON object with `player`, `channel`, `message`, `tauntNumber`, `messageAGP` and, in 96.5 % of records,
`destinationMap` (missing in 1,590 of 45,640, 1,339 of them in build 170934). Verified over all 45,640 chats (harness):
`player` is a number in 1..8, `channel` 0..3, `destinationMap` uses only bit 0 and bits 2..9. `decodeChat` returns
`{ text, invalid: true }` for text that is not JSON or not a JSON object (never in the corpus).

### Live chat versus replayed history

The file also holds the lobby's chat history, replayed by the game, and **its `player` numbers are lobby-time
numbers, not the game's player numbers**. `markHistory` flags it:

- **`'lobby'`**: every chat before 1 s of game time. The history is replayed at the first sync (t ≈ 100-130 ms; 342
  of 346 first bursts land under 1 s); 15,323 chats (34 % of all).
- **`'replay'`**: a later re-send of that history (presumably after a rejoin), 2,346 chats at 94 instants. A chat after 1 s is a
  re-send when its `messageAGP` is empty (67.2/68 write none for history: 13,136 of the 13,137 lobby lines there are
  empty, while live lines have one), or when every field (player, channel, message, tauntNumber, messageAGP,
  destinationMap) equals a lobby line (68.9 fills `messageAGP` for history too); once two chats at one instant are
  re-sends, every chat at that instant is, because a re-send can start with lines older than the first burst kept.

Evidence that `player` is wrong for history and right for live chat, using the sender name the game drew in
`messageAGP` (only 68.9 fills it for history) matched against the header's names:

| | AGP names the header player `player` says | AGP names another seated player | sender number with no seat |
|---|---|---|---|
| lobby (68.9) | 1,471 | **430** | 125 lobby chats in all saves |
| replay (68.9) | 130 | **381** | 37 replay chats in all saves |
| live (all saves) | 21,276 | 2 (both in 68.9) | 0 (harness: every chat from a seatless number is history) |

(For the earlier checker classification by time alone, `verify-robustness/chat-agp-files.js` reproduces 426
pre-game, 375 burst and 5 live mismatches; `markHistory` reduces the live ones to 2, a single re-sent taunt and one
line of a re-sent pair whose other line differs from its lobby copy.) Senders with no seat are always history
(162/162): lobby members who left or watched, or closed-slot numbers such as 7/8 in a 6-player game.

**For history lines, identify the sender by name**: `agpSender(chat.messageAGP, names)` in 68.9, where the name can
also be a lobby member with no seat (61 lines name nobody seated); in 67.2/68 `messageAGP` is empty, so show the
sender as unknown ("lobby"). Do not map history `player` to a header player, and ignore its `recipients`. A viewer
should show `'lobby'` lines as lobby chat and drop `'replay'` lines (they repeat earlier lines).

### messageAGP

The line as the game drew it (strong, from the masked shapes of all lines): `@#` player digit, an optional
`<All>`/`<Team>`/`<Enemy>` tag, colour digit (lobby colour + 1), spaces, a platform icon tag for humans
(`<platform_icon_world>`, `<platform_icon_xbox>`), spaces, then `Name: text` (rarely `Name [suffix]: text`). AI lines
have no icon. 1,469 live human lines are instead `@#` player digit followed directly by the text, with no name.
A taunt line shows the taunt's text after the number. `agpSender` with the header's names returns the longest name
the line names (23,698 lines name one); without names it takes the text before the first `: ` and agrees in all but
46 lines, whose names contain `[`, so pass the names.

### destinationMap: the audience

`decodeChat` turns it into `recipients`, `everyone` and `notForRecorder`. All three are null when the file does not
record the audience: no `destinationMap`, or one with no recipient bits.

- **Bits 2..9** (verified): bit n + 1 = player n may receive the line. The mask is "everyone not excluded": it also
  sets the bits of **closed slots** (in 5,602 live non-everyone chats the extra bits are exactly the full set of
  absent numbers, e.g. 7 and 8 in a 6-player game: 5,512 × {7,8}, 88 × {5,6,7,8}, 2 × {8}; those slots are closed,
  type 1, in 11,376 of 11,378 cases). Guess: it also leaves out players who have left (some all-chat lines list
  only part of the seats). So intersect with the seats: `walkBody(..., { seats })` does it, after which every
  recipient is a seated player (23,401/23,401 live chats with a map). Without seats, `recipients` holds the raw bits.
  Once cut to seats, the non-everyone channel-0 lines after 1 s go to exactly the sender's team (14,554), the sender
  alone (3,003) or one other player, a whisper (2,236) (`verify-semantics/check-chat.js`).
- **`everyone`**: all of bits 2..9 set (1020). Verified against the seats: no chat has it set while a seated player
  is missing, and none reaches every seated player without it (0 and 0 over all live chats).
- **destinationMap = 1** (bit 0 only, no recipient bits) is a **save-68 artefact**: 3,032 live chats, all in save 68
  (177723: 251, 178524: 79, 179158: 187, 180059: 2,515; never in 67.2 or 68.9, harness). It is not "nobody": 378 of
  them were written by the recording player, and of the 3,040 after 1 s the `messageAGP` tags say <All> for 430,
  <Team> for 80, <Enemy> for 10 (2,512 untagged, 8 empty). Senders who had resigned do not explain it (2,585 of
  3,040 were written before the sender or the recorder resigned). Read it as "audience not recorded" and fall back
  on `channelName`.
- **Bit 0** (verified when recipient bits are set): set exactly when the recording player is not among the
  recipients. In the 735 files the owner played: 13,223 of the 13,247 live chats that do not address the recorder
  have it, and none of the 10,029 that do; the recorder's own lines never have it (2,325). 24 exceptions are
  unexplained. So the file holds every player's lines, enemy team chat and whispers included, and `notForRecorder`
  marks the ones the recording player did not get. With no recipient bits `notForRecorder` is false for the
  recorder's own lines and null otherwise (all chat does not always reach the recorder: 46 of 1,929 all-chat lines
  with a map skip them, presumably after the recorder left). In spectator recordings (meta 4 is just 1) bit 0
  says nothing useful. Bit 1 (gaia) is never set.

### channel

Verified from the tag the game drew in `messageAGP`: over all live chats with a `messageAGP`, channel 0 never has a
tag (25,213), channel 1 always `<All>` (2,370), 2 always `<Team>` (339), 3 always `<Enemy>` (49) (harness, all
files). `channelName` is `'default'`, `'all'`, `'team'` or `'enemy'`. Channel 0 is the chat line's current target
(team, a whisper, or everyone; see the recipient counts above). The tag settles the labels, not every audience:
channel 3 lines (`<Enemy>`, 49 live) mostly list the sender's own team as recipients (30 of 47 after 1 s in
`check-chat.js`), so what "enemy" chat reaches in game is still open.

### tauntNumber

A line is a taunt when `tauntNumber` ≥ 0 **and** the message's leading integer equals it; `decodeChat` sets `taunt`
to the number then, else null. The field alone misleads: in 67.2 AI chat lines carry `tauntNumber` 0 (2,982) or a
positive number (2,199) on ordinary AI text, and 5 human lines in 68 carry 0 on typed text. Every human line with
`tauntNumber` ≥ 0 and a leading number has that number (923 + 2,422 + 892 live lines in 67.2/68/68.9).

## Postgame (op 6)

Designed to be read from the end of the file:

```
op 6 | block ... block | u32 block count | u32 version (1) | 8-byte magic ce a4 59 b1 05 db 7b 43 | EOF
block = payload, u32 payload length, u32 block id
```

Verified in 661/661 files: the magic, version 1, 2 blocks, and walking the blocks backwards from the count lands
exactly on the byte after the op id.

- **Block 1, world time** (length 4): u32 game ms; equals the sum of sync increments in every file (verified, and
  enforced by `walkBody`).
- **Block 2, leaderboards**: u32 board count; per board u32 board id, u16 (1 in 1,308 boards, 257 in 2), u32 entry
  count, entries of (i32 player index, i32 rank, i32 rating). Consumed exactly in 661/661 (verified). A block that
  does not decode exactly ends the walk as `corrupt`; `pg.leaderboards` is always an array (the boards read in full).
  - The index is **player number - 1** (verified: the owner's entry on board 4 reads 946 in all 388 games under that
    mapping; under index = number it jumps by 204 on average from game to game).
  - Board ids (strong): board 3 is always present; the second board follows the game type: 4 in random-map games,
    2 in deathmatch, 14 in empire wars. That is the public leaderboard numbering (3 RM 1v1, 4 RM team, 2 DM team,
    14 EW team). Only players with a rating on that board are listed; rank is -1 for unranked players.
  - Guess: in these unranked lobbies the ratings are the players' standing ratings, not a result of this game (the
    owner's board-4 rating never moved across 388 games).

mgz's reading (reverse the remainder, skip 8, big-endian version and count) is the same layout.

## Harness results (`node test-stream.js --all`)

```
save build   files  ends                  actions  syncs    checksums  viewlocks  chats (lobby, replay, live no audience, live misattributed)  op5   chapters  postgame ok  sync ms p50/p99/max  checksum every (game s) p10/p50/p90  MB/s
67.2 170934  80     postgame 77, eof 3    2017003  4433615  8829       4359275    9042 (1323, 77, 1297, 0)                                     4062  0         77/77        50/250/250           14.0/25.4/83.7                       146
67.2 174992  17     postgame 16, eof 1    340235   643152   1278       631513     976 (495, 1, 79, 0)                                          0     0         16/16        82/250/250           17.0/46.6/125.0                      175
67.2 175278  132    postgame 122, eof 10  1857726  5489703  10914      5489703    5163 (2274, 73, 66, 0)                                       0     0         122/122      82/250/250           16.2/41.0/115.6                      168
68 177723    42     postgame 33, eof 9    638837   1722339  3424       1722339    2046 (748, 176, 259, 0)                                      0     0         33/33        82/250/250           15.1/41.0/125.0                      173
68 178524    53     postgame 45, eof 8    874490   1783981  3541       1783981    2615 (956, 255, 103, 0)                                      0     0         45/45        124/250/250          15.9/62.0/125.0                      176
68 179158    116    postgame 97, eof 19   1690009  3311795  6561       3311795    5403 (2588, 392, 187, 0)                                     0     1         97/97        124/250/250          16.5/62.0/125.0                      183
68 180059    203    postgame 184, eof 19  3593399  6578587  13052      6521150    14121 (4753, 853, 2555, 0)                                   0     1         184/184      124/250/250          16.2/62.0/125.0                      180
68.9 185872  78     postgame 66, eof 12   1405191  2510044  4978       2436133    4438 (1658, 392, 0, 2)                                       3     0         66/66        124/250/250          11.1/62.0/125.0                      195
68.9 188329  24     postgame 21, eof 3    440327   918346   1826       740856     1836 (528, 127, 24, 0)                                       0     0         21/21        82/250/250           12.3/41.0/125.0                      186
```

Chats are (lobby, replay, live with no recorded audience, live whose messageAGP names another seated player).

Robustness checkers re-run on the fixed code (`verify-robustness/`, scripts with `-v2` adapted only to the null
`recipients` and the removed chapter `expected` flag):

- `fuzz-v2.js` (22 files, 40 mutations per kind per file): no throw; every forged chapter-like op id (840/840), action
  length change (840/840), chat length change (680/680), zero-filled tail (832 corrupt, 8 truncated) and random
  garbage tail (840/840) ends `corrupt` or `truncated`. The walks that still end `postgame`/`eof` (140 op ids changed
  to another op id, 1 in 6 being the same id; 502 single byte flips inside payloads) dispatch no record the clean
  walk lacks and no action whose world time differs from the clock (0 and 0). The same run on the code before
  these fixes (`recheck/fuzz-before.js`) accepted all 840 forged chapters and ended 231 walks `postgame`/`eof` with
  a skewed clock (121 byte flips, 51 forged chapters, 27 op id changes, 19 chat and 13 action length changes).
- `cuts.js` (55 files, 93,751 cuts at and around every kind of record): no failures; every cut ends `truncated` or
  `eof` at or before the cut with exactly the records that fit (the earlier "end.at after the cut" for cuts inside
  the header is gone: `end.at` is now clamped to the data).
- `synth.js`: chat JSON `null` (and any non-object) is `invalid` instead of throwing; a postgame with 2^32-1 or
  131,072 blocks is rejected in under 1 ms (was 7 s and 104 s for 1 and 4 MB); a short leaderboard block ends
  `corrupt` with `pg.leaderboards` an array; a chapter-like op id where the prefix says none is `corrupt`; bad
  `bodyStart` values are `corrupt` at 0.
- `repro-misclass.js` (#0): a viewlock op id forged to 1, a sync step with bit 16 flipped, and a sync op id forged
  to an offset ahead all end `corrupt` at the damaged record (were `truncated` with 45 % unread, and `postgame`
  twice with a clock 65 s off and 556 skewed actions).
- `chat-attrib-v2.js --seats`: 0 of 24,437 targeted chats list a seatless recipient (5,803 without seats).

`walkBody` itself (`verify-robustness/perf.js`, the four largest files) runs at 1.1-2.3 GB/s with every handler
attached (checksum decoding and chat JSON parsing included) and 3.4-7.3 GB/s with none; an 8 MB body takes about
4-8 ms.

## Open questions

- Checksum value 9, and the exact rule for value 3 after the start.
- Op 5 (single-player only).
- Meta values 6 and 7 (always 0), and meta 3 for game types not in the corpus.
- Why save 68 writes destinationMap 1, and the 24 bit-0 exceptions.
- Whom channel 3 (`<Enemy>`) chat reaches.
- The u16 after each leaderboard id (1, rarely 257).
- The `[suffix]` some names carry in `messageAGP`.
