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
click-log-server (this)      SQLite (data/clicks.db)  →  /report, /journeys, analyze CLI
```

There are no npm dependencies. It uses Node's built-in `node:http` and
`node:sqlite`, so it needs **Node 22.13 or newer**.

## Run it locally (Studio playtests)

```sh
npm start          # http://127.0.0.1:8787, data in ./data/clicks.db
```

Then press Play in Studio. Studio sends to `http://localhost:8787/ingest` with
the token `local-dev`, which is also this server's default when it runs on
loopback, so there's nothing to configure. Game Settings → Security → **Allow
HTTP Requests** must be on (it already is). If the server isn't running,
Studio's sink just retries quietly.

```sh
npm test
```

| env | default | |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | `0.0.0.0` to expose it; then `INGEST_TOKEN` is required |
| `PORT` | `8787` | |
| `DB_PATH` | `./data/clicks.db` | |
| `INGEST_TOKEN` | `local-dev` on loopback | bearer token the game sends |
| `READ_TOKEN` | `INGEST_TOKEN` | bearer token for `/report` and `/journeys` |

## Live servers (optional, later)

Live Roblox servers can't reach your PC, so logging real players needs this
server on a **public HTTPS** URL: one always-on Node 22 process with a
persistent disk. The image `ghcr.io/thepotato97/roblox-click-log` (amd64 and
arm64, built from `main`) runs as user 1000, listens on 8787 and keeps its
database in `/data`:

```sh
docker run -p 8787:8787 -v click-log:/data -e INGEST_TOKEN=... ghcr.io/thepotato97/roblox-click-log:main
```

Then:

1. Start it with `HOST=0.0.0.0 INGEST_TOKEN=$(openssl rand -hex 32)`.
2. Set `LIVE_ENDPOINT` in the game's `ClickLogSink` to `https://<host>/ingest`.
   While it's `''`, live servers send nothing.
3. In Creator Hub, go to your experience, then **Secrets**, and add
   `click_log_token` with that token, restricted to your host's domain.

## Analyse journeys

```sh
npm run analyze -- --since 24h               # aggregate report + 20 latest journeys
npm run analyze -- --since 7d --timelines 0  # aggregates only
npm run analyze -- --user 123456789          # every journey for one player
npm run analyze -- --json > journeys.json    # raw journeys for your own tooling
npm run analyze -- --live-only               # leave out Studio playtest rows
```

In the container, run the same CLI with `node src/analyze.mjs ...` (it reads
`DB_PATH`, so it finds `/data/clicks.db`), e.g.
`kubectl exec deploy/click-log -- node src/analyze.mjs --since 7d`.

Or over HTTP: `GET /report?since=7d&timelines=20` returns markdown (add `studio=0` for live-only), and
`GET /journeys?since=24h&user_id=…&limit=100` returns JSON. Both need
`Authorization: Bearer <READ_TOKEN>`.

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
  invisible floor under the map, the boundary walls) are left out of all of it,
  in the SQL query itself: they're players tapping to move or a character
  walking, and outnumber everything else several times over. New ones are
  refused at ingest (counted as `rejected`); older rows are skipped by the query.
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

To have Claude analyse it, run `npm run analyze -- --since 7d` (or fetch
`/report`) and give it the output. Ask something like "where do new players drop
off and why?"

## Data

Rows hold raw Roblox **UserIds**. That's what makes per-player journeys possible.
Mixpanel gets a salted hash instead, so treat this database as private and keep
`READ_TOKEN` secret. Retries are de-duplicated by the event's id.
