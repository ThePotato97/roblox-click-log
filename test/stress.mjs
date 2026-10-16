import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/server.mjs';
import { openDb } from '../src/db.mjs';

const integer = (name, fallback, minimum = 1) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
};

const ROWS = integer('STRESS_ROWS', 20_000_000);
const PLAYERS = integer('STRESS_PLAYERS', 50_000);
const HOT_ROWS = integer('STRESS_HOT_ROWS', 250_000, 0);
const QUERY_MEMORY = integer('STRESS_QUERY_MEMORY_BYTES', 1_500_000_000);
const QUERY_BUDGET = integer('STRESS_QUERY_BUDGET_BYTES', 1_200_000_000);
const APP_BUDGET = integer('STRESS_APP_BUDGET_BYTES', 2_500_000_000);
const REQUEST_TIMEOUT = integer('STRESS_REQUEST_TIMEOUT_MS', 180_000);
const CONCURRENCY = integer('STRESS_CONCURRENCY', 2);
const RESULT_FILE = process.env.STRESS_RESULTS ?? 'stress-results.json';
const BASE = 1_790_000_000;
const UNTIL = BASE + 7 * 86400;
const TOKEN = 'stress-secret';
const database = `stress_${Date.now()}_${process.pid}`;
const db = openDb({ database });
const results = [];
let server;
let activeTag = '';

const mib = (bytes) => Math.round(Number(bytes) / 1048576 * 10) / 10;
const maxRssBytes = () => process.resourceUsage().maxRSS * 1024;
const querySettings = {
    max_memory_usage: QUERY_MEMORY,
    max_execution_time: Math.ceil(REQUEST_TIMEOUT / 1000),
    max_threads: 4,
    log_queries: 1,
};

// Every statement made by one HTTP request gets the same log_comment, allowing
// the suite to recover its peak memory and exception rows from system.query_log.
const measuredDb = { database };
for (const method of ['exec', 'rows', 'query']) {
    measuredDb[method] = (sql, opts = {}) => db[method](sql, {
        ...opts,
        settings: {
            ...opts.settings,
            ...querySettings,
            ...(activeTag && { log_comment: activeTag }),
        },
    });
}

function query(params) {
    return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined)).toString();
}

async function seed() {
    console.log(JSON.stringify({ phase: 'seed', rows: ROWS, players: PLAYERS, hotRows: HOT_ROWS }));
    const started = performance.now();
    await db.exec(`INSERT INTO events
        WITH
            number % {players:UInt64} + 1 AS uid,
            intDiv(number, {players:UInt64}) AS seq,
            seq % 24 AS pos,
            intDiv(seq, 24) AS block,
            block % 7 AS day,
            intDiv(block, 7) AS round,
            fromUnixTimestamp64Milli({baseMs:Int64} + day * 86400000 + round * 3600000
                + pos * 30000 + uid % 1000) AS ts,
            arrayElement(['control', 'treatment_a', 'treatment_b', 'treatment_c'], toUInt8(uid % 4) + 1) AS arm,
            concat('Product_', toString(uid % 512)) AS product
        SELECT
            concat('stress-', toString(number)) AS id,
            ts AS at,
            ts AS received_at,
            toInt64(uid) AS user_id,
            concat('job:', toString(uid), ':', toString(day), ':', toString(round), ':',
                toString(intDiv(pos, 12))) AS session_id,
            arrayElement(['casual', 'competitive', 'lobby'], toUInt8(uid % 3) + 1) AS place,
            CAST(NULL, 'Nullable(Int64)') AS place_id,
            concat('job-', toString(uid % 1000)) AS job_id,
            false AS studio,
            if(pos IN (2, 6, 14, 18), 'button', if(pos IN (7, 19), 'world', 'event')) AS kind,
            multiIf(
                pos IN (0, 12), 'config_exposure',
                pos IN (1, 13), 'session_started',
                pos IN (3, 15), 'Purchase:PromptOpened',
                pos IN (4, 16), 'Purchase:PromptFinished',
                pos IN (11, 23), 'session_ended',
                pos IN (2, 14), concat('MainUI/Root/Shop/Items/Card_', toString(uid % 4096), '/BuyButton'),
                pos IN (6, 18), concat('MainUI/Root/Inventory/Item_', toString(uid % 8192)),
                pos IN (7, 19), concat('world:target_', toString(uid % 2048)),
                concat('Event_', toString((uid + pos) % 4096))) AS name,
            if(pos IN (2, 3, 4, 14, 15, 16), 'Shop', '') AS menu,
            CAST(NULL, 'Nullable(Float64)') AS x,
            CAST(NULL, 'Nullable(Float64)') AS y,
            if(pos IN (11, 23), CAST(330, 'Nullable(Float64)'), CAST(NULL, 'Nullable(Float64)')) AS value,
            multiIf(
                pos = 0, concat('{\"key\":\"offer\",\"value\":\"', arm, '\"}'),
                pos = 12, concat('{\"key\":\"segment\",\"value\":\"', if(uid % 2 = 0, 'mobile', 'desktop'), '\"}'),
                pos IN (3, 15), concat('{\"name\":\"', product, '\",\"price\":', toString(25 + uid % 500),
                    ',\"source\":\"', if(uid % 3 = 0, 'auto', 'shop'), '\"}'),
                pos IN (4, 16), concat('{\"name\":\"', product, '\",\"price\":999,\"receipt_price\":',
                    toString(25 + uid % 500), ',\"purchased\":', if(uid % 20 = 0, 'true', 'false'), '}'),
                pos IN (5, 17), concat('{\"platform\":\"', if(uid % 2 = 0, 'mobile', 'desktop'),
                    '\",\"device\":\"', if(uid % 3 = 0, 'phone', 'pc'), '\",\"level\":\"',
                    toString(uid % 100), '\",\"country\":\"', arrayElement(['GB', 'US', 'BR', 'DE'], toUInt8(uid % 4) + 1), '\"}'),
                '') AS props
        FROM numbers_mt({rows:UInt64})`, {
        params: { rows: ROWS, players: PLAYERS, baseMs: BASE * 1000 },
        settings: { max_threads: 4, max_insert_threads: 4 },
    });

    if (HOT_ROWS) {
        await db.exec(`INSERT INTO events
            WITH
                toInt64({players:UInt64} + 1) AS uid,
                fromUnixTimestamp64Milli({baseMs:Int64} + number) AS ts
            SELECT
                concat('hot-', toString(number)), ts, ts, uid,
                concat('hot:', toString(uid)), 'casual', CAST(NULL, 'Nullable(Int64)'), 'hot-job', false,
                if(number IN (0, 1, {last:UInt64}), 'event', 'button'),
                multiIf(number = 0, 'config_exposure', number = 1, 'session_started', number = {last:UInt64},
                    'session_ended', concat('Hot/Action_', toString(number % 32))),
                if(number > 1 AND number < {last:UInt64}, 'Stress', ''),
                CAST(NULL, 'Nullable(Float64)'), CAST(NULL, 'Nullable(Float64)'),
                if(number = {last:UInt64}, CAST({duration:Float64}, 'Nullable(Float64)'), CAST(NULL, 'Nullable(Float64)')),
                if(number = 0, '{\"key\":\"offer\",\"value\":\"control\"}', '')
            FROM numbers_mt({hotRows:UInt64})`, {
            params: {
                players: PLAYERS, baseMs: BASE * 1000, hotRows: HOT_ROWS,
                last: HOT_ROWS - 1, duration: HOT_ROWS / 1000,
            },
            settings: { max_threads: 4, max_insert_threads: 4 },
        });
    }
    const [stored] = await db.rows('SELECT count() AS rows, uniqExact(user_id) AS players FROM events FINAL');
    assert.equal(Number(stored.rows), ROWS + HOT_ROWS);
    assert.equal(Number(stored.players), PLAYERS + (HOT_ROWS ? 1 : 0));
    console.log(JSON.stringify({ phase: 'seeded', ...stored, ms: Math.round(performance.now() - started) }));
}

async function consume(response, mode = 'buffer') {
    if (mode === 'stream') {
        let bytes = 0;
        for await (const chunk of response.body) bytes += chunk.length;
        return { bytes, body: '' };
    }
    const body = await response.text();
    return { bytes: Buffer.byteLength(body), body };
}

async function queryMetrics(tag) {
    await db.exec('SYSTEM FLUSH LOGS');
    const [summary] = await db.rows(`SELECT
            countIf(type = 'QueryFinish') AS finished,
            countIf(type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')) AS failed,
            max(memory_usage) AS peak_memory,
            sumIf(read_rows, type = 'QueryFinish') AS read_rows,
            sumIf(read_bytes, type = 'QueryFinish') AS read_bytes,
            sumIf(query_duration_ms, type = 'QueryFinish') AS query_ms
        FROM system.query_log WHERE log_comment = {tag:String}`, { params: { tag } });
    const [top] = await db.rows(`SELECT memory_usage, query_duration_ms, read_rows,
            substring(replaceRegexpAll(query, '\\s+', ' '), 1, 220) AS query
        FROM system.query_log
        WHERE log_comment = {tag:String} AND type = 'QueryFinish'
        ORDER BY memory_usage DESC LIMIT 1`, { params: { tag } });
    const failures = await db.rows(`SELECT exception_code, substring(exception, 1, 500) AS exception
        FROM system.query_log
        WHERE log_comment = {tag:String} AND type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')
        ORDER BY event_time_microseconds`, { params: { tag } });
    return { ...summary, top: top ?? null, failures };
}

async function measuredRequest(name, path, {
    method = 'GET', body, headers = {}, status = 200, mode = 'buffer', validate,
} = {}) {
    const tag = `stress:${name}:${Date.now()}`;
    activeTag = tag;
    const started = performance.now();
    let response;
    let consumed = { bytes: 0, body: '' };
    let requestError = null;
    try {
        response = await fetch(`${base}${path}`, {
            method,
            body,
            headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        consumed = await consume(response, mode);
        assert.equal(response.status, status, `${name}: ${consumed.body.slice(0, 500)}`);
        if (validate) validate(consumed.body, response);
    } catch (error) {
        requestError = error;
    } finally {
        activeTag = '';
    }
    const elapsedMs = Math.round(performance.now() - started);
    const metrics = await queryMetrics(tag);
    const result = {
        name, path, status: response?.status ?? null, responseBytes: consumed.bytes, elapsedMs,
        clickhousePeakBytes: Number(metrics.peak_memory ?? 0),
        clickhousePeakMiB: mib(metrics.peak_memory ?? 0),
        clickhouseQueryMs: Number(metrics.query_ms ?? 0),
        readRows: Number(metrics.read_rows ?? 0),
        readBytes: Number(metrics.read_bytes ?? 0),
        appMaxRssBytes: maxRssBytes(), appMaxRssMiB: mib(maxRssBytes()),
        topQuery: metrics.top, failures: metrics.failures,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (requestError) throw requestError;
    assert.equal(Number(metrics.failed), 0, `${name}: ClickHouse logged a failed query`);
    assert.ok(result.clickhousePeakBytes <= QUERY_BUDGET,
        `${name}: ClickHouse peak ${result.clickhousePeakMiB} MiB exceeds ${mib(QUERY_BUDGET)} MiB`);
    assert.ok(result.appMaxRssBytes <= APP_BUDGET,
        `${name}: app peak RSS ${result.appMaxRssMiB} MiB exceeds ${mib(APP_BUDGET)} MiB`);
    return result;
}

async function measuredConcurrent(name, paths) {
    const tag = `stress:${name}:${Date.now()}`;
    activeTag = tag;
    const started = performance.now();
    let requestError = null;
    let responses = [];
    try {
        responses = await Promise.all(paths.map(async (path) => {
            const response = await fetch(`${base}${path}`, {
                headers: { Authorization: `Bearer ${TOKEN}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            });
            const consumed = await consume(response);
            assert.equal(response.status, 200, `${path}: ${consumed.body.slice(0, 500)}`);
            return { path, status: response.status, bytes: consumed.bytes };
        }));
    } catch (error) {
        requestError = error;
    } finally {
        activeTag = '';
    }
    const metrics = await queryMetrics(tag);
    const result = {
        name, paths, responses, elapsedMs: Math.round(performance.now() - started),
        clickhousePeakBytes: Number(metrics.peak_memory ?? 0),
        clickhousePeakMiB: mib(metrics.peak_memory ?? 0),
        clickhouseQueryMs: Number(metrics.query_ms ?? 0),
        readRows: Number(metrics.read_rows ?? 0), readBytes: Number(metrics.read_bytes ?? 0),
        appMaxRssBytes: maxRssBytes(), appMaxRssMiB: mib(maxRssBytes()),
        topQuery: metrics.top, failures: metrics.failures,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (requestError) throw requestError;
    assert.equal(Number(metrics.failed), 0, `${name}: ClickHouse logged a failed query`);
    assert.ok(result.clickhousePeakBytes <= QUERY_BUDGET,
        `${name}: ClickHouse peak ${result.clickhousePeakMiB} MiB exceeds ${mib(QUERY_BUDGET)} MiB`);
    assert.ok(result.appMaxRssBytes <= APP_BUDGET,
        `${name}: app peak RSS ${result.appMaxRssMiB} MiB exceeds ${mib(APP_BUDGET)} MiB`);
}

let base;
async function run() {
    await db.init();
    await seed();
    server = createApp({ db: measuredDb, ingestToken: TOKEN, readToken: TOKEN }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // Public/static and ingest routes are included so the suite covers the
    // complete HTTP surface, although the analytical routes carry the budgets.
    for (const [name, path, marker] of [
        ['dashboard-root', '/', 'Config'], ['dashboard-alias', '/dashboard', 'Config'],
        ['agent', '/agent', '/paths'], ['llms', '/llms.txt', '/paths'],
        ['health', '/health', '"ok":true'],
    ]) await measuredRequest(name, path, { validate: (body) => assert.match(body, new RegExp(marker)) });
    await measuredRequest('not-found', '/not-found', { status: 404 });
    await measuredRequest('read-auth', '/paths', {
        headers: { Authorization: 'Bearer wrong' }, status: 401,
    });

    const ingestEvents = Array.from({ length: 2000 }, (_, index) => ({
        id: `stress-ingest-${index}`, at: BASE + index / 1000, user_id: PLAYERS + 2,
        kind: 'event', name: 'stress_ingest', props: { index },
    }));
    await measuredRequest('ingest-max-batch', '/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: ingestEvents }),
        validate: (body) => assert.equal(JSON.parse(body).accepted, 2000),
    });

    const window = { since: BASE - 1, until: UNTIL, timelines: 0 };
    const comparison = {
        ...window, compare: 'offer', control: 'control', ci: 1, series: 'daily', format: 'json',
    };
    await measuredRequest('report-all-arms-ci-daily', `/report?${query(comparison)}`, {
        validate: (body) => {
            const json = JSON.parse(body);
            assert.equal(json.experiment.arms.length, 4);
            assert.ok(json.experiment.series.length >= 7);
        },
    });
    await measuredRequest('paths-all-arms-purchases', `/paths?${query({
        ...comparison, dist: 'spend', limit: 1000, purchase_limit: 1000,
    })}`, { validate: (body) => assert.equal(JSON.parse(body).experiment.arms.length, 4) });
    await measuredRequest('paths-follow-up', `/paths?${query({
        ...window, compare: 'offer', path: 'click MainUI/Root/Shop/Items/Card_1/BuyButton',
        limit: 1000, purchase_limit: 1000, format: 'json',
    })}`);
    await measuredRequest('report-intersection-filters', `/report?${query({
        ...window, config: 'offer:control', platform: 'mobile', device: 'phone',
        min_duration: '1m', max_duration: '1h', timelines: 0, format: 'json',
    })}`);
    // Preserve repeated config parameters; URLSearchParams(Object) cannot.
    await measuredRequest('paths-two-config-filters', `/paths?since=${BASE - 1}&until=${UNTIL}`
        + '&config=offer%3Acontrol&config=segment%3Amobile&spender=1&format=json&timelines=0');
    await measuredRequest('configs-overview-interactions', `/configs?${query({
        since: BASE - 1, until: UNTIL, compare: 'offer',
    })}`);
    await measuredRequest('configs-filtered-interactions', `/configs?since=${BASE - 1}&until=${UNTIL}`
        + '&config=segment%3Amobile&compare=offer');
    await measuredRequest('journeys-large-stream', `/journeys?${query({
        ...window, limit: 100_000,
    })}`, { mode: 'stream', headers: { 'Accept-Encoding': 'gzip' } });
    if (HOT_ROWS) await measuredRequest('journeys-hot-player', `/journeys?${query({
        ...window, user_id: PLAYERS + 1, limit: 10,
    })}`, { mode: 'stream', headers: { 'Accept-Encoding': 'gzip' } });

    // Distinct parameters avoid the comparison response cache. This exercises
    // aggregate server pressure, not merely each query's individual limit.
    const concurrent = Array.from({ length: CONCURRENCY }, (_, index) =>
        `/paths?${query({ ...comparison, dist: ['spend', 'session', 'purchases'][index % 3],
            limit: 100 + index, purchase_limit: 100 + index })}`);
    await measuredConcurrent('concurrent-heavy-reads', concurrent);
}

let failure;
try {
    await run();
} catch (error) {
    failure = error;
    console.error(error.stack ?? error);
} finally {
    activeTag = '';
    if (server) await new Promise((resolve) => server.close(resolve));
    await writeFile(RESULT_FILE, JSON.stringify({
        configuration: {
            rows: ROWS, players: PLAYERS, hotRows: HOT_ROWS,
            queryMemoryBytes: QUERY_MEMORY, queryBudgetBytes: QUERY_BUDGET,
            appBudgetBytes: APP_BUDGET, requestTimeoutMs: REQUEST_TIMEOUT, concurrency: CONCURRENCY,
        },
        failure: failure ? String(failure.stack ?? failure) : null,
        results,
    }, null, 2));
    try {
        await db.exec(`DROP DATABASE IF EXISTS ${database}`, { db: 'default' });
    } catch (cleanupError) {
        console.error(`cleanup failed: ${cleanupError.message}`);
        failure ??= cleanupError;
    }
}

if (failure) process.exitCode = 1;
