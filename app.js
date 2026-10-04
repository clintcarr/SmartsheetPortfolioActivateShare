(() => {
  const $ = id => document.getElementById(id);
  const FILTERS = ['fDateFrom', 'fDateTo', 'fLocation', 'fType', 'fActive', 'fShared'];
  let projects = [];
  let accessLevel = 'EDITOR';
  let running = false;
  const selected = new Set();
  const status = {}; // rowId -> {state, ok, message}

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showMsg = (t, good) => { const m = $('msg'); m.hidden = !t; m.textContent = t || ''; m.classList.toggle('good', !!good); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchProjects() {
    const r = await fetch('/api/projects');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    projects = j.projects; accessLevel = j.accessLevel;
  }

  async function load() {
    try {
      await fetchProjects();
      fillSelect('fLocation', projects.map(p => p.location));
      fillSelect('fType', projects.map(p => p.type));
      render();
    } catch (e) {
      $('rows').innerHTML = '<tr><td colspan="8" class="empty">Could not load projects.</td></tr>';
      showMsg('Error: ' + e.message);
    }
  }

  function fillSelect(id, values) {
    const sel = $(id);
    [...new Set(values.filter(Boolean))].sort().forEach(v => sel.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`));
  }

  const selectable = p => !!p.email && !running;

  function filtered() {
    const from = $('fDateFrom').value, to = $('fDateTo').value, loc = $('fLocation').value, type = $('fType').value,
      act = $('fActive').value, sh = $('fShared').value;
    return projects.filter(p =>
      (!from || (p.date && p.date >= from)) &&
      (!to || (p.date && p.date <= to)) &&
      (!loc || p.location === loc) &&
      (!type || p.type === type) &&
      (!act || (act === 'yes') === p.active) &&
      (!sh || (sh === 'yes') === p.shared));
  }

  function render() {
    const list = filtered();
    const tb = $('rows');
    if (!list.length) tb.innerHTML = '<tr><td colspan="8" class="empty">No projects match the filters.</td></tr>';
    else tb.innerHTML = list.map(p => {
      const st = status[p.rowId];
      const cls = !st ? '' : st.ok === true ? 'ok' : st.ok === false ? 'err' : 'busy';
      const stHtml = st ? `<span class="st ${cls}">${esc(st.message)}</span>` : '';
      const nameHtml = p.workspaceId ? `<a href="${esc(p.workspaceUrl)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
      return `<tr>
        <td><input type="checkbox" data-id="${p.rowId}" ${selected.has(p.rowId) ? 'checked' : ''} ${selectable(p) ? '' : 'disabled'}></td>
        <td>${nameHtml}</td><td>${esc(p.date)}</td><td>${esc(p.location)}</td><td>${esc(p.type)}</td>
        <td class="c">${p.active ? '<span class="tick" title="Active">&#10003;</span>' : ''}</td>
        <td class="c">${p.shared ? '<span class="tick" title="Shared">&#10003;</span>' : ''}</td><td class="status">${stHtml}</td></tr>`;
    }).join('');
    $('count').textContent = `${list.length} shown of ${projects.length} · ${selected.size} selected`;
    $('btnShare').disabled = running || selected.size === 0;
    $('btnShare').textContent = running ? 'Working…' : selected.size ? `Activate and share (${selected.size})` : 'Activate and share';
    const eligible = list.filter(selectable);
    $('chkAll').disabled = running;
    $('chkAll').checked = eligible.length > 0 && eligible.every(p => selected.has(p.rowId));
    FILTERS.forEach(id => ($(id).disabled = running));
    $('btnClear').disabled = running;
  }

  $('rows').addEventListener('change', e => {
    const id = Number(e.target.dataset.id);
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    render();
  });
  $('chkAll').addEventListener('change', e => {
    filtered().filter(selectable).forEach(p => e.target.checked ? selected.add(p.rowId) : selected.delete(p.rowId));
    render();
  });
  FILTERS.forEach(id => $(id).addEventListener('change', render));
  $('btnClear').addEventListener('click', () => { FILTERS.forEach(id => ($(id).value = '')); render(); });

  $('btnShare').addEventListener('click', async () => {
    const chosen = projects.filter(p => selected.has(p.rowId));
    const toActivate = chosen.filter(p => !p.active).length;
    if (!confirm(`Activate and share ${chosen.length} project(s) as ${accessLevel}?\n\n` +
      `${toActivate} will be set to Active first; sharing happens once each workspace exists.\n\n` + chosen.map(p => p.email).join('\n'))) return;

    running = true; showMsg('');
    chosen.forEach(p => (status[p.rowId] = { ok: null, message: 'Queued' }));
    render();
    try {
      const r = await fetch('/api/activate-share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIds: [...selected] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      let job;
      do {
        await sleep(3000);
        const jr = await fetch('/api/job?id=' + j.jobId);
        job = await jr.json();
        if (!jr.ok) throw new Error(job.error);
        job.items.forEach(i => (status[i.rowId] = i));
        render();
      } while (!job.done);
      const ok = job.items.filter(i => i.ok).length;
      job.items.filter(i => i.ok).forEach(i => selected.delete(i.rowId));
      showMsg(`${ok} of ${job.items.length} activated and shared.`, ok === job.items.length);
    } catch (e) { showMsg('Error: ' + e.message); }
    running = false;
    try { await fetchProjects(); } catch (e) { showMsg('Error refreshing: ' + e.message); }
    render();
  });

  load();
})();
