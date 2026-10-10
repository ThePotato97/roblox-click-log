// One-off copy of the old SQLite log (events2 + strings) into ClickHouse:
//
//   bun src/migrate.mjs /data/clicks.db
//
// Safe to rerun or resume from the top: copies of a row are dropped in storage
// (ReplacingMergeTree on user_id, at, id).
import { Database } from 'bun:sqlite';
import { GROUND_TAPS, openDb } from './db.mjs';

export async function migrateSqlite(sqlite, db, batch = 50_000, log = () => {}) {
    const strings = [null];
    for (const [id, value] of sqlite.query('SELECT id, value FROM strings').values()) strings[id] = value;
    const text = (id) => (id === null ? '' : strings[id]);
    const pick = sqlite.query(`SELECT rowid AS rid, * FROM events2 WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    let copied = 0;
    for (let rows, after = 0; (rows = pick.all(after, batch)).length; after = rows.at(-1).rid) {
        const out = [];
        for (const r of rows) {
            if (text(r.kind) === 'world' && GROUND_TAPS.has(text(r.name))) continue;
            out.push({
                id: r.id,
                at: r.at.toFixed(3),
                received_at: r.received_at.toFixed(3),
                user_id: r.user_id,
                session_id: text(r.session_id),
                place: text(r.place),
                place_id: r.place_id,
                job_id: text(r.job_id),
                studio: r.studio === 1,
                kind: text(r.kind),
                name: text(r.name),
                menu: text(r.menu),
                x: r.x,
                y: r.y,
                value: r.value,
                props: r.props ?? '',
            });
        }
        await db.exec('INSERT INTO events FORMAT JSONEachRow', { body: out.map((r) => JSON.stringify(r)).join('\n') });
        copied += out.length;
        log(`${copied} rows copied`);
    }
    return copied;
}

if (process.argv[1]?.endsWith('migrate.mjs')) {
    const path = process.argv[2];
    if (!path) {
        console.error('usage: bun src/migrate.mjs <clicks.db>');
        process.exit(1);
    }
    const db = openDb();
    await db.init();
    const copied = await migrateSqlite(new Database(path, { readonly: true }), db, 50_000, console.log);
    console.log(`done: ${copied} rows`);
}
