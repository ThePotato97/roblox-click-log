import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { insertEvents, openDb, purgeGround, queryEvents } from '../src/db.mjs';
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
    const all = JSON.parse(runRead(db, '/journeys', { since: String(T0 - 1) }).body);
    assert.deepEqual(all.map((j) => [j.userId, j.userType]), [[1, 'new'], [1, 'returning'], [2, 'new']]);
    // a later window still knows user 1 played before it
    const later = JSON.parse(runRead(db, '/journeys', { since: String(T0 + 3000) }).body);
    assert.deepEqual(later.map((j) => [j.userId, j.userType]), [[1, 'returning']]);
    const md = runRead(db, '/report', { since: String(T0 - 1) }).body;
    assert.match(md, /new-player journeys \| 2/);
    assert.match(md, /journeys under 15s \| 67%/);
    assert.match(md, /## Exit points, quit within 1 min \(0\)/);
    assert.match(md, /\| world:sky \| \(quit\) \| 1 \| 100% \|/);
});

test('mashing the speed upgrade is not rage, mashing a close button is', () => {
    const burst = (name) => [0, 0.3, 0.6, 0.9].map((at) => ({ kind: 'button', name, at }));
    assert.deepEqual(findRageClicks(burst('MainUI/Menus/SpeedUpgrade/Upgrades/CoinUpgrade/Catcher')), []);
    assert.deepEqual(
        findRageClicks(burst('MainUI/Menus/Shop/Header/CloseButton')).map((r) => r.count),
        [4],
    );
});

test('ground touches are refused and purged; reads come back per player in time order', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'clicklog-'));
    let db = openDb(join(dir, 'clicks.db'));
    insertEvents(db, [
        ev(2, 105, 'button', 'Hud/B'),
        ev(1, 102, 'world', 'touch:Teleport/Teleport'),
        ev(1, 104, 'button', 'Hud/A'),
        ev(1, 50, 'button', 'Hud/Old'),
    ]);
    // ground touches are refused on arrival
    assert.deepEqual(insertEvents(db, [ev(3, 106, 'world', 'touch:Collision')]), { accepted: 0, rejected: 1 });
    // ...and rows stored before that are purged once, in batches
    db.prepare(`INSERT INTO events (id, at, received_at, user_id, kind, name) VALUES ('pre', ?, 0, 1, 'world', 'touch:Collision')`).run(T0 + 103);
    db.exec('PRAGMA user_version = 0');
    // reads skip ground rows still waiting for the purge
    assert.ok(!queryEvents(db, { since: T0 + 100 }).some((e) => e.name === 'touch:Collision'));
    await purgeGround(db, 1);
    const rows = queryEvents(db, { since: T0 + 100 });
    assert.deepEqual(
        rows.map((e) => [e.user_id, e.at - T0, e.name]),
        [
            [1, 102, 'touch:Teleport/Teleport'],
            [1, 104, 'Hud/A'],
            [2, 105, 'Hud/B'],
        ],
    );
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

test('reads on a file DB run off the main thread, so /health answers mid-report', async () => {
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

        const journeys = await (await fetch(`${base}/journeys?since=${T0 - 1}&limit=5`, {
            headers: { Authorization: 'Bearer secret' },
        })).json();
        assert.equal(journeys.length, 5);
    } finally {
        server.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
