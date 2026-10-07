// Journey reconstruction + the analysis report over the click log.
//
// A JOURNEY is one player's continuous visit: their events in time order, cut
// after a `session_ended` or wherever they go quiet for longer than GAP_SECONDS.
// A `teleported` event (lobby -> game, restart hop, ...) does NOT cut it, so a
// journey follows the player across servers the way they experienced it.

export const GAP_SECONDS = 30 * 60;
const RAGE_WINDOW_SECONDS = 2;
const RAGE_MIN_CLICKS = 4;
// Buttons players are MEANT to mash, so a burst on them is never rage. Matched
// against the click target path. The speed upgrade's coin buy button
// (SpeedUpgrade -> CoinUpgrade) is bought level after level in quick taps.
const RAGE_IGNORE = [/\/CoinUpgrade\//];
// bounce cut-offs, shortest first
const BOUNCES = [['15s', 15], ['1 min', 60], ['3 min', 180]];
const SESSION_EDGES = new Set(['session_started', 'session_ended', 'teleported']);

// 'MainUI/Root/Shop/Items/Card/BuyButton' -> 'MainUI/…/Card/BuyButton': the
// head names the ScreenGui, the tail names the button.
export function shortTarget(event) {
    if (event.kind !== 'button') return event.name;
    const parts = event.name.split('/');
    if (parts.length <= 4) return parts.join('/');
    return [parts[0], '…', ...parts.slice(-2)].join('/');
}

export function label(event) {
    if (event.kind === 'event') return event.name;
    const target = shortTarget(event);
    return event.kind === 'world' ? target : `click ${target}`;
}

export function buildJourneys(events, gapSeconds = GAP_SECONDS) {
    const journeys = [];
    let current = null;
    for (const event of events) {
        const startNew =
            !current ||
            current.userId !== event.user_id ||
            event.at - current.end > gapSeconds ||
            current.ended;
        if (startNew) {
            current = {
                id: `${event.user_id}@${Math.floor(event.at)}`,
                userId: event.user_id,
                start: event.at,
                end: event.at,
                places: new Set(),
                ended: false,
                events: [],
            };
            journeys.push(current);
        }
        current.events.push(event);
        current.end = event.at;
        if (event.place) current.places.add(event.place);
        if (event.kind === 'event' && event.name === 'session_ended') current.ended = true;
    }
    return journeys.map(summarise);
}

function summarise(journey) {
    const clicks = journey.events.filter((e) => e.kind !== 'event');
    const end = journey.events.findLast((e) => e.kind === 'event' && e.name === 'session_ended');
    const userType = end?.props?.user_type ?? null;
    return {
        ...journey,
        places: [...journey.places],
        // session_ended carries the game's own session length; the first/last
        // event span undercounts sessions that began before the read window
        durationSeconds: end?.value ?? journey.end - journey.start,
        clickCount: clicks.length,
        // is this the player's first-ever visit? (new = join-time snapshot)
        userType: typeof userType === 'string' ? userType.replace(/^User - /, '').toLowerCase() : null,
        sawStart: journey.events.some((e) => e.kind === 'event' && e.name === 'session_started'),
        rage: findRageClicks(clicks),
    };
}

// Bursts of RAGE_MIN_CLICKS+ clicks on one target inside RAGE_WINDOW_SECONDS:
// the usual sign a button looked clickable and didn't respond.
export function findRageClicks(clicks) {
    const bursts = [];
    let i = 0;
    while (i < clicks.length) {
        if (RAGE_IGNORE.some((pattern) => pattern.test(clicks[i].name))) {
            i++;
            continue;
        }
        let j = i;
        while (
            j + 1 < clicks.length &&
            clicks[j + 1].name === clicks[i].name &&
            clicks[j + 1].at - clicks[i].at <= RAGE_WINDOW_SECONDS
        ) {
            j++;
        }
        if (j - i + 1 >= RAGE_MIN_CLICKS) {
            bursts.push({ target: shortTarget(clicks[i]), count: j - i + 1, at: clicks[i].at });
        }
        i = j + 1;
    }
    return bursts;
}

const fmtClock = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtDate = (unix) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const top = (map, limit) => [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);

const table = (rows, headers) =>
    rows.length
        ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
        : '_none_';

// One journey as a compact timeline: offsets from the start, consecutive
// repeats folded ("×3"), the menu each click happened in.
export function timeline(journey) {
    const lines = [];
    let previous = null;
    for (const event of journey.events) {
        if (event.kind === 'event' && event.name === 'session_started') continue;
        const text = label(event) + (event.kind !== 'event' && event.menu ? `  [${event.menu}]` : '');
        if (previous && previous.text === text) {
            previous.count++;
            lines[lines.length - 1] = `${previous.prefix}${text} ×${previous.count}`;
            continue;
        }
        const marker = event.kind === 'event' ? '•' : '→';
        const prefix = `  +${fmtClock(event.at - journey.start)} ${marker} `;
        previous = { text, count: 1, prefix };
        lines.push(prefix + text);
    }
    const head =
        `### Journey ${journey.id} — user ${journey.userId}` +
        `${journey.userType ? ` (${journey.userType})` : ''}\n` +
        `${fmtDate(journey.start)} UTC · ${fmtClock(journey.durationSeconds)} · ` +
        `${journey.clickCount} clicks · ${journey.places.join(' → ') || 'unknown place'} · ` +
        `${journey.ended ? 'quit' : 'no session_ended (still playing, crashed or cut by a gap)'}`;
    return `${head}\n${lines.join('\n')}`;
}

// The full markdown report: aggregates first, then per-journey timelines.
export function report(journeys, options) {
    const r = createReport(options);
    for (const journey of journeys) r.add(journey);
    return r.render();
}

// The same report fed one journey at a time: only counts and the newest few
// journeys are kept, so a caller can build journeys a batch of players at a time
// (holding a whole 24h window of events ran past the pod's 2Gi).
export function createReport({ timelines = 20, contextSteps = 3 } = {}) {
    const all = []; // per-journey numbers, no events
    const users = new Set();
    const exits = new Map();
    const bounceExits = BOUNCES.map(() => new Map());
    const lastMenus = new Map();
    const openings = new Map();
    const clicks = new Map();
    const reach = new Map();
    const rage = new Map();
    const trigrams = new Map();
    const edges = new Map();
    let recent = [];

    function add(j) {
        users.add(j.userId);
        all.push({ start: j.start, end: j.end, ended: j.ended, isNew: j.userType === 'new', seconds: j.durationSeconds, clicks: j.clickCount });
        const clickEvents = j.events.filter((e) => e.kind !== 'event');
        // where players leave: the last few actions before each quit
        if (j.ended) {
            const path = j.events
                .filter((e) => !SESSION_EDGES.has(e.name) || e.kind !== 'event')
                .slice(-contextSteps)
                .map(label)
                .join(' → ');
            bump(exits, path);
            BOUNCES.forEach(([, seconds], i) => j.durationSeconds < seconds && bump(bounceExits[i], path));
            bump(lastMenus, clickEvents.at(-1)?.menu ?? '(no menu open)');
        }
        // the opening of a new player's visit
        if (j.userType === 'new') bump(openings, clickEvents.slice(0, 3).map(label).join(' → '));
        const reached = new Set();
        const steps = [];
        for (const e of clickEvents) {
            const l = label(e);
            bump(clicks, `${l}${e.menu ? ` [${e.menu}]` : ''}`);
            if (e.kind === 'button') reached.add(shortTarget(e));
            if (steps.at(-1) !== l) steps.push(l);
        }
        // reach: share of journeys that clicked a target at least once
        for (const t of reached) bump(reach, t);
        // common 3-step click sequences anywhere in a journey
        for (let i = 0; i + 2 < steps.length; i++) bump(trigrams, steps.slice(i, i + 3).join(' → '));
        for (const r of j.rage) bump(rage, r.target);
        // Sankey data: each step and what came next, repeats folded, quits as an end node
        let prev = null;
        for (const e of j.events) {
            if (e.kind === 'event' && SESSION_EDGES.has(e.name)) continue;
            const l = label(e);
            if (l === prev) continue;
            if (prev !== null) bump(edges, `${prev}\t${l}`);
            prev = l;
        }
        if (j.ended && prev !== null) bump(edges, `${prev}\t(quit)`);
        if (timelines > 0) {
            recent.push(j);
            if (recent.length > timelines * 4) recent = newest(recent);
        }
    }
    const newest = (list) => [...list].sort((a, b) => b.start - a.start).slice(0, timelines);

    function render() {
        const out = ['# Player journey report', ''];
        if (!all.length) {
            out.push('No events in range.');
            return out.join('\n');
        }
        const ended = all.filter((j) => j.ended);
        const newCount = all.filter((j) => j.isNew).length;
        out.push(
            `${fmtDate(all.reduce((m, j) => Math.min(m, j.start), Infinity))} → ` +
                `${fmtDate(all.reduce((m, j) => Math.max(m, j.end), 0))} UTC`,
            '',
            table(
                [
                    ['players', users.size],
                    ['journeys', all.length],
                    ['ended with a quit', `${ended.length} (${pct(ended.length, all.length)})`],
                    ['new-player journeys', newCount],
                    ['median journey length', fmtClock(median(all.map((j) => j.seconds)))],
                    ['mean journey length', fmtClock(all.reduce((sum, j) => sum + j.seconds, 0) / all.length)],
                    ['median clicks / journey', median(all.map((j) => j.clicks))],
                    ...BOUNCES.map(([name, seconds]) => [`journeys under ${name}`, pct(all.filter((j) => j.seconds < seconds).length, all.length)]),
                ],
                ['metric', 'value'],
            ),
            '',
        );

        out.push(`## Exit points (last ${contextSteps} actions before quitting)`, '');
        out.push(table(top(exits, 15).map(([path, n]) => [path || '(nothing)', n, pct(n, ended.length)]), ['path', 'quits', 'share']), '');
        BOUNCES.forEach(([name, seconds], i) => {
            const quits = ended.filter((j) => j.seconds < seconds).length;
            out.push(`## Exit points, quit within ${name} (${quits})`, '');
            out.push(table(top(bounceExits[i], 10).map(([path, n]) => [path || '(nothing)', n, pct(n, quits)]), ['path', 'quits', 'share']), '');
        });

        out.push('## Menu open at the last click before quitting', '');
        out.push(table(top(lastMenus, 10).map(([menu, n]) => [menu, n, pct(n, ended.length)]), ['menu', 'quits', 'share']), '');

        out.push('## New players: first 3 clicks', '');
        out.push(table(top(openings, 10).map(([path, n]) => [path || '(no clicks)', n, pct(n, newCount)]), ['path', 'journeys', 'share']), '');

        out.push('## Most clicked', '');
        out.push(table(top(clicks, 20), ['target [menu]', 'clicks']), '');

        out.push('## Button reach (share of journeys that ever clicked it)', '');
        out.push(table(top(reach, 20).map(([t, n]) => [t, n, pct(n, all.length)]), ['button', 'journeys', 'share']), '');

        out.push(`## Rage clicks (${RAGE_MIN_CLICKS}+ on one target within ${RAGE_WINDOW_SECONDS}s)`, '');
        out.push(table(top(rage, 15), ['target', 'bursts']), '');

        out.push('## Common 3-click sequences', '');
        out.push(table(top(trigrams, 15), ['sequence', 'times']), '');

        const fromTotal = new Map();
        for (const [e, n] of edges) {
            const from = e.slice(0, e.indexOf('\t'));
            fromTotal.set(from, (fromTotal.get(from) ?? 0) + n);
        }
        out.push('## Transitions (what each step leads to)', '');
        out.push(
            table(
                top(edges, 40).map(([e, n]) => {
                    const [from, to] = e.split('\t');
                    return [from, to, n, pct(n, fromTotal.get(from))];
                }),
                ['from', 'to', 'times', 'share of from'],
            ),
            '',
        );

        if (timelines > 0) {
            const picked = newest(recent);
            out.push(`## Journeys (${picked.length} most recent of ${all.length})`, '');
            for (const journey of picked) out.push(timeline(journey), '');
        }
        return out.join('\n');
    }

    return { add, render };
}

// '24h' / '7d' / '30m' / ISO date / unix seconds -> unix seconds
export function parseSince(value, now = Date.now() / 1000) {
    if (value === undefined || value === null || value === '') return null;
    const rel = /^(\d+(?:\.\d+)?)([mhd])$/.exec(value);
    if (rel) return now - Number(rel[1]) * { m: 60, h: 3600, d: 86400 }[rel[2]];
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new Error(`can't read time "${value}" (use 24h, 7d, an ISO date or unix seconds)`);
    return parsed / 1000;
}
