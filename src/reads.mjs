// The read endpoints, as ClickHouse SQL. Journeys are cut and summarised by the
// database (the Umami/Rybbit way: window functions over raw events, per-journey
// arrays, then plain GROUP BYs), so JS only formats the answer. Full journeys are
// rebuilt in JS just for the few that are shown (timelines, /journeys).
import { randomUUID } from 'node:crypto';
import {
    GAP_SECONDS, RAGE_IGNORE, RAGE_MIN_CLICKS, RAGE_WINDOW_SECONDS, buildJourneys, fmtClock, fmtDate, parseSince, pct, table, timeline,
} from './journeys.mjs';
import { summarizeExperiment } from './experiment-stats.mjs';

// Keep large reads within the server's memory budget: spill aggregate/sort state
// to disk and limit parallel working sets. Applies to reads only, not ingestion.
// https://clickhouse.com/docs/knowledgebase/memory-limit-exceeded-for-query
const READ_SETTINGS = {
    max_bytes_before_external_group_by: 64_000_000,
    max_bytes_before_external_sort: 64_000_000,
    max_threads: 4,
    join_algorithm: 'auto',
};
const READ_CACHE_TTL_MS = 60_000;
const READ_CACHE_MAX = 32;
const READ_CACHES = new WeakMap();

// bounce cut-offs, shortest first
const BOUNCES = [['15s', 15], ['1 min', 60], ['3 min', 180]];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
// a whole-number query param, clamped; goes into SQL as LIMIT
const count = (value, fallback, max) => Math.min(max, Math.max(0, Math.floor(Number(value ?? fallback)) || 0));
const valuesOf = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

function parseConfig(value, name = 'config') {
    if (typeof value !== 'string' || value === '') throw badRequest(`${name} must be key or key:value`);
    const colon = value.indexOf(':');
    const key = colon === -1 ? value : value.slice(0, colon);
    if (!key) throw badRequest(`${name} must include a key`);
    return { raw: value, key, value: colon === -1 ? null : value.slice(colon + 1) };
}

function configFilters(query) {
    const configs = valuesOf(query.config).filter((value) => value !== '').map((value) => parseConfig(value));
    const byKey = new Map();
    for (const config of configs) {
        const previous = byKey.get(config.key);
        if (previous && previous.raw !== config.raw) {
            throw badRequest(`multiple config filters for ${config.key} are ambiguous; use compare for experiment arms`);
        }
        byKey.set(config.key, config);
    }
    return [...byKey.values()];
}

function comparisonOf(query) {
    const comparisons = valuesOf(query.compare).filter((value) => value !== '');
    if (!comparisons.length) return null;
    if (comparisons.length !== 1) throw badRequest('compare must be one config key');
    const comparison = parseConfig(comparisons[0], 'compare');
    if (comparison.value !== null) throw badRequest('compare must be a config key without a value');
    return { key: comparison.key };
}

const configLabel = (query) => valuesOf(query.config).filter(Boolean).join(' + ') || 'everyone';

const DIST_METRICS = new Set(['spend', 'session', 'purchases']);
function distributionOf(query) {
    if (query.dist === undefined || query.dist === '') return null;
    if (!DIST_METRICS.has(query.dist)) throw badRequest('dist must be spend, session or purchases');
    if (!comparisonOf(query)) throw badRequest('dist requires compare=<config key>');
    return query.dist;
}

function outputFormat(query) {
    const format = query.format ?? 'markdown';
    if (!['markdown', 'json'].includes(format)) throw badRequest('format must be markdown or json');
    return format;
}

const scalar = (value) => /^-?\d+(?:\.\d+)?$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : value;

// A structured fallback for the human-first reports. Tables become arrays of
// objects, so API clients never have to split Markdown with awk.
function markdownJson(markdown) {
    const lines = markdown.split('\n');
    const result = { title: '', preamble: [], sections: [] };
    let section = { title: '', text: [], tables: [] };
    const flush = () => {
        if (section.title || section.text.length || section.tables.length) result.sections.push(section);
        section = { title: '', text: [], tables: [] };
    };
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (line.startsWith('# ')) {
            result.title = line.slice(2);
            i++;
            continue;
        }
        if (line.startsWith('## ')) {
            flush();
            section.title = line.slice(3);
            i++;
            continue;
        }
        if (line.startsWith('| ') && i + 1 < lines.length && /^\|(?:\s*---\s*\|)+$/.test(lines[i + 1])) {
            const cells = (row) => row.slice(1, -1).split('|').map((cell) => cell.trim());
            const columns = cells(line);
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].startsWith('| ')) {
                const values = cells(lines[i]);
                rows.push(Object.fromEntries(columns.map((column, index) => [column || 'metric', scalar(values[index] ?? '')])));
                i++;
            }
            section.tables.push({ columns, rows });
            continue;
        }
        if (line && line !== '_none_') (section.title ? section.text : result.preamble).push(line);
        i++;
    }
    flush();
    return result;
}

const FILTER_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
function durationFilter(value, name) {
    if (value === undefined || value === '') return null;
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(value);
    if (!match) throw badRequest(`${name} must be seconds or a duration such as 30s, 5m, 2h or 1d`);
    const seconds = Number(match[1]) * (FILTER_UNITS[match[2]] ?? 1);
    if (!Number.isFinite(seconds)) throw badRequest(`${name} is too large`);
    return seconds;
}

function integerFilter(value, name) {
    if (value === undefined || value === '') return null;
    if (!/^\d+$/.test(value)) throw badRequest(`${name} must be a non-negative whole number`);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw badRequest(`${name} is too large`);
    return number;
}

function booleanFilter(value, name) {
    if (value === undefined || value === '') return null;
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    throw badRequest(`${name} must be 1 or 0`);
}

// Filters evaluated after events have been cut into journeys. Event-level
// filters (place, event, menu) become per-event marks, OR-ed over the journey
// while it is cut (see journeyTable), so they cost no second pass over raw events.
function journeyFilters(query, w, marks) {
    const minDuration = durationFilter(query.min_duration, 'min_duration');
    const maxDuration = durationFilter(query.max_duration, 'max_duration');
    const minClicks = integerFilter(query.min_clicks, 'min_clicks');
    const maxClicks = integerFilter(query.max_clicks, 'max_clicks');
    if (minDuration !== null && maxDuration !== null && minDuration > maxDuration) {
        throw badRequest('min_duration cannot exceed max_duration');
    }
    if (minClicks !== null && maxClicks !== null && minClicks > maxClicks) {
        throw badRequest('min_clicks cannot exceed max_clicks');
    }

    const where = [];
    const addNumber = (value, key, column, operator, type) => {
        if (value === null) return;
        w.params[key] = value;
        where.push(`${column} ${operator} {${key}:${type}}`);
    };
    addNumber(minDuration, 'minDuration', 'dur', '>=', 'Float64');
    addNumber(maxDuration, 'maxDuration', 'dur', '<=', 'Float64');
    addNumber(minClicks, 'minClicks', 'clicks', '>=', 'UInt64');
    addNumber(maxClicks, 'maxClicks', 'clicks', '<=', 'UInt64');

    const ended = booleanFilter(query.ended, 'ended');
    const started = booleanFilter(query.started, 'started');
    if (ended !== null) {
        w.params.ended = ended;
        where.push('ended = {ended:Bool}');
    }
    if (started !== null) {
        w.params.started = started;
        where.push('started = {started:Bool}');
    }
    if (query.user_type !== undefined && query.user_type !== '') {
        if (!['new', 'returning'].includes(query.user_type)) throw badRequest('user_type must be new or returning');
        w.params.isNew = query.user_type === 'new';
        where.push('is_new = {isNew:Bool}');
    }

    for (const [key, expression] of [
        ['place', 'place = {place:String}'],
        ['event', 'name = {event:String}'],
        ['menu', "kind != 'event' AND menu = {menu:String}"],
    ]) {
        if (query[key] === undefined || query[key] === '') continue;
        w.params[key] = query[key];
        where.push(`bitTest(marks, ${marks.length})`);
        marks.push(expression);
    }
    for (const key of ['platform', 'device', 'level', 'country']) {
        if (query[key] === undefined || query[key] === '') continue;
        w.params[key] = query[key];
        where.push(`bitTest(marks, ${marks.length})`);
        marks.push(`if(JSONType(props, '${key}') = 'String', JSONExtractString(props, '${key}'),
            JSONExtractRaw(props, '${key}')) = {${key}:String}`);
    }
    if (query.spender !== undefined && query.spender !== '') {
        const spender = booleanFilter(query.spender, 'spender');
        w.params.spender = spender;
        where.push(`user_id ${spender ? '' : 'NOT '}IN (
            SELECT user_id FROM events FINAL WHERE ${w.where}
                AND kind = 'event' AND name = 'Purchase:PromptFinished'
                AND JSONExtractBool(props, 'purchased'))`);
    }
    return where;
}

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
    // Repeated ?config=key:value filters are ANDed. Keep each value bound rather
    // than interpolating it into the journey-building SQL.
    const configs = configFilters(query);
    for (const [i, config] of configs.entries()) {
        params[`ckey${i}`] = config.key;
        params[`cvalue${i}`] = config.value ?? '';
        params[`anyValue${i}`] = config.value === null;
    }
    return { where: where.join(' AND '), params, configs, since, until };
}

const isExposure = (key) => `kind = 'event' AND name = 'config_exposure' AND JSONExtractString(props, 'key') = {${key}:String}`;
// String(props.value) in JS: true -> 'true', 'abc' -> 'abc'
const EXPOSURE_VALUE = `if(JSONType(props, 'value') = 'String', JSONExtractString(props, 'value'), JSONExtractRaw(props, 'value'))`;
const PURCHASE_PRICE = `multiIf(
    JSONHas(props, 'receipt_price'), JSONExtractFloat(props, 'receipt_price'),
    JSONHas(props, 'receiptPrice'), JSONExtractFloat(props, 'receiptPrice'),
    JSONHas(props, 'robux'), JSONExtractFloat(props, 'robux'),
    JSONHas(props, 'price'), JSONExtractFloat(props, 'price'), 0)`;
const PROMPT_SOURCE = `multiIf(
    JSONHas(props, 'source'), JSONExtractString(props, 'source'),
    JSONHas(props, 'prompt_source'), JSONExtractString(props, 'prompt_source'),
    JSONHas(props, 'trigger'), JSONExtractString(props, 'trigger'), '(unknown)')`;

function compareOptions(query) {
    const comparison = comparisonOf(query);
    const ci = booleanFilter(query.ci, 'ci') ?? false;
    const blank = booleanFilter(query.blank, 'blank') ?? false;
    if (query.series !== undefined && !['', 'daily'].includes(query.series)) throw badRequest('series must be daily');
    const series = query.series === 'daily';
    if ((ci || series || query.control !== undefined) && !comparison) throw badRequest('control, ci and series require compare=<config key>');
    if (ci && (query.control === undefined || query.control === '')) throw badRequest('ci=1 requires control=<arm>');
    if (query.control === '' && !blank) throw badRequest('a blank control requires blank=1');
    return { comparison, ci, blank, series, control: query.control ?? null, dist: distributionOf(query) };
}

async function comparisonTable(db, session, w, options) {
    if (!options.comparison) return;
    w.params.compareKey = options.comparison.key;
    await db.exec(`CREATE TEMPORARY TABLE compare_players ENGINE = MergeTree ORDER BY user_id AS
        SELECT user_id,
            argMax(arm, (last_at, last_id)) AS arm,
            toUnixTimestamp64Milli(argMax(first_at, (last_at, last_id))) / 1000 AS first_exposure
        FROM (
            SELECT user_id, ${EXPOSURE_VALUE} AS arm, min(at) AS first_at,
                max(at) AS last_at, argMax(id, (at, id)) AS last_id
            FROM events FINAL
            WHERE ${w.where} AND ${isExposure('compareKey')}
            GROUP BY user_id, arm
        )
        GROUP BY user_id
        ${options.blank ? '' : "HAVING arm != ''"}`,
    { session, params: w.params });
}

async function selectedPlayersTable(db, session, compared = true) {
    await db.exec(`CREATE TEMPORARY TABLE selected_players ENGINE = MergeTree ORDER BY (arm, user_id) AS
        ${compared ? `SELECT user_id, arm, first_exposure, groupArray((end, dur)) AS sessions
            FROM jr INNER JOIN compare_players USING user_id WHERE in_group
            GROUP BY user_id, arm, first_exposure`
        : `SELECT user_id, '' AS arm, min(start) AS first_exposure, groupArray((end, dur)) AS sessions
            FROM jr WHERE in_group GROUP BY user_id`}`, { session });
}

async function purchaseEventsTable(db, session, w) {
    await db.exec(`CREATE TEMPORARY TABLE purchase_events ENGINE = MergeTree ORDER BY (arm, user_id, at, id) AS
        SELECT CAST(p.arm, 'String') AS arm, CAST(e.user_id, 'Int64') AS user_id,
            CAST(j.is_new, 'UInt8') AS is_new,
            toUnixTimestamp64Milli(e.at) / 1000 AS at, CAST(e.id, 'String') AS id,
            if(JSONHas(e.props, 'name'), JSONExtractString(e.props, 'name'), '?') AS product,
            concat(product, '@', if(JSONHas(e.props, 'price'), JSONExtractRaw(e.props, 'price'), '?')) AS product_price,
            ${PURCHASE_PRICE.replaceAll('props', 'e.props')} AS price,
            ${PROMPT_SOURCE.replaceAll('props', 'e.props')} AS source,
            CAST(materialize(e.name) = 'Purchase:PromptOpened', 'UInt8') AS prompted,
            CAST(materialize(e.name) = 'Purchase:PromptFinished' AND JSONExtractBool(e.props, 'purchased'), 'UInt8') AS purchased,
            CAST(materialize(e.name) = 'Purchase:PromptFinished' AND NOT JSONExtractBool(e.props, 'purchased'), 'UInt8') AS cancelled
        FROM events AS e FINAL
        INNER JOIN selected_players AS p USING user_id
        INNER JOIN (SELECT user_id, start, end, is_new FROM jr WHERE in_group) AS j USING user_id
        WHERE ${w.where} AND e.kind = 'event'
            AND e.name IN ('Purchase:PromptOpened', 'Purchase:PromptFinished')
            AND toUnixTimestamp64Milli(e.at) / 1000 BETWEEN j.start AND j.end`,
    { session, params: w.params });
}

function dailyCutoffs(since, until) {
    const values = [];
    let at = (Math.floor(since / 86400) + 1) * 86400;
    while (at < until && values.length < 90) {
        values.push(at);
        at += 86400;
    }
    if (!values.length || values.at(-1) !== until) values.push(until);
    return values;
}

async function experimentStats(db, session, w, query, options) {
    await selectedPlayersTable(db, session, true);
    await purchaseEventsTable(db, session, w);
    const selected = await db.rows(`SELECT arm, user_id, first_exposure, sessions FROM selected_players ORDER BY arm, user_id`, { session });
    const purchases = await db.rows(`SELECT arm, user_id,
            groupArrayIf((at, price), purchased) AS buys,
            groupArrayIf(at, prompted) AS prompts
        FROM purchase_events GROUP BY arm, user_id`, { session });
    // Keep the large raw event stream on the left. ClickHouse builds its hash
    // table from the right-hand side, so putting events there can consume the
    // whole query memory limit before join_algorithm=auto has a chance to spill.
    const returns = await db.rows(`SELECT p.arm AS arm, p.user_id AS user_id,
            countIf(toUnixTimestamp64Milli(e.at) / 1000 >= p.first_exposure + 86400
                AND toUnixTimestamp64Milli(e.at) / 1000 < p.first_exposure + 172800) > 0 AS d1
        FROM events AS e FINAL INNER JOIN selected_players AS p USING user_id
        WHERE ${w.where}
        GROUP BY p.arm, p.user_id, p.first_exposure`, { session, params: w.params });
    const purchaseMap = new Map(purchases.map((row) => [`${row.arm}\0${row.user_id}`, row]));
    const returnMap = new Map(returns.map((row) => [`${row.arm}\0${row.user_id}`, Boolean(row.d1)]));
    const dataCutoff = w.until ?? Date.now() / 1000;
    const records = selected.map((row) => {
        const key = `${row.arm}\0${row.user_id}`;
        const purchase = purchaseMap.get(key) ?? { buys: [], prompts: [] };
        const buys = purchase.buys.map(([at, price]) => ({ at: Number(at), price: Number(price) }));
        const prompts = purchase.prompts.map(Number);
        const sessions = row.sessions.map(([at, duration]) => ({ at: Number(at), duration: Number(duration) }));
        const spend = buys.reduce((sum, buy) => sum + buy.price, 0);
        return {
            arm: row.arm, userId: row.user_id, firstExposure: Number(row.first_exposure),
            buys, prompts, sessions, spend, purchases: buys.length,
            buyer: buys.length > 0, prompted: prompts.length > 0,
            d1Eligible: Number(row.first_exposure) + 172800 <= dataCutoff,
            d1: returnMap.get(key) ?? false,
        };
    });
    return summarizeExperiment(records, {
        control: options.control, ci: options.ci, dist: options.dist,
        cutoffs: options.series ? dailyCutoffs(w.since, dataCutoff) : [], dataCutoff,
        seed: JSON.stringify(Object.fromEntries(Object.entries(query).sort())),
    });
}

function metricCell(metric, ci, percent = false) {
    const display = (value) => value === null ? '–' : percent ? `${Math.round(value * 10_000) / 100}%` : value;
    if (!ci || metric.lower === null) return display(metric.value);
    const lift = metric.liftVsControl?.value === null || metric.liftVsControl === null
        ? '–' : `${Math.round(metric.liftVsControl.value * 10_000) / 100}%`;
    const chance = metric.chanceBeatsControl === null ? '–' : `${Math.round(metric.chanceBeatsControl * 10_000) / 100}%`;
    return `${display(metric.value)} [${display(metric.lower)}, ${display(metric.upper)}] · lift ${lift} · P(beat control) ${chance}`;
}

function experimentMarkdown(experiment, options, key) {
    const out = [`## ${key} experiment metrics`, ''];
    out.push(table(experiment.arms.map(({ arm, metrics }) => [
        arm || '(blank)', metrics.players.value,
        metricCell(metrics.conversion, options.ci, true), metricCell(metrics.promptedConversion, options.ci, true),
        metricCell(metrics.spendPerPlayer, options.ci), metricCell(metrics.sessionMedian, options.ci),
        metricCell(metrics.sessionMean, options.ci), metricCell(metrics.sessionP90, options.ci),
        metricCell(metrics.d1Return, options.ci, true),
    ]), ['arm', 'players', 'conversion', 'prompted conversion', 'R$ / player',
        'session p50 (s)', 'session mean (s)', 'session p90 (s)', 'D1 return']), '');

    if (options.dist === 'spend') {
        out.push('## Spend per player distribution', '');
        out.push(table(experiment.arms.flatMap(({ arm, distributions }) => distributions.spend.buckets.map((row) => [
            arm || '(blank)', row.bucket, row.players, pct(row.players, distributions.spend.buckets.reduce((n, item) => n + item.players, 0)),
        ])), ['arm', 'R$ bucket', 'players', 'share']), '');
        out.push(table(experiment.arms.map(({ arm, distributions }) => [arm || '(blank)', distributions.spend.p50,
            distributions.spend.p90, distributions.spend.p99, `${Math.round(distributions.spend.top1Share * 10_000) / 100}%`]),
        ['arm', 'p50 R$', 'p90 R$', 'p99 R$', 'top 1% spend share']), '');
    } else if (options.dist === 'purchases') {
        out.push('## Purchases per player distribution', '');
        out.push(table(experiment.arms.flatMap(({ arm, distributions }) => distributions.purchases.buckets.map((row) => [
            arm || '(blank)', row.bucket, row.players, `${Math.round(row.share * 10_000) / 100}%`, distributions.purchases.repeatBuyers,
        ])), ['arm', 'purchases', 'players', 'share', 'repeat buyers (2+)']), '');
    } else if (options.dist === 'session') {
        out.push('## Session length distribution', '');
        out.push(table(experiment.arms.flatMap(({ arm, distributions }) => distributions.session.histogram.map((row) => [
            arm || '(blank)', row.bucket, row.sessions, `${Math.round(row.share * 10_000) / 100}%`,
        ])), ['arm', 'length', 'sessions', 'share']), '');
        out.push(table(experiment.arms.map(({ arm, distributions }) => [arm || '(blank)', distributions.session.mean,
            distributions.session.p50, distributions.session.p90]), ['arm', 'mean (s)', 'p50 (s)', 'p90 (s)']), '');
    }

    if (options.series) {
        out.push('## Daily cumulative experiment metrics', '');
        out.push(table(experiment.series.flatMap((point) => point.arms.map(({ arm, metrics }) => [
            point.at, arm || '(blank)', metrics.players.value,
            metricCell(metrics.conversion, options.ci, true), metricCell(metrics.spendPerPlayer, options.ci),
            metricCell(metrics.sessionMedian, options.ci), metricCell(metrics.d1Return, options.ci, true),
        ])), ['until', 'arm', 'players', 'conversion', 'R$ / player', 'session p50 (s)', 'D1 return']), '');
    }
    return out;
}

// 'MainUI/Root/Shop/Items/Card/BuyButton' -> 'MainUI/…/Card/BuyButton', as shortTarget
const SHORT = `if(kind = 'button' AND length(splitByChar('/', name)) > 4,
    concat(splitByChar('/', name)[1], '/…/', splitByChar('/', name)[-2], '/', splitByChar('/', name)[-1]), name)`;

// Temporary table `jr`, one row per journey in the window: a player's events in
// time order, cut after session_ended or a GAP_SECONDS silence (see buildJourneys).
// `full` labels buttons by their whole path (/paths) instead of the shortened one.
// The config group is per journey (it logged the exposure), or with `byPlayer`
// the player's last exposure in the window.
//
// Events are grouped per player straight off the table, which is sorted by
// player: with optimize_aggregation_in_order each player's array is finished as
// soon as the next player starts, so memory holds a few players, not the window.
// The array is then cut into journeys with arraySplit (no window functions, no
// sort over the whole window).
async function journeyTable(db, session, w, query, { full = false, byPlayer = false } = {}) {
    const lbl = full ? `if(kind = 'button', concat('click ', name), name)` : `if(kind = 'button', concat('click ', short), short)`;
    // per-event flags, OR-ed per journey into `marks`: config exposures (unless
    // byPlayer), then the event-level filters
    const marks = byPlayer ? [] : w.configs.map((_, i) => `${isExposure(`ckey${i}`)} AND ({anyValue${i}:Bool} OR ${EXPOSURE_VALUE} = {cvalue${i}:String})`);
    const where = journeyFilters(query, w, marks);
    const mark = marks.length ? marks.map((m, i) => `bitShiftLeft(toUInt64(${m}), ${i})`).join(' + ') : 'toUInt64(0)';
    const inGroup = !w.configs.length ? '1' : byPlayer ? w.configs.map((_, i) => `user_id IN (
        SELECT user_id FROM events WHERE ${w.where} AND ${isExposure(`ckey${i}`)}
        GROUP BY user_id HAVING {anyValue${i}:Bool} OR argMax(${EXPOSURE_VALUE}, (at, id)) = {cvalue${i}:String})`).join(' AND ')
        : w.configs.map((_, i) => `bitTest(marks, ${i})`).join(' AND ');
    // x: (t, id, label, menu, short target, kind, name, value, marks)
    await db.exec(
        `CREATE TEMPORARY TABLE jr ENGINE = MergeTree ORDER BY (user_id, start) AS
        SELECT user_id, start, end, started, ended, dur, clicks, in_group, steps, cl,
            -- new = the player's first-ever event is in this journey's session (the
            -- game's own user_type tag is unreliable)
            f.first >= end - dur - 5 AS is_new
        FROM (
            SELECT user_id, jev[1].1 AS start, jev[-1].1 AS end,
                arrayExists(x -> x.6 = 'event' AND x.7 = 'session_started', jev) AS started,
                -- a journey is cut right after session_ended, so only its last event can be one
                jev[-1].6 = 'event' AND jev[-1].7 = 'session_ended' AS ended,
                -- session_ended carries the game's own session length; the first/last
                -- event span undercounts sessions that began before the window
                ifNull(if(ended, jev[-1].8, NULL), end - start) AS dur,
                arrayCount(x -> x.6 != 'event', jev) AS clicks,
                arrayFold((acc, x) -> bitOr(acc, x.9), jev, toUInt64(0)) AS marks,
                ${inGroup} AS in_group,
                -- every step but the session edges, in order
                arrayMap(x -> x.3, arrayFilter(x -> NOT (x.6 = 'event' AND x.7 IN ('session_started', 'session_ended', 'teleported')), jev)) AS steps,
                -- clicks: (t, id, label, menu, short target, is button, name)
                arrayMap(x -> (x.1, x.2, x.3, x.4, x.5, x.6 = 'button', x.7), arrayFilter(x -> x.6 != 'event', jev)) AS cl
            FROM (
                SELECT user_id, arraySort(x -> (x.1, x.2), groupArray((
                    toUnixTimestamp64Milli(at) / 1000, id, ${lbl}, menu, ${SHORT} AS short, kind, name, value, ${mark}))) AS ev
                FROM events FINAL
                WHERE ${w.where}
                GROUP BY user_id
            )
            -- split before an event that follows a gap or a session_ended; the previous
            -- event's time and flag are shifted copies of two columns, not of ev
            ARRAY JOIN arraySplit((x, prev_t, prev_ended) -> x.1 - prev_t > ${GAP_SECONDS} OR prev_ended, ev,
                arrayPushFront(arrayPopBack(arrayMap(x -> x.1, ev)), 0),
                arrayPushFront(arrayPopBack(arrayMap(x -> x.6 = 'event' AND x.7 = 'session_ended', ev)), false)) AS jev
        ) AS j LEFT JOIN (
            SELECT user_id, min(toUnixTimestamp64Milli(at)) / 1000 AS first FROM events
            WHERE user_id IN (SELECT user_id FROM events WHERE ${w.where}) GROUP BY user_id
        ) AS f USING user_id
        WHERE ${where.join(' AND ') || '1'}`,
        // Each output row carries a player's or journey's whole path, so the default
        // 50 MB in-order blocks and 256 MB insert blocks would each hold thousands
        // of them at once; keep both small.
        { session, params: w.params, settings: {
            optimize_aggregation_in_order: 1,
            aggregation_in_order_max_block_bytes: 1_000_000,
            min_insert_block_size_bytes: 16_000_000,
        } },
    );
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

// The events of the players in `picked` (a SELECT over jr giving user_id, start,
// end), streamed in player then time order. No join: the table is read in its own
// (user_id, at, id) order, so nothing is sorted or held; journeysOf drops the
// player's journeys that weren't picked.
const journeyEvents = (db, session, w, picked) =>
    db.query(
        `SELECT toUnixTimestamp64Milli(at) / 1000 AS t, user_id, session_id, place, kind, name, menu, x, y, value, props
        FROM events FINAL
        WHERE ${w.where} AND user_id IN (SELECT user_id FROM (${picked}))
        ORDER BY user_id, at, id
        FORMAT JSONEachRow`,
        { session, params: w.params, settings: { output_format_json_quote_64bit_integers: 0 } },
    );

// buildJourneys one player at a time, so memory holds one player's events;
// yields only the picked journeys (the keys of isNew)
async function* journeysOf(rows, isNew) {
    let events = [];
    const flush = function* () {
        for (const j of buildJourneys(events)) {
            const key = `${j.userId}@${j.start}`;
            if (!isNew.has(key)) continue;
            j.userType = isNew.get(key) ? 'new' : 'returning';
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

async function report(db, session, w, query) {
    const options = compareOptions(query);
    if (options.comparison && w.configs.some((config) => config.key === options.comparison.key)) {
        throw badRequest(`compare key ${options.comparison.key} cannot also be a config filter`);
    }
    // A compare read assigns and filters players the same way as /paths so the
    // two endpoints have an identical denominator for identical parameters.
    await journeyTable(db, session, w, query, { byPlayer: Boolean(options.comparison) });
    await comparisonTable(db, session, w, options);
    const cohort = options.comparison ? 'in_group AND user_id IN (SELECT user_id FROM compare_players)' : 'in_group';
    const q = (sql) => db.rows(sql, { session, params: w.params });
    const [o] = await q(
        `SELECT count() AS nJourneys, uniqExact(user_id) AS players, countIf(ended) AS nEnded, countIf(is_new) AS nNew,
            quantileExactInclusive(0.5)(dur) AS med, avg(dur) AS mean, quantileExactInclusive(0.5)(clicks) AS medClicks,
            ${BOUNCES.map(([, s], i) => `countIf(dur < ${s}) AS b${i}, countIf(ended AND dur < ${s}) AS q${i}`).join(', ')},
            min(start) AS lo, max(end) AS hi
        FROM jr WHERE ${cohort}`,
    );
    const out = ['# Player journey report', ''];
    if (!o.nJourneys) {
        out.push('No events in range.');
        return { markdown: out.join('\n'), experiment: null };
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

    let experiment = null;
    if (options.comparison) {
        experiment = await experimentStats(db, session, w, query, options);
        out.push(...experimentMarkdown(experiment, options, options.comparison.key));
    }

    // where players leave: the last 3 actions before each quit
    const exits = (cond, limit) =>
        q(`SELECT arrayStringConcat(arraySlice(steps, -3), ' → ') AS k, count() AS n FROM jr
            WHERE ${cohort} AND ended ${cond} GROUP BY k ORDER BY n DESC, k LIMIT ${limit}`);
    out.push('## Exit points (last 3 actions before quitting)', '');
    out.push(table((await exits('', 15)).map((r) => [r.k || '(nothing)', r.n, pct(r.n, ended)]), ['path', 'quits', 'share']), '');
    for (const [i, [name, seconds]] of BOUNCES.entries()) {
        const quits = o[`q${i}`];
        out.push(`## Exit points, quit within ${name} (${quits})`, '');
        out.push(table((await exits(`AND dur < ${seconds}`, 10)).map((r) => [r.k || '(nothing)', r.n, pct(r.n, quits)]), ['path', 'quits', 'share']), '');
    }

    out.push('## Menu open at the last click before quitting', '');
    const menus = await q(`SELECT if(empty(cl) OR cl[-1].4 = '', '(no menu open)', cl[-1].4) AS k, count() AS n FROM jr
        WHERE ${cohort} AND ended GROUP BY k ORDER BY n DESC, k LIMIT 10`);
    out.push(table(menus.map((r) => [r.k, r.n, pct(r.n, ended)]), ['menu', 'quits', 'share']), '');

    out.push('## New players: first 3 clicks', '');
    const openings = await q(`SELECT arrayStringConcat(arrayMap(x -> x.3, arraySlice(cl, 1, 3)), ' → ') AS k, count() AS n FROM jr
        WHERE ${cohort} AND is_new GROUP BY k ORDER BY n DESC, k LIMIT 10`);
    out.push(table(openings.map((r) => [r.k || '(no clicks)', r.n, pct(r.n, o.nNew)]), ['path', 'journeys', 'share']), '');

    out.push('## Most clicked', '');
    const clicks = await q(`SELECT arrayJoin(arrayMap(x -> concat(x.3, if(x.4 = '', '', concat(' [', x.4, ']'))), cl)) AS k, count() AS n
        FROM jr WHERE ${cohort} GROUP BY k ORDER BY n DESC, k LIMIT 20`);
    out.push(table(clicks.map((r) => [r.k, r.n]), ['target [menu]', 'clicks']), '');

    out.push('## Button reach (share of journeys that ever clicked it)', '');
    const reach = await q(`SELECT arrayJoin(arrayDistinct(arrayMap(x -> x.5, arrayFilter(x -> x.6, cl)))) AS k, count() AS n
        FROM jr WHERE ${cohort} GROUP BY k ORDER BY n DESC, k LIMIT 20`);
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
            FROM jr WHERE ${cohort}
        )
        GROUP BY k ORDER BY n DESC, k LIMIT 15`);
    out.push(table(rage.map((r) => [r.k, r.n]), ['target', 'bursts']), '');

    out.push('## Common 3-click sequences', '');
    const trigrams = await q(`SELECT arrayJoin(arrayMap(i -> arrayStringConcat(arraySlice(s, i, 3), ' → '),
            range(1, toUInt64(greatest(length(s), 2)) - 1))) AS k, count() AS n
        FROM (SELECT arrayCompact(arrayMap(x -> x.3, cl)) AS s FROM jr WHERE ${cohort})
        GROUP BY k ORDER BY n DESC, k LIMIT 15`);
    out.push(table(trigrams.map((r) => [r.k, r.n]), ['sequence', 'times']), '');

    out.push('## Transitions (what each step leads to)', '');
    out.push(table((await transitions(q, 40, '1', 'steps', cohort)).map((r) => [r.f, r.t, r.n, pct(r.n, r.total)]), ['from', 'to', 'times', 'share of from']), '');

    const timelines = count(query.timelines, 20, 1000);
    if (timelines > 0) {
        const picked = `SELECT user_id, start, end, is_new FROM jr WHERE ${cohort} ORDER BY start DESC, user_id LIMIT ${timelines}`;
        const isNew = await picks(db, session, picked);
        const shown = [];
        for await (const j of journeysOf(eventRows(await journeyEvents(db, session, w, picked)), isNew)) shown.push(j);
        shown.sort((a, b) => b.start - a.start);
        out.push(`## Journeys (${shown.length} most recent of ${all})`, '');
        for (const j of shown) out.push(timeline(j), '');
    }
    return { markdown: out.join('\n'), experiment };
}

// step -> next step over every journey, repeats folded, quits as an end node;
// `cond` filters the (f, t) pairs, total is every edge out of f
const transitions = (q, limit, cond = '1', steps = 'steps', where = 'in_group') =>
    q(`SELECT f, t, n, total FROM (
            SELECT p.1 AS f, p.2 AS t, count() AS n, sum(n) OVER (PARTITION BY f) AS total
            FROM (
                SELECT arrayJoin(arrayZip(arrayPopBack(s), arrayPopFront(s))) AS p
                FROM (SELECT if(ended AND notEmpty(${steps}), arrayPushBack(arrayCompact(${steps}), '(quit)'), arrayCompact(${steps})) AS s
                    FROM jr WHERE ${where})
            ) GROUP BY f, t
        ) WHERE ${cond} ORDER BY n DESC, f, t LIMIT ${limit}`);

// /paths: Umami/Rybbit-style path analysis over full step names. A player's group
// is their last exposure to the config key in the window.
async function paths(db, session, w, query) {
    const limit = count(query.limit, 40, 1000) || 40;
    const purchaseLimit = count(query.purchase_limit, 40, 1000) || 40;
    const options = compareOptions(query);
    const comparison = options.comparison;
    if (comparison && w.configs.some((config) => config.key === comparison.key)) {
        throw badRequest(`compare key ${comparison.key} cannot also be a config filter`);
    }
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
    await journeyTable(db, session, w, query, { full: true, byPlayer: true });
    const q = (sql, settings) => db.rows(sql, { session, params: w.params, settings });
    await comparisonTable(db, session, w, options);
    const cohort = comparison ? 'in_group AND user_id IN (SELECT user_id FROM compare_players)' : 'in_group';
    const [o] = await q(`SELECT uniqExact(user_id) AS players, count() AS journeys, min(start) AS lo, max(end) AS hi FROM jr WHERE ${cohort}`);
    const players = o.players;
    const out = ['# Paths', ''];
    if (!o.journeys) {
        out.push('No events in range.');
        return { markdown: out.join('\n'), experiment: null };
    }
    const summary = [['group', configLabel(query)], ['players', players], ['journeys', o.journeys]];
    let arms = null;
    let armPlayers = null;
    if (comparison) {
        const counts = await q(`SELECT arm, uniqExact(jr.user_id) AS players
            FROM jr INNER JOIN compare_players USING user_id WHERE in_group GROUP BY arm ORDER BY arm`);
        arms = counts.map((row) => row.arm);
        armPlayers = new Map(counts.map((row) => [row.arm, row.players]));
        for (const [i, arm] of arms.entries()) w.params[`compareArm${i}`] = arm;
        summary.splice(1, 0,
            ['comparison', comparison.key],
            ...arms.map((arm) => [`${arm} players`, armPlayers.get(arm) ?? 0]),
        );
    }
    out.push(
        `${fmtDate(o.lo)} → ${fmtDate(o.hi)} UTC`,
        '',
        table(summary, ['', '']),
        '',
    );

    let experiment = null;
    if (comparison) {
        experiment = await experimentStats(db, session, w, query, options);
        out.push(...experimentMarkdown(experiment, options, comparison.key));
    } else {
        await selectedPlayersTable(db, session, false);
        await purchaseEventsTable(db, session, w);
    }

    // config_exposure is the grouping, not a step
    const STEPS = `arrayFilter(x -> x != 'config_exposure', steps)`;
    if (comparison) {
        out.push('## Steps by experiment arm (events, clicks, world taps)', '');
        const metrics = arms.flatMap((_, i) => [
            `countIf(arm = {compareArm${i}:String}) AS n${i}`,
            `uniqExactIf(user_id, arm = {compareArm${i}:String}) AS p${i}`,
        ]).join(', ');
        const maxPlayers = arms.length === 1 ? 'p0' : `greatest(${arms.map((_, i) => `p${i}`).join(', ')})`;
        const maxTimes = arms.length === 1 ? 'n0' : `greatest(${arms.map((_, i) => `n${i}`).join(', ')})`;
        const steps = await q(`SELECT k, ${metrics}
            FROM (
                SELECT user_id, arm, arrayJoin(${STEPS}) AS k
                FROM jr INNER JOIN compare_players USING user_id WHERE in_group
            ) GROUP BY k ${match ? `HAVING ${match}` : ''}
            ORDER BY ${maxPlayers} DESC, ${maxTimes} DESC, k LIMIT ${limit}`);
        out.push(table(steps.map((r) => [r.k, ...arms.flatMap((arm, i) => [
            r[`n${i}`], r[`p${i}`], pct(r[`p${i}`], armPlayers.get(arm) ?? 0),
        ])]), ['step', ...arms.flatMap((arm) => [
            `${arm} times`, `${arm} players`, `${arm} player share`,
        ])]), '');
    } else {
        out.push('## Steps (events, clicks, world taps)', '');
        const steps = await q(`SELECT arrayJoin(${STEPS}) AS k, count() AS n, uniqExact(user_id) AS p FROM jr WHERE ${cohort}
            GROUP BY k ${match ? `HAVING ${match}` : ''} ORDER BY p DESC, n DESC, k LIMIT ${limit}`);
        out.push(table(steps.map((r) => [r.k, r.n, r.p, pct(r.p, players)]), ['step', 'times', 'players', 'share of players']), '');
    }

    out.push('## Purchase prompts', '');
    const purchaseMetrics = (repeatColumn) => `countIf(prompted) AS o, countIf(purchased) AS b, countIf(cancelled) AS c,
        uniqExactIf(user_id, prompted) AS pp, uniqExactIf(user_id, purchased) AS bp,
        uniqExactIf(user_id, purchased AND is_new) AS nb,
        uniqExactIf(user_id, purchased AND NOT is_new) AS rb,
        sumIf(price, purchased) AS spend,
        uniqExactIf(user_id, ${repeatColumn} >= 2) AS repeat_buyers`;
    const enriched = `(SELECT *,
        countIf(purchased) OVER (PARTITION BY arm, user_id) AS user_buys,
        countIf(purchased) OVER (PARTITION BY arm, user_id, product_price) AS product_buys
        FROM purchase_events)`;
    const anyBuys = await q(`SELECT arm, 'Any product' AS k, ${purchaseMetrics('user_buys')}
        FROM ${enriched} GROUP BY arm ORDER BY arm`);
    for (const arm of comparison ? arms : ['']) {
        if (!anyBuys.some((row) => row.arm === arm)) anyBuys.push({
            arm, k: 'Any product', o: 0, b: 0, c: 0, pp: 0, bp: 0, nb: 0, rb: 0, spend: 0, repeat_buyers: 0,
        });
    }
    const productBuys = await q(`SELECT arm, product_price AS k, ${purchaseMetrics('product_buys')}
        FROM ${enriched} GROUP BY arm, k ${match ? `HAVING ${match}` : ''}
        ORDER BY arm, o DESC, k LIMIT ${purchaseLimit} BY arm`);
    const buys = [...anyBuys, ...productBuys].sort((a, b) => a.arm.localeCompare(b.arm)
        || (a.k === 'Any product' ? -1 : b.k === 'Any product' ? 1 : b.o - a.o || a.k.localeCompare(b.k)));
    const purchaseRows = buys.map((r) => [
        ...(comparison ? [r.arm || '(blank)'] : []), r.k, r.o, r.b, r.c, r.pp, r.bp, r.nb, r.rb, r.repeat_buyers, r.spend,
    ]);
    out.push(table(purchaseRows, [...(comparison ? ['arm'] : []), 'product@price', 'prompted', 'bought', 'cancelled',
        'prompted players', 'buyers', 'new buyers', 'returning buyers', 'repeat buyers (2+)', 'R$ spent']), '');

    out.push('## Prompt funnel by source', '');
    const funnels = await q(`SELECT arm, if(prompted, source, prompt_source) AS funnel_source,
            uniqExactIf(user_id, prompted) AS prompted_players,
            uniqExactIf(user_id, purchased) AS buyers,
            quantileExactInclusiveIf(0.5)(at - prompt_at, purchased AND prompt_at > 0) AS latency_p50,
            quantileExactInclusiveIf(0.9)(at - prompt_at, purchased AND prompt_at > 0) AS latency_p90
        FROM (
            SELECT *,
                maxIf(at, prompted) OVER (PARTITION BY arm, user_id, product
                    ORDER BY at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prompt_at,
                argMaxIf(source, (at, id), prompted) OVER (PARTITION BY arm, user_id, product
                    ORDER BY at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prompt_source
            FROM purchase_events
        ) GROUP BY arm, funnel_source ORDER BY arm, prompted_players DESC, funnel_source`);
    out.push(table(funnels.map((row) => [
        ...(comparison ? [row.arm || '(blank)'] : []), row.funnel_source, row.prompted_players, row.buyers,
        pct(row.buyers, row.prompted_players), row.latency_p50, row.latency_p90,
    ]), [...(comparison ? ['arm'] : []), 'source', 'prompted players', 'buyers', 'player conversion',
        'purchase latency p50 (s)', 'purchase latency p90 (s)']), '');

    if (path.length) {
        // what came next after the exact sequence, anywhere in a journey
        w.params.path = path.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
        // Compare fixed-size windows without capturing the entire journey in a
        // per-index lambda. Expand only the matching next labels, not full arrays.
        // A row is a whole journey, so keep blocks small for this array operation.
        const next = await q(`SELECT k, count() AS n, uniqExact(user_id) AS p, sum(n) OVER () AS total
            FROM (
                SELECT user_id, arrayFilter((next, window) -> window = {path:Array(String)},
                    arrayResize(arraySlice(s, ${path.length + 1}), length(windows), if(ended, '(quit)', '(end of window)')),
                    windows) AS nexts
                FROM (
                    SELECT user_id, ended, s, arrayShingles(s, ${path.length}) AS windows
                    FROM (SELECT user_id, ended, arrayCompact(${STEPS}) AS s FROM jr WHERE ${cohort})
                    WHERE length(s) >= ${path.length}
                )
            ) ARRAY JOIN nexts AS k
            GROUP BY k ORDER BY n DESC, k LIMIT ${limit}`, { max_block_size: 256 });
        out.push(`## After ${path.join(' → ')}`, '');
        out.push(table(next.map((r) => [r.k, r.n, r.p, pct(r.n, r.total)]), ['next', 'times', 'players', 'share']), '');
    } else {
        out.push('## Transitions', '');
        const cond = match ? 'match(f, {match:String}) OR match(t, {match:String})' : '1';
        const rows = await transitions(q, limit, cond, STEPS, cohort);
        out.push(table(rows.map((r) => [r.f, r.t, r.n, pct(r.n, r.total)]), ['from', 'to', 'times', 'share of from']), '');
    }
    return { markdown: out.join('\n'), experiment };
}

async function journeys(db, session, w, query) {
    await journeyTable(db, session, w, query);
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

// Latest config value per player, then distributions within the intersection of
// any repeated config filters. This powers the browser explorer without making
// it download or parse raw journeys.
async function configs(db, session, w, query) {
    await db.exec(`CREATE TEMPORARY TABLE player_configs ENGINE = MergeTree ORDER BY (user_id, config_key) AS
        SELECT user_id, config_key,
            argMax(config_value, (last_at, last_id)) AS config_value,
            toUnixTimestamp64Milli(argMax(first_at, (last_at, last_id))) / 1000 AS first_exposure
        FROM (
            SELECT user_id, JSONExtractString(props, 'key') AS config_key,
                ${EXPOSURE_VALUE} AS config_value, min(at) AS first_at,
                max(at) AS last_at, argMax(id, (at, id)) AS last_id
            FROM events FINAL
            WHERE ${w.where} AND kind = 'event' AND name = 'config_exposure' AND config_key != ''
            GROUP BY user_id, config_key, config_value
        ) GROUP BY user_id, config_key`, { session, params: w.params });

    const cohort = w.configs.length ? w.configs.map((_, i) => `user_id IN (
        SELECT user_id FROM player_configs
        WHERE config_key = {ckey${i}:String}
            AND ({anyValue${i}:Bool} OR config_value = {cvalue${i}:String}))`).join(' AND ') : '1';
    const opts = { session, params: w.params };
    await db.exec(`CREATE TEMPORARY TABLE cohort_users ENGINE = MergeTree ORDER BY user_id AS
        SELECT DISTINCT user_id FROM player_configs WHERE ${cohort}`, opts);
    // A ClickHouse session permits one active query at a time.
    const [overview] = await db.rows(`SELECT uniqExact(user_id) AS players FROM cohort_users`, opts);
    const rows = await db.rows(`SELECT config_key, config_value, uniqExact(user_id) AS players,
            min(first_exposure) AS first_exposure
        FROM player_configs WHERE user_id IN (SELECT user_id FROM cohort_users)
        GROUP BY config_key, config_value ORDER BY config_key, config_value`, opts);
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.config_key)) grouped.set(row.config_key, []);
        grouped.get(row.config_key).push({
            value: row.config_value,
            players: row.players,
            firstExposure: new Date(Number(row.first_exposure) * 1000).toISOString(),
        });
    }
    const comparison = comparisonOf(query);
    if (comparison && w.configs.some((config) => config.key === comparison.key)) {
        throw badRequest(`compare key ${comparison.key} cannot also be a config filter`);
    }
    let interactions = [];
    if (comparison) {
        w.params.compareKey = comparison.key;
        const matrix = await db.rows(`SELECT c.config_value AS compare_arm,
                o.config_key AS config_key, o.config_value AS config_value,
                uniqExact(c.user_id) AS players
            FROM player_configs AS c INNER JOIN player_configs AS o USING user_id
            WHERE c.user_id IN (SELECT user_id FROM cohort_users)
                AND c.config_key = {compareKey:String} AND o.config_key != {compareKey:String}
            GROUP BY compare_arm, config_key, config_value
            ORDER BY config_key, compare_arm, config_value`, opts);
        const armTotals = new Map((grouped.get(comparison.key) ?? []).map((arm) => [arm.value, arm.players]));
        interactions = matrix.map((row) => ({
            compareArm: row.compare_arm,
            config: row.config_key,
            arm: row.config_value,
            players: row.players,
            playerShare: armTotals.get(row.compare_arm) ? row.players / armTotals.get(row.compare_arm) : 0,
        }));
    }
    return JSON.stringify({
        filters: w.configs.map((config) => config.raw),
        compare: comparison?.key ?? null,
        players: overview.players,
        configs: [...grouped].map(([key, arms]) => ({
            key,
            players: arms.reduce((total, arm) => total + arm.players, 0),
            arms,
        })),
        interactions,
    });
}

// Returns { status, type, body } or { status, type, parts } for a read request;
// `query` is the URL's searchParams as a plain object.
// Optional settings let integration tests exercise spilling under a memory cap.
export async function runRead(db, pathname, query, { settings = {} } = {}) {
    const source = db;
    const cacheable = ['/report', '/paths'].includes(pathname) && query.compare !== undefined;
    const cacheKey = cacheable ? `${pathname}:${JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)))}` : null;
    let cache = READ_CACHES.get(source);
    if (!cache) {
        cache = new Map();
        READ_CACHES.set(source, cache);
    }
    if (cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return cached.result;
        if (cached) cache.delete(cacheKey);
    }
    db = {};
    for (const method of ['exec', 'rows', 'query']) {
        db[method] = (sql, opts = {}) => source[method](sql, {
            ...opts,
            settings: { ...READ_SETTINGS, ...settings, ...opts.settings },
        });
    }
    // temporary tables live in a session; one per request
    const session = randomUUID();
    try {
        if (query.compare !== undefined && !['/paths', '/report', '/configs'].includes(pathname)) {
            throw badRequest('compare is only supported by /paths, /report and /configs');
        }
        let result;
        if (pathname === '/report' || pathname === '/paths') {
            const format = outputFormat(query);
            const document = pathname === '/report'
                ? await report(db, session, windowOf(query, '7d'), query)
                : await paths(db, session, windowOf(query, '24h'), query);
            result = format === 'json'
                ? { status: 200, type: 'application/json', body: JSON.stringify({
                    ...markdownJson(document.markdown), experiment: document.experiment,
                }) }
                : { status: 200, type: 'text/markdown', body: document.markdown };
        } else if (pathname === '/configs') {
            result = { status: 200, type: 'application/json', body: await configs(db, session, windowOf(query, '7d'), query) };
        } else {
            result = { status: 200, type: 'application/json', parts: await journeys(db, session, windowOf(query, '7d'), query) };
        }
        if (cacheKey) {
            cache.set(cacheKey, { expires: Date.now() + READ_CACHE_TTL_MS, result });
            while (cache.size > READ_CACHE_MAX) cache.delete(cache.keys().next().value);
        }
        return result;
    } catch (error) {
        if (error.status !== 400) throw error;
        return { status: 400, type: 'application/json', body: JSON.stringify({ error: error.message }) };
    }
}
