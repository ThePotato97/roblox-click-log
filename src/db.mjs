// SQLite store for the click journey log. Uses Bun's built-in bun:sqlite, so the
// server has no dependencies at all.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

const KINDS = new Set(['button', 'world', 'event']);
const MAX_ID = 64;
const MAX_NAME = 200;
const MAX_SHORT = 100;
const MAX_PROPS_JSON = 4096;
// World taps and touches on the map's structure (the invisible floor, the lobby
// floor, the boundary walls): players tapping to move or a character walking,
// never interacting with anything. ~85% of what the game sent (touch:Collision
// alone ~39k an hour), so they're refused at ingest and were purged once.
const GROUND_TAPS = new Set([
    'world:Collision',
    'world:Lobby/floor',
    'touch:Collision',
    'touch:Lobby/floor',
    'touch:InvisibleBackstop',
    'touch:VisibleWall',
]);

export function openDb(path) {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true });
    }
    // strict: named params bind from plain keys ({ since }) to $since
    const db = new Database(path, { strict: true });
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS events (
            id          TEXT PRIMARY KEY,
            at          REAL NOT NULL,     -- unix seconds (server-synced clock)
            received_at REAL NOT NULL,
            user_id     INTEGER NOT NULL,
            session_id  TEXT,              -- per-server session (JobId:UserId:join)
            place       TEXT,              -- casual | thockland | competitive | lobby
            place_id    INTEGER,
            job_id      TEXT,
            studio      INTEGER NOT NULL DEFAULT 0,
            kind        TEXT NOT NULL,     -- button | world | event
            name        TEXT NOT NULL,     -- gui path / world target / event name
            menu        TEXT,              -- menu open at click time
            x           REAL,
            y           REAL,
            value       REAL,
            props       TEXT               -- JSON
        );
        CREATE INDEX IF NOT EXISTS events_user_at ON events (user_id, at);
        CREATE INDEX IF NOT EXISTS events_at ON events (at);
    `);
    return db;
}

// One-time purge of ground rows stored before ingest refused them. Runs after
// the server is listening, a batch at a time, yielding between batches so
// /health and /ingest keep answering however many rows there are.
export async function purgeGround(db, batch = 5000) {
    if (db.prepare('PRAGMA user_version').get().user_version >= 1) return;
    const del = db.prepare(`DELETE FROM events WHERE rowid IN (
        SELECT rowid FROM events WHERE kind = 'world' AND name IN (SELECT value FROM json_each(?)) LIMIT ?)`);
    const names = JSON.stringify([...GROUND_TAPS]);
    while (del.run(names, batch).changes > 0) await new Promise((r) => setTimeout(r, 0));
    db.exec('PRAGMA user_version = 1');
}

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Normalise one incoming event; null when it is unusable.
export function cleanEvent(raw, receivedAt) {
    if (raw === null || typeof raw !== 'object') return null;
    const id = str(raw.id, MAX_ID);
    const at = num(raw.at);
    const userId = num(raw.user_id);
    const name = str(raw.name, MAX_NAME);
    if (!id || at === null || userId === null || !Number.isInteger(userId) || !name) return null;
    if (!KINDS.has(raw.kind)) return null;
    if (raw.kind === 'world' && GROUND_TAPS.has(name)) return null; // never read, ~85% of volume
    let props = null;
    if (raw.props && typeof raw.props === 'object') {
        const json = JSON.stringify(raw.props);
        if (json.length <= MAX_PROPS_JSON) props = json;
    }
    return {
        id,
        at,
        received_at: receivedAt,
        user_id: userId,
        session_id: str(raw.session_id, MAX_NAME),
        place: str(raw.place, MAX_SHORT),
        place_id: num(raw.place_id),
        job_id: str(raw.job_id, MAX_SHORT),
        studio: raw.studio === true ? 1 : 0,
        kind: raw.kind,
        name,
        menu: str(raw.menu, MAX_SHORT),
        x: num(raw.x),
        y: num(raw.y),
        value: num(raw.value),
        props,
    };
}

// Insert a batch in one transaction. Duplicate ids (a game server retrying a
// batch it thinks failed) are ignored. Returns { accepted, rejected }.
export function insertEvents(db, rawEvents, receivedAt = Date.now() / 1000) {
    const insert = db.prepare(`
        INSERT OR IGNORE INTO events
            (id, at, received_at, user_id, session_id, place, place_id, job_id,
             studio, kind, name, menu, x, y, value, props)
        VALUES
            ($id, $at, $received_at, $user_id, $session_id, $place, $place_id, $job_id,
             $studio, $kind, $name, $menu, $x, $y, $value, $props)
    `);
    let accepted = 0;
    let rejected = 0;
    db.exec('BEGIN');
    try {
        for (const raw of rawEvents) {
            const event = cleanEvent(raw, receivedAt);
            if (!event) {
                rejected++;
                continue;
            }
            accepted += Number(insert.run(event).changes);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    return { accepted, rejected };
}

// Columns a journey reads. received_at, place_id, job_id, studio and id are
// write-side bookkeeping, and every extra column costs a JS property per row.
const READ_COLUMNS = 'at, user_id, session_id, place, kind, name, menu, x, y, value, props';

// Events grouped by player, in time order, optionally filtered. Studio rows are
// excluded unless asked.
//
// Rows come off the `at` index in time order and are sorted here. Asking SQLite
// for ORDER BY user_id, at instead makes it walk events_user_at over the WHOLE
// table and fetch every row by rowid at random to apply the time filter, which
// is what made a 1h report take 11s.
export function queryEvents(db, { since = null, until = null, userId = null, includeStudio = false } = {}) {
    const where = [];
    const params = {};
    if (since !== null) {
        where.push('at >= $since');
        params.since = since;
    }
    if (until !== null) {
        where.push('at < $until');
        params.until = until;
    }
    if (userId !== null) {
        where.push('user_id = $userId');
        params.userId = userId;
    }
    if (!includeStudio) where.push('studio = 0');
    const sql = `SELECT ${READ_COLUMNS} FROM events WHERE ${where.join(' AND ')}`;
    // rows as arrays (values()), copied into plain objects
    const rows = [];
    for (const [at, user_id, session_id, place, kind, name, menu, x, y, value, props] of db.prepare(sql).values(params)) {
        rows.push({ at, user_id, session_id, place, kind, name, menu, x, y, value, props: props ? JSON.parse(props) : null });
    }
    // stable sort; every plan yields same-time rows in rowid order
    return rows.sort((a, b) => a.user_id - b.user_id || a.at - b.at);
}
