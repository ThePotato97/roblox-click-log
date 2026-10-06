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

// The WHERE clause shared by the read queries. Studio rows are excluded unless asked.
function readFilter({ since = null, until = null, userIds = null, includeStudio = false }) {
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
    if (userIds !== null) {
        where.push('user_id IN (SELECT value FROM json_each($userIds))');
        params.userIds = JSON.stringify(userIds);
    }
    if (!includeStudio) where.push('studio = 0');
    // ground rows can still be on disk until purgeGround finishes; loading
    // millions of them is what ran a 24h read out of memory
    where.push(`NOT (kind = 'world' AND name IN (SELECT value FROM json_each($ground)))`);
    params.ground = JSON.stringify([...GROUND_TAPS]);
    return { where: where.join(' AND '), params };
}

// Players with events in the window, ascending, so reads can work through them a
// batch at a time instead of holding every event in the window at once.
export function readUsers(db, filter = {}) {
    const { where, params } = readFilter(filter);
    return db.prepare(`SELECT DISTINCT user_id FROM events WHERE ${where} ORDER BY user_id`).values(params).map((r) => r[0]);
}

// Events grouped by player, in time order, optionally filtered to some players.
// Without `userIds` rows come off the `at` index in time order and are sorted here
// (ORDER BY user_id, at walks events_user_at over the WHOLE table, which made a 1h
// report take 11s); with them each player is one events_user_at seek.
export function queryEvents(db, filter = {}) {
    const { where, params } = readFilter(filter);
    // iterate() streams rows (values() materialised every row a second time), and
    // the few distinct names/places/sessions are shared instead of one copy per row
    const seen = new Map();
    const intern = (s) => (s === null ? s : (seen.get(s) ?? (seen.set(s, s), s)));
    const rows = [];
    for (const r of db.prepare(`SELECT ${READ_COLUMNS} FROM events WHERE ${where}`).iterate(params)) {
        rows.push({
            at: r.at,
            user_id: r.user_id,
            session_id: intern(r.session_id),
            place: intern(r.place),
            kind: intern(r.kind),
            name: intern(r.name),
            menu: intern(r.menu),
            x: r.x,
            y: r.y,
            value: r.value,
            props: r.props ? JSON.parse(r.props) : null,
        });
    }
    // stable sort; every plan yields same-time rows in rowid order
    return rows.sort((a, b) => a.user_id - b.user_id || a.at - b.at);
}

// Each player's first event anywhere in the log, for telling new players from
// returning ones. One min() per player: SQLite answers it with a single
// events_user_at seek, which an IN + GROUP BY (or a studio filter) would lose.
export function firstSeen(db, userIds) {
    const stmt = db.prepare('SELECT min(at) AS at FROM events WHERE user_id = ?');
    return new Map([...userIds].map((id) => [id, stmt.get(id).at]));
}
