// The read endpoints (/report, /journeys). Loading a window of events and building
// every journey is synchronous and gets slow as the log grows, so on a file-backed
// DB it runs in a worker thread with its own read-only connection (WAL lets it read
// alongside the main thread's writes). The main thread stays free to answer /health
// and /ingest; before this, a single 24h report blocked them past the readiness
// probe's timeout and the pod dropped out of service.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { firstSeen, queryEvents, readUsers } from './db.mjs';
import { buildJourneys, createReport, parseSince } from './journeys.mjs';

const USER_BATCH = 500;

// Returns { status, type, body } for a read request. `query` is the URL's searchParams
// as a plain object so it can cross the thread boundary.
export function runRead(db, pathname, query, userBatch = USER_BATCH) {
    const userParam = query.user_id;
    let since, until;
    try {
        since = parseSince(query.since ?? '7d');
        until = parseSince(query.until);
    } catch (error) {
        return { status: 400, type: 'application/json', body: JSON.stringify({ error: error.message }) };
    }
    // ?config=key:value keeps journeys that logged that config_exposure, to compare
    // experiment groups (e.g. config=hud_autohide_moving:true vs :false)
    const [configKey, configValue] = (query.config ?? '').split(':');
    const inGroup = (j) =>
        j.events.some((e) => e.name === 'config_exposure' && e.props?.key === configKey && (configValue === undefined || String(e.props.value) === configValue));
    const filter = { since, until, userIds: userParam ? [Number(userParam)] : null, includeStudio: query.studio !== '0' };
    // players in batches: holding every event in a 24h window at once ran past 2Gi
    const users = readUsers(db, filter);
    const batches = [];
    for (let i = 0; i < users.length; i += userBatch) batches.push(users.slice(i, i + userBatch));
    const journeysFor = (ids) => {
        const journeys = buildJourneys(queryEvents(db, { ...filter, userIds: ids }));
        // new = the player's first-ever event is in this journey's session. The game's
        // own user_type tag is unreliable (always "Returning").
        const first = firstSeen(db, ids);
        for (const j of journeys) j.userType = first.get(j.userId) >= j.end - j.durationSeconds - 5 ? 'new' : 'returning';
        return configKey ? journeys.filter(inGroup) : journeys;
    };
    if (pathname === '/report') {
        const r = createReport({ timelines: Number(query.timelines ?? 20) });
        for (const ids of batches) for (const j of journeysFor(ids)) r.add(j);
        return { status: 200, type: 'text/markdown', body: r.render() };
    }
    // the last `limit` journeys: count back from the end to find where they start,
    // then stream from there one batch at a time
    const limit = Number(query.limit ?? 100);
    let from = batches.length;
    let found = 0;
    while (from > 0 && found < limit) found += journeysFor(batches[--from]).length;
    let skip = Math.max(0, found - limit);
    const parts = function* () {
        yield '[';
        let first = true;
        for (const ids of batches.slice(from)) {
            let journeys = journeysFor(ids);
            if (skip) {
                const n = Math.min(skip, journeys.length);
                journeys = journeys.slice(n);
                skip -= n;
            }
            if (!journeys.length) continue;
            yield (first ? '' : ',') + journeys.map((j) => JSON.stringify(j)).join(',');
            first = false;
        }
        yield ']';
    };
    return { status: 200, type: 'application/json', parts: parts() };
}

// One read at a time: each holds a whole window of events in memory, so letting them
// overlap is how a few impatient refreshes turn into an OOM.
let queue = Promise.resolve();

export function readInWorker(dbPath, pathname, query) {
    let finished;
    const run = () =>
        new Promise((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), { workerData: { dbPath, pathname, query } });
            // after the head, the worker sends one part per 'more' and null at the end,
            // so parts only move as fast as the response drains
            let head = null;
            let waiting = null;
            const fail = (error) => (head ? waiting?.reject(error) : reject(error));
            finished = new Promise((done) => worker.once('exit', done));
            worker.once('error', fail);
            worker.once('exit', (code) => code !== 0 && fail(new Error(`read worker exited with code ${code}`)));
            worker.on('message', (msg) => {
                if (head) return waiting?.resolve(msg);
                head = msg;
                if (!msg.streamed) return resolve(msg);
                resolve({
                    ...msg,
                    parts: (async function* () {
                        try {
                            for (;;) {
                                const part = await new Promise((res, rej) => {
                                    waiting = { resolve: res, reject: rej };
                                    worker.postMessage('more');
                                });
                                if (part === null) return;
                                yield part;
                            }
                        } finally {
                            worker.terminate();
                        }
                    })(),
                });
            });
        });
    const result = queue.then(run, run);
    // the next read waits for this worker to exit, not just for its head
    queue = result.then(() => finished, () => {});
    return result;
}

if (!isMainThread && workerData?.dbPath) {
    const db = new Database(workerData.dbPath, { readonly: true, strict: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const { parts, ...head } = runRead(db, workerData.pathname, workerData.query);
    if (!parts) {
        parentPort.postMessage(head);
        db.close();
    } else {
        parentPort.postMessage({ ...head, streamed: true });
        parentPort.on('message', () => {
            const { value, done } = parts.next();
            parentPort.postMessage(done ? null : value);
        });
    }
}
