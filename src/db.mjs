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
    // Every repeated text value (event names, session ids, places, menus, kinds,
    // job ids) is stored once in `strings`; events2 holds its id. In the old
    // all-text `events` table those repeats were most of the file.
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;  -- wait out a reader's checkpoint instead of failing SQLITE_BUSY
        CREATE TABLE IF NOT EXISTS strings (
            id    INTEGER PRIMARY KEY,
            value TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS events2 (
            id          TEXT PRIMARY KEY,
            at          REAL NOT NULL,     -- unix seconds (server-synced clock)
            received_at REAL NOT NULL,
            user_id     INTEGER NOT NULL,
            session_id  INTEGER,           -- strings.id: per-server session (JobId:UserId:join)
            place       INTEGER,           -- strings.id: casual | thockland | competitive | lobby
            place_id    INTEGER,
            job_id      INTEGER,           -- strings.id
            studio      INTEGER NOT NULL DEFAULT 0,
            kind        INTEGER NOT NULL,  -- strings.id: button | world | event
            name        INTEGER NOT NULL,  -- strings.id: gui path / world target / event name
            menu        INTEGER,           -- strings.id: menu open at click time
            x           REAL,
            y           REAL,
            value       REAL,
            props       TEXT               -- JSON
        );
        CREATE INDEX IF NOT EXISTS events2_user_at ON events2 (user_id, at);
        CREATE INDEX IF NOT EXISTS events2_at ON events2 (at);
        -- events3: events2 with the event's text id swapped for an 8-byte hash.
        -- The id is only there to drop retried batches, and as text it was stored
        -- twice (row + unique index), ~70 bytes an event. New rows land here;
        -- events2 empties out through expiry and is then dropped.
        CREATE TABLE IF NOT EXISTS events3 (
            hash        INTEGER NOT NULL,  -- 64-bit hash of the game's event id
            at          REAL NOT NULL,
            received_at REAL NOT NULL,
            user_id     INTEGER NOT NULL,
            session_id  INTEGER,
            place       INTEGER,
            place_id    INTEGER,
            job_id      INTEGER,
            studio      INTEGER NOT NULL DEFAULT 0,
            kind        INTEGER NOT NULL,
            name        INTEGER NOT NULL,
            menu        INTEGER,
            x           REAL,
            y           REAL,
            value       REAL,
            props       TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS events3_hash ON events3 (hash);
        CREATE INDEX IF NOT EXISTS events3_user_at ON events3 (user_id, at);
        CREATE INDEX IF NOT EXISTS events3_at ON events3 (at);
        -- each player's first event ever, kept past raw-event expiry so "new
        -- player" still means new
        CREATE TABLE IF NOT EXISTS users (
            user_id  INTEGER PRIMARY KEY,
            first_at REAL NOT NULL
        );
        -- closed hours that got events after they closed: the rollup redoes them
        -- (and expiry waits for it), so a late batch isn't lost with its raw rows
        CREATE TABLE IF NOT EXISTS late_hours (hour INTEGER PRIMARY KEY);
    `);
    return db;
}

const hasTable = (db, name) => Boolean(db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
const hasLegacy = (db) => hasTable(db, 'events');
// the tables raw events live in, newest layout first ('events' is the all-text legacy one)
const eventTables = (db) => ['events3', ...(hasTable(db, 'events2') ? ['events2'] : []), ...(hasLegacy(db) ? ['events'] : [])];

// the game's text event id -> signed 64-bit integer for events3.hash
export const eventHash = (id) => BigInt.asIntN(64, BigInt(Bun.hash(id)));

// string -> strings.id for the writer, cached; dropped on rollback, since a
// rolled-back id can be handed to a different string next time
const writeIds = new WeakMap();
function stringId(db, value) {
    if (value === null) return null;
    let ids = writeIds.get(db);
    if (!ids) writeIds.set(db, (ids = new Map()));
    let id = ids.get(value);
    if (id === undefined) {
        id = db.query('INSERT INTO strings (value) VALUES (?) ON CONFLICT (value) DO UPDATE SET value = value RETURNING id').get(value).id;
        ids.set(value, id);
    }
    return id;
}

// strings.id -> string for readers. Ids are append-only, so each read only loads
// strings added since the last one.
const readStrings = new WeakMap();
function stringsOf(db) {
    let strings = readStrings.get(db);
    if (!strings) readStrings.set(db, (strings = [null]));
    for (const [id, value] of db.query('SELECT id, value FROM strings WHERE id >= ?').values(strings.length)) strings[id] = value;
    return strings;
}

function transaction(db, fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        writeIds.delete(db);
        throw error;
    }
}

const INSERT_SQL = `
    INSERT OR IGNORE INTO events3
        (hash, at, received_at, user_id, session_id, place, place_id, job_id,
         studio, kind, name, menu, x, y, value, props)
    VALUES
        ($hash, $at, $received_at, $user_id, $session_id, $place, $place_id, $job_id,
         $studio, $kind, $name, $menu, $x, $y, $value, $props)`;

// a cleaned event (or an old-table row) as an events3 row
const toRow = (db, e) => ({
    hash: eventHash(e.id),
    at: e.at,
    received_at: e.received_at,
    user_id: e.user_id,
    session_id: stringId(db, e.session_id),
    place: stringId(db, e.place),
    place_id: e.place_id,
    job_id: stringId(db, e.job_id),
    studio: e.studio,
    kind: stringId(db, e.kind),
    name: stringId(db, e.name),
    menu: stringId(db, e.menu),
    x: e.x,
    y: e.y,
    value: e.value,
    props: e.props,
});

// One-time copy of the old all-text `events` table into events3, run after the
// server is listening, a batch at a time with a yield between batches so /health
// and /ingest keep answering. Copied rows stay put until the table is dropped at
// the end (deleting them as it went was ~1s per 5000 rows of index upkeep);
// `migrated.upto` is the last copied rowid, and reads skip old rows up to it.
// Ground rows still waiting for the old purge are dropped on the way.
// ponytail: the dropped table's pages are reused by new rows rather than given
// back to the volume; VACUUM if the file itself ever needs to shrink.
export async function migrateEvents(db, batch = 5000) {
    if (!hasLegacy(db)) return;
    db.exec('CREATE TABLE IF NOT EXISTS migrated (upto INTEGER NOT NULL); INSERT INTO migrated SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM migrated)');
    const pick = db.query('SELECT rowid AS rid, * FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?');
    const insert = db.query(INSERT_SQL);
    const mark = db.query('UPDATE migrated SET upto = ?');
    for (let rows; (rows = pick.all(migratedUpto(db), batch)).length; ) {
        transaction(db, () => {
            for (const r of rows) if (!(r.kind === 'world' && GROUND_TAPS.has(r.name))) insert.run(toRow(db, r));
            mark.run(rows.at(-1).rid);
        });
        await new Promise((r) => setTimeout(r, 0));
    }
    db.exec('DROP TABLE events; DROP TABLE migrated');
}

const migratedUpto = (db) => db.query(`SELECT upto FROM migrated`).get()?.upto ?? 0;
const hasMigrated = (db) => Boolean(db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrated'`).get());

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
    const insert = db.query(INSERT_SQL);
    const late = db.query('INSERT OR IGNORE INTO late_hours (hour) VALUES (?)');
    // while events2 still holds rows, a retry of a batch it took must not land twice
    const inOld = hasTable(db, 'events2') ? db.query('SELECT 1 FROM events2 WHERE id = ?') : null;
    let accepted = 0;
    let rejected = 0;
    transaction(db, () => {
        for (const raw of rawEvents) {
            const event = cleanEvent(raw, receivedAt);
            if (!event) {
                rejected++;
                continue;
            }
            if (inOld?.get(event.id)) continue;
            if (!Number(insert.run(toRow(db, event)).changes)) continue;
            accepted++;
            const hour = Math.floor(event.at / 3600) * 3600;
            if (hour + 3600 <= receivedAt) late.run(hour);
        }
    });
    return { accepted, rejected };
}

// The WHERE clause shared by the read queries. Studio rows are excluded unless
// asked. Pass `legacy` (the db) when reading the old all-text table, which can
// still hold ground rows and rows the migration already copied.
function readFilter({ since = null, until = null, userIds = null, includeStudio = false }, legacy = null) {
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
    if (legacy) {
        // rows the migration already copied into events2/events3
        where.push('rowid > $upto');
        params.upto = hasMigrated(legacy) ? migratedUpto(legacy) : 0;
        where.push(`NOT (kind = 'world' AND name IN (SELECT value FROM json_each($ground)))`);
        params.ground = JSON.stringify([...GROUND_TAPS]);
    }
    return { where: where.join(' AND ') || '1', params };
}

// Players with events in the window, ascending, so reads can work through them a
// batch at a time instead of holding every event in the window at once.
export function readUsers(db, filter = {}) {
    const users = new Set();
    for (const table of eventTables(db)) {
        const { where, params } = readFilter(filter, table === 'events' ? db : null);
        for (const [id] of db.query(`SELECT DISTINCT user_id FROM ${table} WHERE ${where}`).values(params)) users.add(id);
    }
    return [...users].sort((a, b) => a - b);
}

// Columns a journey reads. received_at, place_id, job_id and id are write-side
// bookkeeping, and every extra column costs a JS property per row.
const READ_COLUMNS = 'at, user_id, session_id, place, kind, name, menu, x, y, value, props';

// Events grouped by player, in time order, optionally filtered to some players.
// Without `userIds` rows come off the `at` index in time order and are sorted here
// (ORDER BY user_id, at walks the user index over the WHOLE table, which made a
// 1h report take 11s); with them each player is one user index seek. Rows are
// streamed, and every name/session/place is one shared string.
export function queryEvents(db, filter = {}) {
    const rows = [];
    const strings = stringsOf(db);
    const text = (id) => (id === null ? null : strings[id]);
    const { where, params } = readFilter(filter);
    for (const table of eventTables(db).filter((t) => t !== 'events')) {
        for (const r of db.query(`SELECT ${READ_COLUMNS} FROM ${table} WHERE ${where}`).iterate(params)) {
            rows.push({
                at: r.at,
                user_id: r.user_id,
                session_id: text(r.session_id),
                place: text(r.place),
                kind: text(r.kind),
                name: text(r.name),
                menu: text(r.menu),
                x: r.x,
                y: r.y,
                value: r.value,
                props: r.props ? JSON.parse(r.props) : null,
            });
        }
    }
    if (hasLegacy(db)) {
        const seen = new Map();
        const intern = (v) => (v === null ? v : (seen.get(v) ?? (seen.set(v, v), v)));
        const legacy = readFilter(filter, db);
        for (const r of db.query(`SELECT ${READ_COLUMNS} FROM events WHERE ${legacy.where}`).iterate(legacy.params)) {
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
    }
    // stable sort; every plan yields same-time rows in rowid order
    return rows.sort((a, b) => a.user_id - b.user_id || a.at - b.at);
}

// Each player's first event anywhere in the log, for telling new players from
// returning ones. One min() per player and table: SQLite answers each with a
// single user-index seek, which an IN + GROUP BY (or a studio filter) would lose.
// `users` remembers players whose early events have expired.
export function firstSeen(db, userIds) {
    const stmts = [
        db.query('SELECT first_at AS at FROM users WHERE user_id = ?'),
        ...eventTables(db).map((t) => db.query(`SELECT min(at) AS at FROM ${t} WHERE user_id = ?`)),
    ];
    return new Map(
        [...userIds].map((id) => {
            const ats = stmts.map((s) => s.get(id)?.at ?? null).filter((at) => at !== null);
            return [id, ats.length ? Math.min(...ats) : null];
        }),
    );
}

// The earliest raw event still stored, or null.
export function firstEventAt(db) {
    const ats = eventTables(db).map((t) => db.query(`SELECT min(at) AS at FROM ${t}`).get().at).filter((at) => at !== null);
    return ats.length ? Math.min(...ats) : null;
}

// Deletes raw events older than `before`, a batch at a time so /ingest's writes
// never wait long, and drops events2 once it is empty. Each player's earliest
// expiring event goes into `users` first, so no first visit is lost with it. Only
// call it for hours the rollup already has.
// shortcut: freed pages are reused by new rows, not given back to the volume; VACUUM
// once if the file itself needs to shrink.
export function expireEvents(db, before, batch = 5000) {
    // never past an hour the rollup still has to redo
    before = Math.min(before, db.query('SELECT min(hour) AS hour FROM late_hours').get().hour ?? Infinity);
    let deleted = 0;
    for (const table of eventTables(db).filter((t) => t !== 'events')) {
        db.query(
            `INSERT INTO users (user_id, first_at) SELECT user_id, min(at) FROM ${table} WHERE at < ? GROUP BY user_id
             ON CONFLICT (user_id) DO UPDATE SET first_at = min(first_at, excluded.first_at)`,
        ).run(before);
        const del = db.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE at < ? LIMIT ?)`);
        for (let n; (n = Number(del.run(before, batch).changes)); ) deleted += n;
        if (table === 'events2' && !db.query('SELECT 1 FROM events2 LIMIT 1').get()) db.exec('DROP TABLE events2');
    }
    return deleted;
}
