// Dependency-free config explorer served by the API process. Dynamic values are
// assigned with textContent and the report's Markdown tables are parsed into DOM.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Click log — Flows</title>
  <style>
    :root { color-scheme:light; --nav:#2d2f36; --nav2:#24262c; --bg:#f5f6f8; --surface:#fff; --surface2:#f8f9fb; --line:#dfe2e8; --line2:#eceef2; --text:#292c35; --muted:#717683; --purple:#6657d9; --purple2:#897cec; --purpleSoft:#eeebff; --green:#159b78; --red:#c94f5d; --shadow:0 1px 3px #20242c14; }
    * { box-sizing:border-box }
    html,body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif }
    button,input { font:inherit }
    button { cursor:pointer }
    .topbar { min-height:48px; display:flex; align-items:center; justify-content:space-between; gap:18px; padding:0 18px; background:var(--nav); color:#fff }
    .brand { display:flex; align-items:center; gap:24px; min-width:0 }
    .brand strong { font-size:13px; letter-spacing:.08em }
    .nav { display:flex; align-self:stretch }
    .nav span { display:flex; align-items:center; padding:0 15px; border-bottom:3px solid var(--purple2); color:#fff }
    .auth { display:flex; align-items:center; gap:8px }
    .auth input { width:190px; height:32px; border:1px solid #50535c; border-radius:4px; padding:0 9px; background:var(--nav2); color:#fff; outline:none }
    .auth input:focus { border-color:#aaa1ff; box-shadow:0 0 0 2px #887ce744 }
    .auth button { height:32px; border:0; border-radius:4px; padding:0 12px; background:var(--purple); color:#fff; font-weight:600 }
    .pagebar { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:10px 18px; background:var(--surface); border-bottom:1px solid var(--line) }
    .page-title { min-width:0 }
    .page-title h1 { margin:0; font-size:18px; font-weight:600 }
    .page-title p { margin:2px 0 0; color:var(--muted); font-size:12px }
    .page-actions { display:flex; align-items:center; gap:10px }
    .window { display:flex; padding:2px; border:1px solid var(--line); border-radius:5px; background:var(--surface2) }
    .window button { height:28px; min-width:42px; border:0; border-radius:3px; background:transparent; color:var(--muted) }
    .window button[aria-pressed=true] { background:var(--surface); color:var(--purple); box-shadow:var(--shadow); font-weight:600 }
    .status { min-width:150px; color:var(--muted); font-size:12px; text-align:right }
    .status.error { color:var(--red) }
    .shell { display:grid; grid-template-columns:310px minmax(0,1fr); height:calc(100vh - 112px); min-height:520px }
    .query { min-width:0; overflow:auto; background:var(--surface); border-right:1px solid var(--line) }
    .query-section { padding:15px 16px; border-bottom:1px solid var(--line) }
    .eyebrow { margin:0 0 9px; color:var(--muted); font-size:11px; font-weight:700; letter-spacing:.07em; text-transform:uppercase }
    .config { padding:10px 0; border-top:1px solid var(--line2) }
    .config:first-of-type { border-top:0 }
    .config-head { display:flex; align-items:center; justify-content:space-between; gap:8px }
    .axis { min-width:0; border:0; padding:2px 0; background:transparent; color:var(--text); font-weight:600; text-align:left; overflow-wrap:anywhere }
    .axis:hover { color:var(--purple) }
    .axis[aria-pressed=true] { color:var(--purple) }
    .config-count { flex:none; color:var(--muted); font-size:11px }
    .compare-label { margin:6px 0 0; color:var(--purple); font-size:11px; font-weight:600 }
    .arms { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px }
    .arm { min-height:29px; border:1px solid var(--line); border-radius:4px; padding:4px 7px; background:var(--surface2); color:var(--muted); font-size:12px }
    .arm b { margin-left:3px; color:var(--text); font-weight:600 }
    .arm:hover:not(:disabled) { border-color:#aaa2e8; color:var(--purple) }
    .arm[aria-pressed=true] { border-color:var(--purple); background:var(--purpleSoft); color:var(--purple) }
    .config.is-axis .arm { opacity:.55; cursor:default }
    .query-empty { padding:22px 2px; color:var(--muted) }
    .workspace { min-width:0; overflow:auto; background:var(--bg) }
    .report-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:18px 20px 13px }
    .report-head h2 { margin:0; font-size:18px; font-weight:600 }
    .report-head p { margin:3px 0 0; color:var(--muted); font-size:12px }
    .slice { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:5px; color:var(--muted); font-size:12px }
    .chip { min-height:27px; border:1px solid #c8c1f2; border-radius:4px; padding:3px 7px; background:var(--purpleSoft); color:#5145b9 }
    button.chip:hover { border-color:var(--purple) }
    .tabs { display:flex; gap:18px; padding:0 20px; background:var(--surface); border-top:1px solid var(--line); border-bottom:1px solid var(--line) }
    .tab { height:42px; border:0; border-bottom:3px solid transparent; padding:0 2px; background:transparent; color:var(--muted) }
    .tab[aria-selected=true] { border-bottom-color:var(--purple); color:var(--text); font-weight:600 }
    .view { padding:18px 20px 28px }
    .view[hidden] { display:none }
    .panel { background:var(--surface); border:1px solid var(--line); border-radius:5px; box-shadow:var(--shadow) }
    .panel-title { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; border-bottom:1px solid var(--line2) }
    .panel-title h3 { margin:0; font-size:13px; font-weight:600 }
    .panel-title span { color:var(--muted); font-size:11px }
    .flow { min-height:430px; overflow:auto; padding:10px 12px 16px }
    .flow svg { display:block; width:100%; min-width:720px; height:auto }
    .flow .link { fill:none; stroke:#aa9ff0; stroke-opacity:.4 }
    .flow .node { fill:var(--purple) }
    .flow .target { fill:#2f9d87 }
    .flow text { fill:var(--text); font-size:12px }
    .flow .value { fill:var(--muted); font-size:11px }
    .empty { display:grid; place-items:center; min-height:260px; padding:30px; color:var(--muted); text-align:center }
    .table-wrap { overflow:auto }
    table { width:100%; border-collapse:collapse; min-width:660px }
    th,td { padding:9px 11px; border-bottom:1px solid var(--line2); text-align:left; vertical-align:top }
    th { position:sticky; top:0; z-index:1; background:var(--surface2); color:var(--muted); font-size:11px; font-weight:700; white-space:nowrap }
    td { font-size:12px }
    td:not(:first-child),th:not(:first-child) { text-align:right; font-variant-numeric:tabular-nums }
    tbody tr:last-child td { border-bottom:0 }
    tbody tr:hover td { background:#faf9ff }
    @media (max-width:760px) {
      body { overflow:auto }
      .topbar { height:auto; flex-wrap:wrap; padding:8px 12px }
      .nav { display:none }
      .auth { width:100% }
      .auth input { flex:1; width:auto }
      .pagebar { align-items:flex-start; flex-direction:column; padding:11px 12px }
      .page-actions { width:100%; justify-content:space-between }
      .status { min-width:0 }
      .shell { display:block; height:auto; min-height:0 }
      .query { overflow:visible; border-right:0; border-bottom:1px solid var(--line) }
      .workspace { overflow:visible }
      .report-head { padding:15px 12px 10px }
      .slice { justify-content:flex-start }
      .tabs { padding:0 12px }
      .view { padding:12px }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><strong>CLICK LOG</strong><nav class="nav" aria-label="Reports"><span>Flows</span></nav></div>
    <div class="auth">
      <label for="token" style="font-size:12px;color:#c9cbd2">Read token</label>
      <input id="token" type="password" autocomplete="current-password" placeholder="Bearer token">
      <button id="connect" type="button">Connect</button>
    </div>
  </header>
  <section class="pagebar">
    <div class="page-title"><h1>Config interaction flow</h1><p>Compare every arm of one config and narrow the cohort with arms from the others.</p></div>
    <div class="page-actions">
      <div class="window" role="group" aria-label="Time window">
        <button type="button" data-since="24h" aria-pressed="false">24h</button>
        <button type="button" data-since="7d" aria-pressed="true">7d</button>
        <button type="button" data-since="30d" aria-pressed="false">30d</button>
      </div>
      <div id="status" class="status" role="status">Enter the read token to load data.</div>
    </div>
  </section>
  <div class="shell">
    <aside class="query" aria-label="Query builder">
      <section class="query-section"><p class="eyebrow">Config variables</p><div id="configs"><div class="query-empty">Connect to list configs and arms.</div></div></section>
    </aside>
    <main class="workspace">
      <header class="report-head">
        <div><h2 id="report-title">Flows</h2><p id="report-meta">No comparison loaded</p></div>
        <div id="slice" class="slice" aria-live="polite"><span>All players</span></div>
      </header>
      <div class="tabs" role="tablist" aria-label="Report view">
        <button class="tab" id="flow-tab" type="button" role="tab" aria-controls="flow-view" aria-selected="true">Flow</button>
        <button class="tab" id="steps-tab" type="button" role="tab" aria-controls="steps-view" aria-selected="false">Step stats</button>
        <button class="tab" id="purchases-tab" type="button" role="tab" aria-controls="purchases-view" aria-selected="false">Purchases</button>
      </div>
      <section class="view" id="flow-view" role="tabpanel" aria-labelledby="flow-tab">
        <div class="panel"><div class="panel-title"><h3>Most common transitions</h3><span>Selected cohort</span></div><div id="flow" class="flow"><div class="empty">Load a comparison to see the Sankey.</div></div></div>
      </section>
      <section class="view" id="steps-view" role="tabpanel" aria-labelledby="steps-tab" hidden>
        <div class="panel"><div class="panel-title"><h3>Steps by experiment arm</h3><span>Players and share</span></div><div id="steps" class="table-wrap"></div></div>
      </section>
      <section class="view" id="purchases-view" role="tabpanel" aria-labelledby="purchases-tab" hidden>
        <div class="panel"><div class="panel-title"><h3>Purchase prompts</h3><span>Unique buyers and player type</span></div><div id="purchases" class="table-wrap"></div></div>
      </section>
    </main>
  </div>
  <script>
    const byId = (id) => document.getElementById(id);
    const state = { catalog: [], stats: null, selections: {}, compareKey: '', since: '7d', loading: false };
    const token = byId('token');
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
    const baseParams = () => [['since', state.since]];
    const filterParams = () => Object.entries(state.selections)
      .filter(([key, value]) => value && key !== state.compareKey)
      .map(([key, value]) => ['config', key + ':' + value]);

    function configFrom(data, key) { return (data && data.configs || []).find((config) => config.key === key); }
    function renderConfigs() {
      const root = byId('configs');
      root.replaceChildren();
      if (!state.catalog.length) { root.append(el('div', 'query-empty', 'No config exposures found in this window.')); return; }
      for (const config of state.catalog) {
        const current = configFrom(state.stats, config.key);
        const countByArm = new Map((current && current.arms || []).map((arm) => [arm.value, arm.players]));
        const total = current ? current.players : 0;
        const section = el('section', config.key === state.compareKey ? 'config is-axis' : 'config');
        const head = el('div', 'config-head');
        const axis = el('button', 'axis', config.key);
        axis.type = 'button';
        axis.setAttribute('aria-pressed', String(config.key === state.compareKey));
        axis.addEventListener('click', async () => {
          if (state.compareKey === config.key || state.loading) return;
          state.compareKey = config.key;
          delete state.selections[config.key];
          await refreshData();
        });
        head.append(axis, el('span', 'config-count', total.toLocaleString() + ' players'));
        section.append(head);
        if (config.key === state.compareKey) section.append(el('div', 'compare-label', 'Comparing all arms'));
        const arms = el('div', 'arms');
        for (const arm of config.arms) {
          const count = countByArm.get(arm.value) || 0;
          const share = total ? Math.round(count / total * 100) : 0;
          const button = el('button', 'arm');
          button.type = 'button';
          button.setAttribute('aria-pressed', String(state.selections[config.key] === arm.value));
          button.disabled = config.key === state.compareKey;
          button.append(document.createTextNode(arm.value || '(empty)'), el('b', '', count.toLocaleString() + ' · ' + share + '%'));
          button.addEventListener('click', async () => {
            if (state.loading) return;
            state.selections[config.key] = state.selections[config.key] === arm.value ? '' : arm.value;
            await refreshData();
          });
          arms.append(button);
        }
        section.append(arms);
        root.append(section);
      }
    }

    function renderSlice() {
      const root = byId('slice');
      root.replaceChildren();
      const filters = Object.entries(state.selections).filter(([key, value]) => value && key !== state.compareKey);
      if (!filters.length) { root.append(el('span', '', 'All players')); return; }
      root.append(el('span', '', 'Filtered by'));
      for (const [key, value] of filters) {
        const chip = el('button', 'chip', key + ' = ' + value + ' ×');
        chip.type = 'button';
        chip.addEventListener('click', async () => { state.selections[key] = ''; await refreshData(); });
        root.append(chip);
      }
    }

    function parseTable(lines, start) {
      const rows = [];
      let i = start;
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].slice(1, -1).split('|').map((cell) => cell.trim()));
        i++;
      }
      return { headers: rows[0] || [], rows: rows.slice(2), next: i };
    }
    function reportTables(markdown) {
      const result = new Map();
      const lines = markdown.split(/\\r?\\n/);
      let section = 'Summary';
      for (let i = 0; i < lines.length;) {
        const heading = /^##\\s+(.*)$/.exec(lines[i]);
        if (heading) { section = heading[1]; i++; continue; }
        if (lines[i].startsWith('|')) {
          const parsed = parseTable(lines, i);
          result.set(section, { headers: parsed.headers, rows: parsed.rows });
          i = parsed.next; continue;
        }
        i++;
      }
      return result;
    }
    function findTable(tables, prefix) {
      for (const [name, table] of tables) if (name.startsWith(prefix)) return table;
      return null;
    }
    function renderTable(root, data, emptyMessage) {
      root.replaceChildren();
      if (!data || !data.rows.length) { root.append(el('div', 'empty', emptyMessage)); return; }
      const table = el('table');
      const thead = el('thead');
      const header = el('tr');
      for (const cell of data.headers) header.append(el('th', '', cell));
      thead.append(header); table.append(thead);
      const tbody = el('tbody');
      for (const row of data.rows) {
        const tr = el('tr');
        for (const cell of row) tr.append(el('td', '', cell));
        tbody.append(tr);
      }
      table.append(tbody); root.append(table);
    }

    function shortLabel(value) { return value.length > 31 ? value.slice(0, 28) + '…' : value; }
    function renderSankey(data) {
      const root = byId('flow');
      root.replaceChildren();
      if (!data || !data.rows.length) { root.append(el('div', 'empty', 'No transitions matched this cohort.')); return; }
      const links = data.rows.map((row) => ({ from: row[0], to: row[1], n: Number(String(row[2]).replace(/,/g, '')) }))
        .filter((link) => link.from && link.to && link.from !== link.to && Number.isFinite(link.n) && link.n > 0)
        .slice(0, 18);
      if (!links.length) { root.append(el('div', 'empty', 'No transitions matched this cohort.')); return; }
      const sources = new Map(); const targets = new Map();
      for (const link of links) {
        sources.set(link.from, (sources.get(link.from) || 0) + link.n);
        targets.set(link.to, (targets.get(link.to) || 0) + link.n);
      }
      const sourceNodes = [...sources].map(([name, total]) => ({ name, total })).sort((a,b) => b.total-a.total);
      const targetNodes = [...targets].map(([name, total]) => ({ name, total })).sort((a,b) => b.total-a.total);
      const width = 980; const height = Math.max(430, Math.max(sourceNodes.length, targetNodes.length) * 72 + 70);
      const top = 36; const bottom = 34; const gap = 34;
      const total = links.reduce((sum, link) => sum + link.n, 0);
      const scale = Math.min((height-top-bottom-gap*(sourceNodes.length-1))/total, (height-top-bottom-gap*(targetNodes.length-1))/total);
      function place(nodes, x) {
        const used = nodes.reduce((sum,node) => sum + node.total*scale, 0) + gap*(nodes.length-1);
        let y = top + Math.max(0,(height-top-bottom-used)/2);
        for (const node of nodes) { node.x=x; node.y=y; node.h=Math.max(2,node.total*scale); node.offset=0; y += node.h+gap; }
        return new Map(nodes.map((node) => [node.name,node]));
      }
      const sourceMap = place(sourceNodes, 250); const targetMap = place(targetNodes, 720);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 '+width+' '+height);
      svg.setAttribute('role','img');
      svg.setAttribute('aria-label','Most common event transitions for the selected config cohort');
      for (const link of links.sort((a,b) => b.n-a.n)) {
        const source = sourceMap.get(link.from); const target = targetMap.get(link.to);
        const thick = Math.max(2,link.n*scale);
        const sy = source.y+source.offset+thick/2; const ty = target.y+target.offset+thick/2;
        source.offset += thick; target.offset += thick;
        const path = document.createElementNS(ns,'path');
        path.setAttribute('class','link');
        path.setAttribute('d','M '+(source.x+14)+' '+sy+' C 430 '+sy+', 540 '+ty+', '+target.x+' '+ty);
        path.setAttribute('stroke-width',String(thick));
        const title = document.createElementNS(ns,'title'); title.textContent = link.from+' → '+link.to+': '+link.n.toLocaleString(); path.append(title); svg.append(path);
      }
      function drawNode(node, target) {
        const rect = document.createElementNS(ns,'rect');
        rect.setAttribute('class',target?'node target':'node'); rect.setAttribute('x',String(node.x)); rect.setAttribute('y',String(node.y)); rect.setAttribute('width','14'); rect.setAttribute('height',String(node.h)); rect.setAttribute('rx','2'); svg.append(rect);
        const name = document.createElementNS(ns,'text'); name.textContent=shortLabel(node.name); name.setAttribute('x',String(target?node.x+23:node.x-10)); name.setAttribute('y',String(node.y+Math.min(14,node.h/2+4))); name.setAttribute('text-anchor',target?'start':'end'); svg.append(name);
        const value = document.createElementNS(ns,'text'); value.textContent=node.total.toLocaleString(); value.setAttribute('class','value'); value.setAttribute('x',String(target?node.x+23:node.x-10)); value.setAttribute('y',String(node.y+Math.min(29,node.h/2+19))); value.setAttribute('text-anchor',target?'start':'end'); svg.append(value);
      }
      sourceNodes.forEach((node) => drawNode(node,false)); targetNodes.forEach((node) => drawNode(node,true));
      root.append(svg);
    }

    function showTab(name) {
      for (const button of document.querySelectorAll('.tab')) {
        const active = button.id === name+'-tab';
        button.setAttribute('aria-selected',String(active));
        byId(button.getAttribute('aria-controls')).hidden = !active;
      }
    }
    for (const button of document.querySelectorAll('.tab')) button.addEventListener('click',() => showTab(button.id.replace('-tab','')));

    async function loadCatalog() {
      const response = await api('/configs',baseParams());
      const data = await response.json();
      state.catalog = data.configs;
      if (!state.compareKey || !state.catalog.some((config) => config.key === state.compareKey)) state.compareKey = state.catalog[0] ? state.catalog[0].key : '';
    }
    async function refreshData() {
      if (!token.value || !state.compareKey || state.loading) return;
      state.loading = true; setStatus('Running query…'); renderSlice();
      try {
        const filters = filterParams();
        const [statsResponse,reportResponse] = await Promise.all([
          api('/configs',baseParams().concat(filters)),
          api('/paths',baseParams().concat([['compare',state.compareKey],['limit','50'],['purchase_limit','100']],filters))
        ]);
        state.stats = await statsResponse.json();
        const markdown = await reportResponse.text();
        const tables = reportTables(markdown);
        renderConfigs(); renderSlice();
        renderSankey(findTable(tables,'Transitions'));
        renderTable(byId('steps'),findTable(tables,'Steps'),'No steps matched this cohort.');
        renderTable(byId('purchases'),findTable(tables,'Purchase prompts'),'No purchase prompts matched this cohort.');
        byId('report-title').textContent = state.compareKey+' flows';
        byId('report-meta').textContent = state.stats.players.toLocaleString()+' players · latest exposure per player · last '+state.since;
        setStatus('Updated just now');
      } catch (error) { setStatus(error.message,true); }
      finally { state.loading=false; }
    }
    async function connect() {
      if (!token.value) { setStatus('A read token is required.',true); token.focus(); return; }
      sessionStorage.setItem('clickLogReadToken',token.value);
      state.loading=true; setStatus('Loading configs…');
      try { await loadCatalog(); state.loading=false; await refreshData(); }
      catch (error) { state.loading=false; setStatus(error.message,true); }
    }
    byId('connect').addEventListener('click',connect);
    token.addEventListener('keydown',(event) => { if (event.key==='Enter') connect(); });
    for (const button of document.querySelectorAll('[data-since]')) button.addEventListener('click',async () => {
      if (state.loading || state.since===button.dataset.since) return;
      state.since=button.dataset.since;
      document.querySelectorAll('[data-since]').forEach((peer) => peer.setAttribute('aria-pressed',String(peer===button)));
      await loadCatalog(); await refreshData();
    });
    if (token.value) connect();
  </script>
</body>
</html>`;
