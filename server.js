// AI Workshops Share - local server. No dependencies. Requires Node 18+.
// Run:  node server.js   then open http://localhost:3000
// The API key lives in config.json and never reaches the browser.
//
// Flow per selected project (a background job the page polls):
//   1. set Workspace Status = Active in the project list (if not already)
//   2. wait for the project workspace to be created
//   3. share the workspace with the email in the project name
//   4. tick the Shared checkbox in the project list

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let wsCache = { at: 0, list: [] };
const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg, API_KEY, BASE, PORT, PF, SHEET_ID, COLS, ACCESS, SEND_EMAIL, ACTIVE_VALUE, POLL_MS, TIMEOUT_MS, TRACKER_NAME, TRACKER_ACCESS;

function applyConfig(c) {
  const key = (c.smartsheet || {}).apiKey;
  if (!key || key.startsWith('PASTE_')) throw new Error('smartsheet.apiKey is not set');
  if (!Array.isArray(c.portfolios) || !c.portfolios.length) throw new Error('config needs at least one entry in "portfolios"');
  cfg = c;
  API_KEY = key;
  BASE = c.smartsheet.baseUrl || 'https://api.smartsheet.com/2.0';
  PORT = (c.server || {}).port || 3000;
  // The first portfolio in config.json is used (a portfolio picker can be added later).
  PF = c.portfolios[0];
  SHEET_ID = PF.projectListSheetId;
  COLS = Object.assign({ name: 'Project Name', status: 'Workspace Status', date: 'Date', location: 'Location', type: 'Type', shared: 'Shared' }, PF.columns);
  ACCESS = PF.workspaceAccess || 'EDITOR';
  SEND_EMAIL = PF.sendInviteEmail !== false;
  ACTIVE_VALUE = PF.activeValue || 'Active';
  POLL_MS = (PF.pollSeconds || 5) * 1000;
  TIMEOUT_MS = (PF.provisionTimeoutSeconds || 300) * 1000;
  TRACKER_NAME = (PF.trackerSheet || {}).name || 'Community Project Tracker';
  TRACKER_ACCESS = (PF.trackerSheet || {}).access || 'ADMIN';
  wsCache = { at: 0, list: [] };
}
try { applyConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
catch (e) { console.error('Config error in config.json: ' + e.message); process.exit(1); }

// ---- config editing (used by the Settings dialog)
const LEVELS = ['VIEWER', 'COMMENTER', 'EDITOR', 'EDITOR_SHARE', 'ADMIN'];
function publicConfig() {
  const k = cfg.smartsheet.apiKey;
  return { smartsheet: { apiKeySet: true, apiKeyHint: '…' + k.slice(-4), baseUrl: cfg.smartsheet.baseUrl || '' }, server: cfg.server || {}, portfolios: cfg.portfolios, levels: LEVELS };
}
function saveConfig(body) {
  const sm = body.smartsheet || {};
  const next = {
    smartsheet: { apiKey: (sm.apiKey || '').trim() || cfg.smartsheet.apiKey, baseUrl: (sm.baseUrl || '').trim() || 'https://api.smartsheet.com/2.0' },
    server: { port: Number((body.server || {}).port) || 3000 },
    portfolios: (body.portfolios || []).map(p => ({
      name: String(p.name || '').trim(),
      projectListSheetId: Number(p.projectListSheetId),
      workspaceAccess: p.workspaceAccess,
      sendInviteEmail: !!p.sendInviteEmail,
      trackerSheet: { name: String((p.trackerSheet || {}).name || '').trim(), access: (p.trackerSheet || {}).access },
      columns: Object.fromEntries(['name', 'status', 'date', 'location', 'type', 'shared'].map(k => [k, String((p.columns || {})[k] || '').trim()])),
      activeValue: String(p.activeValue || '').trim(),
      pollSeconds: Number(p.pollSeconds),
      provisionTimeoutSeconds: Number(p.provisionTimeoutSeconds),
    })),
  };
  if (!next.portfolios.length) throw new Error('At least one portfolio is required');
  if (!(next.server.port >= 1 && next.server.port <= 65535)) throw new Error('Port must be 1-65535');
  next.portfolios.forEach((p, i) => {
    const n = p.name || `Portfolio ${i + 1}`;
    if (!p.name) throw new Error(`Portfolio ${i + 1}: name is required`);
    if (!(p.projectListSheetId > 0)) throw new Error(`${n}: project list sheet ID must be a number`);
    if (!LEVELS.includes(p.workspaceAccess)) throw new Error(`${n}: invalid workspace access`);
    if (!LEVELS.includes(p.trackerSheet.access)) throw new Error(`${n}: invalid tracker access`);
    if (!p.trackerSheet.name) throw new Error(`${n}: tracker sheet name is required`);
    if (Object.values(p.columns).some(v => !v)) throw new Error(`${n}: every column name is required`);
    if (!p.activeValue) throw new Error(`${n}: active value is required`);
    if (!(p.pollSeconds >= 1) || !(p.provisionTimeoutSeconds >= 10)) throw new Error(`${n}: poll seconds >= 1 and timeout >= 10`);
  });
  const portChanged = next.server.port !== PORT;
  const text = JSON.stringify(next, null, 2) + '\n';
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  fs.writeFileSync(CONFIG_PATH + '.tmp', text);
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
  applyConfig(next);
  return { portChanged };
}
function findSheet(node, name) {
  const want = name.trim().toLowerCase();
  const hit = (node.sheets || []).find(s => s.name.trim().toLowerCase() === want);
  if (hit) return hit;
  for (const f of node.folders || []) { const r = findSheet(f, name); if (r) return r; }
  return null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ss(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = new Error(json.message || json.raw || res.statusText);
    e.status = res.status; e.errorCode = json.errorCode; throw e;
  }
  return json;
}

// ---- workspace lookup, cached 60s unless force
async function workspaces(force) {
  if (!force && Date.now() - wsCache.at < 60000) return wsCache.list;
  let list = [], page = 1, total = 1;
  do {
    const r = await ss('GET', `/workspaces?includeAll=false&pageSize=500&page=${page}`);
    list = list.concat(r.data || []); total = r.totalPages || 1; page++;
  } while (page <= total);
  wsCache = { at: Date.now(), list };
  return list;
}

function resolveWorkspace(row, colById, wsList) {
  // 1. any cell hyperlink pointing at a workspace
  for (const c of row.cells) {
    const url = c.hyperlink && c.hyperlink.url;
    if (url && /\/workspaces\//.test(url)) {
      const hit = wsList.find(w => w.permalink && url.startsWith(w.permalink));
      if (hit) return hit;
    }
  }
  // 2. workspace whose name equals the project name
  const nameCol = Object.values(colById).find(c => c.title === COLS.name);
  const nameCell = row.cells.find(c => c.columnId === nameCol.id);
  const nm = String((nameCell && nameCell.value) || '').trim().toLowerCase();
  return wsList.find(w => w.name.trim().toLowerCase() === nm) || null;
}

async function loadProjects(force) {
  const [sheet, wsList] = await Promise.all([ss('GET', `/sheets/${SHEET_ID}`), workspaces(force)]);
  const colById = {}; sheet.columns.forEach(c => (colById[c.id] = c));
  const cellOf = (row, title) => {
    const col = sheet.columns.find(c => c.title === title);
    return col && row.cells.find(c => c.columnId === col.id);
  };
  const val = (row, title) => {
    const cell = cellOf(row, title);
    return cell && cell.displayValue != null ? String(cell.displayValue) : (cell && cell.value != null ? String(cell.value) : '');
  };
  const raw = (row, title) => {
    const cell = cellOf(row, title);
    return cell && cell.value != null ? String(cell.value) : '';
  };
  return sheet.rows.map(row => {
    const ws = resolveWorkspace(row, colById, wsList);
    const name = val(row, COLS.name).trim();
    const status = raw(row, COLS.status);
    return {
      rowId: row.id,
      name,
      email: EMAIL_RE.test(name) ? name : null,
      date: raw(row, COLS.date),
      location: val(row, COLS.location),
      type: val(row, COLS.type),
      status,
      active: status === ACTIVE_VALUE,
      shared: raw(row, COLS.shared).toLowerCase() === 'true',
      workspaceId: ws ? ws.id : null,
      workspaceName: ws ? ws.name : null,
      workspaceUrl: ws ? ws.permalink : null,
    };
  }).filter(p => p.name);
}

async function columnId(title) {
  const sheet = await ss('GET', `/sheets/${SHEET_ID}?pageSize=1`);
  const col = sheet.columns.find(c => c.title === title);
  if (!col) throw new Error(`Column "${title}" not found in the project list`);
  return col.id;
}

// Grant `level` on a sheet and VERIFY it. Handles: new share, existing share (update), and
// Smartsheet silently granting a lower level (e.g. unlicensed users cannot be Admin).
async function itemShare(sheetId, email) {
  const r = await ss('GET', `/sheets/${sheetId}/shares?sharingInclude=ITEM&includeAll=true`);
  return (r.data || []).find(s => (s.email || '').toLowerCase() === email.toLowerCase()) || null;
}
async function ensureSheetAccess(sheetId, email, level) {
  let share = await itemShare(sheetId, email);
  if (!share) {
    try { await ss('POST', `/sheets/${sheetId}/shares?sendEmail=false`, [{ email, accessLevel: level }]); }
    catch (e) { if (!(e.errorCode === 1020 || /already/i.test(e.message))) throw e; }
    share = await itemShare(sheetId, email);
  }
  if (share && share.accessLevel !== level) {
    await ss('PUT', `/sheets/${sheetId}/shares/${share.id}`, { accessLevel: level });
    share = await itemShare(sheetId, email);
  }
  if (!share) throw new Error('share was not created on the sheet');
  if (share.accessLevel !== level) {
    throw new Error(`Smartsheet set ${share.accessLevel} instead of ${level} (Admin needs a licensed Smartsheet user)`);
  }
}

// ---- background jobs
const jobs = new Map();

function startJob(rowIds) {
  const job = { id: crypto.randomUUID(), done: false, items: rowIds.map(id => ({ rowId: id, name: '', state: 'queued', ok: null, message: 'Queued' })) };
  jobs.set(job.id, job);
  runJob(job).catch(e => {
    job.items.filter(i => i.ok === null).forEach(i => setItem(i, 'error', false, e.message));
  }).finally(() => { job.done = true; });
  return job;
}

function setItem(item, state, ok, message) { item.state = state; item.ok = ok; item.message = message; }

async function runJob(job) {
  let projects = await loadProjects(true);
  const pending = []; // items waiting for a workspace
  const toActivate = [];

  for (const item of job.items) {
    const p = projects.find(x => x.rowId === item.rowId);
    if (!p) { setItem(item, 'error', false, 'Project not found'); continue; }
    item.name = p.name;
    if (!p.email) { setItem(item, 'error', false, 'Project name is not a valid email address'); continue; }
    pending.push(item);
    if (!p.active) toActivate.push(item);
    else setItem(item, 'waiting', null, p.workspaceId ? 'Workspace exists' : 'Already active, waiting for workspace');
  }

  // 1. activate
  if (toActivate.length) {
    try {
      const col = await columnId(COLS.status);
      await ss('PUT', `/sheets/${SHEET_ID}/rows`,
        toActivate.map(i => ({ id: i.rowId, cells: [{ columnId: col, value: ACTIVE_VALUE }] })));
      toActivate.forEach(i => setItem(i, 'waiting', null, 'Activated, waiting for workspace'));
    } catch (e) {
      toActivate.forEach(i => { setItem(i, 'error', false, `Could not set ${COLS.status}: ${e.message}`); pending.splice(pending.indexOf(i), 1); });
    }
  }

  // 2 + 3 + 4. wait for each workspace, then share
  const started = Date.now();
  let sharedCol = null;
  while (pending.length) {
    projects = await loadProjects(true);
    for (const item of [...pending]) {
      const p = projects.find(x => x.rowId === item.rowId);
      if (!p || !p.workspaceId) continue;
      pending.splice(pending.indexOf(item), 1);
      setItem(item, 'sharing', null, 'Sharing…');
      try {
        await ss('POST', `/workspaces/${p.workspaceId}/shares?sendEmail=${SEND_EMAIL}`,
          [{ email: p.email, accessLevel: ACCESS }]);
        item.message = `Shared with ${p.email} (${ACCESS})`;
      } catch (e) {
        const already = e.errorCode === 1020 || /already/i.test(e.message);
        if (!already) { setItem(item, 'error', false, e.message); continue; }
        item.message = `Already shared with ${p.email}`;
      }
      // give the participant higher access on the tracker sheet only (workspace stays at ACCESS)
      try {
        const ws = await ss('GET', `/workspaces/${p.workspaceId}?loadAll=true`);
        const sheet = findSheet(ws, TRACKER_NAME);
        if (!sheet) throw new Error(`sheet "${TRACKER_NAME}" not found in workspace`);
        await ensureSheetAccess(sheet.id, p.email, TRACKER_ACCESS);
        item.message += `; ${TRACKER_ACCESS} on ${TRACKER_NAME}`;
      } catch (e) {
        console.error(`[${p.email}] ${TRACKER_ACCESS} on ${TRACKER_NAME} failed:`, e.message);
        setItem(item, 'error', false, `Workspace shared, but ${TRACKER_ACCESS} on ${TRACKER_NAME} failed: ${e.message}`);
        continue;
      }
      try {
        sharedCol = sharedCol || await columnId(COLS.shared);
        await ss('PUT', `/sheets/${SHEET_ID}/rows`, [{ id: item.rowId, cells: [{ columnId: sharedCol, value: true }] }]);
        setItem(item, 'done', true, item.message);
      } catch (e) {
        setItem(item, 'done', true, `${item.message} (could not tick Shared: ${e.message})`);
      }
    }
    if (!pending.length) break;
    if (Date.now() - started > TIMEOUT_MS) {
      pending.forEach(i => setItem(i, 'error', false, `Workspace not created within ${TIMEOUT_MS / 1000}s. Try again later.`));
      break;
    }
    await sleep(POLL_MS);
  }
}

// ---- http
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const STATIC = new Set(['/index.html', '/styles.css', '/app.js', '/settings.js']);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b)); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return send(res, 200, publicConfig());
      if (req.method === 'POST') {
        const origin = req.headers.origin || '';
        if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: 'Forbidden origin' });
        try { return send(res, 200, saveConfig(JSON.parse((await readBody(req)) || '{}'))); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, { projects: await loadProjects(true), accessLevel: ACCESS });
    if (req.method === 'POST' && url.pathname === '/api/activate-share') {
      const { rowIds } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(rowIds) || !rowIds.length) return send(res, 400, { error: 'No projects selected' });
      return send(res, 200, { jobId: startJob(rowIds).id });
    }
    if (req.method === 'GET' && url.pathname === '/api/job') {
      const job = jobs.get(url.searchParams.get('id'));
      return job ? send(res, 200, job) : send(res, 404, { error: 'Job not found' });
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (req.method === 'GET' && STATIC.has(p)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] });
      return res.end(fs.readFileSync(path.join(__dirname, p)));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`AI Workshops Share running at http://localhost:${PORT}`));
