// The read endpoints (/report, /journeys). Loading a window of events and building
// every journey is synchronous and gets slow as the log grows, so on a file-backed
// DB it runs in a worker thread with its own read-only connection (WAL lets it read
// alongside the main thread's writes). The main thread stays free to answer /health
// and /ingest; before this, a single 24h report blocked them past the readiness
// probe's timeout and the pod dropped out of service.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { queryEvents } from './db.mjs';
import { buildJourneys, parseSince, report } from './journeys.mjs';

// Returns { status, type, body } for a read request. `query` is the URL's searchParams
// as a plain object so it can cross the thread boundary.
export function runRead(db, pathname, query) {
    const userParam = query.user_id;
    const events = queryEvents(db, {
        since: parseSince(query.since ?? '7d'),
        until: parseSince(query.until),
        userId: userParam ? Number(userParam) : null,
        includeStudio: query.studio !== '0',
    });
    const journeys = buildJourneys(events);
    if (pathname === '/report') {
        const timelines = Number(query.timelines ?? 20);
        return { status: 200, type: 'text/markdown', body: report(journeys, { timelines }) };
    }
    const limit = Number(query.limit ?? 100);
    return { status: 200, type: 'application/json', body: JSON.stringify(journeys.slice(-limit)) };
}

// One read at a time: each holds a whole window of events in memory, so letting them
// overlap is how a few impatient refreshes turn into an OOM.
let queue = Promise.resolve();

export function readInWorker(dbPath, pathname, query) {
    const run = () =>
        new Promise((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), { workerData: { dbPath, pathname, query } });
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', (code) => {
                if (code !== 0) reject(new Error(`read worker exited with code ${code}`));
            });
        });
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}

if (!isMainThread && workerData?.dbPath) {
    const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
    try {
        parentPort.postMessage(runRead(db, workerData.pathname, workerData.query));
    } finally {
        db.close();
    }
}
