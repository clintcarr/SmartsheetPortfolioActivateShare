// AI Workshops Share - local server. No dependencies. Requires Node 18+.
// Run:  node server.js   then open http://localhost:3000
// The API key lives in config.json and never reaches the browser.
//
// Flow per selected project (a background job the page watches):
//   1. set Workspace Status = Active in the project list (if not already)
//   2. wait for the project workspace to be created
//   3. share the workspace with the email in the project name (Admin by default, optional custom invite text)
//   4. tick the Shared checkbox in the project list
//
// Analytics: counts the participant's own edits in each project's tracker sheet by reading cell history,
// with a quick check of a few key cells first. Scans, the job list and the activity log are kept in data/state.json.
// Same behaviour as the Google Apps Script version; here everything runs in this one process.

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const LEVELS = ['VIEWER', 'COMMENTER', 'EDITOR', 'EDITOR_SHARE', 'ADMIN'];
const TRACKER_LEVELS = ['NONE'].concat(LEVELS);
const COLUMN_KEYS = ['name', 'status', 'date', 'location', 'type', 'shared', 'attended'];
const DEFAULT_COLUMNS = { name: 'Project Name', status: 'Workspace Status', date: 'Date', location: 'Location', type: 'Type', shared: 'Shared', attended: 'Attended' };
// Cells checked first by an analytics scan: if the participant has not edited any, the scan stops early.
const DEFAULT_QUICK = [
  { column: 'Start Date', row: 8 }, { column: 'End Date', row: 5 }, { column: 'Status', row: 8 },
  { column: 'WBS ID', row: 22 }, { column: 'WBS ID', row: 36 },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCAN_BATCH = 60;        // cell-history requests sent in parallel
const SCAN_BATCH_MS = Number(process.env.AIWS_SCAN_BATCH_MS) || 15000;  // minimum time per batch, keeps us under Smartsheet's 300 requests/minute limit
const LOG_MAX = 1000;
const ITEM_TTL_MS = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- config
let cfg, API_KEY, BASE, PORT;
function applyConfig(c) {
  const key = (c.smartsheet || {}).apiKey;
  if (!key || key.startsWith('PASTE_')) throw new Error('smartsheet.apiKey is not set');
  if (!Array.isArray(c.portfolios) || !c.portfolios.length) throw new Error('config needs at least one entry in "portfolios"');
  cfg = c;
  API_KEY = key;
  BASE = c.smartsheet.baseUrl || 'https://api.smartsheet.com/2.0';
  PORT = (c.server || {}).port || 3000;
}
try { applyConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
catch (e) { console.error('Config error in config.json: ' + e.message); process.exit(1); }

// The first portfolio is used. Missing settings get defaults, so an older config.json still works.
function pf() {
  const p = cfg.portfolios[0];
  return {
    name: p.name || 'Portfolio',
    projectListSheetId: p.projectListSheetId,
    workspaceAccess: p.workspaceAccess || 'ADMIN',
    sendInviteEmail: p.sendInviteEmail !== false,
    emailSubject: p.emailSubject || '',
    emailMessage: p.emailMessage || '',
    ccMe: !!p.ccMe,
    trackerSheet: { name: (p.trackerSheet || {}).name || 'Community Project Tracker', access: (p.trackerSheet || {}).access || 'NONE' },
    columns: Object.assign({}, DEFAULT_COLUMNS, p.columns),
    activeValue: p.activeValue || 'Active',
    pollSeconds: p.pollSeconds || 5,
    provisionTimeoutSeconds: p.provisionTimeoutSeconds || 300,
    quickCheck: Array.isArray(p.quickCheck) ? p.quickCheck : DEFAULT_QUICK,
  };
}

function getConfigPublic() {
  logEvent('info', 'settings.open', 'Opened Settings');
  const k = cfg.smartsheet.apiKey;
  return {
    smartsheet: { apiKeySet: true, apiKeyHint: '…' + k.slice(-4), baseUrl: cfg.smartsheet.baseUrl || '' },
    server: { port: PORT },
    portfolios: cfg.portfolios.map(p => Object.assign({ quickCheck: DEFAULT_QUICK, emailSubject: '', emailMessage: '', ccMe: false }, p,
      { columns: Object.assign({}, DEFAULT_COLUMNS, p.columns), trackerSheet: { name: (p.trackerSheet || {}).name || '', access: (p.trackerSheet || {}).access || 'NONE' } })),
    levels: LEVELS,
    trackerLevels: TRACKER_LEVELS,
  };
}

function flatten(o, prefix, out) {
  Object.keys(o || {}).forEach(k => {
    const v = o[k], p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object') flatten(v, p, out); else out[p] = v;
  });
  return out;
}
function diffConfig(a, b) {
  const fa = flatten(a, '', {}), fb = flatten(b, '', {}), out = [];
  Object.keys(fb).forEach(k => { if (k === 'smartsheet.apiKey') return; if (String(fa[k]) !== String(fb[k])) out.push(`${k}: ${fa[k]} -> ${fb[k]}`); });
  Object.keys(fa).forEach(k => { if (k !== 'smartsheet.apiKey' && !(k in fb)) out.push(k + ' removed'); });
  return out;
}

function saveConfig(body) {
  const sm = body.smartsheet || {};
  const next = {
    smartsheet: { apiKey: String(sm.apiKey || '').trim() || cfg.smartsheet.apiKey, baseUrl: String(sm.baseUrl || '').trim() || 'https://api.smartsheet.com/2.0' },
    server: { port: Number((body.server || {}).port) || 3000 },
    portfolios: (body.portfolios || []).map(p => ({
      name: String(p.name || '').trim(),
      projectListSheetId: Number(p.projectListSheetId),
      workspaceAccess: p.workspaceAccess,
      sendInviteEmail: !!p.sendInviteEmail,
      emailSubject: String(p.emailSubject || '').trim(),
      emailMessage: String(p.emailMessage || '').trim(),
      ccMe: !!p.ccMe,
      trackerSheet: { name: String((p.trackerSheet || {}).name || '').trim(), access: (p.trackerSheet || {}).access },
      columns: Object.fromEntries(COLUMN_KEYS.map(k => [k, String((p.columns || {})[k] || '').trim()])),
      activeValue: String(p.activeValue || '').trim(),
      pollSeconds: Number(p.pollSeconds),
      provisionTimeoutSeconds: Number(p.provisionTimeoutSeconds),
      quickCheck: (p.quickCheck || []).map(q => ({ column: String((q || {}).column || '').trim(), row: Number((q || {}).row) })),
    })),
  };
  if (!next.portfolios.length) throw new Error('At least one portfolio is required');
  if (!(next.server.port >= 1 && next.server.port <= 65535)) throw new Error('Port must be 1-65535');
  next.portfolios.forEach((p, i) => {
    const n = p.name || `Portfolio ${i + 1}`;
    if (!p.name) throw new Error(`Portfolio ${i + 1}: name is required`);
    if (!(p.projectListSheetId > 0)) throw new Error(`${n}: project list sheet ID must be a number`);
    if (!LEVELS.includes(p.workspaceAccess)) throw new Error(`${n}: invalid workspace access`);
    if (!TRACKER_LEVELS.includes(p.trackerSheet.access)) throw new Error(`${n}: invalid tracker access`);
    if (!p.trackerSheet.name) throw new Error(`${n}: tracker sheet name is required`);
    if (Object.values(p.columns).some(v => !v)) throw new Error(`${n}: every column name is required`);
    if (!p.activeValue) throw new Error(`${n}: active value is required`);
    if (p.quickCheck.some(q => !q.column || !(q.row >= 1) || q.row !== Math.floor(q.row))) throw new Error(`${n}: each quick-check cell needs a column name and a whole row number (1 or more)`);
    if (!(p.pollSeconds >= 1) || !(p.provisionTimeoutSeconds >= 10)) throw new Error(`${n}: poll seconds >= 1 and timeout >= 10`);
  });
  const changes = diffConfig(cfg, next);
  if (String(sm.apiKey || '').trim()) changes.push('API key updated');
  const portChanged = next.server.port !== PORT;
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
  applyConfig(next);
  logEvent('ok', 'settings.save', changes.length ? 'Saved: ' + changes.join(', ') : 'Saved (no changes)');
  return { ok: true, portChanged };
}

// ---------------------------------------------------------------- stored state (scans, jobs, log) in data/state.json
let state = { items: {}, scans: {}, log: [] };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch { /* first run */ }
let saveTimer = null;
function writeState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_PATH + '.tmp', STATE_PATH);
  } catch (e) { console.error('Could not save data/state.json:', e.message); }
}
function persist() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, 300); }
process.on('SIGINT', () => { writeState(); process.exit(0); });
process.on('SIGTERM', () => { writeState(); process.exit(0); });

// ---------------------------------------------------------------- activity log
let lastErr = { sig: '', at: 0 };
function logEvent(level, act, msg) {
  try {
    msg = String(msg == null ? '' : msg).replace(/\s+/g, ' ').slice(0, 160);
    if (level === 'error') {                                   // don't flood the log with the same repeating error
      const sig = act + '|' + msg;
      if (lastErr.sig === sig && Date.now() - lastErr.at < 60000) return;
      lastErr = { sig, at: Date.now() };
    }
    state.log.unshift({ t: Date.now(), level, act, msg });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    persist();
  } catch { /* logging must never break the app */ }
}
function getLog() { return { entries: state.log.slice(0, LOG_MAX), max: LOG_MAX, user: '' }; }
function clearLog() { state.log = []; logEvent('info', 'log.clear', 'Log cleared'); return { ok: true }; }
function logView() { logEvent('info', 'log.view', 'Opened the log page'); return { ok: true }; }

// ---------------------------------------------------------------- Smartsheet API
async function ss(method, urlPath, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(BASE + urlPath, {
      method,
      headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (res.status === 429 || res.status === 503) { await sleep(2000 * (attempt + 1)); continue; }   // rate limited: back off and retry
    if (!res.ok) {
      const e = new Error(json.message || json.raw || res.statusText);
      e.status = res.status; e.errorCode = json.errorCode; throw e;
    }
    return json;
  }
  throw new Error('Smartsheet is rate limiting requests. Try again shortly.');
}
const isAlready = e => e.errorCode === 1020 || /already/i.test(e.message);

// Several GETs in parallel; the ones Smartsheet rate-limited are retried after a wait.
async function getMany(paths) {
  const one = async p => {
    try {
      const res = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + API_KEY } });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (res.ok) return { ok: true, json };
      return { ok: false, error: json.message || 'HTTP ' + res.status, status: res.status };
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const out = new Array(paths.length);
  let pending = paths.map((_, i) => i);
  for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
    const rs = await Promise.all(pending.map(i => one(paths[i])));
    const again = [];
    rs.forEach((r, k) => { if (!r.ok && (r.status === 429 || r.status === 503)) again.push(pending[k]); else out[pending[k]] = r; });
    pending = again;
    if (pending.length) await sleep(15000 * (attempt + 1));
  }
  pending.forEach(i => { out[i] = { ok: false, error: 'rate limited' }; });
  return out;
}

async function workspaces() {
  let list = [], page = 1, total = 1;
  do {
    const r = await ss('GET', `/workspaces?includeAll=false&pageSize=500&page=${page}`);
    list = list.concat(r.data || []); total = r.totalPages || 1; page++;
  } while (page <= total);
  return list;
}

async function loadProjects() {
  const P = pf(), C = P.columns;
  const [sheet, wsList] = await Promise.all([ss('GET', `/sheets/${P.projectListSheetId}`), workspaces()]);
  const colByTitle = {}; sheet.columns.forEach(c => { colByTitle[c.title] = c; });
  const cellOf = (row, title) => { const col = colByTitle[title]; return col && row.cells.find(c => c.columnId === col.id); };
  const val = (row, title) => { const c = cellOf(row, title); return c && c.displayValue != null ? String(c.displayValue) : (c && c.value != null ? String(c.value) : ''); };
  const raw = (row, title) => { const c = cellOf(row, title); return c && c.value != null ? String(c.value) : ''; };
  const findWs = (row, name) => {
    for (const c of row.cells) {                               // 1. workspace hyperlink on any cell
      const url = c.hyperlink && c.hyperlink.url;
      if (url && /\/workspaces\//.test(url)) {
        const hit = wsList.find(w => w.permalink && url.startsWith(w.permalink));
        if (hit) return hit;
      }
    }
    const nm = name.toLowerCase();                             // 2. workspace named after the project
    return wsList.find(w => w.name.trim().toLowerCase() === nm) || null;
  };
  return sheet.rows.map(row => {
    const name = val(row, C.name).trim();
    const status = raw(row, C.status);
    const ws = findWs(row, name);
    return {
      rowId: row.id, name, email: EMAIL_RE.test(name) ? name : null,
      date: raw(row, C.date), location: val(row, C.location), type: val(row, C.type),
      status, active: status === P.activeValue, shared: raw(row, C.shared).toLowerCase() === 'true',
      attended: colByTitle[C.attended] ? raw(row, C.attended).toLowerCase() === 'true' : null,   // null = no such column
      workspaceId: ws ? ws.id : null, workspaceName: ws ? ws.name : null, workspaceUrl: ws ? ws.permalink : null,
    };
  }).filter(p => p.name);
}

async function columnId(title) {
  const sheet = await ss('GET', `/sheets/${pf().projectListSheetId}?pageSize=1`);
  const col = sheet.columns.find(c => c.title === title);
  if (!col) throw new Error(`Column "${title}" not found in the project list`);
  return col.id;
}

function findSheet(node, name) {
  const want = name.trim().toLowerCase();
  const hit = (node.sheets || []).find(s => s.name.trim().toLowerCase() === want);
  if (hit) return hit;
  for (const f of node.folders || []) { const r = findSheet(f, name); if (r) return r; }
  return null;
}

// Make sure the user has `level` on a whole workspace: upgrades an existing share (for example Editor to Admin) and verifies.
async function ensureWorkspaceAccess(wsId, email, level) {
  const find = async () => {
    const r = await ss('GET', `/workspaces/${wsId}/shares?includeAll=true`);
    return (r.data || []).find(s => (s.email || '').toLowerCase() === email.toLowerCase()) || null;
  };
  let share = await find();
  if (share && share.accessLevel !== level) {
    await ss('PUT', `/workspaces/${wsId}/shares/${share.id}`, { accessLevel: level });
    share = await find();
  }
  if (!share) throw new Error('share was not found on the workspace');
  if (share.accessLevel !== level) throw new Error(`Smartsheet set ${share.accessLevel} instead of ${level} (Admin needs a licensed Smartsheet user)`);
}

async function itemShare(sheetId, email) {
  const r = await ss('GET', `/sheets/${sheetId}/shares?sharingInclude=ITEM&includeAll=true`);
  return (r.data || []).find(s => (s.email || '').toLowerCase() === email.toLowerCase()) || null;
}
// Grant `level` on one sheet and verify it (new share, existing share, or Smartsheet granting a lower level).
async function ensureSheetAccess(sheetId, email, level) {
  let share = await itemShare(sheetId, email);
  if (!share) {
    try { await ss('POST', `/sheets/${sheetId}/shares?sendEmail=false`, [{ email, accessLevel: level }]); }
    catch (e) { if (!isAlready(e)) throw e; }
    share = await itemShare(sheetId, email);
  }
  if (share && share.accessLevel !== level) {
    await ss('PUT', `/sheets/${sheetId}/shares/${share.id}`, { accessLevel: level });
    share = await itemShare(sheetId, email);
  }
  if (!share) throw new Error('share was not created on the sheet');
  if (share.accessLevel !== level) throw new Error(`Smartsheet set ${share.accessLevel} instead of ${level} (Admin needs a licensed Smartsheet user)`);
}

// ---------------------------------------------------------------- activate and share (job items)
let chain = Promise.resolve();                                  // one state-changing job step at a time
const exclusive = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

function setItem(item, st, ok, message) {
  item.state = st; item.ok = ok; item.message = message; item.updated = Date.now(); persist();
  logEvent(ok === false ? 'error' : st === 'done' ? 'ok' : 'info', 'item.' + st, (item.name || item.rowId) + ': ' + message);
}
function loadItems() {
  const now = Date.now();
  Object.keys(state.items).forEach(k => { const it = state.items[k]; if (it.state !== 'waiting' && now - it.updated > ITEM_TTL_MS) delete state.items[k]; });
  return Object.values(state.items);
}

async function getProjects(reason) {
  const why = reason || 'load';
  try {
    const P = pf();
    const projects = await loadProjects();
    const act = projects.filter(p => p.active).length, sh = projects.filter(p => p.shared).length;
    logEvent('info', why === 'initial' ? 'page.open' : why === 'reload' ? 'reload' : 'retrieve',
      `Retrieved ${projects.length} projects from ${P.name} (${act} active, ${sh} shared)` + (why === 'initial' || why === 'reload' ? '' : ` [${why}]`));
    kickPending();                                              // resume anything left waiting from before a restart
    return { projects, accessLevel: P.workspaceAccess, items: loadItems(), user: '' };
  } catch (e) {
    logEvent('error', 'retrieve', 'Could not retrieve projects: ' + e.message);
    throw e;
  }
}

function activateAndShare(rowIds) {
  return exclusive(async () => {
    try {
      const P = pf();
      const projects = await loadProjects();
      const now = Date.now();
      const toActivate = [];
      logEvent('info', 'job.start', `Activate and share requested for ${rowIds.length} project(s)`);
      rowIds.forEach(id => {
        const p = projects.find(x => x.rowId === id);
        const item = { rowId: id, name: '', state: 'queued', ok: null, message: 'Queued', started: now, updated: now };
        if (!p) { item.state = 'error'; item.ok = false; item.message = 'Project not found'; }
        else {
          item.name = p.name;
          if (!p.email) { item.state = 'error'; item.ok = false; item.message = 'Project name is not a valid email address'; }
          else if (!p.active) toActivate.push(item);
          else { item.state = 'waiting'; item.message = p.workspaceId ? 'Workspace exists' : 'Already active, waiting for workspace'; }
        }
        state.items[id] = item; persist();
        if (item.state === 'error') logEvent('error', 'item.error', (item.name || item.rowId) + ': ' + item.message);
      });
      if (toActivate.length) {
        try {
          const col = await columnId(P.columns.status);
          await ss('PUT', `/sheets/${P.projectListSheetId}/rows`, toActivate.map(i => ({ id: i.rowId, cells: [{ columnId: col, value: P.activeValue }] })));
          logEvent('ok', 'activate', `Set ${P.columns.status} to ${P.activeValue} for ${toActivate.length} project(s)`);
          toActivate.forEach(i => setItem(i, 'waiting', null, 'Activated, waiting for workspace'));
        } catch (e) {
          toActivate.forEach(i => setItem(i, 'error', false, `Could not set ${P.columns.status}: ${e.message}`));
        }
      }
      kickPending();
      return { ok: true };
    } catch (e) { logEvent('error', 'job.start', 'Activate and share failed: ' + e.message); throw e; }
  });
}

function getStatus() { kickPending(); return { items: loadItems() }; }

// Background worker: re-checks waiting projects every pollSeconds until none are left.
let pendingRunning = false;
function kickPending() {
  if (pendingRunning || !loadItems().some(i => i.state === 'waiting')) return;
  pendingRunning = true;
  (async () => {
    try {
      while (loadItems().some(i => i.state === 'waiting')) {
        try { await exclusive(processPendingOnce); }
        catch (e) { logEvent('error', 'process', 'Processing failed: ' + e.message); }
        await sleep(pf().pollSeconds * 1000);
      }
    } finally { pendingRunning = false; }
  })();
}

async function processPendingOnce() {
  const waiting = loadItems().filter(i => i.state === 'waiting');
  if (!waiting.length) return;
  const P = pf(), C = P.columns, level = P.workspaceAccess, tracker = P.trackerSheet, timeoutMs = P.provisionTimeoutSeconds * 1000;
  const projects = await loadProjects();
  let sharedCol = null;

  const tickShared = async (item, msg) => {
    try {
      sharedCol = sharedCol || await columnId(C.shared);
      await ss('PUT', `/sheets/${P.projectListSheetId}/rows`, [{ id: item.rowId, cells: [{ columnId: sharedCol, value: true }] }]);
      setItem(item, 'done', true, msg);
    } catch (e) { setItem(item, 'done', true, `${msg} (could not tick Shared: ${e.message})`); }
  };

  for (const item of waiting) {
    const p = projects.find(x => x.rowId === item.rowId);
    if (!p || !p.workspaceId) {
      if (Date.now() - item.started > timeoutMs) setItem(item, 'error', false, `Workspace not created within ${P.provisionTimeoutSeconds}s. Try again later.`);
      continue;
    }
    let msg;
    try {
      const share = { email: p.email, accessLevel: level };
      if (P.sendInviteEmail) {                                  // custom text only applies when Smartsheet sends the email
        const fill = t => String(t || '').replace(/\{name\}/g, p.name).replace(/\{workspace\}/g, p.workspaceName || p.name).replace(/\{url\}/g, p.workspaceUrl || '');
        if (P.emailSubject) share.subject = fill(P.emailSubject);
        if (P.emailMessage) share.message = fill(P.emailMessage);
        if (P.ccMe) share.ccMe = true;
      }
      await ss('POST', `/workspaces/${p.workspaceId}/shares?sendEmail=${P.sendInviteEmail}`, [share]);
      msg = `Shared with ${p.email} (${level})`;
    } catch (e) {
      if (!isAlready(e)) { setItem(item, 'error', false, e.message); continue; }
      try { await ensureWorkspaceAccess(p.workspaceId, p.email, level); }     // already shared: make sure the level is right
      catch (e2) { setItem(item, 'error', false, `Already shared, but setting ${level} on the workspace failed: ${e2.message}`); continue; }
      msg = `Already shared with ${p.email} (${level})`;
    }
    if (tracker.access === 'NONE') { await tickShared(item, msg); continue; }   // workspace access already covers the tracker sheet
    try {
      const ws = await ss('GET', `/workspaces/${p.workspaceId}?loadAll=true`);
      const sheet = findSheet(ws, tracker.name);
      if (!sheet) throw new Error(`sheet "${tracker.name}" not found in workspace`);
      await ensureSheetAccess(sheet.id, p.email, tracker.access);
      msg += `; ${tracker.access} on ${tracker.name}`;
    } catch (e) {
      setItem(item, 'error', false, `Workspace shared, but ${tracker.access} on ${tracker.name} failed: ${e.message}`);
      continue;
    }
    await tickShared(item, msg);
  }
}

// ---------------------------------------------------------------- analytics: participant edits in each tracker sheet
// A row only records its LAST editor, and formulas (TODAY(), AI columns) recalculate under the owner's name, which
// overwrites the participant. Each cell's own history keeps every editor, so we read the history of the cells and
// count the entries made by the participant (one request per cell, so a full scan takes a few minutes per project).
const whoName = u => (u ? (u.name || u.email || '') : '');
const pendingScan = s => s.state === 'queued' || s.state === 'scanning';
let stopAt = 0, scanRunning = false;

function stopRequested(s) { return stopAt > 0 && stopAt >= (s.startedAt || 0); }
function markStopped(s) {
  s.state = 'stopped'; s.finishedAt = Date.now();
  s.message = `Stopped by you at ${s.total ? Math.round(s.done / s.total * 100) : 0}%, with ${s.changes} change(s) found so far`;
  persist();
  logEvent('info', 'scan.stopped', `${s.name}: ${s.message}`);
}
function stopScans() {
  stopAt = Date.now() + 1;                                       // a running scan stops at its next batch
  let stopped = 0;
  Object.values(state.scans).filter(pendingScan).forEach(s => { markStopped(s); stopped++; });
  logEvent('info', 'scan.stop', `Stop requested: ${stopped} scan(s) stopped`);
  return { stopped };
}

// Stored results for the page. Makes no Smartsheet calls, so it is instant and safe to poll.
function getAnalytics(rowIds) {
  const want = new Set(rowIds || []);
  const all = Object.values(state.scans);
  return { items: all.filter(s => want.has(s.rowId)), scanning: all.some(pendingScan), tracker: pf().trackerSheet.name, generatedAt: Date.now() };
}

// rowIds: projects to scan. force=false skips projects that already have a finished scan; full=true skips the quick check.
async function startScan(rowIds, force, full) {
  const projects = await loadProjects();
  let started = 0, skipped = 0;
  (rowIds || []).forEach(id => {
    const p = projects.find(x => x.rowId === id);
    if (!p || !p.workspaceId || !p.email) { skipped++; return; }
    const ex = state.scans[p.rowId];
    if (ex && pendingScan(ex)) { skipped++; return; }            // already running
    if (ex && ex.state === 'done' && !force) { skipped++; return; }
    state.scans[p.rowId] = { rowId: p.rowId, name: p.name, email: p.email, workspaceId: p.workspaceId, workspaceUrl: p.workspaceUrl,
      state: 'queued', full: !!full, cursor: 0, total: 0, done: 0, changes: 0, lastEdit: null, lastBy: '', errors: 0, startedAt: Date.now(), message: 'Queued' };
    started++;
  });
  persist();
  logEvent('info', 'scan.start', `Scan requested for ${(rowIds || []).length} project(s): ${started} started, ${skipped} skipped`);
  kickScans();
  return { started, skipped };
}

// The page calls this while a scan is showing; it just makes sure the background worker is running.
function processScans() { kickScans(); return { pending: Object.values(state.scans).filter(pendingScan).length }; }

function kickScans() {
  if (scanRunning || !Object.values(state.scans).some(pendingScan)) return;
  scanRunning = true;
  (async () => {
    try {
      for (;;) {
        const todo = Object.values(state.scans).filter(pendingScan).sort((a, b) => a.startedAt - b.startedAt);
        if (!todo.length) break;
        const s = todo[0];
        if (stopRequested(s)) { markStopped(s); continue; }
        try { await scanOne(s, pf()); }
        catch (e) { s.state = 'error'; s.message = e.message; persist(); logEvent('error', 'scan.error', `${s.name}: ${e.message}`); }
      }
    } finally { scanRunning = false; }
  })();
}

// Cells to look at first for the configured "column, row number" pairs that exist in this sheet.
function quickCells(sheet, quick) {
  const colByTitle = {}, rowByNumber = {};
  sheet.columns.forEach(c => { colByTitle[String(c.title).trim().toLowerCase()] = c; });
  sheet.rows.forEach(r => { rowByNumber[r.rowNumber] = r; });
  const cells = [], missing = [];
  (quick || []).forEach(q => {
    const col = colByTitle[String(q.column).trim().toLowerCase()], row = rowByNumber[q.row];
    const label = `${q.column} (row ${q.row})`;
    if (col && row) cells.push({ rowId: row.id, colId: col.id, label }); else missing.push(label);
  });
  return { cells, missing };
}
const historyPath = (sheetId, rowId, colId) => `/sheets/${sheetId}/rows/${rowId}/columns/${colId}/history?includeAll=true`;
function countMine(s, entries, me) {
  let n = 0;
  (entries || []).forEach(e => {
    const by = e.modifiedBy;
    if (by && String(by.email || '').toLowerCase() === me) {      // only the participant's own edits count
      n++;
      if (!s.lastEdit || e.modifiedAt > s.lastEdit) { s.lastEdit = e.modifiedAt; s.lastBy = whoName(by); }
    }
  });
  return n;
}

async function scanOne(s, P) {
  s.state = 'scanning';
  if (!s.sheetId) {
    const ws = await ss('GET', `/workspaces/${s.workspaceId}?loadAll=true`);
    const sh = findSheet(ws, P.trackerSheet.name);
    if (!sh) throw new Error(`Sheet "${P.trackerSheet.name}" not found in the workspace`);
    s.sheetId = sh.id; s.sheetUrl = sh.permalink || '';
    persist();
  }
  if (stopRequested(s)) { markStopped(s); return; }
  const sheet = await ss('GET', `/sheets/${s.sheetId}`);
  s.sheetUrl = sheet.permalink || s.sheetUrl;
  const me = String(s.email).toLowerCase();

  // Stage 1 (quick check): look at a handful of key cells. If the participant has not touched any, stop here.
  if (s.full) s.quickNote = 'Full scan requested, quick check skipped';
  if (!s.full && !s.quickDone) {
    const q = quickCells(sheet, P.quickCheck);
    s.quickLabels = q.cells.map(c => c.label);
    s.quickMissing = q.missing;
    if (!q.cells.length && !(P.quickCheck || []).length) s.quickNote = 'No quick-check cells are set in Settings, so the full scan ran';
    if (q.cells.length) {
      const res = await getMany(q.cells.map(c => historyPath(s.sheetId, c.rowId, c.colId)));
      let bad = 0, found = 0;
      res.forEach(r => { if (!r.ok) bad++; else found += countMine(s, r.json.data, me); });
      s.quickDone = true;
      if (!found && !bad) {
        s.state = 'done'; s.partial = true; s.changes = 0; s.lastEdit = null; s.lastBy = '';
        s.total = s.done = q.cells.length; s.finishedAt = Date.now();
        s.message = `Partial scan of ${s.quickLabels.join(', ')} returned no changes`;
        persist();
        logEvent('ok', 'scan.done', `${s.name}: ${s.message}`);
        return;
      }
      // the participant edited a key cell (or the check could not be completed): do the full scan
      s.lastEdit = null; s.lastBy = '';
      s.quickNote = found ? `Participant edited the key cells (${found} edit(s)), so the full scan ran` : `${bad} key cell(s) could not be read, so the full scan ran`;
      logEvent('info', 'scan.quick', `${s.name}: ${s.quickNote}`);
    } else {
      s.quickDone = true;
      s.quickNote = 'None of the key cells exist in this sheet (check the column names and row numbers in Settings), so the full scan ran';
      logEvent('info', 'scan.quick', `${s.name}: ${s.quickNote}`);
    }
    persist();
  }

  // Stage 2 (full scan): read the history of every cell.
  const cols = sheet.columns.map(c => c.id), rows = sheet.rows.map(r => r.id);
  s.total = rows.length * cols.length;
  s.partial = false;
  while (s.cursor < s.total) {
    const t = Date.now(), n = Math.min(SCAN_BATCH, s.total - s.cursor), paths = [];
    for (let k = 0; k < n; k++) {
      const idx = s.cursor + k;
      paths.push(historyPath(s.sheetId, rows[Math.floor(idx / cols.length)], cols[idx % cols.length]));
    }
    const rs = await getMany(paths);
    if (s.state === 'stopped') return;                            // stopped while the batch was running: keep what was saved
    rs.forEach(r => { if (!r.ok) { s.errors++; return; } s.changes += countMine(s, r.json.data, me); });
    s.cursor += n; s.done = s.cursor; persist();
    if (stopRequested(s)) { markStopped(s); return; }
    const took = Date.now() - t;
    if (took < SCAN_BATCH_MS && s.cursor < s.total) await sleep(SCAN_BATCH_MS - took);
    if (s.state === 'stopped') return;
  }
  s.state = 'done'; s.finishedAt = Date.now();
  s.message = `${s.changes} change(s) by the participant in ${s.total} cells` + (s.errors ? `, ${s.errors} cell(s) could not be read` : '');
  persist();
  logEvent(s.errors ? 'error' : 'ok', 'scan.done', `${s.name}: ${s.message}`);
}

// ---------------------------------------------------------------- http
// The page calls  POST /api/rpc/<function>  with {"args":[...]}. Only these functions can be called.
const RPC = { getProjects, activateAndShare, getStatus, getConfigPublic, saveConfig, getLog, clearLog, logView, getAnalytics, startScan, processScans, stopScans };
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const STATIC = new Set(['/index.html', '/styles.css', '/app.js', '/settings.js']);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b)); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname.startsWith('/api/rpc/')) {
      const origin = req.headers.origin || '';
      if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: 'Forbidden origin' });
      const name = url.pathname.slice('/api/rpc/'.length);
      if (!Object.prototype.hasOwnProperty.call(RPC, name)) return send(res, 404, { error: 'Unknown function' });
      let args = [];
      try { args = (JSON.parse((await readBody(req)) || '{}').args) || []; } catch { return send(res, 400, { error: 'Bad request' }); }
      try { return send(res, 200, { result: await RPC[name](...args) }); }
      catch (e) { return send(res, 200, { error: e.message }); }
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
}).listen(PORT, '127.0.0.1', () => {
  console.log(`AI Workshops Share running at http://localhost:${PORT}`);
  kickPending(); kickScans();                                    // pick up anything left running before a restart
});
