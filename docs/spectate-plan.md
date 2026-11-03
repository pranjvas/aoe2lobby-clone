# Spectate on aoe2lobby.online: plan and V1 design

## Ground rule: public data only

The site's spectate features use public data only:

- the aoe2lobby.com spectate feed (match metadata);
- the World's Edge community API (`aoe-api.worldsedgelink.com/community`: match history, replay files);
- aoe2companion's public match API;
- `aoe.ms` replay links.

Never use CaptureAge's code, formats (`.caderec`), keys or certificates, its local gRPC API (CadeRemote), or the
authenticated Game API or relay. CaptureAge's rich live view comes from a locally running, signed-in game client
streaming its own simulation; no public source carries live game state (positions, resources, kills). Every public
live source carries metadata only, and replays exist only after a game ends.

So spectating on the site has two halves:

- **While a game runs (V1):** a rich match page that hands off to the game client (`aoe2de://1/<matchId>`).
- **After it ends (V2):** analysis built from the public `.aoe2record` replay.

Every request to an external service goes through `server.js`, because the CSP is `connect-src 'self'`.

## Roadmap

### V1a: match page (this branch)

1. `/spectate/<matchId>`: one page per game in progress, linked from every Spectate card. It shows:
   - teams with player colour, name, country, civ (hidden when the lobby hides civs) and rating;
   - map, mode, size, speed, population, server and mod;
   - elapsed time, the spectator delay explained correctly, and the spectator count;
   - **Watch in game** (`aoe2de://1/<id>`, needs a click) and **Copy link**.
2. Feed fixes:
   - honour `hide_civilizations`;
   - label the civ ids the feed's schema doesn't cover;
   - classify slots as human, AI or closed;
   - send `country` only where it is shown.
3. Game-ended handoff: when a game leaves the feed, its page switches to *Ended* and shows the winner, rating
   changes, duration and a replay download link (`aoe.ms`) once the World's Edge API has the result.
4. Per-match `<title>`, description and Open Graph tags, served by `server.js`, so shared links preview well.
   Match pages are `noindex` because they only live for a game's length.

### V1b: next

- Civ tech-tree and unit stats on hover, from SiegeEngineers/aoe2techtree `data.json` (MIT, self-hosted).
- Caster tools: a scoreboard (best of N, score dots, name overrides) and an OBS overlay route
  `/overlay/<matchId>` with a transparent background.
- Followed players: an alert when a followed profile starts a game, with a one-click spectate link. The feed is
  snapshot-only, so expect 60-120 s latency.

### V2: post-game analysis from the public replay

- Server pipeline: `getReplayFiles` (batches of 10 or fewer, under about 120 requests a minute). Use each signed
  URL straight away and never log or store it. Gunzip the file, parse it in Node, and cache the result per match.
- Parser: `aoe2rec-js` (WASM, fastest path to current-patch support) or a JS port of mgz's fast path (MIT,
  patchable). First prove that current-build recordings parse.
- Features, in priority order:
  - exact age-up times;
  - a build-order timeline;
  - eAPM per minute;
  - units and techs queued;
  - market and tribute logs;
  - the chat log (public matches only);
  - a minimap of building placements;
  - playback with `?t=` share links.
- Label every estimate (unit paths, idle time, army counts) as an estimate.

### Not feasible or not appropriate

- **No public source:** live resources, population, army value, kills, fog, a live minimap or render, or live
  scrubbing.
- **Fairness:** watching your own live game.
- **Licensing:** the game's sprites and sounds, unless the Game Content Usage Rules clearly allow them.
- **Auto-launching:** opening `aoe2de://` without a user gesture.

## V1a design

### Data sources and facts (verified live, 2026-11-03)

- **aoe2lobby.com spectate feed** (`wss://aoe2lobby.com/ws/spectate/`): about 470 games per snapshot, unauthenticated.
  Settings sit flat on each match (`map_name`, `mode`, `size`, `speed`, `population`, `server`,
  `hide_civilizations`, `record`, `observer_delay` in minutes, `observers`). `slots` is an object.
  `observer_delay` is 2 for matchmaking and 0-10 for custom lobbies.
- **World's Edge `getRecentMatchHistory?profile_ids=[id]`**: a finished game appears within minutes. Match it by
  `id === matchId`, with `startgametime === start_time` as a check. It has no CORS headers, so it is called from
  `server.js` only.
- **`aoe.ms/replay/?gameId=<id>&profileId=<pid>`**: redirects to a ZIP holding the `.aoe2record`. A plain top-level
  link works (the CSP does not apply to navigation). Use it only for a player whose replay size is above 0.
  `record: false` is the host's own setting, not the lobby's: in 518418201 (`record: false`) only the host's row is
  `-1` and the other five players uploaded, so it doesn't hide their replays.
- **aoe2companion `/api/matches?profile_ids=`**: resolves civs the feed doesn't label. Search `matches[]` by id;
  never assume `matches[0]`.

### Feed rules (from a live snapshot of 444 games, 2026-11-03)

- **Slots:** classify each slot by `slot.status`, using the schema's labels (0 Open, 1 Closed, 2 AI, 3 Player).
  - `3` is a human. `profileid` is always a positive integer. A few have no name: show `Player <id>`, never "AI".
  - `2` is an AI. It has no `profileid`, name, country or Steam fields, but it does have a civ, team and colour.
    The match-level `ai` flag is true exactly when a game has one.
  - `1` is a closed slot (custom lobbies list all 8 slots). Its team and colour are null and its civ is a dummy
    value, so skip it. `0` (open) never occurs in running games; skip it too.
  - **Fallback when `status` is missing:** a positive `profileid` means human; otherwise a set team and colour
    mean AI; otherwise the slot is closed.
  - **Names never decide AI:** some humans are called things like "D-Computers".
- **Teams:** `team` 1 means "no team" (custom games and free-for-all), and 2-5 are Teams 1-4 (display as
  value - 1). Matchmaking always uses 2 and 3.
- **Colours:** `color` is 0-7, which is player colour 1-8 (Blue, Red, Green, Yellow, Teal, Purple, Grey, Orange).
  No two players in a game share one.
- **Hidden civs:** `hide_civilizations` games still carry the **real** civ picks, so the server must drop them
  (`civ: null`, `civsHidden: true`) for those games, or the page would reveal them.
- **Countries:** ISO-2 codes in mixed case, so lowercase them. A few are null or missing.
- **Counting players:** count 1v1 versus team from human and AI slots. `slots_taken` and `slots_total` are
  unreliable.
- **Matchmaking queues:** every matchmaking game has `description` `AUTOMATCH`.
  - A negative `match_typeid` (-18 to -21, -51) is a **Quick Play** queue, the raw Relic id negated (aoe2companion:
    `qp_rm_1v1`, `qp_vs_ai`). These games are not ranked: title them "Quick Play". They change a Quick Play rating
    that none of the feed's ladders (0/3/4/13/14) carries, so `ladder` and each player's `rating` are `null`.
  - A positive `match_typeid` is a ranked queue (the schema's table).
  - A few ranked games arrive with `mode` and the other settings null. They take the ladder from the queue:
    5/16 RM 1v1 (3), 6-8/17-19 RM team (4), 10/20 EW 1v1 (13), 11-13/21-23 EW team (14). Any other queue gets
    `ladder: null`, never the unranked ladder.
- **Duplicate listings:** a player can be listed in two games at once (after leaving an older one), so a listed
  game is not guaranteed to be anyone's current game.
- **Unlabelled civs:** `-61`, `-62` and `-63` are the only civ values the schema doesn't label (about 3% of
  slots, ranked games included), plus a rare `-57`. They look like raw ids of civs newer than the schema's table,
  negated, in the same way negative `mapid`s are `-Number(map_name)` (raw match-history `civilization_id` 61 and
  62 are Saxons and Varangians).

- **Civ table** (checked against aoe2companion across ranked, custom, Quick Play and vs-AI games): `-61` Saxons,
  `-62` Varangians, `-63` Danes (25 of 25 consistent over two snapshots), and `-57` Puru (seen once, an AI slot in
  518428009, with no conflicting evidence). `-56` has not been seen yet, so it stays unlabelled. Never read them as
  `abs(id)`, because the schema's 57 and 61-63 are Return of Rome civs. scraper.js labels lobby players with the
  same table, so the lobby list names these civs too.
  The schema's `15` "Aztec" is shown as "Aztecs", and its Return of Rome internal names `58` "OldPersians", `62`
  "OldRomans" and `66` "LacViet" as "Persians", "Romans" and "Lac Viet" (in the lobby list too).
  - Any other unlabelled id shows as `Unknown civ` and is logged once, so the table can be updated by hand.
  - A live aoe2companion lookup fallback, in the style of `resolveMapNames`, is a follow-up if new civs ever appear
    without a schema update.
- **Player colours (1-8):** `#405BFF` Blue, `#FF0000` Red, `#00FF00` Green, `#FFFF00` Yellow, `#00FFFF` Teal,
  `#FF57B3` Pink, `#797979` Grey, `#FF9600` Orange (aoe2companion's `colorHex`).

### Post-game rules (World's Edge `getRecentMatchHistory`, 10 tracked games and 307 matches of history)

- **Finding the game:** `matchHistoryStats` is not sorted and holds old games, so find the entry with
  `id === matchId`. `startgametime` equalled the feed's `start_time` in 9 of 9 games: require it.
- **Timing:** a finished game appeared 11 s after `completiontime` in the one direct measurement, and rating
  changes are filled in from the first appearance.
  - Poll from the game's end: wait at least 20 s between attempts for the first 3 minutes, then at least 60 s.
  - Give up 15 minutes after the first lookup (normally right after the game left the feed), so a game first asked
    for later (a shared link, a tab that was hidden) is still looked up.
- **Winner:** `matchhistorymember[].outcome === 1` means a win, and 0 a loss. It agrees with
  `matchhistoryreportresults[].resulttype`. Every ranked game had exactly one winning team.
  - Custom lobbies can have several winning team ids, everyone winning (co-op) or nobody winning.
  - Show a winning team only when every winner has the same feed team and no loser shares it. Otherwise list the
    winning players, or "No result reported" when nobody won.
  - AI players have no rows, so in a game with AI opponents (AI not on a human's team) where no human won, the AI
    won (`aiWon`): every probe vs-AI game with no winning row is one where every human lost (aoe2companion
    `won: false`). Show the AI's team when the AI opponents share one ("Team 4 (AI) won"), else "The AI won".
- **Teams:** Relic `teamid` has no fixed offset from the feed's team, so join players by `profile_id` and label
  teams with the feed's team numbers.
- **Rating change:** `newrating - oldrating`. Unranked custom lobbies change a separate **unranked** rating, and
  Quick Play games a **Quick Play** rating, so label them as such. AI players have no rows.
- **Relic civ ids:** `civilization_id` uses different numbering from the feed. It isn't needed, so don't map it.
- **Replay:**
  - A `matchurls[]` row with `size > 0` means that player uploaded a replay. `-1` or no row means none, and `-1`
    is not a temporary state.
  - Link `https://aoe.ms/replay/?gameId=<id>&profileId=<pid>`, using the uploader with the largest size. It
    redirects (301) to `api.ageofempires.com`'s ZIP download.
  - Never fetch or link `matchurls[].url`: it returns 409 without a signed query string.
  - The feed's `record: false` doesn't hide the link (see above). With no upload, such a lobby says it didn't
    record a replay.

### Current bugs this branch fixes (server.js)

- AI players are dropped, because slots without a `profileid` or name are skipped.
- Nameless humans are shown as "AI".
- Unlabelled civ ids become `null`.
- `hide_civilizations` is ignored.
- `team` and `color` are passed through raw (1 means no team; colours are 0-based).
- The ladder is chosen from `players.length`, which excludes AI.

### API

`GET /api/spectate`: the list. Its game objects have the same shape as `game` below, with these differences:

- `country` is dropped, because the list doesn't show it;
- `civsHidden`, `record` and `endedAt` are included, so the list and detail stay one shape;
- AI players are now included, with `kind: "ai"`.

Player fields are the same in the list and the detail:

- **`kind`:** `human` or `ai`.
- **`team`:** the display team, 1-4, or `null` when the player has no team (free-for-all and some custom games).
  Raw feed team 1 becomes `null` and 2-5 become 1-4.
- **`color`:** the display colour, 1-8, or `null`.
- **`civ`:** the civ name, `"Unknown civ"`, or `null` when `civsHidden`.
- **`id` and `name`:** an AI has `id: 0` and `name: "AI"`. A nameless human is `Player <id>`.
- **`rating` and `ratings`:** for humans only. An AI has `rating: null` and `ratings: {}`. `rating` is the game's
  own `ladder`, and `null` when `ladder` is (Quick Play).
- **`steamProfile`:** humans only, when present.
- **`country`:** in the detail only, as a lowercase ISO-2 code or `null`.

`GET /api/spectate/<matchId>` (digits only): one game.

```json
{
  "status": "live | ended | unknown",
  "updatedAt": 1793695667,
  "stale": false,
  "game": {
    "id": 518421824, "title": "Ranked match", "isRanked": true, "isQuickPlay": false, "map": "Arabia", "matchType": "Random Map",
    "mapSize": "Tiny (2 player)", "speed": "Normal", "population": 200, "server": "India", "modInfo": "No Mods",
    "startTime": 1793695658, "observerDelay": 2, "observers": 3, "ladder": "3", "civsHidden": false,
    "record": true, "endedAt": null,
    "players": [
      { "id": 123, "name": "Player", "kind": "human | ai", "team": 1, "color": 1, "civ": "Franks",
        "country": "in", "steamProfile": "https://steamcommunity.com/profiles/7656...", "rating": 1234,
        "ratings": { "0": 1100, "3": 1234 } }
    ]
  },
  "result": null
}
```

When `status` is `ended`, `result` becomes the following:

```json
{
  "state": "pending | found | unavailable",
  "completedAt": 1793697000, "duration": 1342,
  "winningTeam": 1,
  "noWinner": false,
  "aiWon": false,
  "ratingKind": "ranked | quickplay | unranked",
  "players": [ { "id": 123, "won": true, "oldRating": 1234, "newRating": 1250 } ],
  "replay": { "available": true, "profileId": 123 }
}
```

- **While `pending` or `unavailable`:** every field except `state` is `null`.
- **`winningTeam`:** the display team, or `null` when the winners don't form one feed team. The page then lists the
  winning players.
- **`noWinner`:** `true` when nobody won.
- **`aiWon`:** `true` when the AI side won (no human won, and the game has AI opponents). `winningTeam` is then the
  AI's display team when they share one, else `null`, and `noWinner` is `false`.
- **`players`:** human players matched by `profile_id`.
- **`replay`:** `available` is `false` when nobody uploaded a replay. The page builds the link
  `https://aoe.ms/replay/?gameId=<game.id>&profileId=<replay.profileId>`.

- **`unknown`:** the server never saw the game, for example after a restart or a wrong link. `game` and `result`
  are `null`. With `stale: true` it only means the server has no usable live data (no snapshot, or one over 10
  minutes old), so it can't tell: a game of a stale snapshot is never reported `live`.
- **`pending`:** the result is still being looked up. The page polls again.
- **`unavailable`:** the lookup gave up, about 15 minutes after its first attempt. The page says the result
  couldn't be found in the match history.

### Server behaviour

- One shared freshness rule: `/api/spectate` and `/api/spectate/<id>` both refresh the snapshot on demand, at most
  once a minute, as today. Nothing polls on its own. A snapshot over 10 minutes old is stale: the list shows no
  games, and the detail and the page tags treat its games as `unknown`.
- **Implausible snapshots:** a snapshot with no games, or with under half the games of a fresh previous one, is a
  feed glitch (hundreds of games are always in progress). It counts as a failed refresh, so it ends no games.
- **Ended games:** on each refresh, games that were in the previous snapshot and are missing from the new one move
  to an `endedGames` map, with `endedAt` set to the new snapshot's time. Entries are kept for 2 hours, capped by
  count.
- **Result lookup:** triggered only by a detail request for an ended game.
  - Only one request runs for each game. Two lookups for a game are at least 20 s apart for the first 3 minutes
    after `endedAt`, and at least 60 s apart after that.
  - Across all games, at most one World's Edge request runs at a time, requests start at least 1 s apart, and at
    most 30 start per minute. A request that would break these limits is skipped, and the result stays `pending`.
  - Retries rotate across the game's human players. A game with no human players settles as `unavailable` at once.
  - A settled result is cached. The lookup gives up about 15 minutes after its first request (a game no request
    has been made for yet is never given up on unasked).
  - Every upstream number is validated. Signed URLs are never requested, logged or returned.
- **`/spectate/<matchId>`:** serves `index.html` with these tags replaced, all with escaped feed text:
  - `<title>`;
  - the description;
  - the canonical link;
  - `og:title`, `og:description` and `og:url`;
  - an added `<meta name="robots" content="noindex">`.

  Asset URLs in `index.html` are root-absolute, so the page works at any path.
- **Validation:** match ids are digits only, and their length is capped.

### Frontend behaviour

- `app.js` detects `/spectate/<id>` at start-up and shows the match view in place of the lists. The Lobbies,
  Players and Spectate buttons go back to `/`, opening the chosen view.
- **Polling:** every 30 s while the game is live, and every 20 s while its result is pending. It stops once the
  result is `found` or `unavailable`, or the game is `unknown`, and pauses while the tab is hidden.
- **No live data** (`unknown` or `live` with `stale: true`): the page keeps polling and says the game can't be
  checked yet, never "not found". A game already on screen stays, as last seen live, without the LIVE pill,
  spectator count, delay countdown or Watch in game.
- **Teams:** teams are grouped by `team`. Each `team: null` player gets a card of their own, labelled "No team".
  The Spectate list cards use the same grouping, so free-for-all games are no longer lumped into "Team 1".
- **Player rows:** a colour swatch, the name (AI shows as "AI"), the civ or "Hidden", the country badge, the
  rating, and the AoE2Insights and Steam links for humans. The ratings are the game's own ladder (not Elo Type, which
  the Spectate cards follow), so the page names it visibly ("Ratings: RM 1v1"), not only in a tooltip.
- **Result panel:**
  - the winner (a team or the winning players);
  - Won or Lost for each player;
  - the rating change, labelled "ranked", "Quick Play rating" or "unranked rating";
  - the game length;
  - **Download replay**, a plain link to `aoe.ms`.
- **Spectator delay:** worded as "Spectators watch about N min behind the live game". While elapsed time is under
  the delay, a countdown shows when the delayed stream starts.
- **Copy link:** uses the Clipboard API, falling back to selecting the text.
- **Focus:** a poll rebuilds only the parts that changed, and a rebuilt part gives focus back to the same control
  (or the part's first one when it is gone, like Watch in game once the game ends).
- **Card links:** every Spectate card links to its match page.
- **Country:** shown as an uppercase code badge with the full name as a tooltip (`Intl.DisplayNames`). Flag emoji
  don't render on Windows.

### Checks

`qa/spectate-match-check.js` starts nothing. It runs against a running server (`BASE=http://127.0.0.1:3002` by
default) and checks:

- the list API;
- a live game's detail API;
- an unknown and an invalid id;
- that `/spectate/<id>` returns HTML with an escaped per-match title, canonical and `noindex`;
- that `/spectate/<id>/../server.js`-style paths never serve source.
