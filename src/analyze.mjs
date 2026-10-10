// Journey analysis CLI: the same reads as the HTTP endpoints, straight off
// ClickHouse (CLICKHOUSE_* env, see db.mjs). Prints the markdown report, or
// /paths, or JSON journeys -- the thing to hand Claude when asking "what are
// players doing?".
//
//   bun src/analyze.mjs [--since 7d] [--until ...] [--user <userId>] [--timelines 20]
//                       [--config key:value] [--live-only] [--json] [--paths [--path a>b]]
import { parseArgs } from 'node:util';
import { openDb } from './db.mjs';
import { runRead } from './reads.mjs';

const { values } = parseArgs({
    options: {
        since: { type: 'string', default: '7d' },
        until: { type: 'string' },
        user: { type: 'string' },
        timelines: { type: 'string', default: '20' },
        config: { type: 'string' },
        // Studio playtest rows are included unless asked otherwise
        'live-only': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        paths: { type: 'boolean', default: false },
        path: { type: 'string' },
        match: { type: 'string' },
        limit: { type: 'string' },
    },
});

const query = Object.fromEntries(
    Object.entries({
        since: values.since,
        until: values.until,
        user_id: values.user,
        timelines: values.timelines,
        config: values.config,
        studio: values['live-only'] ? '0' : undefined,
        path: values.path,
        match: values.match,
        limit: values.limit ?? (values.json ? '1000000' : undefined),
    }).filter(([, v]) => v !== undefined),
);
const result = await runRead(openDb(), values.json ? '/journeys' : values.paths ? '/paths' : '/report', query);
if (result.parts) for await (const part of result.parts) process.stdout.write(part);
else process.stdout.write(result.body);
process.stdout.write('\n');
