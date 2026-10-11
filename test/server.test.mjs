import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { insertEvents, openDb } from '../src/db.mjs';
import { buildJourneys, findRageClicks, timeline } from '../src/journeys.mjs';
import { migrateSqlite } from '../src/migrate.mjs';
import { createApp } from '../src/server.mjs';
import { runRead } from '../src/reads.mjs';

const T0 = 1_790_000_000;
let n = 0;
const ev = (userId, at, kind, name, extra = {}) => ({
    id: `e${n++}`,
    at: T0 + at,
    user_id: userId,
    session_id: `job:${userId}:${T0}`,
    place: 'casual',
    kind,
    name,
    ...extra,
});

const sample = () => [
    ev(1, 0, 'event', 'session_started'),
    ev(1, 5, 'button', 'MainUI/Root/RightSide/ShopButton'),
    ev(1, 6, 'event', 'UI:Opened:Shop'),
    ...[7, 7.3, 7.6, 7.9].map((t) => ev(1, t, 'button', 'MainUI/Root/Shop/Items/Card/BuyButton', { menu: 'Shop' })),
    ev(1, 9, 'world', 'world:sky'),
    ev(1, 60, 'event', 'session_ended', { value: 60, props: { user_type: 'User - New' } }),
    ev(1, 4000, 'event', 'session_started'),
    ev(1, 4010, 'button', 'MainUI/Root/RightSide/ShopButton'),
    ev(2, 0, 'button', 'Hud/Spawn'),
];

// a fresh database per test on the ClickHouse at CLICKHOUSE_URL (test/run.sh starts one)
const dbs = [];
async function freshDb(events = []) {
    const db = openDb({ database: `test_${Date.now()}_${dbs.length}_${Math.floor(Math.random() * 1e6)}` });
    dbs.push(db);
    await db.init();
    if (events.length) await insertEvents(db, events);
    return db;
}
after(async () => {
    for (const db of dbs) await db.exec(`DROP DATABASE IF EXISTS ${db.database}`, { db: 'default' });
});

const since = { since: String(T0 - 1) };
const read = async (db, path, query, opts) => {
    const r = await runRead(db, path, { ...since, ...query }, opts);
    if (!r.parts) return r;
    let body = '';
    for await (const part of r.parts) body += part;
    return { ...r, body };
};
const journeys = async (db, query) => JSON.parse((await read(db, '/journeys', query)).body);

async function withServer(fn, db, isReady) {
    db ??= await freshDb();
    const server = createApp({ db, ingestToken: 'secret', isReady }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`, db);
    } finally {
        server.close();
    }
}

test('ingest stores gzip batches, rejects bad auth, stores retries once', async () => {
    await withServer(async (base, db) => {
        const events = sample();
        const body = gzipSync(JSON.stringify({ events: [...events, { id: 'bad' }, ev(3, 1, 'world', 'touch:Collision')] }));
        const headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };

        const denied = await fetch(`${base}/ingest`, { method: 'POST', headers, body });
        assert.equal(denied.status, 401);

        const auth = { ...headers, Authorization: 'Bearer secret' };
        for (let i = 0; i < 2; i++) {
            const res = await (await fetch(`${base}/ingest`, { method: 'POST', headers: auth, body })).json();
            assert.deepEqual(res, { accepted: events.length, rejected: 2 }); // a bad row, a ground tap
        }
        const [{ n }] = await db.rows('SELECT count() AS n FROM events FINAL');
        assert.equal(n, events.length);

        const get = (path) => fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } });
        assert.match(await (await get(`/report?since=${T0 - 1}`)).text(), /\| journeys \| 3 \|/);
        assert.equal((await get('/report?since=nonsense')).status, 400);
        assert.equal((await get('/report?user_id=1;DROP')).status, 400);
        assert.deepEqual(await (await get(`/journeys?since=${T0 - 1}&limit=0`)).json(), []);
        const gz = await get(`/journeys?since=${T0 - 1}`);
        assert.equal((await gz.json()).length, 3);
    });
});

test('ingest answers 503 while ClickHouse is unreachable, so the game retries', async () => {
    const db = openDb({ url: 'http://127.0.0.1:9' });
    await withServer(async (base) => {
        const res = await fetch(`${base}/ingest`, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify({ events: sample() }),
        });
        assert.equal(res.status, 503);
        assert.equal((await fetch(`${base}/health`)).status, 503); // no traffic until it's back
    }, db, () => false);
});

test('journeys split on quit and long gaps, and spot rage clicks', async () => {
    const db = await freshDb(sample());
    const all = await journeys(db);
    assert.deepEqual(all.map((j) => [j.userId, j.ended, j.userType]), [[1, true, 'new'], [1, false, 'returning'], [2, false, 'new']]);
    const [first] = all;
    assert.equal(first.clickCount, 6);
    assert.deepEqual(first.rage.map((r) => r.count), [4]);
    assert.match(timeline(first), /×4/);
    // a session that began before the read window keeps its full length
    assert.equal((await journeys(db, { since: String(T0 + 5), until: String(T0 + 100) }))[0].durationSeconds, 60);
    // a later window still knows user 1 played before it
    assert.deepEqual((await journeys(db, { since: String(T0 + 3000) })).map((j) => [j.userId, j.userType]), [[1, 'returning']]);
    assert.deepEqual((await journeys(db, { user_id: '2' })).map((j) => j.userId), [2]);
    // limit keeps the newest
    assert.deepEqual((await journeys(db, { limit: '1' })).map((j) => j.start - T0), [4000]);
});

test('journey filters combine across journeys, reports and paths', async () => {
    const db = await freshDb([
        ...sample(),
        ev(4, 20, 'button', 'Lobby/Play', { place: 'lobby', menu: 'Lobby' }),
    ]);
    const filtered = await journeys(db, {
        min_duration: '1m',
        max_duration: '60',
        min_clicks: '6',
        max_clicks: '6',
        ended: '1',
        started: 'true',
        user_type: 'new',
        place: 'casual',
        event: 'UI:Opened:Shop',
        menu: 'Shop',
    });
    assert.deepEqual(filtered.map((j) => [j.userId, j.durationSeconds, j.clickCount, j.ended, j.userType]),
        [[1, 60, 6, true, 'new']]);
    assert.deepEqual((await journeys(db, { max_duration: '10s' })).map((j) => j.userId), [1, 2, 4]);
    assert.deepEqual((await journeys(db, { ended: '0', started: '0' })).map((j) => j.userId), [2, 4]);
    assert.deepEqual((await journeys(db, { user_type: 'returning' })).map((j) => j.userId), [1]);
    assert.deepEqual((await journeys(db, { place: 'lobby' })).map((j) => j.userId), [4]);

    assert.match((await read(db, '/report', { min_duration: '1m', ended: '1' })).body, /\| journeys \| 1 \|/);
    assert.match((await read(db, '/paths', { event: 'UI:Opened:Shop', menu: 'Shop' })).body, /\| journeys \| 1 \|/);

    for (const query of [
        { min_duration: 'later' },
        { min_duration: '2m', max_duration: '1m' },
        { min_clicks: '-1' },
        { min_clicks: '3', max_clicks: '2' },
        { ended: 'yes' },
        { user_type: 'existing' },
    ]) assert.equal((await read(db, '/journeys', query)).status, 400);
});

test('the SQL report matches what the journeys say', async () => {
    const db = await freshDb([
        ...sample(),
        ...[0, 0.3, 0.6, 0.9].map((t) => ev(3, t, 'button', 'MainUI/Menus/SpeedUpgrade/Upgrades/CoinUpgrade/Catcher')),
    ]);
    const md = (await read(db, '/report', { timelines: '5' })).body;
    assert.match(md, /\| players \| 3 \|/);
    assert.match(md, /\| new-player journeys \| 3 \|/);
    assert.match(md, /\| journeys under 15s \| 75% \|/);
    assert.match(md, /\| median clicks \/ journey \| 2\.5 \|/);
    assert.match(md, /## Exit points, quit within 1 min \(0\)/);
    assert.match(md, /\| click MainUI\/…\/Card\/BuyButton → click MainUI\/…\/Card\/BuyButton → world:sky \| 1 \| 100% \|/);
    assert.match(md, /\| \(no menu open\) \| 1 \| 100% \|/); // the last click was world:sky
    assert.match(md, /\| click MainUI\/…\/Card\/BuyButton \[Shop\] \| 4 \|/);
    assert.match(md, /\| MainUI\/Root\/RightSide\/ShopButton \| 2 \| 50% \|/); // reach
    assert.match(md, /## Rage clicks[^]*\| MainUI\/…\/Card\/BuyButton \| 1 \|\n\n/); // CoinUpgrade mashing isn't rage
    assert.match(md, /\| click MainUI\/Root\/RightSide\/ShopButton → click MainUI\/…\/Card\/BuyButton → world:sky \| 1 \|/);
    assert.match(md, /\| world:sky \| \(quit\) \| 1 \| 100% \|/);
    assert.match(md, /## Journeys \(4 most recent of 4\)/);
    assert.match(md, /### Journey 1@1790000000 — user 1 \(new\)/);
});

test('mashing the speed upgrade is not rage, mashing a close button is', () => {
    const burst = (name) => [0, 0.3, 0.6, 0.9].map((at) => ({ kind: 'button', name, at }));
    assert.deepEqual(findRageClicks(burst('MainUI/Menus/SpeedUpgrade/Upgrades/CoinUpgrade/Catcher')), []);
    assert.deepEqual(findRageClicks(burst('MainUI/Menus/Shop/Header/CloseButton')).map((r) => r.count), [4]);
});

test('disk spilling preserves reports, config paths and journeys under a memory cap', async () => {
    const db = await freshDb();
    await db.exec(`INSERT INTO events (id, at, received_at, user_id, kind, name, props)
        SELECT toString(number), fromUnixTimestamp64Milli(${T0 * 1000} + (number % 100) * 1000), now64(3),
            toInt64(intDiv(number, 100)), if(number % 100 = 0, 'event', 'button'),
            if(number % 100 = 0, 'config_exposure', if(number % 2 = 0, 'Hud/A', 'Hud/B')),
            if(number % 100 = 0, '{"key":"test","value":true}', '')
        FROM numbers(20000)`);
    const capped = { settings: {
        max_memory_usage: 256_000_000,
        max_threads: 1,
        max_bytes_before_external_group_by: 65_536,
        max_bytes_before_external_sort: 65_536,
        group_by_two_level_threshold: 1,
        log_queries: 1,
        log_comment: db.database,
    } };
    const inMemory = { settings: {
        max_bytes_before_external_group_by: 0,
        max_bytes_before_external_sort: 0,
        max_bytes_ratio_before_external_group_by: 0,
        max_bytes_ratio_before_external_sort: 0,
    } };
    for (const [path, query] of [
        ['/report', { timelines: '2' }],
        ['/paths', { config: 'test:true', path: 'click Hud/A' }],
        ['/journeys', { limit: '2' }],
    ]) {
        assert.equal((await read(db, path, query, capped)).body, (await read(db, path, query, inMemory)).body);
    }
    await db.exec('SYSTEM FLUSH LOGS');
    const [{ spills }] = await db.rows(`SELECT sum(ProfileEvents['ExternalAggregationWritePart']) AS spills
        FROM system.query_log WHERE log_comment = {tag:String} AND type = 'QueryFinish'`, { params: { tag: db.database } });
    assert.ok(spills > 0, 'exercise external aggregation, not just its settings');
});

test('?config=key:value keeps only journeys in that experiment group', async () => {
    const exposure = (userId, value) => ev(userId, 1, 'event', 'config_exposure', { props: { key: 'hud_autohide_moving', value } });
    const db = await freshDb([...sample(), exposure(1, true), exposure(2, false)]);
    const users = async (config) => (await journeys(db, { config })).map((j) => j.userId);
    assert.deepEqual(await users('hud_autohide_moving:true'), [1]);
    assert.deepEqual(await users('hud_autohide_moving:false'), [2]);
    assert.deepEqual(await users('hud_autohide_moving'), [1, 2]);
    assert.match((await read(db, '/report', { config: 'hud_autohide_moving:false' })).body, /\| journeys \| 1 \|/);
});

test('/paths: steps, purchases and next steps by config group (the player\'s last exposure)', async () => {
    const exposure = (userId, at, value) => ev(userId, at, 'event', 'config_exposure', { props: { key: 'chaos_catalog', value } });
    const prompt = (userId, at, purchased) => [
        ev(userId, at, 'event', 'Purchase:PromptOpened', { props: { name: 'TacticalNuke_1', price: 540 } }),
        ev(userId, at + 1, 'event', 'Purchase:PromptFinished', { props: { name: 'TacticalNuke_1', price: 540, purchased } }),
    ];
    const db = await freshDb([
        exposure(1, 1, 'disasters'),
        exposure(1, 2, 'power'), // last exposure wins
        ev(1, 3, 'event', 'UI:Opened:Chaos'),
        ev(1, 4, 'button', 'React/Menus/Container/Content/Cards/TacticalNuke/Catcher'),
        ...prompt(1, 5, false),
        ev(1, 10, 'event', 'session_ended'),
        ev(1, 3700, 'event', 'UI:Opened:Chaos'),
        ev(1, 3701, 'button', 'React/Menus/Container/ExitButton'),
        exposure(2, 1, 'disasters'),
        ev(2, 2, 'event', 'UI:Opened:Chaos'),
        ...prompt(2, 4, true),
    ]);
    const paths = async (query) => (await read(db, '/paths', query)).body;
    const power = await paths({ config: 'chaos_catalog:power' });
    assert.match(power, /\| players \| 1 \|/);
    assert.match(power, /\| UI:Opened:Chaos \| 2 \| 1 \| 100% \|/);
    assert.match(power, /\| TacticalNuke_1@540 \| 1 \| 0 \| 1 \| 1 \|/);
    assert.match(power, /\| click React\/Menus\/Container\/Content\/Cards\/TacticalNuke\/Catcher \| Purchase:PromptOpened \| 1 \| 100% \|/);
    assert.match(power, /\| Purchase:PromptFinished \| \(quit\) \| 1 \|/);
    assert.doesNotMatch(power, /config_exposure/);
    assert.match(await paths({ config: 'chaos_catalog:disasters' }), /\| TacticalNuke_1@540 \| 1 \| 1 \| 0 \| 1 \|/);

    const next = await paths({ path: 'UI:Opened:Chaos' });
    assert.match(next, /\| players \| 2 \|/);
    assert.match(next, /## After UI:Opened:Chaos/);
    assert.match(next, /\| click React\/Menus\/Container\/ExitButton \| 1 \| 1 \| 33% \|/);
    assert.match(next, /\| Purchase:PromptOpened \| 1 \| 1 \| 33% \|/);
    const two = await paths({ path: "UI:Opened:Chaos>click React/Menus/Container/Content/Cards/TacticalNuke/Catcher" });
    assert.match(two, /\| Purchase:PromptOpened \| 1 \| 1 \| 100% \|/);
    assert.match(await paths({ match: 'exitbutton' }), /\| UI:Opened:Chaos \| click React\/Menus\/Container\/ExitButton \| 1 \|/);
    assert.equal((await read(db, '/paths', { match: '(' })).status, 400);
});

test('follow-up paths handle long journeys, overlaps, short journeys and terminal steps', async () => {
    const db = await freshDb([
        ev(2, 0, 'button', 'Hud/A'), ev(2, 1, 'button', 'Hud/B'), ev(2, 2, 'button', 'Hud/A'),
        ev(2, 3, 'event', 'session_ended'),
        ev(3, 0, 'button', 'Hud/A'),
        ev(4, 0, 'event', 'session_started'),
    ]);
    await db.exec(`INSERT INTO events (id, at, received_at, user_id, kind, name)
        SELECT toString(number), fromUnixTimestamp64Milli(${T0 * 1000} + number * 10), now64(3),
            1, 'button', if(number % 2 = 0, 'Hud/A', 'Hud/B') FROM numbers(20000)`);
    const opts = { settings: { max_memory_usage: 256_000_000, max_threads: 1 } };
    const three = (await read(db, '/paths', { path: 'click Hud/A>click Hud/B>click Hud/A' }, opts)).body;
    assert.match(three, /\| click Hud\/B \| 9999 \| 1 \| 100% \|/);
    assert.match(three, /\| \(quit\) \| 1 \| 1 \| 0% \|/);
    const two = (await read(db, '/paths', { path: 'click Hud/A>click Hud/B' }, opts)).body;
    assert.match(two, /\| click Hud\/A \| 10000 \| 2 \| 100% \|/);
    assert.match(two, /\| \(end of window\) \| 1 \| 1 \| 0% \|/);
});

test('the old SQLite log copies over once, however often the copy runs', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
        CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE);
        CREATE TABLE events2 (id TEXT PRIMARY KEY, at REAL NOT NULL, received_at REAL NOT NULL, user_id INTEGER NOT NULL,
            session_id INTEGER, place INTEGER, place_id INTEGER, job_id INTEGER, studio INTEGER NOT NULL DEFAULT 0,
            kind INTEGER NOT NULL, name INTEGER NOT NULL, menu INTEGER, x REAL, y REAL, value REAL, props TEXT);
        INSERT INTO strings VALUES (1, 'button'), (2, 'Hud/A'), (3, 'casual'), (4, 'world'), (5, 'touch:Collision'), (6, 'Shop');
        INSERT INTO events2 (id, at, received_at, user_id, place, kind, name, menu, props) VALUES
            ('a', ${T0 + 1}, 0, 7, 3, 1, 2, 6, '{"k":1}'),
            ('b', ${T0 + 2}, 0, 7, 3, 4, 5, NULL, NULL),
            ('c', ${T0 + 3}.25, 0, 7, NULL, 1, 2, NULL, NULL);
    `);
    const db = await freshDb();
    assert.equal(await migrateSqlite(sqlite, db, 1), 2); // the ground touch stays behind
    await migrateSqlite(sqlite, db);
    const [j] = await journeys(db);
    assert.deepEqual(
        j.events.map((e) => [e.at - T0, e.name, e.place, e.menu, e.props]),
        [[1, 'Hud/A', 'casual', 'Shop', { k: 1 }], [3.25, 'Hud/A', null, null, null]],
    );
});
