// Settings dialog: edits config.json through the server. Uses the helpers app.js exposes on window.App.
(function () {
  var App = window.App, $ = function (id) { return document.getElementById(id); };
  var run = App.run, esc = App.esc, askConfirm = App.askConfirm, showMsg = App.showMsg, load = App.load;

  // ---------------------------------------------------------------- settings dialog
  var COLS = [['name', 'Project name'], ['status', 'Workspace status'], ['date', 'Date'], ['location', 'Location'], ['type', 'Type / client'], ['shared', 'Shared'], ['attended', 'Attended']];
  var conf = null, cur = 0;
  function field(label, html, hint) { return '<label class="sf"><span>' + label + '</span>' + html + (hint ? '<small>' + hint + '</small>' : '') + '</label>'; }
  function input(id, val, type, extra) { return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val) + '" ' + (extra || '') + '>'; }
  function levelSel(id, val, levels) { return '<select id="' + id + '">' + (levels || conf.levels).map(function (l) { return '<option ' + (l === val ? 'selected' : '') + '>' + l + '</option>'; }).join('') + '</select>'; }

  function renderSettings() {
    var p = conf.portfolios[cur];
    $('settingsBody').innerHTML =
      '<h3>Smartsheet</h3><div class="sgrid">' +
      field('API key', input('sKey', '', 'password', 'placeholder="' + (conf.smartsheet.apiKeySet ? 'Unchanged (' + esc(conf.smartsheet.apiKeyHint) + ')' : 'Paste your API token') + '" autocomplete="off"'), conf.smartsheet.apiKeySet ? 'Leave blank to keep the current key' : 'Required') +
      field('Base URL', input('sBase', conf.smartsheet.baseUrl)) +
      field('Server port', input('sPort', conf.server.port, 'number', 'min="1" max="65535"'), 'Port changes need a server restart') + '</div>' +
      '<h3>Portfolio</h3><div class="ptabs"><select id="pSel">' + conf.portfolios.map(function (x, i) { return '<option value="' + i + '" ' + (i === cur ? 'selected' : '') + '>' + esc(x.name || 'Portfolio ' + (i + 1)) + (i === 0 ? ' (in use)' : '') + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="ghost" id="pAdd">Add</button><button type="button" class="ghost" id="pDel" ' + (conf.portfolios.length < 2 ? 'disabled' : '') + '>Remove</button></div>' +
      '<div class="sgrid">' +
      field('Name', input('pName', p.name)) + field('Project list sheet ID', input('pSheet', p.projectListSheetId, 'number')) +
      field('Workspace access', levelSel('pAccess', p.workspaceAccess)) + field('Tracker sheet name', input('pTrName', p.trackerSheet.name)) +
      field('Tracker sheet access', levelSel('pTrAccess', p.trackerSheet.access, conf.trackerLevels), 'NONE = no separate share; the workspace access applies') + field('Active value', input('pActive', p.activeValue), 'Workspace Status value that triggers creation') +
      field('Poll every (seconds)', input('pPoll', p.pollSeconds, 'number', 'min="1"')) + field('Workspace timeout (seconds)', input('pTimeout', p.provisionTimeoutSeconds, 'number', 'min="10"')) +
      '<label class="sf chk"><input id="pEmail" type="checkbox" ' + (p.sendInviteEmail ? 'checked' : '') + '><span>Send Smartsheet invite email</span></label>' +
      '<label class="sf chk"><input id="pCc" type="checkbox" ' + (p.ccMe ? 'checked' : '') + '><span>Send me a copy of the invite email</span></label></div>' +
      '<h3>Invite email text</h3><div class="sgrid">' + field('Subject', input('pSubj', p.emailSubject || ''), 'Leave blank for the Smartsheet default') + '<span></span></div>' +
      '<label class="sf" style="margin-top:14px;"><span>Message</span><textarea id="pMsg" rows="5">' + esc(p.emailMessage || '') + '</textarea><small>Added to the Smartsheet invitation. You can use {name} (project name), {workspace} (workspace name) and {url} (workspace link). Leave blank for the default. Only used when "Send Smartsheet invite email" is ticked. Smartsheet cannot attach files to this email.</small></label>' +
      '<h3>Analytics quick check</h3><label class="sf"><span>Cells checked first (one per line: column name, row number)</span><textarea id="pQuick" rows="5" spellcheck="false">' + esc((p.quickCheck || []).map(function (q) { return q.column + ', ' + q.row; }).join('\n')) + '</textarea><small>If the participant has edited none of these cells, the scan stops and reports a partial scan with no changes. Leave empty to always do the full scan.</small></label>' +
      '<h3>Column names in the project list</h3><div class="sgrid">' + COLS.map(function (c) { return field(c[1], input('pc_' + c[0], p.columns[c[0]])); }).join('') + '</div>';
    $('pSel').onchange = function (e) { collect(); cur = Number(e.target.value); renderSettings(); };
    $('pAdd').onclick = function () { collect(); var c = JSON.parse(JSON.stringify(conf.portfolios[cur])); c.name += ' copy'; conf.portfolios.push(c); cur = conf.portfolios.length - 1; renderSettings(); };
    $('pDel').onclick = function () {
      askConfirm('Remove "' + conf.portfolios[cur].name + '" from the settings?').then(function (yes) {
        if (!yes) return; conf.portfolios.splice(cur, 1); cur = 0; renderSettings(); $('settingsDlg').showModal();
      });
    };
  }

  function collect() {
    var p = conf.portfolios[cur];
    p.name = $('pName').value; p.projectListSheetId = $('pSheet').value; p.workspaceAccess = $('pAccess').value; p.sendInviteEmail = $('pEmail').checked; p.ccMe = $('pCc').checked; p.emailSubject = $('pSubj').value; p.emailMessage = $('pMsg').value;
    p.trackerSheet = { name: $('pTrName').value, access: $('pTrAccess').value };
    p.activeValue = $('pActive').value; p.pollSeconds = $('pPoll').value; p.provisionTimeoutSeconds = $('pTimeout').value;
    p.quickCheck = $('pQuick').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var k = l.lastIndexOf(','); return { column: (k < 0 ? l : l.slice(0, k)).trim(), row: k < 0 ? NaN : Number(l.slice(k + 1)) };
    });
    COLS.forEach(function (c) { p.columns[c[0]] = $('pc_' + c[0]).value; });
    conf.smartsheet.apiKey = $('sKey').value; conf.smartsheet.baseUrl = $('sBase').value; conf.server.port = $('sPort').value;
  }
  function settingsErr(t) { var m = $('settingsMsg'); m.hidden = !t; m.textContent = t || ''; }

  $('btnSettings').addEventListener('click', function () {
    settingsErr('');
    run('getConfigPublic').then(function (c) { conf = c; cur = 0; renderSettings(); $('settingsDlg').showModal(); })
      .catch(function (e) { showMsg('Could not load settings: ' + e.message); });
  });
  $('settingsCancel').addEventListener('click', function () { $('settingsDlg').close(); });
  $('settingsSave').addEventListener('click', function () {
    collect(); settingsErr('');
    run('saveConfig', conf).then(function (r) { $('settingsDlg').close(); showMsg(r && r.portChanged ? 'Settings saved. Restart the server for the new port to take effect.' : 'Settings saved.', true); return load('settings-saved'); })
      .catch(function (e) { settingsErr(e.message); });
  });

})();
