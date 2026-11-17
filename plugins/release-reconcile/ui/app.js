// The Release audit page. Sandboxed frame, opaque origin, no network: every
// action is a call of this plugin's own tools through the page bridge, as the
// signed-in user (docs/PLUGIN-PACKAGES.md#pages). Write tools (save, delete,
// start, cancel) are confirmed by the user in the app. All text is set with
// textContent: nothing from a commit or ticket is ever interpreted as HTML.
(function () {
  'use strict';

  var params = new URLSearchParams((location.hash || '').slice(1));
  var nonce = params.get('octipus');
  var parentOrigin = params.get('parent');
  var waiting = new Map();
  var nextId = 1;
  var port = null;
  if (nonce && parentOrigin) {
    var channel = new MessageChannel();
    channel.port1.onmessage = function (event) {
      var data = event.data;
      if (!data || data.octipus !== 'result' || typeof data.id !== 'number') return;
      var done = waiting.get(data.id);
      if (typeof done !== 'function') return;
      waiting.delete(data.id);
      done(data);
    };
    window.parent.postMessage({ octipus: 'ready', nonce: nonce }, parentOrigin, [channel.port2]);
    port = channel.port1;
  }

  function callTool(tool, args) {
    return new Promise(function (resolve, reject) {
      if (!port) { reject(new Error('Open this page from the Octipus app: it has no connection to it.')); return; }
      var id = nextId++;
      waiting.set(id, function (reply) {
        if (!reply.ok) { reject(new Error(reply.code === 'denied_by_user' ? 'Not done: you did not allow it.' : (reply.error || 'The call failed'))); return; }
        var result = reply.result || {};
        var text = result.content && result.content[0] && result.content[0].text;
        if (result.isError) { reject(new Error(text || 'The plugin failed')); return; }
        try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
      });
      port.postMessage({ octipus: 'call', id: id, tool: tool, args: args || {} });
    });
  }

  var $ = function (id) { return document.getElementById(id); };
  var POLL_MS = 3000;
  var state = { profile: null, runId: null, timer: null };

  // Placeholders only: replace with your own environment, folders, connections and projects.
  var EXAMPLE = {
    id: 'example', name: 'Example product line', environmentId: '<your environment id>', workspaceRoot: '/path/to/workspace',
    ticketProjects: ['ABC'],
    tracker: { connection: 'tracker', kind: 'jira-cloud', versionFormat: '{product}: v.{version}', doneStatuses: ['Done'], parentCarriesVersion: true },
    forge: { connection: 'forge', kind: 'gitlab' },
    manifestFiles: ['package.json', 'package-lock.json', 'pom.xml', '**/pom.xml'],
    mrPattern: 'See merge request (\\S+![0-9]+)',
    repos: [
      { key: 'api', path: 'service-api', product: 'service', fetch: { connection: 'forge', remotePath: '/group/service-api.git' }, forgeProject: 'group/service-api',
        source: 'develop', release: 'release/2.0.0', testing: 'testing/2.0.0', baseline: { tag: 'v2.0.0-rc1' } },
      { key: 'web', path: 'service-web', product: 'service', source: 'develop', release: 'release/2.0.0', baseline: { tag: 'v2.0.0-rc1' } },
    ],
  };

  function setStatus(t) { $('status').textContent = t || ''; }
  function showError(m) { $('error').textContent = m || ''; $('error').hidden = !m; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = String(text); if (cls) e.className = cls; return e; }
  function guard(fn) { return function () { showError(''); fn().catch(function (e) { setStatus(''); showError(e.message); }); }; }

  function renderVersions(profile) {
    var box = $('versions');
    box.textContent = '';
    var products = [];
    (profile && profile.repos || []).forEach(function (r) { if (products.indexOf(r.product) < 0) products.push(r.product); });
    products.forEach(function (p) {
      var id = 'v-' + p;
      var label = el('label', p); label.htmlFor = id;
      var input = document.createElement('input'); input.type = 'text'; input.id = id; input.dataset.product = p; input.placeholder = 'e.g. 2.0.0 (empty: skip)'; input.value = (profile.targetVersions || {})[p] || ''; 
      box.appendChild(label); box.appendChild(input);
    });
  }

  function useProfile(profile) {
    state.profile = profile;
    $('profile-json').value = JSON.stringify(profile, null, 2);
    renderVersions(profile);
  }

  async function refreshLists() {
    var p = await callTool('profile_list');
    var sel = $('profiles');
    sel.textContent = '';
    sel.appendChild(el('option', '—')).value = '';
    p.profiles.forEach(function (x) { var o = el('option', x.name + ' (' + x.id + ')'); o.value = x.id; sel.appendChild(o); });
    var r = await callTool('audit_list');
    var rs = $('runs');
    rs.textContent = '';
    rs.appendChild(el('option', '—')).value = '';
    r.runs.slice(0, 50).forEach(function (x) { var o = el('option', x.updatedAt + ' · ' + x.runId.slice(0, 8)); o.value = x.runId; rs.appendChild(o); });
  }

  function cell(row, text, cls) { var td = el('td', text, cls); row.appendChild(td); return td; }

  function renderReport(out) {
    var rep = out.report;
    $('report').hidden = false;
    $('report-meta').textContent = out.profile + ' · ' + Object.keys(rep.versions).map(function (k) { return rep.versions[k]; }).join(', ') + ' · collected ' + rep.collectedAt;
    var banner = $('banner');
    banner.className = 'banner ' + (rep.complete ? 'ok' : 'incomplete');
    banner.textContent = rep.complete ? 'Evidence complete: repositories, tracker and open merge requests were read in full.'
      : 'Evidence INCOMPLETE (repositories: ' + rep.completeness.repositories + ', tracker: ' + rep.completeness.tracker + ', open MRs: ' + rep.completeness.openMergeRequests + '). Verdicts that depend on missing data are marked unknown.';
    var f = $('findings'); f.textContent = '';
    rep.findings.forEach(function (x) { var tr = document.createElement('tr'); cell(tr, x.severity, 'sev-' + x.severity); cell(tr, x.kind, 'mono'); cell(tr, x.message); f.appendChild(tr); });
    if (!rep.findings.length) { var tr0 = document.createElement('tr'); cell(tr0, 'none'); f.appendChild(tr0); }
    var t = $('tickets'); t.textContent = '';
    rep.tickets.forEach(function (x) {
      var tr = document.createElement('tr');
      cell(tr, x.key + (x.parentKey ? ' ↑' + x.parentKey : ''), 'mono');
      cell(tr, (x.found ? (x.summary || '') + ' · ' + (x.status || '?') : 'not found in tracker'));
      cell(tr, x.versions ? x.versions.join(', ') : 'unknown');
      cell(tr, x.verdicts.length ? x.verdicts.map(function (v) { return v.kind + (v.product ? '(' + v.product + ')' : ''); }).join(', ') : 'ok');
      var ev = cell(tr, ''); var ul = el('ul', null, 'ev');
      x.evidence.slice(0, 20).forEach(function (c) { ul.appendChild(el('li', c.repo + '@' + c.branch + ' ' + c.sha.slice(0, 12) + (c.mr ? ' · ' + c.mr : '') + (c.mergedBranch ? ' · ' + c.mergedBranch : '') + ' · ' + c.how, 'mono')); });
      if (x.evidence.length > 20) ul.appendChild(el('li', '+' + (x.evidence.length - 20) + ' more (raw JSON)'));
      ev.appendChild(ul);
      t.appendChild(tr);
    });
    var r = $('repos'); r.textContent = '';
    rep.repos.forEach(function (x) {
      var tr = document.createElement('tr');
      cell(tr, x.key + ' (' + x.product + ')' + (x.complete ? '' : ' · incomplete'), 'mono');
      cell(tr, Object.keys(x.refs).map(function (n) { var v = x.refs[n]; return n + ' ' + v.input + ' → ' + (v.sha ? v.sha.slice(0, 12) : v.status) + ' (' + v.source + ', ' + v.at + ')'; }).join('\n'), 'mono');
      cell(tr, x.checks.map(function (c) { return c.kind === 'branch_pair' ? c.a + '→' + c.b + ': ancestry ' + (c.aInB ? 'yes' : 'no') + ', tree ' + (c.sameTree ? 'same' : c.manifestOnly ? 'manifest-only diff' : 'differs (' + c.changedFiles + ')') : c.kind; }).join('\n'));
      cell(tr, x.problems.join('\n'));
      r.appendChild(tr);
    });
    $('raw').textContent = JSON.stringify(rep, null, 2);
  }

  async function poll() {
    clearTimeout(state.timer);
    if (!state.runId) return;
    var out = await callTool('audit_status', { runId: state.runId });
    if (out.status === 'running') { setStatus('Collecting: ' + (out.stage || 'starting') + '…'); state.timer = setTimeout(guard(poll), POLL_MS); return; }
    setStatus('Run ' + out.status + (out.finishedAt ? ' at ' + out.finishedAt : ''));
    if (out.error) showError(out.error);
    if (out.report) renderReport(out);
  }

  $('template').addEventListener('click', function () { useProfile(EXAMPLE); });
  $('load').addEventListener('click', guard(async function () {
    var id = $('profiles').value;
    if (!id) throw new Error('Choose a saved profile');
    useProfile((await callTool('profile_get', { id: id })).profile);
  }));
  $('options').addEventListener('click', guard(async function () {
    var o = await callTool('collector_options');
    var box = $('options-out');
    box.hidden = false;
    box.textContent = o.environments.length
      ? o.environments.map(function (e) { return e.name + ' — id ' + e.id + ' — folders: ' + (e.roots.join(', ') || 'none approved'); }).join('\n') + '\nConnections: ' + (o.connections.join(', ') || 'none approved')
      : 'No host execution environment of yours is available here.';
  }));
  $('save').addEventListener('click', guard(async function () {
    var parsed;
    try { parsed = JSON.parse($('profile-json').value); } catch (e) { throw new Error('The profile is not valid JSON: ' + e.message); }
    if (state.profile && state.profile.id === parsed.id) {
      var targets = {};
      Array.prototype.forEach.call(document.querySelectorAll('#versions input'), function (i) { if (i.value.trim()) targets[i.dataset.product] = i.value.trim(); });
      var previous = state.profile.targetVersions || {};
      var changed = Object.keys(targets).length !== Object.keys(previous).length || Object.keys(targets).some(function (key) { return targets[key] !== previous[key]; });
      if (changed) { if (Object.keys(targets).length) parsed.targetVersions = targets; else delete parsed.targetVersions; }
    }
    var out = await callTool('profile_save', { profile: parsed });
    setStatus('Saved profile ' + out.id);
    useProfile((await callTool('profile_get', { id: out.id })).profile);
    await refreshLists();
  }));
  $('delete').addEventListener('click', guard(async function () {
    var id = state.profile && state.profile.id;
    if (!id) throw new Error('Load a saved profile first');
    await callTool('profile_delete', { id: id });
    setStatus('Deleted profile ' + id);
    state.profile = null; renderVersions(null); await refreshLists();
  }));
  $('start').addEventListener('click', guard(async function () {
    if (!state.profile) throw new Error('Load or save a profile first');
    var versions = {};
    Array.prototype.forEach.call(document.querySelectorAll('#versions input'), function (i) { if (i.value.trim()) versions[i.dataset.product] = i.value.trim(); });
    setStatus('Starting…');
    var out = await callTool('audit_start', { profileId: state.profile.id, versions: versions, includeTesting: $('include-testing').checked, fetch: $('fetch').checked });
    state.runId = out.runId;
    await refreshLists();
    await poll();
  }));
  $('open').addEventListener('click', guard(async function () {
    state.runId = $('runs').value || null;
    if (!state.runId) throw new Error('Choose a run');
    await poll();
  }));
  $('cancel').addEventListener('click', guard(async function () {
    var id = state.runId || $('runs').value;
    if (!id) throw new Error('Choose a run');
    await callTool('audit_cancel', { runId: id });
    clearTimeout(state.timer);
    setStatus('Cancelled');
  }));

  guard(refreshLists)();
})();
