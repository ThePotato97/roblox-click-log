// Public, secret-free instructions for an agent using the HTTP read API.
// Keep this beside the implementation rather than copying the README at runtime,
// so the production image does not need source-tree path assumptions.
export const AGENT_DOCS = `# Click-log agent API

This service records Roblox player events and reconstructs continuous journeys.
Use the same origin as this document. Never send or repeat the bearer token in
output, logs, query parameters, or generated links.

## Authentication

The read endpoints require this header:

\`Authorization: Bearer <READ_TOKEN>\`

\`GET /health\`, \`GET /agent\`, \`GET /llms.txt\`, \`GET /\`, and
\`GET /dashboard\` do not require authentication. The dashboard asks for the
read token and keeps it in browser session storage.

## Recommended workflow

1. Start with \`/configs\` to discover experiment keys, arms, and player counts.
2. Use \`/report\` for aggregate behaviour and recent example timelines.
3. Use \`/paths\` to inspect steps, transitions, purchase prompts, or compare all arms.
4. Request \`/journeys\` only when full event-level JSON is needed; set a conservative \`limit\`.
5. Narrow expensive reads with time and journey filters. Filters can be combined.

## Read endpoints

### GET /report

Returns Markdown (or structured JSON with \`format=json\`). Default window: \`since=7d\`. The report contains overview,
exit points, new-player openings, clicks, reach, rage clicks, sequences,
transitions, and recent journey timelines. Set \`timelines=0\` to omit timelines.
It accepts the same experiment comparison parameters as \`/paths\`.

### GET /paths

Returns Markdown (or structured JSON with \`format=json\`). Default window: \`since=24h\`. It includes full step names,
purchase prompts, and transitions. Parameters specific to this endpoint:

- \`match=<regex>\`: case-insensitive filter on displayed step/transition names.
- \`path=<step>[><step>...]\`: exact sequence of one to three steps; returns the next step.
- \`limit=<n>\`: maximum step, transition, or follow-up rows; default 40, maximum 1000.
- \`purchase_limit=<n>\`: independent maximum product rows; default 40, maximum 1000.
- \`compare=<config key>\`: discover every observed arm and show side-by-side
  step counts, distinct players, and player share, for example
  \`compare=chaos_catalog\`. Each player uses their latest value in the window.
- \`control=<arm>&ci=1\`: add 95% Wilson intervals to conversion rates,
  player-bootstrap intervals to spend and session metrics, relative lift with
  bounds, and the bootstrap chance that each arm beats the control. D1 counts
  any event 24-48 hours after first arm exposure, only with a full 48-hour window.
- \`series=daily\`: return cumulative daily metrics through one shared \`until\`.
- \`blank=1\`: include the blank arm; blank arms are excluded by default.
- \`dist=spend|session|purchases\`: include the selected distribution. Spend
  includes 0, 1-50, 51-200, and 200+ R$ buckets, percentiles, and top-1% share.
- \`format=json\`: return typed experiment metrics and structured report tables.

The purchase table is split by arm and reports prompt, purchase, and cancellation
events; distinct prompted players and buyers; distinct new and returning buyers;
repeat buyers; receipt-price R$ spend; and an \`Any product\` row. A buyer is a
distinct player with \`Purchase:PromptFinished\` and \`purchased=true\`.

Button steps are written as \`click <full button path>\`. URL-encode \`>\`, spaces,
slashes, and other reserved characters in requests.

### GET /journeys

Returns a JSON array containing complete journeys and events. Default window:
\`since=7d\`. \`limit\` selects the newest journeys; default 100. Prefer a small
limit because the response can be large. Responses support gzip.

### GET /configs

Returns JSON containing every config key and its observed arms, using each
player's latest value in the window. Each config includes exposed-player counts
per arm. Repeat \`config=key:value\` to restrict the player population to an
intersection of arms and reveal interactions with every other config.
Journey-level filters such as duration and clicks do not apply to this endpoint.

## Common parameters

- \`since\`, \`until\`: \`30m\`, \`24h\`, \`7d\`, ISO timestamp, or Unix seconds.
  Relative values mean that long ago. The time window is applied to raw events
  before journeys are reconstructed.
- \`user_id=<Roblox UserId>\`: one numeric user.
- \`studio=0\`: exclude Studio playtests.
- \`config=key:value\`: select an experiment value; \`config=key\` selects anyone
  exposed. Repeat the parameter to AND filters across different keys. Conflicting
  values for one key return \`400\`; use \`compare\` on \`/paths\` or \`/report\`
  for all arms.
- \`min_duration\`, \`max_duration\`: inclusive journey-duration bounds. Accept
  seconds or \`s\`, \`m\`, \`h\`, \`d\`, for example \`30s\` or \`5m\`.
- \`min_clicks\`, \`max_clicks\`: inclusive non-event click-count bounds.
- \`started=1|0\`: require or exclude a recorded \`session_started\`.
- \`ended=1|0\`: require or exclude a recorded \`session_ended\`.
- \`user_type=new|returning\`: first-ever journey or a later journey.
- \`place=<exact place>\`: at least one event in that place.
- \`event=<exact raw event name>\`: at least one event with that name. For a
  button, use its full target path without the \`click \` prefix.
- \`menu=<exact menu>\`: at least one click while that menu was open.
- \`platform\`, \`device\`, \`level\`, \`country\`: require an exact matching
  value in event props within the journey.
- \`spender=1|0\`: include or exclude players with a completed purchase in the window.

Journey duration uses the game's duration on \`session_ended\` when present;
otherwise it is the span between the first and last event visible in the window.

## Examples

\`GET /report?since=24h&min_duration=3m&ended=1&studio=0&timelines=10\`

\`GET /paths?since=7d&user_type=new&path=UI%3AOpened%3AChaos&limit=20\`

\`GET /paths?compare=chaos_catalog&purchase_limit=100\`

\`GET /paths?compare=chaos_catalog&control=power&ci=1&series=daily&since=7d&until=2026-10-16T00%3A00%3A00Z&format=json\`

\`GET /configs?since=7d&config=chaos_label%3Aicons\`

\`GET /journeys?since=24h&event=Purchase%3APromptFinished&limit=25\`

## Errors

- \`400\`: invalid parameter or contradictory range.
- \`401\`: missing or incorrect read token.
- \`503\`: ClickHouse is unavailable or the service is not ready.
`;
