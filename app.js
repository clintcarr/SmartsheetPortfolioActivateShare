// AI Workshops Share - page logic. Talks to server.js through run(name, ...args).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var FILTERS = ['fDateFrom', 'fDateTo', 'fLocation', 'fType', 'fActive', 'fShared'];
  var BUSY = { queued: 1, waiting: 1, sharing: 1 };
  var projects = [], accessLevel = 'EDITOR', running = false, filtersFilled = false;
  var selected = new Set(), status = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function showMsg(t, good) { var m = $('msg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('good', !!good); }

  // call a server function: POST /api/rpc/<name> with {args:[...]} and resolve with its result
  function run(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch('/api/rpc/' + fn, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: args }) })
      .then(function (r) { return r.json().catch(function () { return { error: 'Bad response from the server' }; }); })
      .then(function (j) { if (j.error) throw new Error(j.error); return j.result; });
  }

  // in-page confirm dialog
  function askConfirm(text) {
    return new Promise(function (resolve) {
      $('confirmBody').textContent = text;
      var dlg = $('confirmDlg');
      function done(v) { $('confirmYes').onclick = $('confirmNo').onclick = null; dlg.close(); resolve(v); }
      $('confirmYes').onclick = function () { done(true); };
      $('confirmNo').onclick = function () { done(false); };
      dlg.showModal();
    });
  }

  // ---------------------------------------------------------------- table
  function applyItems(items) { (items || []).forEach(function (i) { status[i.rowId] = i; }); }

  function fetchProjects(reason) {
    return run('getProjects', reason).then(function (j) { projects = j.projects; accessLevel = j.accessLevel; applyItems(j.items); if (j.user) $('who').textContent = 'Signed in as ' + j.user; });
  }

  function fillSelect(id, values) {
    var sel = $(id);
    Array.from(new Set(values.filter(Boolean))).sort().forEach(function (v) { sel.insertAdjacentHTML('beforeend', '<option>' + esc(v) + '</option>'); });
  }

  function load(reason) {
    return fetchProjects(reason || 'initial').then(function () {
      if (!filtersFilled) { fillSelect('fLocation', projects.map(function (p) { return p.location; })); fillSelect('fType', projects.map(function (p) { return p.type; })); filtersFilled = true; }
      render();
      var busyIds = Object.keys(status).filter(function (k) { return BUSY[status[k].state]; }).map(Number);
      if (busyIds.length && !running) { running = true; render(); pollLoop(busyIds); }   // resume watching a job from an earlier visit
    }).catch(function (e) {
      $('rows').innerHTML = '<tr><td colspan="8" class="empty">Could not load projects.</td></tr>';
      showMsg('Error: ' + e.message);
    });
  }

  function selectable(p) { return !!p.email && !running; }

  function filtered() {
    var from = $('fDateFrom').value, to = $('fDateTo').value, loc = $('fLocation').value, type = $('fType').value, act = $('fActive').value, sh = $('fShared').value;
    return projects.filter(function (p) {
      return (!from || (p.date && p.date >= from)) && (!to || (p.date && p.date <= to)) && (!loc || p.location === loc) &&
        (!type || p.type === type) && (!act || (act === 'yes') === p.active) && (!sh || (sh === 'yes') === p.shared);
    });
  }

  var PAGE_SIZE = 25, page = 1;
  function render() {
    var all = filtered(), tb = $('rows');
    var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (page > pages) page = pages;
    var list = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);      // only the current page is drawn
    $('pager').hidden = all.length <= PAGE_SIZE;
    $('pgInfo').textContent = 'Showing ' + (all.length ? (page - 1) * PAGE_SIZE + 1 : 0) + ' to ' + Math.min(page * PAGE_SIZE, all.length) + ' of ' + all.length;
    $('pgNum').textContent = 'Page ' + page + ' of ' + pages;
    $('pgPrev').disabled = $('pgFirst').disabled = page <= 1; $('pgNext').disabled = $('pgLast').disabled = page >= pages;
    if (!list.length) tb.innerHTML = '<tr><td colspan="8" class="empty">No projects match the filters.</td></tr>';
    else tb.innerHTML = list.map(function (p) {
      var st = status[p.rowId];
      var cls = !st ? '' : st.ok === true ? 'ok' : st.ok === false ? 'err' : 'busy';
      var stHtml = st ? '<span class="st ' + cls + '">' + esc(st.message) + '</span>' : '';
      var nameHtml = p.workspaceId ? '<a href="' + esc(p.workspaceUrl) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>' : esc(p.name);
      return '<tr><td><input type="checkbox" data-id="' + p.rowId + '" ' + (selected.has(p.rowId) ? 'checked' : '') + ' ' + (selectable(p) ? '' : 'disabled') + '></td>' +
        '<td>' + nameHtml + '</td><td>' + esc(p.date) + '</td><td>' + esc(p.location) + '</td><td>' + esc(p.type) + '</td>' +
        '<td class="c">' + (p.active ? '<span class="tick" title="Active">&#10003;</span>' : '') + '</td>' +
        '<td class="c">' + (p.shared ? '<span class="tick" title="Shared">&#10003;</span>' : '') + '</td><td class="status">' + stHtml + '</td></tr>';
    }).join('');
    $('count').textContent = all.length + ' shown of ' + projects.length + ' · ' + selected.size + ' selected';
    $('btnShare').disabled = running || selected.size === 0;
    $('btnShare').textContent = running ? 'Working…' : selected.size ? 'Activate and share (' + selected.size + ')' : 'Activate and share';
    var eligible = list.filter(selectable);
    $('chkAll').disabled = running;
    $('chkAll').checked = eligible.length > 0 && eligible.every(function (p) { return selected.has(p.rowId); });
    FILTERS.forEach(function (id) { $(id).disabled = running; });
    $('btnClear').disabled = running;
  }

  $('rows').addEventListener('change', function (e) {
    var id = Number(e.target.dataset.id);
    if (!id) return;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    render();
  });
  $('chkAll').addEventListener('change', function (e) {
    var pg = filtered().slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);   // this page only
    pg.filter(selectable).forEach(function (p) { if (e.target.checked) selected.add(p.rowId); else selected.delete(p.rowId); });
    render();
  });
  FILTERS.forEach(function (id) { $(id).addEventListener('change', function () { page = 1; render(); }); });
  $('pgFirst').addEventListener('click', function () { page = 1; render(); });
  $('pgPrev').addEventListener('click', function () { page--; render(); });
  $('pgNext').addEventListener('click', function () { page++; render(); });
  $('pgLast').addEventListener('click', function () { page = 1e9; render(); });
  $('btnClear').addEventListener('click', function () { FILTERS.forEach(function (id) { $(id).value = ''; }); page = 1; render(); });

  // ---------------------------------------------------------------- activate and share
  function pollLoop(ids) {
    function step() {
      return run('getStatus').then(function (j) {
        applyItems(j.items);
        render();
        var open = ids.filter(function (id) { return status[id] && BUSY[status[id].state]; });
        if (open.length) return sleep(4000).then(step);
        var ok = ids.filter(function (id) { return status[id] && status[id].ok; });
        ok.forEach(function (id) { selected.delete(id); });
        showMsg(ok.length + ' of ' + ids.length + ' activated and shared.', ok.length === ids.length);
      });
    }
    return step().catch(function (e) { showMsg('Error: ' + e.message); })
      .then(function () { running = false; return fetchProjects('after-job'); })
      .catch(function (e) { showMsg('Error refreshing: ' + e.message); })
      .then(render);
  }

  $('btnShare').addEventListener('click', function () {
    var chosen = projects.filter(function (p) { return selected.has(p.rowId); });
    var toActivate = chosen.filter(function (p) { return !p.active; }).length;
    askConfirm('Activate and share ' + chosen.length + ' project(s) as ' + accessLevel + '?\n\n' + toActivate +
      ' will be set to Active first; sharing happens once each workspace exists.\n\n' + chosen.map(function (p) { return p.email; }).join('\n'))
      .then(function (yes) {
        if (!yes) return;
        var ids = Array.from(selected);
        running = true; showMsg('');
        ids.forEach(function (id) { status[id] = { ok: null, state: 'queued', message: 'Queued' }; });
        render();
        return run('activateAndShare', ids).then(function () { return pollLoop(ids); }).catch(function (e) {
          running = false; showMsg('Error: ' + e.message); render();
        });
      });
  });

  // ---------------------------------------------------------------- reload + log page
  $('btnReload').addEventListener('click', function () {
    if (running) return;
    showMsg('');
    fetchProjects('reload').then(function () { render(); showMsg('Reloaded ' + projects.length + ' projects.', true); })
      .catch(function (e) { showMsg('Error: ' + e.message); });
  });

  var logEntries = [];
  function showView(v) {
    $('intro').hidden = v !== 'projects';
    $('btnFilters').hidden = v === 'log';
    $('viewProjects').hidden = v !== 'projects'; $('viewAnalytics').hidden = v !== 'analytics'; $('viewLog').hidden = v !== 'log';
    $('viewFilters').hidden = v === 'log';
  }
  function lMsg(t, good) { var m = $('lMsg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('good', !!good); }
  function fmtTime(t) { var d = new Date(t); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString(); }
  function renderLog() {
    var lv = $('lLevel').value, q = $('lSearch').value.trim().toLowerCase();
    var list = logEntries.filter(function (e) { return (!lv || e.level === lv) && (!q || (e.act + ' ' + e.msg).toLowerCase().indexOf(q) >= 0); });
    $('lCount').textContent = list.length + ' shown of ' + logEntries.length + ' entries';
    $('lRows').innerHTML = list.length ? list.map(function (e) {
      return '<tr><td>' + esc(fmtTime(e.t)) + '</td><td><span class="lvl ' + esc(e.level) + '">' + esc(e.level) + '</span></td><td>' + esc(e.act) + '</td><td>' + esc(e.msg) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">No log entries.</td></tr>';
  }
  function loadLog() {
    lMsg('');
    return run('getLog').then(function (j) { logEntries = j.entries; renderLog(); })
      .catch(function (e) { lMsg('Could not load the log: ' + e.message); });
  }
  function setFilterPane(show) {
    $('viewFilters').classList.toggle('collapsed', !show);
    $('btnFilters').textContent = show ? 'Hide filters' : 'Show filters';
    try { localStorage.setItem('filtersShown', show ? '1' : '0'); } catch (e) {}
  }
  (function () { var s = '1'; try { s = localStorage.getItem('filtersShown') || '1'; } catch (e) {} setFilterPane(s !== '0'); })();
  $('btnFilters').addEventListener('click', function () { setFilterPane($('viewFilters').classList.contains('collapsed')); });
  $('btnHelp').addEventListener('click', function () { $('helpDlg').showModal(); });
  $('helpClose').addEventListener('click', function () { $('helpDlg').close(); });
  $('btnLog').addEventListener('click', function () { showView('log'); run('logView').catch(function () {}).then(loadLog); });
  $('lBack').addEventListener('click', function () { showView('projects'); });
  $('lRefresh').addEventListener('click', loadLog);
  $('lLevel').addEventListener('change', renderLog);
  $('lSearch').addEventListener('input', renderLog);
  $('lClear').addEventListener('click', function () {
    askConfirm('Clear the whole activity log? This cannot be undone.').then(function (yes) {
      if (!yes) return;
      run('clearLog').then(loadLog).catch(function (e) { lMsg('Error: ' + e.message); });
    });
  });

  // ---------------------------------------------------------------- analytics page
  var an = { items: [], timer: null, skipped: 0, driving: false };
  function aMsg(t, good) { var m = $('aMsg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('good', !!good); }
  function analyticsVisible() { return !$('viewAnalytics').hidden; }
  function analyticsProjects() {
    var only = $('aAttended').checked;
    return filtered().filter(function (p) { return p.workspaceId && (!only || p.attended !== false); });   // attended === null means the project list has no such column
  }
  function analyticsIds() { return analyticsProjects().map(function (p) { return p.rowId; }); }
  function daysAgo(iso) { return Math.max(0, (Date.now() - new Date(iso).getTime()) / 86400000); }
  function agoText(iso) { var d = Math.floor(daysAgo(iso)); return d === 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago'; }
  function fmtDT(iso) { var d = new Date(iso); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function isBusy(i) { return i.state === 'queued' || i.state === 'scanning'; }

  function renderAnalytics() {
    an.sel = an.sel || {};
    var byId = {};
    an.items.forEach(function (i) { byId[i.rowId] = i; });
    var shown = filtered(), withWs = analyticsProjects();
    an.skipped = shown.filter(function (p) { return !p.workspaceId; }).length;
    an.notAttended = shown.filter(function (p) { return p.workspaceId && p.attended === false; }).length;
    var items = withWs.map(function (p) { return byId[p.rowId] || { rowId: p.rowId, name: p.name, state: 'none', changes: 0 }; });
    var sort = $('aSort').value;
    items.sort(function (a, b) {
      if (sort === 'name') return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      if (sort === 'most' || sort === 'fewest') {
        var ca = a.changes || 0, cb = b.changes || 0;
        return ca === cb ? (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1) : (sort === 'most' ? cb - ca : ca - cb);
      }
      var ta = a.lastEdit ? new Date(a.lastEdit).getTime() : 0, tb = b.lastEdit ? new Date(b.lastEdit).getTime() : 0;
      if (!ta && !tb) return 0; if (!ta) return 1; if (!tb) return -1;
      return sort === 'oldest' ? ta - tb : tb - ta;
    });
    var maxC = Math.max(1, Math.max.apply(null, items.map(function (i) { return i.changes || 0; }).concat([0])));
    var scanned = items.filter(function (i) { return i.state === 'done'; }).length;
    var busy = items.filter(isBusy).length, notScanned = items.filter(function (i) { return i.state === 'none' || i.state === 'error' || i.state === 'stopped'; }).length;
    $('aCount').textContent = items.length + ' project(s) · ' + scanned + ' scanned' + (busy ? ' · ' + busy + ' scanning' : '') + (notScanned ? ' · ' + notScanned + ' not scanned' : '') + (an.skipped ? ' · ' + an.skipped + ' without a workspace skipped' : '') + ($('aAttended').checked && an.notAttended ? ' · ' + an.notAttended + ' not attended hidden' : '');
    $('aStop').hidden = !busy;
    var nSel = items.filter(function (i) { return an.sel[i.rowId]; }).length;
    $('aScan').disabled = an.starting || !notScanned;
    $('aRescan').disabled = $('aFull').disabled = an.starting || !nSel;
    $('aRescan').textContent = 'Quick re-scan selected' + (nSel ? ' (' + nSel + ')' : ''); $('aFull').textContent = 'Full re-scan selected' + (nSel ? ' (' + nSel + ')' : '');
    $('aAll').checked = !!items.length && nSel === items.length;
    if (!items.length) { $('aChart').innerHTML = '<div style="text-align:center;color:var(--ink-dim);padding:30px;">No attended projects with a workspace match the filters.</div>'; return; }

    $('aChart').innerHTML = items.map(function (i) {
      var nm = i.sheetUrl ? '<a class="alabel" href="' + esc(i.sheetUrl) + '" target="_blank" rel="noopener" title="Open the tracker sheet">' + esc(i.name) + '</a>' : '<span class="alabel">' + esc(i.name) + '</span>';
      var label = '<div class="acell"><input type="checkbox" class="asel" data-id="' + esc(String(i.rowId)) + '" ' + (an.sel[i.rowId] ? 'checked' : '') + ' title="Select for re-scan">' + nm + '</div>';
      var n = i.changes || 0, w = Math.max(2, Math.min(100, n / maxC * 100));
      if (i.state === 'none') return '<div class="arow">' + label + '<div class="atrack"></div><div class="ainfo">Not scanned yet</div></div>';
      if (i.state === 'stopped') return '<div class="arow">' + label + '<div class="atrack"><div class="afill scan" style="width:' + (n ? w.toFixed(1) : 2) + '%;opacity:.4"></div></div><div class="ainfo" style="color:var(--warn,#C99A3E)">Stopped at ' + (i.total ? Math.round(i.done / i.total * 100) : 0) + '%<br><span style="opacity:.7">' + n + ' change(s) found before stopping</span></div></div>';
      if (i.state === 'error') return '<div class="arow">' + label + '<div class="atrack"></div><div class="ainfo" style="color:var(--err)">' + esc(i.message || 'Scan failed') + '</div></div>';
      if (isBusy(i)) {
        var pct = i.total ? Math.round(i.done / i.total * 100) : 0;
        return '<div class="arow">' + label + '<div class="atrack"><div class="afill scan" style="width:' + (n ? w.toFixed(1) : 2) + '%"></div></div>' +
          '<div class="ainfo">' + (i.state === 'queued' ? 'Queued' : '<b>Scanning ' + pct + '%</b> · ' + i.done + ' of ' + i.total + ' cells') + '<br>' + n + ' change(s) so far' + (i.quickNote ? '<br><span style="opacity:.7">' + esc(i.quickNote) + '</span>' : '') + '</div></div>';
      }
      var tip = (i.quickNote ? i.quickNote + '\n' : '') + n + ' edit(s) by the participant\n' + i.total + ' cells read' + (i.errors ? ' (' + i.errors + ' could not be read)' : '') + (i.finishedAt ? '\nScanned ' + fmtDT(new Date(i.finishedAt).toISOString()) : '');
      if (i.partial) return '<div class="arow" title="' + esc(i.message + (i.finishedAt ? '\nScanned ' + fmtDT(new Date(i.finishedAt).toISOString()) : '')) + '">' + label + '<div class="atrack"><div class="afill none" style="width:100%"></div></div><div class="ainfo">Partial scan of these rows returned no changes<br><span style="opacity:.7">' + esc((i.quickLabels || []).join(', ')) + '</span></div></div>';
      if (!n) return '<div class="arow" title="' + esc(tip) + '">' + label + '<div class="atrack"><div class="afill none" style="width:100%"></div></div><div class="ainfo">No edits by the participant<br><span style="opacity:.7">' + i.total + ' cells checked' + (i.errors ? ', ' + i.errors + ' unreadable' : '') + '</span></div></div>';
      var d = daysAgo(i.lastEdit), cls = d <= 7 ? 'fresh' : d <= 30 ? 'mid' : 'stale';
      return '<div class="arow" title="' + esc(tip) + '">' + label + '<div class="atrack"><div class="afill ' + cls + '" style="width:' + w.toFixed(1) + '%"></div></div>' +
        '<div class="ainfo"><b>' + n + (n === 1 ? ' change' : ' changes') + '</b> · last ' + esc(fmtDT(i.lastEdit)) + ' (' + agoText(i.lastEdit) + ')<br>by ' + esc(i.lastBy || i.name) + (i.quickNote ? '<br><span style="opacity:.7">' + esc(i.quickNote) + '</span>' : '') + '</div></div>';
    }).join('') + '<div class="aaxis"><span>0</span><span>' + (maxC / 2) + '</span><span>' + maxC + ' changes</span></div>';
  }

  // stored results only: no Smartsheet calls, so it is instant
  function loadAnalytics() {
    return run('getAnalytics', analyticsIds()).then(function (res) {
      an.items = res.items; renderAnalytics();
      if (res.scanning) driveScan();
    }).catch(function (e) { aMsg('Error: ' + e.message); });
  }

  // while a scan runs: keep asking the server to work (it can take minutes) and poll the progress
  function driveScan() {
    if (an.driving) return;
    an.driving = true; renderAnalytics();
    var working = false;
    function kick() {
      if (working) return;
      working = true;
      var t = Date.now();
      run('processScans').catch(function () {}).then(function () { return Date.now() - t < 5000 ? sleep(5000) : null; }).then(function () { working = false; });
    }
    function tick() {
      kick();
      return run('getAnalytics', analyticsIds()).then(function (res) {
        an.items = res.items;
        if (analyticsVisible()) renderAnalytics();
        if (res.scanning) return sleep(4000).then(tick);
        an.driving = false; renderAnalytics();
        if (analyticsVisible()) aMsg('Scan complete.', true);
      });
    }
    tick().catch(function (e) { an.driving = false; if (analyticsVisible()) { renderAnalytics(); aMsg('Error: ' + e.message); } });
  }

  function selectedIds() { return analyticsIds().filter(function (id) { return an.sel && an.sel[id]; }); }
  function startScan(force, full, onlySelected) {
    var ids = onlySelected ? selectedIds() : analyticsIds();
    if (!ids.length) { aMsg(onlySelected ? 'Tick the projects to scan first.' : 'Nothing to scan.'); return; }
    aMsg('');
    an.starting = true; renderAnalytics();
    run('startScan', ids, !!force, !!full).then(function (r) {
      aMsg(r.started ? 'Scanning ' + r.started + ' project(s). Each takes a few minutes. You can leave this page open, or close it and come back: the scan carries on.' : 'Nothing to scan.', !!r.started);
      return run('getAnalytics', ids);
    }).then(function (res) { an.starting = false; an.items = res.items; renderAnalytics(); if (res.scanning) driveScan(); })
      .catch(function (e) { an.starting = false; aMsg('Error: ' + e.message); renderAnalytics(); });
  }

  $('btnProjects').addEventListener('click', function () { showView('projects'); });
  $('btnAnalytics').addEventListener('click', function () { showView('analytics'); aMsg(''); loadAnalytics(); });
  $('aScan').addEventListener('click', function () { startScan(false); });
  $('aRescan').addEventListener('click', function () {
    var n = selectedIds().length;
    askConfirm('Quick re-scan ' + n + ' selected project(s)? Projects with no participant edits in the key cells finish in seconds; the others take a few minutes. Existing results stay until it finishes.').then(function (yes) { if (yes) startScan(true, false, true); });
  });
  $('aFull').addEventListener('click', function () {
    var n = selectedIds().length;
    askConfirm('Full re-scan ' + n + ' selected project(s)? This reads every cell, so each takes a few minutes even if the quick check would find nothing.').then(function (yes) { if (yes) startScan(true, true, true); });
  });
  $('aChart').addEventListener('change', function (e) {
    var t = e.target; if (!t.classList || !t.classList.contains('asel')) return;
    an.sel = an.sel || {}; if (t.checked) an.sel[t.getAttribute('data-id')] = true; else delete an.sel[t.getAttribute('data-id')];
    renderAnalytics();
  });
  $('aAll').addEventListener('change', function (e) {
    an.sel = an.sel || {}; analyticsIds().forEach(function (id) { if (e.target.checked) an.sel[id] = true; else delete an.sel[id]; });
    renderAnalytics();
  });
  $('aStop').addEventListener('click', function () {
    $('aStop').disabled = true; aMsg('Stopping...', true);
    run('stopScans').then(function () { return run('getAnalytics', analyticsIds()); })
      .then(function (res) { an.items = res.items; renderAnalytics(); aMsg('Scan stopped. Results found so far are kept.', true); })
      .catch(function (e) { aMsg('Error: ' + e.message); })
      .then(function () { $('aStop').disabled = false; });
  });
  $('aSort').addEventListener('change', renderAnalytics);
  $('aAttended').addEventListener('change', function () { if (analyticsVisible()) loadAnalytics(); });
  FILTERS.concat(['btnClear']).forEach(function (id) {
    $(id).addEventListener(id === 'btnClear' ? 'click' : 'change', function () {
      if (!analyticsVisible()) return;
      clearTimeout(an.timer); an.timer = setTimeout(loadAnalytics, 300);
    });
  });

  window.App = { run: run, esc: esc, askConfirm: askConfirm, showMsg: showMsg, load: load };
  load();
})();
