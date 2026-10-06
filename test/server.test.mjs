import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { insertEvents, openDb, queryEvents } from '../src/db.mjs';
import { buildJourneys, findRageClicks, report } from '../src/journeys.mjs';
import { createApp } from '../src/server.mjs';

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
    const md = report(journeys, { timelines: 5 });
    assert.match(md, /MainUI\/…\/Card\/BuyButton/);
    assert.match(md, /×4/);
});

test('mashing the speed upgrade is not rage, mashing a close button is', () => {
    const burst = (name) => [0, 0.3, 0.6, 0.9].map((at) => ({ kind: 'button', name, at }));
    assert.deepEqual(findRageClicks(burst('MainUI/Menus/SpeedUpgrade/Upgrades/CoinUpgrade/Catcher')), []);
    assert.deepEqual(
        findRageClicks(burst('MainUI/Menus/Shop/Header/CloseButton')).map((r) => r.count),
        [4],
    );
});

test('ground taps are dropped, taps on things in the world are kept', () => {
    const tap = (name, at) => ({ user_id: 1, at, kind: 'world', name, place: 'Game' });
    const [journey] = buildJourneys([
        tap('world:Collision', 0),
        tap('world:Drops/GemRegular', 1),
        tap('world:Lobby/floor', 2),
    ]);
    assert.deepEqual(journey.events.map((e) => e.name), ['world:Drops/GemRegular']);
    assert.equal(journey.clickCount, 1);
});

test('windowed reads skip ground touches in SQL and come back per player in time order', () => {
    const db = openDb(':memory:');
    insertEvents(db, [
        ev(2, 105, 'button', 'Hud/B'),
        ev(1, 103, 'world', 'touch:Collision'),
        ev(1, 102, 'world', 'touch:Teleport/Teleport'),
        ev(2, 101, 'world', 'touch:VisibleWall'),
        ev(1, 104, 'button', 'Hud/A'),
        ev(1, 50, 'button', 'Hud/Old'),
    ]);
    const rows = queryEvents(db, { since: T0 + 100 });
    assert.deepEqual(
        rows.map((e) => [e.user_id, e.at - T0, e.name]),
        [
            [1, 102, 'touch:Teleport/Teleport'],
            [1, 104, 'Hud/A'],
            [2, 105, 'Hud/B'],
        ],
    );
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
