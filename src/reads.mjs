// The read endpoints, as ClickHouse SQL. Journeys are cut and summarised by the
// database (the Umami/Rybbit way: window functions over raw events, per-journey
// arrays, then plain GROUP BYs), so JS only formats the answer. Full journeys are
// rebuilt in JS just for the few that are shown (timelines, /journeys).
import { randomUUID } from 'node:crypto';
import {
    GAP_SECONDS, RAGE_IGNORE, RAGE_MIN_CLICKS, RAGE_WINDOW_SECONDS, buildJourneys, fmtClock, fmtDate, parseSince, pct, table, timeline,
} from './journeys.mjs';

// events per slice when building the journey table (see journeyTable)
const SLICE_ROWS = 1_000_000;
// bounce cut-offs, shortest first
const BOUNCES = [['15s', 15], ['1 min', 60], ['3 min', 180]];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
// a whole-number query param, clamped; goes into SQL as LIMIT
const count = (value, fallback, max) => Math.min(max, Math.max(0, Math.floor(Number(value ?? fallback)) || 0));

// The request's filters as SQL over `events` plus their bound params.
function windowOf(query, defaultSince) {
    let since, until;
    try {
        since = parseSince(query.since ?? defaultSince);
        until = parseSince(query.until);
    } catch (error) {
        throw badRequest(error.message);
    }
    const where = ['at >= fromUnixTimestamp64Milli({since:Int64})'];
    const params = { since: Math.round(since * 1000) };
    if (until !== null) {
        where.push('at < fromUnixTimestamp64Milli({until:Int64})');
        params.until = Math.round(until * 1000);
    }
    if (query.user_id) {
        if (!/^\d+$/.test(query.user_id)) throw badRequest('user_id must be a number');
        where.push('user_id = {user:Int64}');
        params.user = query.user_id;
    }
    if (query.studio === '0') where.push('NOT studio');
    // ?config=key:value: config_exposure events for key (and value, if given)
    const [key, value] = (query.config ?? '').split(':');
    params.ckey = key ?? '';
    params.cvalue = value ?? '';
    params.anyValue = value === undefined;
    return { where: where.join(' AND '), params };
}

const IS_EXPOSURE = `kind = 'event' AND name = 'config_exposure' AND JSONExtractString(props, 'key') = {ckey:String}`;
// String(props.value) in JS: true -> 'true', 'abc' -> 'abc'
const EXPOSURE_VALUE = `if(JSONType(props, 'value') = 'String', JSONExtractString(props, 'value'), JSONExtractRaw(props, 'value'))`;

// 'MainUI/Root/Shop/Items/Card/BuyButton' -> 'MainUI/…/Card/BuyButton', as shortTarget
const SHORT = `if(kind = 'button' AND length(splitByChar('/', name)) > 4,
    concat(splitByChar('/', name)[1], '/…/', splitByChar('/', name)[-2], '/', splitByChar('/', name)[-1]), name)`;

// Temporary table `jr`, one row per journey in the window: a player's events in
// time order, cut after session_ended or a GAP_SECONDS silence (see buildJourneys).
// `full` labels buttons by their whole path (/paths) instead of the shortened one.
// The config group is per journey (it logged the exposure), or with `byPlayer`
// the player's last exposure in the window.
async function journeyTable(db, session, w, { full = false, byPlayer = false, sliceRows = SLICE_ROWS } = {}) {
    const lbl = full ? `if(kind = 'button', concat('click ', name), name)` : `if(kind = 'button', concat('click ', short), short)`;
    // the select below for one slice of players; `w.where` inside it is the slice's
    const select = (w) => `
        WITH
            e AS (
                SELECT *, sum(brk) OVER (PARTITION BY user_id ORDER BY at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS jn
                FROM (
                    SELECT user_id, at, id, kind, name, menu, value, props,
                        toUnixTimestamp64Milli(at) / 1000 AS t,
                        kind = 'event' AND name IN ('session_started', 'session_ended', 'teleported') AS edge,
                        ${SHORT} AS short,
                        ${lbl} AS lbl,
                        t - lagInFrame(t, 1, -1e12) OVER w > ${GAP_SECONDS}
                            OR lagInFrame(kind = 'event' AND name = 'session_ended', 1, false) OVER w AS brk
                    FROM events FINAL
                    WHERE ${w.where}
                    WINDOW w AS (PARTITION BY user_id ORDER BY at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                )
            ),
            j AS (
                SELECT user_id, jn, min(t) AS start, max(t) AS end,
                    countIf(kind = 'event' AND name = 'session_ended') > 0 AS ended,
                    -- session_ended carries the game's own session length; the first/last
                    -- event span undercounts sessions that began before the window
                    ifNull(argMaxIf(value, (t, id), kind = 'event' AND name = 'session_ended'), end - start) AS dur,
                    countIf(kind != 'event') AS clicks,
                    {ckey:String} = '' OR ${byPlayer ? `user_id IN (
                        SELECT user_id FROM events WHERE ${w.where} AND ${IS_EXPOSURE}
                        GROUP BY user_id HAVING {anyValue:Bool} OR argMax(${EXPOSURE_VALUE}, at) = {cvalue:String})`
                    : `countIf(${IS_EXPOSURE} AND ({anyValue:Bool} OR ${EXPOSURE_VALUE} = {cvalue:String})) > 0`} AS in_group,
                    -- every step but the session edges, in order
                    arrayMap(x -> x.3, arraySort(groupArrayIf((t, id, lbl), NOT edge))) AS steps,
                    -- clicks: (t, id, label, menu, short target, is button, name)
                    arraySort(groupArrayIf((t, id, lbl, menu, short, kind = 'button', name), kind != 'event')) AS cl
                FROM e GROUP BY user_id, jn
            )
        SELECT j.*,
            -- new = the player's first-ever event is in this journey's session (the
            -- game's own user_type tag is unreliable)
            f.first >= j.end - j.dur - 5 AS is_new
        FROM j LEFT JOIN (
            SELECT user_id, min(toUnixTimestamp64Milli(at)) / 1000 AS first FROM events
            WHERE user_id IN (SELECT user_id FROM events WHERE ${w.where}) GROUP BY user_id
        ) AS f USING user_id`;
    // Holding a whole window's journeys at once ran ClickHouse out of memory (~1.5GB
    // per 4M events), so the table is filled a slice of players at a time. Slices
    // are user_id ranges, which the sort key reads straight off disk.
    const [{ n }] = await db.rows(`SELECT count() AS n FROM events WHERE ${w.where}`, { params: w.params });
    const slices = Math.max(1, Math.ceil(n / sliceRows));
    const bounds = slices > 1 ? (await db.rows(
        `SELECT quantilesExact(${Array.from({ length: slices - 1 }, (_, i) => (i + 1) / slices).join(', ')})(user_id) AS q
        FROM events WHERE ${w.where}`,
        { params: w.params },
    ))[0].q : [];
    const edges = [null, ...new Set(bounds), null];
    await db.exec(`CREATE TEMPORARY TABLE jr ENGINE = MergeTree ORDER BY (user_id, start) EMPTY AS ${select(w)}`, { session, params: w.params });
    for (let i = 0; i + 1 < edges.length; i++) {
        const range = [edges[i] !== null && `user_id > ${edges[i]}`, edges[i + 1] !== null && `user_id <= ${edges[i + 1]}`].filter(Boolean);
        const slice = { ...w, where: [w.where, ...range].join(' AND ') };
        await db.exec(`INSERT INTO jr ${select(slice)}`, { session, params: w.params });
    }
}

// Rows of events as buildJourneys wants them, read line by line off the response.
async function* eventRows(res) {
    const decoder = new TextDecoder();
    let rest = '';
    const parse = (line) => {
        const r = JSON.parse(line);
        return {
            at: r.t,
            user_id: Number(r.user_id),
            session_id: r.session_id || null,
            place: r.place || null,
            kind: r.kind,
            name: r.name,
            menu: r.menu || null,
            x: r.x,
            y: r.y,
            value: r.value,
            props: r.props ? JSON.parse(r.props) : null,
        };
    };
    for await (const chunk of res.body) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
        rest = lines.pop();
        for (const line of lines) if (line) yield parse(line);
    }
    if (rest) yield parse(rest);
}

// The events of the journeys in `picked` (a SELECT over jr giving user_id, start,
// end), streamed in player then time order.
const journeyEvents = (db, session, w, picked) =>
    db.query(
        `SELECT toUnixTimestamp64Milli(at) / 1000 AS t, user_id, session_id, place, kind, name, menu, x, y, value, props
        FROM events AS e FINAL INNER JOIN (${picked}) AS p ON e.user_id = p.user_id
        WHERE ${w.where} AND t >= p.start AND t <= p.end
        ORDER BY user_id, at, id
        FORMAT JSONEachRow`,
        { session, params: w.params, settings: { output_format_json_quote_64bit_integers: 0 } },
    );

// buildJourneys one player at a time, so memory holds one player's events
async function* journeysOf(rows, isNew) {
    let events = [];
    const flush = function* () {
        for (const j of buildJourneys(events)) {
            j.userType = isNew.get(`${j.userId}@${j.start}`) ? 'new' : 'returning';
            yield j;
        }
        events = [];
    };
    for await (const e of rows) {
        if (events.length && events[0].user_id !== e.user_id) yield* flush();
        events.push(e);
    }
    yield* flush();
}

async function picks(db, session, sql) {
    const rows = await db.rows(sql, { session });
    return new Map(rows.map((r) => [`${r.user_id}@${r.start}`, r.is_new]));
}

async function report(db, session, w, query, opts) {
    await journeyTable(db, session, w, opts);
    const q = (sql) => db.rows(sql, { session });
    const [o] = await q(
        `SELECT count() AS nJourneys, uniqExact(user_id) AS players, countIf(ended) AS nEnded, countIf(is_new) AS nNew,
            quantileExactInclusive(0.5)(dur) AS med, avg(dur) AS mean, quantileExactInclusive(0.5)(clicks) AS medClicks,
            ${BOUNCES.map(([, s], i) => `countIf(dur < ${s}) AS b${i}, countIf(ended AND dur < ${s}) AS q${i}`).join(', ')},
            min(start) AS lo, max(end) AS hi
        FROM jr WHERE in_group`,
    );
    const out = ['# Player journey report', ''];
    if (!o.nJourneys) {
        out.push('No events in range.');
        return out.join('\n');
    }
    const all = o.nJourneys;
    const ended = o.nEnded;
    out.push(
        `${fmtDate(o.lo)} → ${fmtDate(o.hi)} UTC`,
        '',
        table(
            [
                ['players', o.players],
                ['journeys', all],
                ['ended with a quit', `${ended} (${pct(ended, all)})`],
                ['new-player journeys', o.nNew],
                ['median journey length', fmtClock(o.med)],
                ['mean journey length', fmtClock(o.mean)],
                ['median clicks / journey', o.medClicks],
                ...BOUNCES.map(([name], i) => [`journeys under ${name}`, pct(o[`b${i}`], all)]),
            ],
            ['metric', 'value'],
        ),
        '',
    );

    // where players leave: the last 3 actions before each quit
    const exits = (cond, limit) =>
        q(`SELECT arrayStringConcat(arraySlice(steps, -3), ' → ') AS k, count() AS n FROM jr
            WHERE in_group AND ended ${cond} GROUP BY k ORDER BY n DESC, k LIMIT ${limit}`);
    out.push('## Exit points (last 3 actions before quitting)', '');
    out.push(table((await exits('', 15)).map((r) => [r.k || '(nothing)', r.n, pct(r.n, ended)]), ['path', 'quits', 'share']), '');
    for (const [i, [name, seconds]] of BOUNCES.entries()) {
        const quits = o[`q${i}`];
        out.push(`## Exit points, quit within ${name} (${quits})`, '');
        out.push(table((await exits(`AND dur < ${seconds}`, 10)).map((r) => [r.k || '(nothing)', r.n, pct(r.n, quits)]), ['path', 'quits', 'share']), '');
    }

    out.push('## Menu open at the last click before quitting', '');
    const menus = await q(`SELECT if(empty(cl) OR cl[-1].4 = '', '(no menu open)', cl[-1].4) AS k, count() AS n FROM jr
        WHERE in_group AND ended GROUP BY k ORDER BY n DESC, k LIMIT 10`);
    out.push(table(menus.map((r) => [r.k, r.n, pct(r.n, ended)]), ['menu', 'quits', 'share']), '');

    out.push('## New players: first 3 clicks', '');
    const openings = await q(`SELECT arrayStringConcat(arrayMap(x -> x.3, arraySlice(cl, 1, 3)), ' → ') AS k, count() AS n FROM jr
        WHERE in_group AND is_new GROUP BY k ORDER BY n DESC, k LIMIT 10`);
    out.push(table(openings.map((r) => [r.k || '(no clicks)', r.n, pct(r.n, o.nNew)]), ['path', 'journeys', 'share']), '');

    out.push('## Most clicked', '');
    const clicks = await q(`SELECT arrayJoin(arrayMap(x -> concat(x.3, if(x.4 = '', '', concat(' [', x.4, ']'))), cl)) AS k, count() AS n
        FROM jr WHERE in_group GROUP BY k ORDER BY n DESC, k LIMIT 20`);
    out.push(table(clicks.map((r) => [r.k, r.n]), ['target [menu]', 'clicks']), '');

    out.push('## Button reach (share of journeys that ever clicked it)', '');
    const reach = await q(`SELECT arrayJoin(arrayDistinct(arrayMap(x -> x.5, arrayFilter(x -> x.6, cl)))) AS k, count() AS n
        FROM jr WHERE in_group GROUP BY k ORDER BY n DESC, k LIMIT 20`);
    out.push(table(reach.map((r) => [r.k, r.n, pct(r.n, all)]), ['button', 'journeys', 'share']), '');

    // runs of one name within RAGE_WINDOW_SECONDS of the run's first click, as
    // findRageClicks: acc = (run start, name, clicks, short target, bursts)
    out.push(`## Rage clicks (${RAGE_MIN_CLICKS}+ on one target within ${RAGE_WINDOW_SECONDS}s)`, '');
    const rage = await q(`SELECT arrayJoin(arrayMap(b -> b.2, arrayFilter(b -> NOT multiSearchAny(b.1, ${JSON.stringify(RAGE_IGNORE).replaceAll('"', "'")}),
            arrayConcat(r.5, if(r.3 >= ${RAGE_MIN_CLICKS}, [(r.2, r.4)], []))))) AS k, count() AS n
        FROM (
            SELECT arrayFold((acc, x) -> if(x.7 = acc.2 AND x.1 - acc.1 <= ${RAGE_WINDOW_SECONDS},
                    (acc.1, acc.2, acc.3 + 1, acc.4, acc.5),
                    (x.1, x.7, toUInt64(1), x.5, if(acc.3 >= ${RAGE_MIN_CLICKS}, arrayPushBack(acc.5, (acc.2, acc.4)), acc.5))),
                cl, (toFloat64(0), '', toUInt64(0), '', CAST([], 'Array(Tuple(String, String))'))) AS r
            FROM jr WHERE in_group
        )
        GROUP BY k ORDER BY n DESC, k LIMIT 15`);
    out.push(table(rage.map((r) => [r.k, r.n]), ['target', 'bursts']), '');

    out.push('## Common 3-click sequences', '');
    const trigrams = await q(`SELECT arrayJoin(arrayMap(i -> arrayStringConcat(arraySlice(s, i, 3), ' → '),
            range(1, toUInt64(greatest(length(s), 2)) - 1))) AS k, count() AS n
        FROM (SELECT arrayCompact(arrayMap(x -> x.3, cl)) AS s FROM jr WHERE in_group)
        GROUP BY k ORDER BY n DESC, k LIMIT 15`);
    out.push(table(trigrams.map((r) => [r.k, r.n]), ['sequence', 'times']), '');

    out.push('## Transitions (what each step leads to)', '');
    out.push(table((await transitions(q, 40)).map((r) => [r.f, r.t, r.n, pct(r.n, r.total)]), ['from', 'to', 'times', 'share of from']), '');

    const timelines = count(query.timelines, 20, 1000);
    if (timelines > 0) {
        const picked = `SELECT user_id, start, end, is_new FROM jr WHERE in_group ORDER BY start DESC, user_id LIMIT ${timelines}`;
        const isNew = await picks(db, session, picked);
        const shown = [];
        for await (const j of journeysOf(eventRows(await journeyEvents(db, session, w, picked)), isNew)) shown.push(j);
        shown.sort((a, b) => b.start - a.start);
        out.push(`## Journeys (${shown.length} most recent of ${all})`, '');
        for (const j of shown) out.push(timeline(j), '');
    }
    return out.join('\n');
}

// step -> next step over every journey, repeats folded, quits as an end node;
// `cond` filters the (f, t) pairs, total is every edge out of f
const transitions = (q, limit, cond = '1', steps = 'steps') =>
    q(`SELECT f, t, n, total FROM (
            SELECT p.1 AS f, p.2 AS t, count() AS n, sum(n) OVER (PARTITION BY f) AS total
            FROM (
                SELECT arrayJoin(arrayZip(arrayPopBack(s), arrayPopFront(s))) AS p
                FROM (SELECT if(ended AND notEmpty(${steps}), arrayPushBack(arrayCompact(${steps}), '(quit)'), arrayCompact(${steps})) AS s
                    FROM jr WHERE in_group)
            ) GROUP BY f, t
        ) WHERE ${cond} ORDER BY n DESC, f, t LIMIT ${limit}`);

// /paths: Umami/Rybbit-style path analysis over full step names. A player's group
// is their last exposure to the config key in the window.
async function paths(db, session, w, query, opts) {
    const limit = count(query.limit, 40, 1000) || 40;
    let match = '';
    if (query.match) {
        try {
            new RegExp(query.match);
        } catch (error) {
            throw badRequest(error.message);
        }
        w.params.match = `(?i)${query.match}`;
        match = 'match(k, {match:String})';
    }
    const path = (query.path ?? query.from ?? '').split('>').filter(Boolean);
    if (path.length > 3) throw badRequest('path takes at most 3 steps');
    await journeyTable(db, session, w, { ...opts, full: true, byPlayer: true });
    const q = (sql) => db.rows(sql, { session, params: w.params });
    const [o] = await q(`SELECT uniqExact(user_id) AS players, count() AS journeys, min(start) AS lo, max(end) AS hi FROM jr WHERE in_group`);
    const players = o.players;
    const out = ['# Paths', ''];
    if (!o.journeys) {
        out.push('No events in range.');
        return out.join('\n');
    }
    out.push(
        `${fmtDate(o.lo)} → ${fmtDate(o.hi)} UTC`,
        '',
        table([['group', query.config ?? 'everyone'], ['players', players], ['journeys', o.journeys]], ['', '']),
        '',
    );

    // config_exposure is the grouping, not a step
    const STEPS = `arrayFilter(x -> x != 'config_exposure', steps)`;
    out.push('## Steps (events, clicks, world taps)', '');
    const steps = await q(`SELECT arrayJoin(${STEPS}) AS k, count() AS n, uniqExact(user_id) AS p FROM jr WHERE in_group
        GROUP BY k ${match ? `HAVING ${match}` : ''} ORDER BY p DESC, n DESC, k LIMIT ${limit}`);
    out.push(table(steps.map((r) => [r.k, r.n, r.p, pct(r.p, players)]), ['step', 'times', 'players', 'share of players']), '');

    out.push('## Purchase prompts', '');
    const buys = await q(`SELECT concat(if(JSONHas(props, 'name'), JSONExtractString(props, 'name'), '?'), '@',
            if(JSONHas(props, 'price'), JSONExtractRaw(props, 'price'), '?')) AS k,
            countIf(name = 'Purchase:PromptOpened') AS o,
            countIf(name = 'Purchase:PromptFinished' AND JSONExtractBool(props, 'purchased')) AS b,
            countIf(name = 'Purchase:PromptFinished' AND NOT JSONExtractBool(props, 'purchased')) AS c,
            uniqExact(user_id) AS p
        FROM events FINAL
        WHERE ${w.where} AND kind = 'event' AND name IN ('Purchase:PromptOpened', 'Purchase:PromptFinished')
            AND user_id IN (SELECT user_id FROM jr WHERE in_group)
        GROUP BY k ${match ? `HAVING ${match}` : ''} ORDER BY o DESC, k LIMIT ${limit}`);
    out.push(table(buys.map((r) => [r.k, r.o, r.b, r.c, r.p]), ['product@price', 'prompted', 'bought', 'cancelled', 'players']), '');

    if (path.length) {
        // what came next after the exact sequence, anywhere in a journey
        w.params.path = path.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
        const next = await q(`SELECT if(i + ${path.length} > length(s), if(ended, '(quit)', '(end of window)'), s[i + ${path.length}]) AS k,
                count() AS n, uniqExact(user_id) AS p, sum(n) OVER () AS total
            FROM (SELECT user_id, ended, arrayCompact(${STEPS}) AS s FROM jr WHERE in_group)
            ARRAY JOIN arrayFilter(i -> arraySlice(s, i, ${path.length}) = {path:Array(String)}, arrayEnumerate(s)) AS i
            GROUP BY k ORDER BY n DESC, k LIMIT ${limit}`);
        out.push(`## After ${path.join(' → ')}`, '');
        out.push(table(next.map((r) => [r.k, r.n, r.p, pct(r.n, r.total)]), ['next', 'times', 'players', 'share']), '');
    } else {
        out.push('## Transitions', '');
        const cond = match ? 'match(f, {match:String}) OR match(t, {match:String})' : '1';
        const rows = await transitions(q, limit, cond, STEPS);
        out.push(table(rows.map((r) => [r.f, r.t, r.n, pct(r.n, r.total)]), ['from', 'to', 'times', 'share of from']), '');
    }
    return out.join('\n');
}

async function journeys(db, session, w, query, opts) {
    await journeyTable(db, session, w, opts);
    // the newest `limit`, then in player and time order
    const limit = count(query.limit, 100, 10_000_000);
    const picked = `SELECT user_id, start, end, is_new FROM jr WHERE in_group ORDER BY start DESC, user_id LIMIT ${limit}`;
    const isNew = await picks(db, session, picked);
    const res = await journeyEvents(db, session, w, picked);
    return (async function* () {
        yield '[';
        let first = true;
        for await (const j of journeysOf(eventRows(res), isNew)) {
            yield (first ? '' : ',') + JSON.stringify(j);
            first = false;
        }
        yield ']';
    })();
}

// Returns { status, type, body } or { status, type, parts } for a read request;
// `query` is the URL's searchParams as a plain object.
// `opts.sliceRows` is for tests
export async function runRead(db, pathname, query, opts = {}) {
    // temporary tables live in a session; one per request
    const session = randomUUID();
    try {
        if (pathname === '/report') return { status: 200, type: 'text/markdown', body: await report(db, session, windowOf(query, '7d'), query, opts) };
        if (pathname === '/paths') return { status: 200, type: 'text/markdown', body: await paths(db, session, windowOf(query, '24h'), query, opts) };
        return { status: 200, type: 'application/json', parts: await journeys(db, session, windowOf(query, '7d'), query, opts) };
    } catch (error) {
        if (error.status !== 400) throw error;
        return { status: 400, type: 'application/json', body: JSON.stringify({ error: error.message }) };
    }
}
