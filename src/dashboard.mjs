// Dependency-free config explorer served by the API process. Dynamic values are
// always assigned with textContent; report Markdown is parsed into DOM nodes so
// config/event names cannot inject HTML.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Click-log config explorer</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2d; --line:#28334d; --muted:#91a0bd; --text:#edf2ff; --accent:#7c9cff; --accent2:#46d6a0; --danger:#ff7b8b; }
    * { box-sizing:border-box }
    body { margin:0; background:radial-gradient(circle at top left,#172441 0,#0b1020 38rem); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,sans-serif }
    main { width:min(1480px,calc(100% - 32px)); margin:0 auto; padding:32px 0 72px }
    h1 { margin:0; font-size:clamp(28px,4vw,46px); letter-spacing:-.04em }
    h2 { margin:0 0 14px; font-size:20px }
    h3 { margin:22px 0 10px; font-size:16px }
    .lede,.muted { color:var(--muted) }
    .lede { margin:6px 0 26px; font-size:16px }
    .panel { background:color-mix(in srgb,var(--panel) 94%,transparent); border:1px solid var(--line); border-radius:16px; box-shadow:0 18px 50px #0004 }
    .controls { display:grid; grid-template-columns:minmax(220px,2fr) 140px minmax(180px,1fr) auto; gap:12px; padding:16px }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase }
    input,select,button { min-height:42px; border:1px solid var(--line); border-radius:10px; background:#0d1425; color:var(--text); padding:0 12px; font:inherit }
    button { cursor:pointer; border-color:#5575df; background:linear-gradient(135deg,#5575df,#7457d9); font-weight:800 }
    button:disabled { cursor:wait; opacity:.55 }
    .status { min-height:24px; margin:10px 4px 18px; color:var(--muted) }
    .status.error { color:var(--danger) }
    .filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; padding:16px; margin-bottom:18px }
    .filter.compare select { border-color:var(--accent); color:#cbd7ff }
    .summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:18px 0 }
    .stat { padding:18px }
    .stat strong { display:block; font-size:28px; letter-spacing:-.03em }
    .stat span { color:var(--muted) }
    .config-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); gap:14px; margin-bottom:22px }
    .config { padding:18px }
    .config-head { display:flex; justify-content:space-between; gap:12px; align-items:baseline; margin-bottom:14px }
    .config-head strong { overflow-wrap:anywhere }
    .arm { display:grid; grid-template-columns:minmax(90px,1fr) minmax(90px,2fr) auto; align-items:center; gap:10px; margin:9px 0 }
    .arm-name { overflow-wrap:anywhere }
    .track { height:8px; overflow:hidden; border-radius:999px; background:#26314a }
    .bar { height:100%; border-radius:inherit; background:linear-gradient(90deg,var(--accent),var(--accent2)) }
    .report { padding:20px; overflow:auto }
    .report > h1:first-child { display:none }
    table { width:100%; border-collapse:collapse; margin:8px 0 20px; white-space:nowrap }
    th,td { padding:9px 11px; border-bottom:1px solid var(--line); text-align:left }
    th { position:sticky; top:0; background:var(--panel); color:#c7d3ef; font-size:12px }
    tr:hover td { background:#18223a }
    .empty { padding:30px; text-align:center; color:var(--muted) }
    @media (max-width:820px) { main{width:min(100% - 20px,1480px);padding-top:20px}.controls{grid-template-columns:1fr 1fr}.controls label:first-child{grid-column:1/-1}.summary{grid-template-columns:1fr}.arm{grid-template-columns:minmax(70px,1fr) minmax(70px,2fr) auto} }
    @media (max-width:520px) { .controls{grid-template-columns:1fr}.controls label:first-child{grid-column:auto}.config-grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <main>
    <h1>Config explorer</h1>
    <p class="lede">Compare every arm of one experiment, then slice it by exact arms from the others.</p>
    <section class="panel controls" aria-label="Query controls">
      <label>Read token<input id="token" type="password" autocomplete="current-password" placeholder="Bearer token"></label>
      <label>Window<select id="since"><option value="24h">24 hours</option><option value="7d" selected>7 days</option><option value="30d">30 days</option><option value="90d">90 days</option></select></label>
      <label>Compare all arms of<select id="compare"></select></label>
      <button id="load" type="button">Load stats</button>
    </section>
    <div id="status" class="status" role="status"></div>
    <section id="filters-wrap" hidden>
      <h2>Arm filters</h2>
      <div id="filters" class="panel filters"></div>
    </section>
    <section id="summary" class="summary" hidden></section>
    <section>
      <h2>Config distributions</h2>
      <div id="configs" class="config-grid"><div class="panel empty">Enter the read token to load config statistics.</div></div>
    </section>
    <section>
      <h2>Interaction detail</h2>
      <div id="report" class="panel report"><div class="empty">Choose a comparison config to load paths.</div></div>
    </section>
  </main>
  <script>
    const byId = (id) => document.getElementById(id);
    const state = { catalog: [], selections: {} };
    const token = byId('token');
    const since = byId('since');
    const compare = byId('compare');
    const loadButton = byId('load');
    token.value = sessionStorage.getItem('clickLogReadToken') || '';

    const el = (name, className, text) => {
      const node = document.createElement(name);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const setStatus = (message, error) => {
      const node = byId('status');
      node.textContent = message;
      node.className = error ? 'status error' : 'status';
    };
    async function api(path, params) {
      const url = new URL(path, location.origin);
      for (const [key, value] of params) url.searchParams.append(key, value);
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token.value } });
      if (!response.ok) {
        let message = 'Request failed (' + response.status + ')';
        try { message = (await response.json()).error || message; } catch {}
        throw new Error(message);
      }
      return response;
    }
    const baseParams = () => [['since', since.value]];
    const activeFilters = () => Object.entries(state.selections)
      .filter(([key, value]) => value && key !== compare.value)
      .map(([key, value]) => ['config', key + ':' + value]);

    function renderControls() {
      const previous = compare.value;
      compare.replaceChildren();
      for (const config of state.catalog) {
        const option = el('option', '', config.key);
        option.value = config.key;
        compare.append(option);
      }
      compare.value = state.catalog.some((config) => config.key === previous) ? previous : (state.catalog[0] ? state.catalog[0].key : '');

      const filters = byId('filters');
      filters.replaceChildren();
      for (const config of state.catalog) {
        const label = el('label', config.key === compare.value ? 'filter compare' : 'filter');
        label.append(document.createTextNode(config.key));
        const select = el('select');
        select.dataset.key = config.key;
        select.append(el('option', '', config.key === compare.value ? 'All arms (comparison axis)' : 'All arms'));
        for (const arm of config.arms) {
          const option = el('option', '', arm.value);
          option.value = arm.value;
          select.append(option);
        }
        select.value = state.selections[config.key] || '';
        select.disabled = config.key === compare.value;
        select.addEventListener('change', () => { state.selections[config.key] = select.value; });
        label.append(select);
        filters.append(label);
      }
      byId('filters-wrap').hidden = !state.catalog.length;
    }

    function renderSummary(data, filters) {
      const summary = byId('summary');
      summary.replaceChildren();
      for (const [value, label] of [[data.players, 'players in slice'], [data.configs.length, 'config variables'], [filters.length, 'active arm filters']]) {
        const card = el('div', 'panel stat');
        card.append(el('strong', '', String(value)), el('span', '', label));
        summary.append(card);
      }
      summary.hidden = false;
    }

    function renderConfigs(data) {
      const root = byId('configs');
      root.replaceChildren();
      if (!data.configs.length) { root.append(el('div', 'panel empty', 'No config exposures matched this slice.')); return; }
      for (const config of data.configs) {
        const card = el('article', 'panel config');
        const head = el('div', 'config-head');
        head.append(el('strong', '', config.key), el('span', 'muted', config.players + ' exposed'));
        card.append(head);
        for (const arm of config.arms) {
          const share = config.players ? Math.round(arm.players / config.players * 100) : 0;
          const row = el('div', 'arm');
          const track = el('div', 'track');
          const bar = el('div', 'bar');
          bar.style.width = share + '%';
          track.append(bar);
          row.append(el('span', 'arm-name', arm.value || '(empty)'), track, el('span', 'muted', arm.players + ' · ' + share + '%'));
          card.append(row);
        }
        root.append(card);
      }
    }

    function markdownTable(lines, start) {
      const rows = [];
      let i = start;
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].slice(1, -1).split('|').map((cell) => cell.trim()));
        i++;
      }
      const table = el('table');
      const thead = el('thead');
      const header = el('tr');
      for (const cell of rows[0] || []) header.append(el('th', '', cell));
      thead.append(header); table.append(thead);
      const tbody = el('tbody');
      for (const row of rows.slice(2)) {
        const tr = el('tr');
        for (const cell of row) tr.append(el('td', '', cell));
        tbody.append(tr);
      }
      table.append(tbody);
      return { table, next: i };
    }
    function renderMarkdown(markdown) {
      const root = byId('report');
      root.replaceChildren();
      const lines = markdown.split(/\\r?\\n/);
      for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (!line) { i++; continue; }
        if (line.startsWith('|')) {
          const parsed = markdownTable(lines, i); root.append(parsed.table); i = parsed.next; continue;
        }
        const heading = /^(#{1,3})\\s+(.*)$/.exec(line);
        if (heading) { root.append(el('h' + heading[1].length, '', heading[2])); i++; continue; }
        root.append(el('p', line === '_none_' ? 'muted' : '', line)); i++;
      }
    }

    async function loadCatalog() {
      const response = await api('/configs', baseParams());
      const data = await response.json();
      state.catalog = data.configs;
      renderControls();
    }
    async function refresh() {
      if (!token.value) { setStatus('A read token is required.', true); token.focus(); return; }
      sessionStorage.setItem('clickLogReadToken', token.value);
      loadButton.disabled = true;
      setStatus('Loading config distributions and path interaction stats…');
      try {
        await loadCatalog();
        const filters = activeFilters();
        const statsResponse = await api('/configs', baseParams().concat(filters));
        const stats = await statsResponse.json();
        renderSummary(stats, filters);
        renderConfigs(stats);
        if (compare.value) {
          const reportResponse = await api('/paths', baseParams().concat([['compare', compare.value], ['limit', '50'], ['purchase_limit', '100']], filters));
          renderMarkdown(await reportResponse.text());
        }
        setStatus('Showing latest values per player for ' + since.options[since.selectedIndex].text.toLowerCase() + '.');
      } catch (error) {
        setStatus(error.message, true);
      } finally { loadButton.disabled = false; }
    }
    compare.addEventListener('change', () => { renderControls(); });
    loadButton.addEventListener('click', refresh);
    token.addEventListener('keydown', (event) => { if (event.key === 'Enter') refresh(); });
    if (token.value) refresh();
  </script>
</body>
</html>`;
