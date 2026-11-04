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
live source carries metadata only. A recording is written while a game runs, but only on the PC of a real game client
playing or watching it (see [Near-live](#near-live)).

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

### V1b: civ details, caster overlay, followed players (this branch)

- Civ details on hover: bonuses, unique units with their stats, unique techs and team bonus, from
  SiegeEngineers/aoe2techtree's data (MIT), built into a self-hosted `civ-info.json`.
- Caster tools: a scoreboard (title, best of N, score dots, side names, swap) and an OBS overlay at
  `/overlay/<matchId>` or `/overlay/player/<profileId>`, with a transparent background.
- Followed players: an alert when a followed profile starts a game, with links to its page and to watch it. The feed
  is snapshot-only, so expect 60-120 s latency.

See [V1b design](#v1b-design).

### V2: replay viewer (this branch)

A finished game played back on the site, from its `.aoe2record` file, read in the visitor's browser. The file comes
from the match page's **Watch this game**, which has the server fetch the official replay, or is dropped in from the
visitor's savegame folder. See [V2 design](#v2-design).

- `/replay?match=<id>`: a finished game the server still knows. `/replay`: drop or pick a file (`.aoe2record`, or
  the official ZIP holding one).
- A map of the game: terrain, starting resources, buildings and walls as they are placed, where players send units,
  and flares.
- A timeline (play, pause, speeds up to 64x, a scrubber marked with age-ups and resignations).
- Per player at any moment: resources in the bank (the game's own figure), age, units trained by type, buildings,
  techs, actions per minute, market trades and tributes. Charts over the game, the build order, the chat.
- Parser: a JS port of mgz's fast path (MIT), fixed for save versions 67.2, 68 and 68.9, which mgz doesn't cover.

### Not feasible or not appropriate

- **No public source:** live resources, population, army value, kills, fog, a live minimap or render, or live
  scrubbing. [Near-live](#near-live) covers what a real game client watching a game can supply.
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
  518428009, with no conflicting evidence), and `-56` Thracians (two AI slots, in 518465237 and 518464315, matched by
  player colour; every other slot of both games matched too). Never read them as
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
- **`civRor`:** `true` only for a Return of Rome civ labelled like a DE civ (the schema's `OldPersians` and
  `OldRomans` show as Persians and Romans), so the page doesn't show that DE civ's details. Absent otherwise. The
  lobby list's players carry it too, as `true` or `false`.
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
- **Start time:** "Started N min ago", ticking, while the game is live; once it has ended (or there is no live
  data) a clock time, "Started at HH:MM", beside "Ended at HH:MM".
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
- that `/spectate/<id>/../server.js`-style paths never serve source;
- the V1b index and player APIs, the overlay routes and `civ-info.json` (see below).

## V1b design

### API

- **`GET /api/spectate/index`:** the list cut down to what followed-player alerts need, about a tenth of its size:
  `{updatedAt, stale, games: [{id, startTime, map, players: [human profile ids]}]}`. Like the list, it has no games
  while the snapshot is stale. The browser matches its follows against it, so the follow list never reaches the
  server.
- **`GET /api/spectate/player/<profileId>`:** the same answer as `/api/spectate/<matchId>`, for the game that player
  started last, of the live games and the ended ones still kept (2 hours). The feed keeps listing a player in a team
  game they have left for as long as it runs (dozens of players are in two live games at once), so a live game older
  than one they have since finished isn't theirs any more. No such game, or a stale snapshot (which can't tell what
  they're playing), is `unknown`. Profile ids are 1-12 digits; anything else is a 404 JSON `{error}`.
- **`/overlay/<matchId>` and `/overlay/player/<profileId>`:** serve `overlay.html` (`noindex`, `no-cache`); anything
  else under `/overlay/` is a 404. `overlay.js`, `overlay.css` and `civ-info.json` are public files.

### Civ details

- `tools/build-civ-info.js` (no dependencies) reads aoe2techtree's `data/data.json` and English `strings.json` at a
  pinned commit, and writes `civ-info.json`, about 43 KB: per civ, its type, bonuses, unique units (with base
  cost, HP, attack, armour, range, speed and training time), unique techs and team bonus. It is keyed by the data's
  civ key, which is the name the feeds use ("Incas", where the help text says "Inca"). It also carries
  aoe2techtree's MIT licence text. Rerun it and bump the commit after a game update; `app.js` fetches the file
  unversioned, so visitors get the new one within a day (the server's cache time for unversioned files).
  - A unit's name is string `LanguageNameId + 9000`, sometimes split over lines; a few newer units use
    `LanguageNameId` itself. A unit with modes (Ratha) stands in with the mode that fits its class.
  - The help text wraps some bonuses over two lines: a line without a "•" continues the bullet before it.
- `app.js` loads it once. A civ it covers becomes a button chip on lobby cards, Spectate cards and match pages:
  hovering previews the details; a click, tap or Enter pins them and moves focus into the popover (so a keyboard can
  scroll a long one); Escape, Tab or a click elsewhere closes them. The popover stays inside the viewport and follows
  its chip, found again by civ and player, through redraws and as cards move. Civs without data (the Chronicles
  civs, and `civRor` civs) stay plain chips.

### Followed players

- A star next to each human player (Spectate cards, match pages) follows them. Follows live in local storage
  (`aoe2Follows`: up to 100 `{id, name}`, plus the desktop notification choice) and sync across tabs.
- While the site is open, a tab with follows fetches the index every 60 s (a hidden tab only when it may show a
  desktop notification) and alerts for each game with a followed player that it hasn't announced yet. Announced
  games, and when the tab last checked, are kept in memory and copied to session storage (`aoe2Alerted`,
  `{checkedAt, ids}`) for reloads and for a page back from the back/forward cache (which also picks up follows and
  caster settings changed meanwhile), so blocked storage doesn't repeat alerts within a page. A tab's first check,
  or one more than 5 minutes after its last, announces the games it finds as games players are in, as one summary
  when several players are in them; later checks announce games as started. A player just followed, in this tab or
  another, isn't announced for the game they're already in (the games known then are marked at once, and the rest at
  the next check if it comes within 3 minutes, so a much later check still announces their new game). A match page
  never announces its own game. A check that finds more than three new games announces the three newest, plus a
  line for the rest.
- Alerts are toasts (a polite live region, at most four) with **Open game** and **Watch in game**, and optionally
  desktop notifications (`Notification`, after the visitor allows it) while the tab is in the background. Turning
  them on shows one straight away; a browser that can't show them from a page (Chrome on Android) is told so, and
  they stay off.
- The Spectate view shows a panel of followed players, who of them is in a game (linked), and unfollow buttons.
  The Games filter has "Followed players only". A summary alert's "See their games" opens it, with the other
  spectate filters (type, server, search) cleared so no followed game is hidden.

### Caster tools and overlay

- A collapsed **Caster tools** panel on the match page sets what the overlay shows (this game, or the game a chosen
  player is in), a title, best of 1-15, each side's wins (capped at the wins needed), side names and a swap. It
  writes the overlay link, with Copy and Preview (`?preview=1`, a dark backdrop). Settings stay in local storage
  (`aoe2Caster`), so between games the caster only changes the score and copies the link again. They are saved
  only when the caster edits them: opening another game's page doesn't change them. A followed player who isn't in
  that game is shown as "this game" there, and stays the saved choice through other edits until the caster picks
  what the overlay shows on that page. The score never changes by itself.
- The overlay reads `bo`, `s` (`left-right`), `l`, `r`, `t` and `swap=1` from its query string and polls the match or
  player API (30 s, or 20 s while a result is pending). A match overlay stops once its result is in; a player overlay
  keeps the last game on screen until their next one starts. Following a player keeps their side on the left from
  game to game. A game with more than two sides lists every player without a score (and names a winner by their
  own names, never the side names). The winning side is the result's team; without one, the one side holding
  winners, or the AI's side when the AI won ("The AI won" when that isn't one side). While the feed is down, a game
  that may still be on says "No live data"; an ended one keeps its result.
- Known limits of following a player: an ended game is kept for 2 hours (and not across a server restart), after
  which a game they left that is still running counts as theirs again; and while the feed is down, the overlay
  can't tell what they're playing, so it keeps what it shows (an ended game's result is not looked up then).
- Everything from the feed or the URL is put in with `textContent`. The page has no analytics and no site chrome.

### Checks

`qa/spectate-match-check.js` also checks:

- the index's shape, that it matches the list, and its size;
- a player's game, an unknown player and malformed profile ids;
- the overlay routes, their headers, and 404s for everything else;
- that `civ-info.json` is served and well formed, while the build script and docs are not served. It prints the
  civs in play that have no details.

## V2 design

### Why a replay, and what it can show

A recorded game is the list of what each player ordered, with the game time of each order. The game works out what
happened (units walking, fights, gathering) by running its own engine on those orders, so nothing outside the game
can replay the simulation itself. What the file does carry, and the viewer shows:

- **Exact:** the map (terrain, elevation, every starting tree, mine, relic and animal), the players (name, civ,
  colour, team), every order with its time (buildings and walls placed where, units and techs queued, where units
  were sent, market trades, tributes, flares, resignations), the chat, the moment each player reaches an age (the
  game announces it as a chat line), each game's building footprints, and, every 500 game steps, each player's
  resources in the bank (food, wood, gold and stone added together) and their number of objects (units, buildings,
  walls and foundations). Those samples are 6 to 125 game seconds apart, about once a minute in a big game, so the page
  says how old the bank figure is.
- **Estimated, and labelled so:** resources spent (each order's base cost, before civ bonuses; an order the game
  refused still counts), units trained (queued, not necessarily finished). A cancel names only a queue slot, so it
  takes back the newest order standing at that building, within 10 game minutes. Working the slot out from train times
  did worse, because when an order leaves the queue isn't known. An age line proves its click stood, so it undoes a
  cancel that took that click, and takes the unit it passed over instead.
- **Not available:** where units are, fights, kills, units alive, villagers per resource, the bank split by resource.

### Loading a file

- `/replay` serves `replay.html`. The visitor drops a file or picks one: an `.aoe2record`, or the ZIP from the match
  page's **Download replay** (one `.aoe2record` inside, stored or deflated).
- The page reads the file into memory and hands it to a worker (`replay-worker.js`), which parses it with
  `replay-parse.js` and returns the model below. The header is raw DEFLATE; the worker inflates it with
  `DecompressionStream('deflate-raw')`, stopping at 128 MB. Files over 64 MB are refused.
- A dropped file is sent nowhere: the page's only request for it is `/replay-data.json` (names, costs, terrain
  colours). Everything from a file goes into the page with `textContent`.

### Fetching a replay

The owner lifted the rule against the server fetching replays on 4 Nov 2026, within these limits. It stops the
visitor having to download a file and drop it in, which is how aoe2insights works too.

- `GET /api/replay/<matchId>` takes only a match id. The game must be one this server has seen end, within the 2 hours
  it keeps them, and the link is built from that game's own result: `https://aoe.ms/replay/?gameId=<id>&profileId=<the
  largest uploader>`. Nobody can point it at anything else.
- The link redirected to `api.ageofempires.com`, which served the ZIP itself (`application/zip`), when tested on a
  real game. Whatever it redirects to is never logged or kept, and `matchurls[].url` is still never touched.
- The answer is the ZIP (`no-store`, `noindex`), read in the browser like a dropped file. Errors are JSON
  `{error}`: `live` (409), `pending`, `none`, `unknown` (404), `busy` (429, `Retry-After`), `failed` (502).
- Limits: 32 MB a file, 30 seconds, 30 downloads a minute. Files stay in memory for 30 minutes, 64 MB in all, and two
  requests for one game share a download, so a shared game costs one fetch. Nothing is written to disk.
- An official download has no closing record and was recorded by a player, so it looks like a running game of the
  visitor's own to the [lock](#live-follow). It's safe to open, because the server only serves games that have ended,
  so the page dates the file long ago to pass that check.

### Parser output

`ReplayParse.parseFile(bytes, inflateRaw, onProgress)` resolves to:

```js
{
  // complete: the body ran to its end. watched: true, false, or null with too few steps to tell (see Near-live)
  file: { game: 'VER 9.4', save: 68.9, build: 188329, complete: true, steps: 24968, watched: false },
  startedAt: 1793696458,                 // unix seconds, or null
  duration: 2909034,                     // game milliseconds (the in-game clock)
  settings: { map, mapSize, dimension, rmsMapId, speed, population, infiniteResources, turbo, treaty, lobby, mod,
              rated, hiddenCivs },                // speed 'Normal' | 'Fast' ...
  // startingAge 'dark' ... 'postimperial', per player: a "Standard" start can differ between players and modes
  players: [{ number, name, profileId, civId, color, team, human, startingAge, start: { x, y }, rating }],
  map: { dimension, terrain: Uint8Array, elevation: Uint8Array },          // row-major, dimension * dimension
  gaia: { gold, stone, relic, tree, forage, fish, herdable, huntable },     // flat [x, y, x, y, ...] arrays
  startObjects: [{ player, unit, x, y }],
  sizes: [{ [buildingId]: tiles }],      // this game's footprints, by player number (0 is gaia)
  events: [{ t, p, k, ... }],            // what the viewer uses, sorted by t (kinds below)
  apm: { [player]: [actions in minute 0, minute 1, ...] },
  stats: { [player]: [[t, bank, objects], ...] },
  chat: [{ t, p, text, audience }],
  warnings: []
}
```

Event kinds: `queue {unit, n}`, `research {tech}`, `age {age, label}`, `build {unit, x, y}`,
`wall {unit, x1, y1, x2, y2}`, `move | attackMove | patrol | attackGround | order {x, y, n, work?}` (n units
selected; `work` is an order onto a resource), `flare {x, y}`, `buy | sell {resource, amount}`,
`tribute {to, food, wood, gold, stone}`, `resign {}`. Coordinates are tiles. Cancelled orders are already taken out.

Facts worth keeping (each was measured on 745 replays; the byte layouts are in [replay-format](replay-format/)):

- Tiles are stored row by row: tile (x, y) is index `y * dimension + x` (100% of 911,105 trees sit on forest tiles
  that way, 33% the other way round). The map draws tile (0, 0) at the left corner, x up to the top corner and y down
  to the bottom, as RecAnalyst's minimap does (a square image of the tiles, rotated 45 degrees counter-clockwise).
- One train order lists every selected building, but trains `amount` units in total, not per building: reading it
  per building would need players to gather about 47,000 resources in 15 seconds.
- Age lines arrive a median of 130, 160 and 190 seconds after the click, the game's research times. The line's text
  is in the recorder's language, and typed chat can copy it, so the parser tells them by `messageAGP`'s tag and
  counts ages in order.
- AI commands are in the file. Actions per minute count humans only, leave out what the client sends by itself, and
  count a mass delete, town bell or tribute once per instant, because one key press sends a record per object.
- Limits refuse a file that holds far more than a real game does (in `replay-parse.js`, with the largest real values
  beside them), and long lists stop at 100,000 rows, above the largest real one (88,005 market rows).
- Infinite-resource games read a bank of 0 throughout, and a bank can dip below 0.

### Near-live

Researched on 4 Nov 2026, after the first version of this plan called live stats impossible. Following a game on your
own PC is built, as [Live follow](#live-follow); the other routes aren't.

- **It exists elsewhere.** [aoe2recs.com](https://aoe2recs.com/), the Spectator Dashboard, shows games in progress
  with each player's current age, their top three units and the in-game chat, updating live, for about seven games at
  a time, nearly all with top-rated players. It shows no resources, unit positions or live map. It doesn't say how it
  works; in-game chat is in no public API, so the data almost certainly comes from real game clients watching those
  games. A community catalog infers the same, and the small number of games fits one client per game.
- **What the files show.** Every one of 744 replays was created when its game started and last written when it
  ended, including the 9 the account only watched. A watched recording holds the game from its first second even when
  the watcher joined late, in the same format as a played one, so `replay-parse.js` reads it. It parses in about
  150 ms, and it reads a file that stops mid-game.
- **Proven on a running game (4 Nov 2026):** the file grew by about 1.3 KB a second with its last-write time current,
  and `replay-parse.js` read it while the game was writing it, in about 100 ms a read. Between reads 8 seconds apart the
  game clock, the orders and the bank rows all moved on. That game was one the account played, so a watched game's
  file growing the same way is still to be confirmed.
- **Routes:**
  - Follow on your own PC: the page re-reads the growing file (File System Access API, Chrome and Edge). Only useful
    to someone with the game open. Built.
  - A spectator PC: a PC or Windows server running the real game watches chosen games and uploads the recording, so
    any visitor can follow in the browser with no game. One game per running copy; it needs a game licence and account,
    and the game's terms must be checked before automating it.
  - Ask aoe2recs' operator for permission to use their live feed: top games only, and only what they show.
- **Hard rule:** a recording of a game you're playing holds every player's orders with no delay, so a live view of it
  would be a cheat tool. Any live feature must refuse those games.
- **Still impossible on a website:** unit positions, fights and kills need the game's engine. CaptureAge has them by
  running the real game on the same PC.

### Live follow

- **Flow:** on `/replay`, in a browser with `showDirectoryPicker`, the visitor picks their savegame folder. The page
  takes the newest `.aoe2record`, which must have been written within a minute, reads it every 6 seconds while it
  grows, and re-parses it whole (about 100 ms). Nothing leaves the browser.
- **The whole game is there.** A recording holds the game from its first second, so the view can run **From the
  start** at any speed and catch up, and **Go live** returns to the newest moment. At the newest moment each read moves
  the playhead along; anywhere else it stays put and says how far behind it is. The tab, chosen player, map position and
  scroll position survive each read.
- **The newest moment is the watcher's.** It trails the real game by the lobby's spectator delay, which this page
  doesn't change.
- **The lock.** A player's client writes a camera record at every step, the first within 124 ms; a watching client
  writes none. So `file.watched` is false once a file has one camera record, true after 10 steps without any, and null
  before that, because a read can land between a step and its record. Of 746 replays this refuses all 727 real games
  the account played in real time and allows all 9 it watched. Three more are allowed: the account is seated in them,
  but they have no camera records and were written faster than the game's speed (2.75 to 4.19 game seconds a second),
  so nobody was playing them in real time. They look like a client catching up.
- The lock is checked on every read, before anything reaches the page, and on the ordinary file drop too: an
  unfinished file written in the last 5 minutes with camera records is refused. It is a rule of this page, not
  security: the game's own players are protected by the game, and the page's code is public.
- A read can fail when the game writes during it, so it retries, and gives up after three failed polls. A file with no
  new data for 10 minutes ends the follow, and the closing record ends it at once. What's on screen then stays as a
  replay of the game so far.

