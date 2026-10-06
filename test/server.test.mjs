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

test('a burst on a button that responds is not rage', () => {
    const taps = [10, 10.4, 10.8, 11.2, 11.6];
    const speedBuys = taps.flatMap((t) => [
        ev(3, t, 'button', 'MainUI/Root/Speed/BuyButton'),
        ev(3, t + 0.1, 'event', 'Resource:Sink:coins:Upgrade:Speed', { value: 100 }),
    ]);
    assert.deepEqual(findRageClicks(speedBuys), []);

    const deadButton = taps.map((t) => ev(3, t, 'button', 'MainUI/Root/Shop/DeadButton'));
    assert.deepEqual(findRageClicks(deadButton).map((r) => r.count), [5]);
});
