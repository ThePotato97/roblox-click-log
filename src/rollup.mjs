// Hourly rollup: each closed hour is summarised once, per player, into small rows,
// and /rollup adds the rows up for any window. A multi-day experiment read is then
// a lookup instead of rebuilding every journey in the window (which ran past
// Cloudflare's 100s and came back 524). Raw /journeys stays for one-off digging.
//
// One row per (hour, player): counts of every step they took, the 2-, 3- and
// 4-step sequences they walked (Sankey data, a layer per ?path step), purchase
// prompts and their config exposures. Per player, so unique-player counts and
// ?config groups stay exact over any window.
//
// Raw events expire after RETENTION_DAYS; the rollup is kept forever. A change to
// what a row holds therefore only reaches hours whose raw events still exist: bump
// the table names (rollup3...) to rebuild those.
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { deflateSync, inflateSync } from 'node:zlib';
import { Database } from 'bun:sqlite';
import { expireEvents, firstEventAt, queryEvents } from './db.mjs';
import { parseSince } from './journeys.mjs';

const HOUR = 3600;
// an hour is rolled up this long after it closes, so late batches still land in it
const GRACE_SECONDS = 10 * 60;
const SESSION_EDGES = new Set(['session_started', 'session_ended', 'teleported']);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 14);
const MAX_PATH = 4;

export function openRollup(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS rollup2 (
            hour    INTEGER NOT NULL,   -- unix seconds, start of the hour
            user_id INTEGER NOT NULL,
            configs TEXT,               -- JSON {key: value}, last exposure in the hour
            data    BLOB NOT NULL,      -- deflated JSON { n, e, b }; e keys are 2-4 steps joined by tabs
            PRIMARY KEY (hour, user_id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS rollup2_hours (hour INTEGER PRIMARY KEY);
        -- first version: transitions only, rebuilt as rollup2
        DROP TABLE IF EXISTS rollup;
        DROP TABLE IF EXISTS rollup_hours;
    `);
}

// full button paths, unlike the report's shortTarget, which merges distinct buttons
const step = (e) => (e.kind === 'button' ? `click ${e.name}` : e.name);

function summarise(events) {
    const n = {};
    const e = {};
    const b = {};
    let configs = null;
    // shortcut: a sequence that straddles an hour boundary is dropped (a few per
    // player-hour at most); carry the last steps over if it matters
    let recent = []; // the last MAX_PATH steps, repeats folded
    const walk = (s) => {
        recent.push(s);
        if (recent.length > MAX_PATH) recent.shift();
        for (let len = 2; len <= recent.length; len++) {
            const k = recent.slice(-len).join('\t');
            e[k] = (e[k] ?? 0) + 1;
        }
    };
    for (const ev of events) {
        if (ev.kind === 'event' && ev.name === 'config_exposure') {
            if (ev.props?.key !== undefined) (configs ??= {})[ev.props.key] = ev.props.value;
            continue;
        }
        if (ev.kind === 'event' && SESSION_EDGES.has(ev.name)) {
            if (ev.name === 'session_ended') {
                if (recent.length) walk('(quit)');
                recent = [];
            }
            continue;
        }
        const s = step(ev);
        n[s] = (n[s] ?? 0) + 1;
        if (ev.name === 'Purchase:PromptOpened' || ev.name === 'Purchase:PromptFinished') {
            const k = `${ev.props?.name ?? '?'}@${ev.props?.price ?? '?'}`;
            const p = (b[k] ??= [0, 0, 0]); // prompted, bought, cancelled
            if (ev.name === 'Purchase:PromptOpened') p[0]++;
            else p[ev.props?.purchased ? 1 : 2]++;
        }
        if (s !== recent.at(-1)) walk(s);
    }
    return { configs, data: { n, e, b } };
}

export function rollupHour(db, hour) {
    const events = queryEvents(db, { since: hour, until: hour + HOUR });
    const rows = [];
    for (let i = 0; i < events.length; ) {
        let j = i;
        while (j < events.length && events[j].user_id === events[i].user_id) j++;
        rows.push({ user: events[i].user_id, ...summarise(events.slice(i, j)) });
        i = j;
    }
    const insert = db.query('INSERT OR REPLACE INTO rollup2 (hour, user_id, configs, data) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
        for (const r of rows) insert.run(hour, r.user, r.configs && JSON.stringify(r.configs), deflateSync(JSON.stringify(r.data)));
        db.query('INSERT OR IGNORE INTO rollup2_hours (hour) VALUES (?)').run(hour);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return rows.length;
}

// Rolls up every closed hour not done yet, oldest first (the first run backfills
// the whole log). Returns how many hours it did.
export function rollupPending(db, now = Date.now() / 1000) {
    openRollup(db);
    const first = firstEventAt(db);
    if (first === null) return 0;
    const done = new Set(db.query('SELECT hour FROM rollup2_hours').values().map(([h]) => h));
    let count = 0;
    for (let hour = Math.floor(first / HOUR) * HOUR; hour + HOUR + GRACE_SECONDS <= now; hour += HOUR) {
        if (done.has(hour)) continue;
        rollupHour(db, hour);
        count++;
    }
    return count;
}

// Runs rollupPending in a worker with its own connection, so the main thread keeps
// answering /health and /ingest through a backfill. Overlapping calls are skipped.
let running = null;
export function rollupInWorker(dbPath) {
    running ??= new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { rollupDbPath: dbPath } });
        worker.once('error', reject);
        worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rollup worker exited with code ${code}`))));
    }).finally(() => (running = null));
    return running;
}

if (!isMainThread && workerData?.rollupDbPath) {
    const db = new Database(workerData.rollupDbPath, { strict: true });
    db.exec('PRAGMA busy_timeout = 5000');
    rollupPending(db);
    // every hour before the cutoff is rolled up by now, so its raw events can go
    expireEvents(db, Date.now() / 1000 - RETENTION_DAYS * 86400);
    db.close();
}

const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '–');
const fmtDate = (unix) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16);
const table = (rows, headers) =>
    rows.length
        ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
        : '_none_';

// GET /rollup?since=&until=&config=key:value&match=regex&path=a>b&limit=40 (from= is a 1-step path)
// since/until round down to the hour. A player's group is their last exposure to
// `key` in the window.
export function readRollup(db, query) {
    const since = Math.floor(parseSince(query.since ?? '24h') / HOUR) * HOUR;
    const untilRaw = parseSince(query.until);
    const until = untilRaw === null ? Infinity : Math.floor(untilRaw / HOUR) * HOUR;
    const limit = Number(query.limit ?? 40);
    const match = query.match ? new RegExp(query.match, 'i') : null;
    const [configKey, configValue] = (query.config ?? '').split(':');
    const range = [since, until === Infinity ? Number.MAX_SAFE_INTEGER : until];

    let group = null;
    if (configKey) {
        const last = new Map();
        for (const [user, configs] of db.query('SELECT user_id, configs FROM rollup2 WHERE hour >= ? AND hour < ? AND configs IS NOT NULL ORDER BY hour').values(...range)) {
            const c = JSON.parse(configs);
            if (configKey in c) last.set(user, String(c[configKey]));
        }
        group = new Set([...last].filter(([, v]) => configValue === undefined || v === configValue).map(([u]) => u));
    }

    const players = new Set();
    const names = new Map(); // step -> [times, Set(players)]
    const edges = new Map();
    const buys = new Map(); // product@price -> [prompted, bought, cancelled, Set(players)]
    for (const [user, blob] of db.query('SELECT user_id, data FROM rollup2 WHERE hour >= ? AND hour < ?').values(...range)) {
        if (group && !group.has(user)) continue;
        players.add(user);
        const { n, e, b } = JSON.parse(inflateSync(blob));
        for (const k in n) {
            const v = names.get(k) ?? names.set(k, [0, new Set()]).get(k);
            v[0] += n[k];
            v[1].add(user);
        }
        for (const k in e) edges.set(k, (edges.get(k) ?? 0) + e[k]);
        for (const k in b) {
            const v = buys.get(k) ?? buys.set(k, [0, 0, 0, new Set()]).get(k);
            for (let i = 0; i < 3; i++) v[i] += b[k][i];
            v[3].add(user);
        }
    }

    const hours = db.query('SELECT min(hour) AS lo, max(hour) AS hi, count(*) AS n FROM rollup2_hours WHERE hour >= ? AND hour < ?').get(...range);
    const out = ['# Rollup', ''];
    out.push(
        hours.n
            ? `${fmtDate(hours.lo)} → ${fmtDate(hours.hi + HOUR)} UTC (${hours.n} hours rolled up; the current hour and the last ${GRACE_SECONDS / 60} min are not in yet)`
            : 'No rolled-up hours in range yet.',
        '',
        table(
            [
                ['group', query.config ?? 'everyone'],
                ['players', players.size],
                ...(group ? [['exposed in window', group.size]] : []),
            ],
            ['', ''],
        ),
        '',
    );
    const keep = (s) => !match || match.test(s);

    out.push('## Steps (events, clicks, world taps)', '');
    out.push(
        table(
            [...names]
                .filter(([k]) => keep(k))
                .sort((a, b) => b[1][1].size - a[1][1].size || b[1][0] - a[1][0])
                .slice(0, limit)
                .map(([k, [times, users]]) => [k, times, users.size, pct(users.size, players.size)]),
            ['step', 'times', 'players', 'share of players'],
        ),
        '',
    );

    out.push('## Purchase prompts', '');
    out.push(
        table(
            [...buys]
                .filter(([k]) => keep(k))
                .sort((a, b) => b[1][0] - a[1][0])
                .slice(0, limit)
                .map(([k, [o, bought, c, users]]) => [k, o, bought, c, users.size]),
            ['product@price', 'prompted', 'bought', 'cancelled', 'players'],
        ),
        '',
    );

    // ?path=a>b>c (or ?from=a): what came next after walking those steps; without
    // it, every single transition
    const path = (query.path ?? query.from ?? '').split(/\s*>\s*/).filter(Boolean);
    if (path.length >= MAX_PATH) throw new SyntaxError(`path can be at most ${MAX_PATH - 1} steps`);
    const prefix = path.join('\t');
    const rows = [];
    const totals = new Map();
    for (const [k, v] of edges) {
        const steps = k.split('\t');
        if (steps.length !== Math.max(path.length, 1) + 1) continue;
        if (path.length ? !k.startsWith(`${prefix}\t`) : !(keep(steps[0]) || keep(steps[1]))) continue;
        const from = steps.slice(0, -1).join(' > ');
        rows.push([from, steps.at(-1), v]);
        totals.set(from, (totals.get(from) ?? 0) + v);
    }
    out.push(`## Transitions${path.length ? ` after ${path.join(' > ')}` : ''}`, '');
    out.push(
        table(
            rows
                .sort((a, b) => b[2] - a[2])
                .slice(0, limit)
                .map(([from, to, v]) => [from, to, v, pct(v, totals.get(from))]),
            ['after', 'next', 'times', 'share'],
        ),
        '',
    );
    return out.join('\n');
}
