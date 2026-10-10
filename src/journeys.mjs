// Journey reconstruction and markdown helpers for the click log. The report
// itself is SQL (reads.mjs); this rebuilds the few journeys shown in full.
//
// A JOURNEY is one player's continuous visit: their events in time order, cut
// after a `session_ended` or wherever they go quiet for longer than GAP_SECONDS.
// A `teleported` event (lobby -> game, restart hop, ...) does NOT cut it, so a
// journey follows the player across servers the way they experienced it.

export const GAP_SECONDS = 30 * 60;
export const RAGE_WINDOW_SECONDS = 2;
export const RAGE_MIN_CLICKS = 4;
// Buttons players are MEANT to mash, so a burst on them is never rage. Matched
// against the click target path (substrings). The speed upgrade's coin buy button
// (SpeedUpgrade -> CoinUpgrade) is bought level after level in quick taps.
export const RAGE_IGNORE = ['/CoinUpgrade/'];

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
        if (RAGE_IGNORE.some((part) => clicks[i].name.includes(part))) {
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

export const fmtClock = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
export const fmtDate = (unix) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
export const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');


export const table = (rows, headers) =>
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
