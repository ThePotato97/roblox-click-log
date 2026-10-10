// Click journey log server. Game servers POST batches to /ingest
// (@Server/ClickLogSink); /report and /journeys read them back.
//
//   HOST          bind address (default 127.0.0.1: local only; 0.0.0.0 to expose)
//   PORT          listen port (default 8787)
//   CLICKHOUSE_*  where the events live (see db.mjs)
//   INGEST_TOKEN  the game's `click_log_token` secret; defaults to 'local-dev'
//                 (what Studio sends) and is REQUIRED when HOST is not loopback
//   READ_TOKEN    bearer token for the read endpoints (default: INGEST_TOKEN)
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createGzip, gunzipSync } from 'node:zlib';
import { insertEvents, openDb } from './db.mjs';
import { runRead } from './reads.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // after decompression
const MAX_EVENTS_PER_REQUEST = 2000;
// what Studio playtests send (ClickLogSink LOCAL_TOKEN); only accepted on loopback
const LOCAL_TOKEN = 'local-dev';

function tokenMatches(header, expected) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const want = Buffer.from(expected);
    return given.length === want.length && timingSafeEqual(given, want);
}

// waits for `out` to drain, or for the response to close (then it never will)
const drainOrClose = (out, res) =>
    new Promise((resolve) => {
        const done = () => {
            out.off('drain', done);
            res.off('close', done);
            resolve();
        };
        out.on('drain', done);
        res.on('close', done);
    });

function send(res, status, body, type = 'application/json') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(payload);
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
        chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') {
        body = gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
    }
    return JSON.parse(body.toString('utf8'));
}

export function createApp({ db, ingestToken, readToken = ingestToken }) {
    if (!ingestToken) throw new Error('INGEST_TOKEN is required');
    return createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                return send(res, 200, { ok: true, image: process.env.IMAGE ?? null });
            }
            if (req.method === 'POST' && url.pathname === '/ingest') {
                if (!tokenMatches(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'unauthorized' });
                const body = await readBody(req);
                const events = Array.isArray(body?.events) ? body.events : null;
                if (!events || events.length > MAX_EVENTS_PER_REQUEST) return send(res, 400, { error: 'expected { events: [...] }' });
                return send(res, 200, await insertEvents(db, events));
            }
            if (req.method === 'GET' && ['/report', '/journeys', '/paths'].includes(url.pathname)) {
                if (!tokenMatches(req.headers.authorization, readToken)) return send(res, 401, { error: 'unauthorized' });
                const query = Object.fromEntries(url.searchParams);
                const result = await runRead(db, url.pathname, query);
                // gzip when asked: a journey repeats the same names and keys event after
                // event, so 140MB of JSON goes out as ~13MB
                const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
                res.writeHead(result.status, {
                    'Content-Type': `${result.type}; charset=utf-8`,
                    ...(gzip && { 'Content-Encoding': 'gzip' }),
                });
                const out = gzip ? createGzip() : res;
                if (gzip) out.pipe(res);
                for await (const part of result.parts ?? [result.body]) {
                    if (res.destroyed) break; // client went away; break cancels the query
                    if (!out.write(part)) await drainOrClose(out, res);
                }
                return out.end();
            }
            return send(res, 404, { error: 'not found' });
        } catch (error) {
            // ClickHouse down or refusing: 503, so the game's sink keeps the batch and retries
            const status = error.status ?? (error instanceof SyntaxError ? 400 : error.clickhouse || error.code === 'ConnectionRefused' ? 503 : 500);
            if (status >= 500) console.error(error);
            if (res.headersSent) return res.destroy();
            return send(res, status, { error: status >= 500 ? 'internal error' : error.message });
        }
    });
}

if (process.argv[1]?.endsWith('server.mjs')) {
    const host = process.env.HOST ?? '127.0.0.1';
    const port = Number(process.env.PORT ?? 8787);
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const ingestToken = process.env.INGEST_TOKEN || (loopback ? LOCAL_TOKEN : null);
    if (!ingestToken) {
        console.error('INGEST_TOKEN is required when HOST is not loopback');
        process.exit(1);
    }
    const db = openDb();
    // ClickHouse can still be starting (it's a sidecar); /ingest answers 503 until then
    const init = () => db.init().catch((error) => (console.error('clickhouse not ready', error.message), setTimeout(init, 5000)));
    init();
    createApp({ db, ingestToken, readToken: process.env.READ_TOKEN || undefined }).listen(port, host, () => {
        console.log(`click-log-server listening on http://${host}:${port}`);
    });
}
