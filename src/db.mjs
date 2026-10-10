// ClickHouse store for the click journey log, over its HTTP interface (plain
// fetch, so the server still has no dependencies).
//
//   CLICKHOUSE_URL       default http://127.0.0.1:8123
//   CLICKHOUSE_DB        default clicklog (created if missing)
//   CLICKHOUSE_USER      default 'default'
//   CLICKHOUSE_PASSWORD  default ''

const KINDS = new Set(['button', 'world', 'event']);
const MAX_ID = 64;
const MAX_NAME = 200;
const MAX_SHORT = 100;
const MAX_PROPS_JSON = 4096;
// World taps and touches on the map's structure (the invisible floor, the lobby
// floor, the boundary walls): players tapping to move or a character walking,
// never interacting with anything. ~85% of what the game sent (touch:Collision
// alone ~39k an hour), so they're refused at ingest.
export const GROUND_TAPS = new Set([
    'world:Collision',
    'world:Lobby/floor',
    'touch:Collision',
    'touch:Lobby/floor',
    'touch:InvisibleBackstop',
    'touch:VisibleWall',
]);

// Raw events, kept forever. Sorted by player then time, so a player's journey is
// one contiguous read; repeated strings are LowCardinality dictionaries and the
// rest is ZSTD. ReplacingMergeTree drops a retried batch's duplicates on merge,
// and reads use FINAL so they never see one before that.
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS events (
        id          String,
        at          DateTime64(3, 'UTC') CODEC(Delta, ZSTD),  -- server-synced clock
        received_at DateTime64(3, 'UTC') CODEC(Delta, ZSTD),
        user_id     Int64,
        session_id  String CODEC(ZSTD),                         -- JobId:UserId:join
        place       LowCardinality(String),                     -- casual | thockland | competitive | lobby
        place_id    Nullable(Int64),
        job_id      String CODEC(ZSTD),
        studio      Bool,
        kind        LowCardinality(String),                     -- button | world | event
        name        LowCardinality(String),                     -- gui path / world target / event name
        menu        LowCardinality(String),                     -- menu open at click time
        x           Nullable(Float64),
        y           Nullable(Float64),
        value       Nullable(Float64),
        props       String CODEC(ZSTD)                          -- JSON, '' when none
    )
    ENGINE = ReplacingMergeTree
    PARTITION BY toYYYYMM(at)
    ORDER BY (user_id, at, id)`;

export function openDb({
    url = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123',
    database = process.env.CLICKHOUSE_DB ?? 'clicklog',
    user = process.env.CLICKHOUSE_USER ?? 'default',
    password = process.env.CLICKHOUSE_PASSWORD ?? '',
} = {}) {
    const headers = { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password };
    // One statement. `params` bind {name:Type} placeholders server-side; `session`
    // keeps temporary tables between statements; `body` is data for an INSERT.
    // Returns the Response, whose body is still unread.
    async function query(sql, { params = {}, session, body, settings = {}, db = database } = {}) {
        const search = new URLSearchParams({ database: db, ...settings });
        if (session) search.set('session_id', session);
        for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, Array.isArray(v) ? `[${v.join(',')}]` : String(v));
        if (body !== undefined) search.set('query', sql);
        const res = await fetch(`${url}/?${search}`, { method: 'POST', headers, body: body ?? sql });
        if (!res.ok) throw Object.assign(new Error(`clickhouse: ${(await res.text()).trim()}`), { clickhouse: true });
        return res;
    }
    // rows of a SELECT as objects, 64-bit integers as JSON numbers
    const rows = async (sql, opts = {}) => {
        const settings = { output_format_json_quote_64bit_integers: 0, ...opts.settings };
        const text = await (await query(`${sql} FORMAT JSONEachRow`, { ...opts, settings })).text();
        return text ? text.trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
    };
    const exec = async (sql, opts) => void (await (await query(sql, opts)).text());
    return {
        database,
        query,
        rows,
        exec,
        async init() {
            await exec(`CREATE DATABASE IF NOT EXISTS ${database}`, { db: 'default' });
            await exec(SCHEMA);
        },
    };
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
    if (!id || at === null || at < 0 || userId === null || !Number.isInteger(userId) || !name) return null;
    if (!KINDS.has(raw.kind)) return null;
    if (raw.kind === 'world' && GROUND_TAPS.has(name)) return null; // never read, ~85% of volume
    let props = '';
    if (raw.props && typeof raw.props === 'object') {
        const json = JSON.stringify(raw.props);
        if (json.length <= MAX_PROPS_JSON) props = json;
    }
    return {
        id,
        // DateTime64 reads unix seconds from a string, not a JSON number
        at: at.toFixed(3),
        received_at: receivedAt.toFixed(3),
        user_id: userId,
        session_id: str(raw.session_id, MAX_NAME) ?? '',
        place: str(raw.place, MAX_SHORT) ?? '',
        place_id: num(raw.place_id),
        job_id: str(raw.job_id, MAX_SHORT) ?? '',
        studio: raw.studio === true,
        kind: raw.kind,
        name,
        menu: str(raw.menu, MAX_SHORT) ?? '',
        x: num(raw.x),
        y: num(raw.y),
        value: num(raw.value),
        props,
    };
}

// Rows (already cleaned) in one INSERT. async_insert lets ClickHouse merge the
// game servers' small batches into bigger parts; waiting for it means a 200 is
// only sent once the rows are on disk.
export async function insertRows(db, rows) {
    if (!rows.length) return;
    await db.exec('INSERT INTO events FORMAT JSONEachRow', {
        body: rows.map((r) => JSON.stringify(r)).join('\n'),
        settings: { async_insert: 1, wait_for_async_insert: 1 },
    });
}

// Returns { accepted, rejected }. A retried batch is accepted again; the copies
// are dropped in storage (see SCHEMA).
export async function insertEvents(db, rawEvents, receivedAt = Date.now() / 1000) {
    const rows = [];
    for (const raw of rawEvents) {
        const event = cleanEvent(raw, receivedAt);
        if (event) rows.push(event);
    }
    await insertRows(db, rows);
    return { accepted: rows.length, rejected: rawEvents.length - rows.length };
}
