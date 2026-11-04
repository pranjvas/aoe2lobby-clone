# The AoE2: DE replay format

The byte layouts `replay-parse.js` reads, for save versions 67.2, 68 and 68.9 (April to November 2026), which mgz
doesn't cover. They were measured on 745 replays and each part checked independently.

- [header.md](header.md): the start of the file through the map tiles.
- [objects.md](objects.md): players' starting state, every starting object, and the map's name.
- [actions.md](actions.md): every player command.
- [stream.md](stream.md): the body, the per-player figures in its checksum blocks, chat and the postgame.
- [data.md](data.md): how `replay-data.json` is built.

These notes name the one-off scripts the measurements came from (`test-*.js`, `explore/`, `verify-*/`). They aren't
in this repository: the replays they ran on hold other players' names and chat, so nothing here depends on them.
To recheck after a game update, run `node qa/replay-check.js parse <savegame folder>`.
