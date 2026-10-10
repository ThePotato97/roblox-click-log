# roblox-click-log

Stores every click players make in a Roblox experience and rebuilds each
player's journey from them. The Roblox side (`ClickLogController` on the client,
`ClickLogSink` on the server) lives in the game's own repo; this is the server
it posts to. You can read the result yourself, or hand it to Claude to analyse.

```
ClickLogController (client)  every GuiButton activation + world tap, batched every 5s
        │ analytics.clicks (Remo)
        ▼
ClickLogSink (game server)   + every design event, funnel step, session start/end/teleport
        │ HttpService POST /ingest, gzip, every 10s
        ▼
click-log-server (this)      ClickHouse  →  /report, /paths, /journeys, analyze CLI
```

There are no dependencies. It runs on **Bun** (1.4+) and talks to
**ClickHouse** over its HTTP interface. Every event is kept, compressed in
columns; journeys, paths and the report are computed in SQL when you read them
(the way Umami and Rybbit do it), so a week reads in seconds and nothing has to
be rolled up or expired.

## Run it locally (Studio playtests)

```sh
clickhouse server  # or any ClickHouse on 127.0.0.1:8123 (https://clickhouse.com/docs/install)
bun start          # http://127.0.0.1:8787
```

Then press Play in Studio. Studio sends to `http://localhost:8787/ingest` with
the token `local-dev`, which is also this server's default when it runs on
loopback, so there's nothing to configure. Game Settings → Security → **Allow
HTTP Requests** must be on (it already is). If the server isn't running,
Studio's sink just retries quietly.

```sh
npm test           # starts a throwaway ClickHouse in Docker
CLICKHOUSE_URL=http://127.0.0.1:8123 npm test   # or uses yours (each test makes its own database)
```

| env | default | |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | `0.0.0.0` to expose it; then `INGEST_TOKEN` is required |
| `PORT` | `8787` | |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | |
| `CLICKHOUSE_DB` | `clicklog` | created on start, with its `events` table |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | |
| `INGEST_TOKEN` | `local-dev` on loopback | bearer token the game sends |
| `READ_TOKEN` | `INGEST_TOKEN` | bearer token for `/report` and `/journeys` |

## Live servers (optional, later)

Live Roblox servers can't reach your PC, so logging real players needs this
server on a **public HTTPS** URL: one always-on Bun process with a
ClickHouse beside it. The image `ghcr.io/thepotato97/roblox-click-log` (amd64
and arm64, built from `main`) runs as user 1000 and listens on 8787:

```sh
docker run -p 8787:8787 -e INGEST_TOKEN=... -e CLICKHOUSE_URL=http://clickhouse:8123 ghcr.io/thepotato97/roblox-click-log:main
```

If ClickHouse is down, `/ingest` answers 503 and the game's sink keeps the batch
and retries.

To move an old SQLite log (`clicks.db`) over, once: `bun src/migrate.mjs /data/clicks.db`.
Rerunning it is harmless.

Then:

1. Start it with `HOST=0.0.0.0 INGEST_TOKEN=$(openssl rand -hex 32)`.
2. Set `LIVE_ENDPOINT` in the game's `ClickLogSink` to `https://<host>/ingest`.
   While it's `''`, live servers send nothing.
3. In Creator Hub, go to your experience, then **Secrets**, and add
   `click_log_token` with that token, restricted to your host's domain.

## Analyse journeys

```sh
bun run analyze -- --since 24h               # aggregate report + 20 latest journeys
bun run analyze -- --since 7d --timelines 0  # aggregates only
bun run analyze -- --paths --config chaos_catalog:power --path UI:Opened:Chaos
bun run analyze -- --user 123456789 --json   # every journey for one player
bun run analyze -- --live-only               # leave out Studio playtest rows
```

In the cluster: `kubectl exec deploy/click-log -c app -- bun src/analyze.mjs --since 7d`.

Or over HTTP, with `Authorization: Bearer <READ_TOKEN>`:

| endpoint | returns | |
| --- | --- | --- |
| `GET /report` | markdown | the report below; `timelines=20` |
| `GET /paths` | markdown | steps, purchase prompts, and transitions or what follows a path |
| `GET /journeys` | JSON | the newest `limit` (100) journeys in full; `user_id=` for one player |

All three take `since` (default `7d`, `24h` for `/paths`) and `until` (`24h`, `7d`,
`30m`, an ISO date or unix seconds), `studio=0` for live-only, and
`config=key:value` (e.g. `hud_autohide_moving:true`; `key` alone for anyone exposed)
to compare experiment groups. For `/report` and `/journeys` a journey is in the
group if it logged that exposure; for `/paths` a player is, by their last exposure
in the window.

`/paths` also takes `match` (case-insensitive regex on step names, e.g.
`Chaos|Nuke`), `path` (1-3 exact steps joined by `>`, e.g.
`UI:Opened:Chaos>click React/…/Cards/TacticalNuke/Catcher`: what came next after
them, `(quit)` or `(end of window)` included) and `limit` (40 rows). Its steps are
event names, `click <full button path>` and world targets (full paths, unlike the
report's shortened ones).

The report covers:

- overview: players, journeys, how many ended in a quit, median length, and the
  share of journeys under 3 minutes
- **exit points**: the last 3 actions before each quit, and which menu was open
  at the last click
- the first 3 clicks of new players
- most-clicked targets (with the menu open at the time) and button reach
- **rage clicks**: 4 or more clicks on one target within 2 seconds, which usually
  means a button looked clickable but didn't respond (buttons meant to be mashed,
  like the speed upgrade, are listed in `RAGE_IGNORE` in `src/journeys.mjs`)
- common 3-click sequences
- ground taps and touches (`GROUND_TAPS` in `src/db.mjs`, e.g. the
  invisible floor under the map, the boundary walls) are refused at ingest
  (counted as `rejected`): they're players tapping to move or a character
  walking, and outnumber everything else several times over.
- per-journey timelines like this:

```
### Journey 1@1790000000 — user 1 (new)
2026-09-21 14:13:20 UTC · 1:00 · 4 clicks · casual · quit
  +0:05 → click MainUI/Root/RightSide/ShopButton
  +0:06 • UI:Opened:Shop
  +0:07 → click MainUI/…/Card/BuyButton  [Shop] ×2
  +0:09 → world:Floor/Chunk
  +1:00 • session_ended
```

A **journey** is one player's continuous visit. It ends at `session_ended` or
after 30 minutes with no events. A `teleported` hop (lobby to game, server
restart) does not end it.

To have Claude analyse it, fetch `/report` or `/paths` (or run the CLI) and give
it the output. Ask something like "where do new players drop
off and why?"

## Data

Rows hold raw Roblox **UserIds**. That's what makes per-player journeys possible.
Mixpanel gets a salted hash instead, so treat this database as private and keep
`READ_TOKEN` secret. A retried batch is accepted again and its copies dropped in
storage (`ReplacingMergeTree` on player, time and event id; reads use `FINAL`).
