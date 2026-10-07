import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { insertEvents, migrateEvents, openDb, queryEvents } from '../src/db.mjs';
import { buildJourneys, findRageClicks, report } from '../src/journeys.mjs';
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

async function withServer(fn) {
    const db = openDb(':memory:');
    const server = createApp({ db, ingestToken: 'secret' }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`, db);
    } finally {
        server.close();
    }
}

test('ingest stores gzip batches, rejects bad auth, ignores retries', async () => {
    await withServer(async (base, db) => {
        const events = sample();
        const body = gzipSync(JSON.stringify({ events: [...events, { id: 'bad' }] }));
        const headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };

        const denied = await fetch(`${base}/ingest`, { method: 'POST', headers, body });
        assert.equal(denied.status, 401);

        const auth = { ...headers, Authorization: 'Bearer secret' };
        const first = await (await fetch(`${base}/ingest`, { method: 'POST', headers: auth, body })).json();
        assert.deepEqual(first, { accepted: events.length, rejected: 1 });
        const retry = await (await fetch(`${base}/ingest`, { method: 'POST', headers: auth, body })).json();
        assert.equal(retry.accepted, 0);
        assert.equal(queryEvents(db).length, events.length);

        const md = await (await fetch(`${base}/report?since=${T0 - 1}`, { headers: { Authorization: 'Bearer secret' } })).text();
        assert.match(md, /# Player journey report/);

        const read = (path) => fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } });
        assert.equal((await read('/report?since=nonsense')).status, 400);
        assert.deepEqual(await (await read(`/journeys?since=${T0 - 1}&limit=0`)).json(), []);
    });
});

test('journeys split on quit and long gaps, and spot rage clicks', () => {
    const db = openDb(':memory:');
    insertEvents(db, sample());
    const journeys = buildJourneys(queryEvents(db));
    assert.equal(journeys.length, 3);
    const [first] = journeys;
    assert.equal(first.ended, true);
    assert.equal(first.userType, 'new');
    assert.equal(first.clickCount, 6);
    assert.deepEqual(first.rage.map((r) => r.count), [4]);
    // a session that began before the read window keeps its full length
    assert.equal(buildJourneys(queryEvents(db, { since: T0 + 5, until: T0 + 100 }))[0].durationSeconds, 60);
    const md = report(journeys, { timelines: 5 });
    assert.match(md, /MainUI\/…\/Card\/BuyButton/);
    assert.match(md, /×4/);
});

test('new = first seen in the log; bounces get their own exit tables', () => {
    const db = openDb(':memory:');
    insertEvents(db, sample());
    const all = JSON.parse([...runRead(db, '/journeys', { since: String(T0 - 1) }).parts].join(''));
    assert.deepEqual(all.map((j) => [j.userId, j.userType]), [[1, 'new'], [1, 'returning'], [2, 'new']]);
    // a later window still knows user 1 played before it
    const later = JSON.parse([...runRead(db, '/journeys', { since: String(T0 + 3000) }).parts].join(''));
    assert.deepEqual(later.map((j) => [j.userId, j.userType]), [[1, 'returning']]);
    const md = runRead(db, '/report', { since: String(T0 - 1) }).body;
    assert.match(md, /new-player journeys \| 2/);
    assert.match(md, /journeys under 15s \| 67%/);
    assert.match(md, /## Exit points, quit within 1 min \(0\)/);
    assert.match(md, /\| world:sky \| \(quit\) \| 1 \| 100% \|/);
});

test('batching players changes nothing in the output', () => {
    const db = openDb(':memory:');
    insertEvents(db, [...sample(), ev(3, 7, 'button', 'Hud/C'), ev(4, 8, 'button', 'Hud/D'), ev(4, 9, 'event', 'session_ended')]);
    const q = { since: String(T0 - 1) };
    const journeys = (query, batch) => [...runRead(db, '/journeys', query, batch).parts].join('');
    for (const limit of ['2', '3', '100']) assert.equal(journeys({ ...q, limit }, 1), journeys({ ...q, limit }));
    assert.equal(JSON.parse(journeys({ ...q, limit: '2' }, 1)).length, 2);
    assert.equal(runRead(db, '/report', q, 1).body, runRead(db, '/report', q).body);
});

test('mashing the speed upgrade is not rage, mashing a close button is', () => {
    const burst = (name) => [0, 0.3, 0.6, 0.9].map((at) => ({ kind: 'button', name, at }));
    assert.deepEqual(findRageClicks(burst('MainUI/Menus/SpeedUpgrade/Upgrades/CoinUpgrade/Catcher')), []);
    assert.deepEqual(
        findRageClicks(burst('MainUI/Menus/Shop/Header/CloseButton')).map((r) => r.count),
        [4],
    );
});

test('old all-text rows migrate into the deduped table; reads cover both until then', async () => {
    const db = openDb(':memory:');
    // the pre-dedup table, as an older server left it
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, at REAL NOT NULL, received_at REAL NOT NULL, user_id INTEGER NOT NULL,
        session_id TEXT, place TEXT, place_id INTEGER, job_id TEXT, studio INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
        name TEXT NOT NULL, menu TEXT, x REAL, y REAL, value REAL, props TEXT)`);
    const old = db.prepare(`INSERT INTO events (id, at, received_at, user_id, place, kind, name, props) VALUES (?, ?, 0, ?, 'casual', ?, ?, ?)`);
    old.run('o1', T0 + 102, 1, 'world', 'touch:Teleport/Teleport', null);
    old.run('o2', T0 + 103, 1, 'world', 'touch:Collision', null); // ground, never read
    old.run('o3', T0 + 104, 1, 'button', 'Hud/A', '{"k":1}');
    insertEvents(db, [ev(2, 105, 'button', 'Hud/B'), ev(1, 50, 'button', 'Hud/Old'), ev(1, 106, 'button', 'Hud/A')]);
    // ground touches are refused on arrival
    assert.deepEqual(insertEvents(db, [ev(3, 106, 'world', 'touch:Collision')]), { accepted: 0, rejected: 1 });
    const read = () => queryEvents(db, { since: T0 + 100 }).map((e) => [e.user_id, e.at - T0, e.name, e.place, e.props]);
    const expected = [
        [1, 102, 'touch:Teleport/Teleport', 'casual', null],
        [1, 104, 'Hud/A', 'casual', { k: 1 }],
        [1, 106, 'Hud/A', 'casual', null],
        [2, 105, 'Hud/B', 'casual', null],
    ];
    assert.deepEqual(read(), expected);
    await migrateEvents(db, 1);
    assert.equal(db.query(`SELECT count(*) n FROM sqlite_master WHERE name = 'events'`).get().n, 0);
    assert.deepEqual(read(), expected);
    // each text value is stored once however many rows use it
    assert.equal(db.query(`SELECT count(*) n FROM strings WHERE value = 'Hud/A'`).get().n, 1);
    db.close();
});

// slow on purpose (it needs a report that takes a while), so past the 5s default
test('reads on a file DB run off the main thread, so /health answers mid-report', { timeout: 30_000 }, async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'clicklog-'));
    const dbPath = join(dir, 'clicks.db');
    const db = openDb(dbPath);
    // enough rows that building the report takes a noticeable while
    const many = [];
    for (let u = 0; u < 400; u++) {
        for (let i = 0; i < 500; i++) many.push(ev(1000 + u, i, 'button', `Hud/Button${i % 40}`));
    }
    for (let i = 0; i < many.length; i += 2000) insertEvents(db, many.slice(i, i + 2000));

    const server = createApp({ db, dbPath, ingestToken: 'secret' }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const order = [];
        const reportDone = fetch(`${base}/report?since=${T0 - 1}`, { headers: { Authorization: 'Bearer secret' } })
            .then((r) => r.text())
            .then((md) => {
                order.push('report');
                return md;
            });
        await new Promise((r) => setTimeout(r, 50));
        const health = await fetch(`${base}/health`);
        order.push('health');
        assert.equal(health.status, 200);
        const md = await reportDone;
        assert.match(md, /# Player journey report/);
        assert.deepEqual(order, ['health', 'report']);

        // streamed out of the worker in batches of 200
        const journeys = await (await fetch(`${base}/journeys?since=${T0 - 1}&limit=1000`, {
            headers: { Authorization: 'Bearer secret' },
        })).json();
        assert.equal(journeys.length, 400);
        // fetch asks for gzip and inflates it; check it really went out compressed
        const raw = await fetch(`${base}/journeys?since=${T0 - 1}&limit=1000`, {
            headers: { Authorization: 'Bearer secret', 'Accept-Encoding': 'gzip' },
            decompress: false,
        });
        assert.equal(raw.headers.get('content-encoding'), 'gzip');
    } finally {
        server.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('?config=key:value keeps only journeys in that experiment group', () => {
    const db = openDb(':memory:');
    const exposure = (userId, value) => ev(userId, 1, 'event', 'config_exposure', { props: { key: 'hud_autohide_moving', value } });
    insertEvents(db, [...sample(), exposure(1, true), exposure(2, false)]);
    const users = (config) =>
        JSON.parse([...runRead(db, '/journeys', { since: String(T0 - 1), config }).parts].join('')).map((j) => j.userId);
    assert.deepEqual(users('hud_autohide_moving:true'), [1]);
    assert.deepEqual(users('hud_autohide_moving:false'), [2]);
    assert.deepEqual(users('hud_autohide_moving'), [1, 2]);
    assert.match(runRead(db, '/report', { since: String(T0 - 1), config: 'hud_autohide_moving:false' }).body, /journeys \| 1 \|/);
});
