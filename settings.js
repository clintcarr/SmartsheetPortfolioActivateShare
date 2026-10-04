// Settings dialog: edits config.json through /api/config
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLS = [['name', 'Project name'], ['status', 'Workspace status'], ['date', 'Date'], ['location', 'Location'], ['type', 'Type / client'], ['shared', 'Shared']];
  let conf = null, cur = 0;

  const field = (label, html, hint) => `<label class="sf"><span>${label}</span>${html}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const input = (id, val, type = 'text', extra = '') => `<input id="${id}" type="${type}" value="${esc(val)}" ${extra}>`;
  const levelSel = (id, val) => `<select id="${id}">${conf.levels.map(l => `<option ${l === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

  function render() {
    const p = conf.portfolios[cur];
    $('settingsBody').innerHTML = `
      <h3>Smartsheet</h3>
      <div class="sgrid">
        ${field('API key', input('sKey', '', 'password', `placeholder="Unchanged (${esc(conf.smartsheet.apiKeyHint)})" autocomplete="off"`), 'Leave blank to keep the current key')}
        ${field('Base URL', input('sBase', conf.smartsheet.baseUrl))}
        ${field('Server port', input('sPort', conf.server.port, 'number', 'min="1" max="65535"'), 'Port changes need a server restart')}
      </div>

      <h3>Portfolio</h3>
      <div class="ptabs">
        <select id="pSel">${conf.portfolios.map((x, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(x.name || 'Portfolio ' + (i + 1))}${i === 0 ? ' (in use)' : ''}</option>`).join('')}</select>
        <button type="button" class="ghost" id="pAdd">Add</button>
        <button type="button" class="ghost" id="pDel" ${conf.portfolios.length < 2 ? 'disabled' : ''}>Remove</button>
      </div>
      <div class="sgrid">
        ${field('Name', input('pName', p.name))}
        ${field('Project list sheet ID', input('pSheet', p.projectListSheetId, 'number'))}
        ${field('Workspace access', levelSel('pAccess', p.workspaceAccess))}
        ${field('Tracker sheet name', input('pTrName', p.trackerSheet.name))}
        ${field('Tracker sheet access', levelSel('pTrAccess', p.trackerSheet.access))}
        ${field('Active value', input('pActive', p.activeValue), 'Workspace Status value that triggers creation')}
        ${field('Poll every (seconds)', input('pPoll', p.pollSeconds, 'number', 'min="1"'))}
        ${field('Workspace timeout (seconds)', input('pTimeout', p.provisionTimeoutSeconds, 'number', 'min="10"'))}
        <label class="sf chk"><input id="pEmail" type="checkbox" ${p.sendInviteEmail ? 'checked' : ''}><span>Send Smartsheet invite email</span></label>
      </div>

      <h3>Column names in the project list</h3>
      <div class="sgrid">${COLS.map(([k, l]) => field(l, input('pc_' + k, p.columns[k]))).join('')}</div>`;
    $('pSel').onchange = e => { collect(); cur = Number(e.target.value); render(); };
    $('pAdd').onclick = () => { collect(); const c = JSON.parse(JSON.stringify(conf.portfolios[cur])); c.name = c.name + ' copy'; conf.portfolios.push(c); cur = conf.portfolios.length - 1; render(); };
    $('pDel').onclick = () => { if (!confirm(`Remove "${conf.portfolios[cur].name}" from the config?`)) return; conf.portfolios.splice(cur, 1); cur = 0; render(); };
  }

  function collect() {
    const p = conf.portfolios[cur];
    p.name = $('pName').value; p.projectListSheetId = $('pSheet').value;
    p.workspaceAccess = $('pAccess').value; p.sendInviteEmail = $('pEmail').checked;
    p.trackerSheet = { name: $('pTrName').value, access: $('pTrAccess').value };
    p.activeValue = $('pActive').value; p.pollSeconds = $('pPoll').value; p.provisionTimeoutSeconds = $('pTimeout').value;
    COLS.forEach(([k]) => (p.columns[k] = $('pc_' + k).value));
    conf.smartsheet.apiKey = $('sKey').value; conf.smartsheet.baseUrl = $('sBase').value;
    conf.server.port = $('sPort').value;
  }

  function err(t) { const m = $('settingsMsg'); m.hidden = !t; m.textContent = t || ''; }

  $('btnSettings').addEventListener('click', async () => {
    err('');
    try {
      const r = await fetch('/api/config'); conf = await r.json();
      if (!r.ok) throw new Error(conf.error);
      cur = 0; render(); $('settingsDlg').showModal();
    } catch (e) { alert('Could not load settings: ' + e.message); }
  });
  $('settingsCancel').addEventListener('click', () => $('settingsDlg').close());
  $('settingsSave').addEventListener('click', async () => {
    collect(); err('');
    try {
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(conf) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      $('settingsDlg').close();
      alert(j.portChanged ? 'Settings saved. Restart the server for the new port to take effect.' : 'Settings saved.');
      location.reload();
    } catch (e) { err(e.message); }
  });
})();
