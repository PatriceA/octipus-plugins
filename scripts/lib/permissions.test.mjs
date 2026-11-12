import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPermissions, diffPermissions, formatStoreBytes, networkWarnings, permissionsProblems, PERMISSION_KEYS, storeWords } from './permissions.mjs';
import { withStore } from '../../tests/fixtures/permissions.mjs';

const H = (c) => c.repeat(64);

// The CLI's shape (octi plugin permissions --json) at the pinned OCTIPUS_REF.
const base = {
  name: 'x', version: '1.0.0', apiVersion: '1.0.0', runtime: 'package',
  host: ['notes:read'], network: ['api.example.com'], secrets: [], settings: [], store: null,
  tools: [{ name: 'list', effect: 'read' }, { name: 'save', effect: 'write' }],
  effects: { read: 1, write: 1, external: 0 },
  contributions: {
    commands: [{ name: 'go', tool: 'list' }],
    schedules: [{ id: 'daily', cron: '0 7 * * *', tool: 'list', input: { n: 1 } }],
    events: [{ on: 'note.created', tool: 'list' }],
    prompt: { file: 'prompt.md', sha256: H('a'), roles: ['coder'] },
    context: { tool: 'list', roles: ['coder'] },
  },
  pages: [{ path: 'a', title: 'A', entry: 'index.html' }],
  ui: { dir: 'ui', sha256: H('b') },
  dashboards: [],
  trustedInput: false, maxProtection: 1,
};
/** `base` with `over` merged (and contributions merged one level down). */
const withP = (over = {}) => {
  const p = structuredClone(base);
  for (const [k, v] of Object.entries(over)) p[k] = k === 'contributions' ? { ...p.contributions, ...v } : v;
  return p;
};
const widening = (d) => d.changes.filter((c) => c.widens).map((c) => c.text);
const texts = (d) => d.changes.map((c) => `${c.widens ? '+' : '-'} ${c.text}`);

test('the CLI shape passes; the key order is the CLI\'s', () => {
  assert.deepEqual(permissionsProblems(base), []);
  assert.deepEqual(Object.keys(base), PERMISSION_KEYS);
  assert.equal(assertPermissions(base), base);
});

test('the old shape, another key order, unsorted lists or a missing hash are refused', () => {
  assert.match(permissionsProblems({ ...base, pages: 1 })[0], /old shape/);
  assert.match(permissionsProblems(withP({ contributions: { prompt: false } }))[0], /old shape/);
  const { ui, ...noUi } = base;
  assert.match(permissionsProblems({ ...noUi, ui })[0], /in that order/);
  assert.match(permissionsProblems({ ...base, extra: 1 })[0], /exactly/);
  assert.match(permissionsProblems(withP({ host: ['z:read', 'notes:read'] })).join(), /host/);
  assert.match(permissionsProblems(withP({ tools: [...base.tools].reverse() })).join(), /tools/);
  assert.match(permissionsProblems(withP({ effects: { read: 2, write: 1, external: 0 } })).join(), /effects/);
  assert.match(permissionsProblems(withP({ contributions: { prompt: { file: 'prompt.md', sha256: null } } })).join(), /prompt/);
  assert.match(permissionsProblems(withP({ contributions: { prompt: { file: 'prompt.md', sha256: `sha256:${H('a')}` } } })).join(), /prompt/);
  assert.match(permissionsProblems(withP({ contributions: { prompt: { roles: ['coder'], file: 'prompt.md', sha256: H('a') } } })).join(), /contributions/);
  assert.match(permissionsProblems(withP({ contributions: { context: { tool: 'list', roles: ['b', 'a'] } } })).join(), /contributions/);
  assert.match(permissionsProblems(withP({ contributions: { schedules: [{ id: 'd', cron: '* * * * *', tool: 'list', input: undefined, extra: 1 }] } })).join(), /contributions/);
  assert.match(permissionsProblems(withP({ ui: null })).join(), /ui/);
  assert.match(permissionsProblems(withP({ pages: [], ui: { dir: 'ui', sha256: H('b') } })).join(), /ui/);
  assert.match(permissionsProblems(withP({ pages: [{ path: 'a', title: 'A‮', entry: 'index.html' }] })).join(), /pages/);
  assert.match(permissionsProblems(withP({ maxProtection: 5 })).join(), /maxProtection/);
  assert.match(permissionsProblems(withP({ tools: [{ name: 'list', effect: 'read' }, { name: 'list', effect: 'read' }], effects: { read: 2, write: 0, external: 0 } })).join(), /twice/);
  assert.throws(() => assertPermissions({ ...base, pages: 1 }, 'x 1.0.0'), /x 1\.0\.0: .*old shape/);
});

test('a new plugin widens by definition and lists everything, with what each item is bound to', () => {
  const d = diffPermissions(null, base);
  assert.equal(d.widened, true);
  assert.equal(d.firstVersion, true);
  const t = d.changes.map((c) => c.text);
  for (const line of ['host API scope notes:read', 'network host api.example.com', 'tool save (write)', 'command /go → list',
    'schedule daily (0 7 * * * UTC) → list with {"n":1}', 'event note.created → list', `prompt prompt.md (roles coder), sha256 ${H('a')}`,
    'context → list (roles coder)', 'page a ("A") → index.html', `page files (ui/), sha256 ${H('b')}`, 'maxProtection 1']) assert.ok(t.includes(line), line);
});

test('the same permissions change nothing', () => {
  const d = diffPermissions(base, withP({ version: '1.1.0' }));
  assert.equal(d.widened, false);
  assert.deepEqual(d.changes, []);
});

test('host, network and tools', () => {
  assert.deepEqual(widening(diffPermissions(base, withP({ host: ['notes:read', 'tasks:write'] }))), ['host API scope tasks:write']);
  assert.deepEqual(widening(diffPermissions(base, withP({ network: ['api.example.com', 'evil.example'] }))), ['network host evil.example']);
  const t = (tools) => withP({ tools, effects: { read: tools.filter((x) => x.effect === 'read').length, write: tools.filter((x) => x.effect === 'write').length, external: tools.filter((x) => x.effect === 'external').length } });
  assert.deepEqual(widening(diffPermissions(base, t([{ name: 'list', effect: 'external' }, { name: 'save', effect: 'write' }]))), ['tool list: read → external']);
  // Review finding 11: write → read (or external → read) drops the per-call
  // approval and unlocks unattended runs: a change that widens.
  const toRead = diffPermissions(base, t([{ name: 'list', effect: 'read' }, { name: 'save', effect: 'read' }]));
  assert.equal(toRead.widened, true);
  assert.deepEqual(texts(toRead), ['+ tool save: write → read (no per-call approval any more: it can run unattended)']);
  const ext = withP({ tools: [{ name: 'list', effect: 'read' }, { name: 'save', effect: 'external' }], effects: { read: 1, write: 0, external: 1 } });
  assert.equal(diffPermissions(ext, base).widened, false, 'external → write still asks every call');
  assert.equal(diffPermissions(ext, base).changes[0].change, 'narrower');
  assert.equal(diffPermissions(ext, t([{ name: 'list', effect: 'read' }, { name: 'save', effect: 'read' }])).widened, true);
  assert.equal(diffPermissions(base, withP({ host: [], network: [] })).widened, false);
});

test('commands: added or retargeted widens; removed does not', () => {
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { commands: [{ name: 'go', tool: 'list' }, { name: 'more', tool: 'save' }] } }))), ['+ command /more → save']);
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { commands: [{ name: 'go', tool: 'save' }] } }))), ['+ command /go: list → save']);
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { commands: [] } }))), ['- command /go → list']);
  // A rename is a removal and an addition: the addition widens.
  assert.equal(diffPermissions(base, withP({ contributions: { commands: [{ name: 'go2', tool: 'list' }] } })).widened, true);
});

test('schedules: a tool or a cron widens; the input alone is a change, not a widening', () => {
  const s = (x) => withP({ contributions: { schedules: [{ ...base.contributions.schedules[0], ...x }] } });
  assert.deepEqual(texts(diffPermissions(base, s({ tool: 'save' }))), ['+ schedule daily: tool list → save']);
  assert.deepEqual(texts(diffPermissions(base, s({ cron: '* * * * *' }))), ['+ schedule daily: cron 0 7 * * * → * * * * * (UTC)']);
  const input = diffPermissions(base, s({ input: { n: 2 } }));
  assert.equal(input.widened, false);
  assert.deepEqual(texts(input), ['- schedule daily: input {"n":1} → {"n":2}']);
  const { input: _, ...noInput } = base.contributions.schedules[0];
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { schedules: [noInput] } }))), ['- schedule daily: input {"n":1} → null']);
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { schedules: [] } }))), ['- schedule daily (0 7 * * * UTC) → list']);
  assert.equal(diffPermissions(base, withP({ contributions: { schedules: [...base.contributions.schedules, { id: 'e', cron: '0 0 * * *', tool: 'list' }] } })).widened, true);
});

test('events: an added handler widens, a removed one does not', () => {
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { events: [{ on: 'note.created', tool: 'list' }, { on: 'note.created', tool: 'save' }] } }))), ['+ event note.created → save']);
  assert.deepEqual(texts(diffPermissions(base, withP({ contributions: { events: [] } }))), ['- event note.created → list']);
});

test('prompt: a changed file or text widens; roles widen only when they reach more agents', () => {
  const pr = (x) => withP({ contributions: { prompt: x } });
  assert.deepEqual(texts(diffPermissions(base, pr({ file: 'prompt.md', sha256: H('c'), roles: ['coder'] }))), ['+ prompt text (prompt.md)']);
  assert.deepEqual(texts(diffPermissions(base, pr({ file: 'other.md', sha256: H('a'), roles: ['coder'] }))), ['+ prompt text (other.md)']);
  assert.deepEqual(texts(diffPermissions(base, pr({ file: 'prompt.md', sha256: H('a') }))), ['+ prompt roles coder → every role']);
  assert.deepEqual(texts(diffPermissions(base, pr({ file: 'prompt.md', sha256: H('a'), roles: ['coder', 'writer'] }))), ['+ prompt roles coder → roles coder, writer']);
  assert.deepEqual(texts(diffPermissions(pr({ file: 'prompt.md', sha256: H('a'), roles: ['coder', 'writer'] }), base)), ['- prompt roles coder, writer → roles coder']);
  assert.deepEqual(texts(diffPermissions(pr({ file: 'prompt.md', sha256: H('a') }), base)), ['- prompt every role → roles coder']);
  assert.deepEqual(texts(diffPermissions(base, pr(null))), ['- prompt prompt.md']);
  assert.deepEqual(texts(diffPermissions(pr(null), base)), ['+ prompt prompt.md (roles coder)']);
});

test('context: another tool widens; roles widen only when they reach more agents', () => {
  const cx = (x) => withP({ contributions: { context: x } });
  assert.deepEqual(texts(diffPermissions(base, cx({ tool: 'save', roles: ['coder'] }))), ['+ context tool list → save']);
  assert.deepEqual(texts(diffPermissions(base, cx({ tool: 'list' }))), ['+ context roles coder → every role']);
  assert.deepEqual(texts(diffPermissions(cx({ tool: 'list' }), base)), ['- context every role → roles coder']);
  assert.deepEqual(texts(diffPermissions(base, cx(null))), ['- context → list']);
  assert.deepEqual(texts(diffPermissions(cx(null), base)), ['+ context → list (roles coder)']);
});

test('pages: added or changed widens, a removed one does not; other page files widen', () => {
  assert.deepEqual(texts(diffPermissions(base, withP({ pages: [{ path: 'a', title: 'B', entry: 'index.html' }] }))), ['+ page a: "A" index.html → "B" index.html']);
  assert.deepEqual(texts(diffPermissions(base, withP({ pages: [{ path: 'a', title: 'A', entry: 'other.html' }] }))), ['+ page a: "A" index.html → "A" other.html']);
  assert.deepEqual(texts(diffPermissions(base, withP({ pages: [...base.pages, { path: 'b', title: 'B', entry: 'b.html' }] }))), ['+ page b ("B")']);
  assert.deepEqual(texts(diffPermissions(base, withP({ ui: { dir: 'ui', sha256: H('d') } }))), ['+ page files (ui/)']);
  assert.deepEqual(texts(diffPermissions(base, withP({ pages: [], ui: null }))), ['- page a ("A")']);
  assert.equal(diffPermissions(withP({ pages: [], ui: null }), base).widened, true);
});

test('trustedInput, runtime and maxProtection', () => {
  assert.equal(diffPermissions(base, withP({ trustedInput: true })).widened, true);
  assert.equal(diffPermissions(withP({ trustedInput: true }), base).widened, false);
  assert.equal(diffPermissions(base, withP({ runtime: 'in-process' })).widened, true);
  assert.equal(diffPermissions(base, withP({ maxProtection: 3 })).widened, true);
  assert.equal(diffPermissions(withP({ maxProtection: 3 }), base).widened, false);
  assert.equal(diffPermissions(base, withP({ apiVersion: '1.1.0' })).widened, false);
});

// Review finding 11: secrets and settings, and a command's input.
test('secrets and settings: required, sorted, diffed; a new secret widens', () => {
  // Required, right after network, as the pinned CLI prints them.
  for (const k of ['secrets', 'settings']) {
    const { [k]: _, ...without } = base;
    assert.match(permissionsProblems(without)[0], /exactly/, k);
  }
  const { secrets, settings, ...noLists } = base;
  assert.match(permissionsProblems({ ...noLists, secrets, settings })[0], /in that order/);
  const withS = (secrets, settings) => ({ ...base, ...(secrets ? { secrets } : {}), ...(settings ? { settings } : {}) });
  assert.deepEqual(permissionsProblems(withS(['A'], null)), []);
  assert.match(permissionsProblems(withS(['B', 'A'], null)).join(), /secrets/);
  assert.match(permissionsProblems(withS(['A', 'A'], null)).join(), /twice/);
  assert.match(permissionsProblems(withS(null, [1])).join(), /settings/);
  assert.match(permissionsProblems({ ...base, secrets: null }).join(), /secrets/);
  assert.match(permissionsProblems({ ...base, secretz: [] })[0], /exactly/);

  const d = diffPermissions(base, withS(['API_TOKEN'], ['base_url']));
  assert.deepEqual(texts(d), ['+ secret API_TOKEN', '- setting base_url']);
  assert.equal(d.widened, true);
  const settingOnly = diffPermissions(withS(['API_TOKEN'], null), withS(['API_TOKEN'], ['limit']));
  assert.equal(settingOnly.widened, false);
  assert.deepEqual(texts(settingOnly), ['- setting limit']);
  assert.deepEqual(texts(diffPermissions(withS(['A'], ['b']), base)), ['- secret A', '- setting b']);
  const t = diffPermissions(null, withS(['API_TOKEN'], ['limit'])).changes.map((c) => c.text);
  assert.ok(t.includes('secret API_TOKEN') && t.includes('setting limit'));
  // A listing from before them (an index entry from an older CLI) diffs as none.
  const { secrets: _s, settings: _t, store: _u, ...older } = base;
  assert.deepEqual(diffPermissions(older, base).changes, []);
  assert.deepEqual(texts(diffPermissions(older, withS(['A'], null))), ['+ secret A']);
});

// The per-user store: `store: { quotaBytes } | null` right after
// `settings`, with store:read / store:write. Required, as the pinned CLI prints it.
test('store: required, right after settings, within the bounds', () => {
  const MB = 1024 * 1024;
  const stored = (store, host = ['notes:read', 'store:read', 'store:write']) => withStore(withP({ host }), store);
  const five = stored({ quotaBytes: 5 * MB });
  assert.deepEqual(Object.keys(five), PERMISSION_KEYS);
  assert.deepEqual(permissionsProblems(five), []);
  assert.deepEqual(permissionsProblems(withStore(base, null)), []);
  const { store: _, ...noStore } = base;
  assert.match(permissionsProblems(noStore)[0], /exactly/, 'a listing without store');
  for (const quotaBytes of [1024, 20 * MB]) assert.deepEqual(permissionsProblems(stored({ quotaBytes })), [], String(quotaBytes));
  for (const quotaBytes of [1023, 20 * MB + 1, 1024.5, '5242880', null, -1]) assert.match(permissionsProblems(stored({ quotaBytes })).join(), /permissions\.store/, String(quotaBytes));
  for (const store of [{}, { quotaBytes: 5 * MB, extra: 1 }, [], true, 5 * MB, undefined]) assert.match(permissionsProblems(stored(store)).join(), /permissions\.store/, JSON.stringify(store));
  // Only right after settings, where the CLI prints it.
  const { store, ...rest } = five;
  assert.match(permissionsProblems({ ...rest, store })[0], /in that order/);
  // With a store scope, and only then (the CLI refuses the manifest otherwise).
  assert.match(permissionsProblems(stored({ quotaBytes: 5 * MB }, ['notes:read'])).join(), /without the host scope/);
  assert.match(permissionsProblems(stored(null, ['store:read'])).join(), /store is null/);
  assert.deepEqual(permissionsProblems(stored({ quotaBytes: MB }, ['store:read'])), []);
});

test('store: the diff and the words are Octipus\'s', () => {
  const MB = 1024 * 1024;
  const host = ['notes:read', 'store:read', 'store:write'];
  const stored = (quotaBytes) => withStore(withP({ host }), quotaBytes === null ? null : { quotaBytes });
  const noStore = withP({ host });
  assert.equal(formatStoreBytes(5 * MB), '5 MB');
  assert.equal(formatStoreBytes(2.5 * MB), '2.5 MB');
  assert.equal(formatStoreBytes(512 * 1024), '512 KB');
  assert.equal(formatStoreBytes(100), '100 bytes');
  assert.equal(storeWords(5 * MB), 'Keeps up to 5 MB of its own data per user');

  const store = (d) => d.changes.filter((c) => c.kind === 'store').map(({ kind, change, text, widens }) => ({ kind, change, text, widens }));
  assert.deepEqual(store(diffPermissions(noStore, stored(5 * MB))), [{ kind: 'store', change: 'added', text: 'store (5 MB per user)', widens: true }]);
  // A listing without the key (an index entry from an older CLI) reads as null, both ways.
  const { store: _, ...older } = noStore;
  assert.deepEqual(store(diffPermissions(older, stored(5 * MB))), [{ kind: 'store', change: 'added', text: 'store (5 MB per user)', widens: true }]);
  assert.deepEqual(store(diffPermissions(stored(null), older)), []);
  const wider = diffPermissions(stored(5 * MB), stored(10 * MB));
  assert.deepEqual(store(wider), [{ kind: 'store', change: 'wider', text: 'store quota 5 MB → 10 MB per user', widens: true }]);
  assert.equal(wider.widened, true);
  const narrower = diffPermissions(stored(10 * MB), stored(5 * MB));
  assert.deepEqual(store(narrower), [{ kind: 'store', change: 'narrower', text: 'store quota 10 MB → 5 MB per user', widens: false }]);
  assert.equal(narrower.widened, false);
  const removed = diffPermissions(stored(5 * MB), stored(null));
  assert.deepEqual(store(removed), [{ kind: 'store', change: 'removed', text: 'store (5 MB per user)', widens: false }]);
  assert.equal(removed.widened, false);
  assert.deepEqual(diffPermissions(stored(5 * MB), stored(5 * MB)).changes, []);
  assert.ok(diffPermissions(null, stored(5 * MB)).changes.some((c) => c.text === 'store (5 MB per user)'));
  assert.ok(!diffPermissions(null, stored(null)).changes.some((c) => c.text.startsWith('store')));
});

test('a command\'s input: accepted when present; a change, not a widening', () => {
  const cmd = (x) => withP({ contributions: { commands: [{ name: 'go', tool: 'list', ...x }] } });
  assert.deepEqual(permissionsProblems(cmd({ input: { q: 1 } })), []);
  assert.match(permissionsProblems(cmd({ input: 'x' })).join(), /commands/);
  const d = diffPermissions(cmd({ input: { q: 1 } }), cmd({ input: { q: 2 } }));
  assert.equal(d.widened, false);
  assert.deepEqual(texts(d), ['- command /go: input {"q":1} → {"q":2}']);
  assert.deepEqual(texts(diffPermissions(base, cmd({ input: { q: 1 } }))), ['- command /go: input null → {"q":1}']);
});

test('a wildcard host on what may be a public suffix is warned about', () => {
  const w = (network) => networkWarnings(withP({ network }));
  assert.equal(w(['*.github.io']).length, 1);
  assert.equal(w(['*.co.uk']).length, 1);
  assert.equal(w(['*.example.com:8443']).length, 1);
  assert.equal(w(['*']).length, 1);
  assert.deepEqual(w(['api.example.com', '*.api.example.com', 'x.github.io']), []);
  assert.match(w(['*.github.io'])[0], /public suffix/);
});

// Dashboards (Octipus #501): right after ui, sorted by id, widgets in order; checked and diffed as Octipus does.
test('dashboards: their shape, the CLI\'s form, the diff', () => {
  const dash = (widgets, id = 'main', title = 'Money') => ({ id, title, widgets });
  const w = (over = {}) => ({ id: 'open', type: 'stat', title: 'Open', tool: 'list', ...over });
  const withD = (dashboards) => withP({ dashboards });
  assert.deepEqual(permissionsProblems(withD([dash([w({ input: { status: 'open' } }), w({ id: 'b', type: 'table' })])])), []);
  assert.match(permissionsProblems(withD([dash([w({ type: 'html' })])])).join(), /dashboards/);
  assert.match(permissionsProblems(withD([dash([])])).join(), /dashboards/);
  assert.match(permissionsProblems(withD([dash([w({ input: { q: 'a\u202Eb' } })])])).join(), /dashboards/);
  assert.match(permissionsProblems(withD([dash([w({ refreshSeconds: 60 })])])).join(), /dashboards/, 'layout fields are not in the summary');
  assert.match(permissionsProblems(withD([dash([w()], 'zeta'), dash([w()], 'alpha')])).join(), /exact form/, 'sorted by id');
  assert.match(permissionsProblems(withD([dash([w(), w()])])).join(), /twice/);
  const { dashboards: _d, ...noDash } = base;
  assert.match(permissionsProblems(noDash)[0], /exactly/);

  const one = withD([dash([w(), w({ id: 'b', tool: 'save', type: 'table' })])]);
  assert.deepEqual(texts(diffPermissions(base, one)), ['+ dashboard main ("Money"): list, save']);
  assert.equal(diffPermissions(one, withD([dash([w({ input: { all: true } }), w({ id: 'b', tool: 'save', type: 'table' })])])).widened, true);
  const relabelled = diffPermissions(one, withD([dash([w({ title: 'Open now' }), w({ id: 'b', tool: 'save', type: 'table' })])]));
  assert.equal(relabelled.widened, false);
  assert.equal(diffPermissions(one, base).widened, false);
  const first = diffPermissions(null, one).changes.map((c) => c.text);
  assert.ok(first.some((t) => t.startsWith('dashboard main ("Money"): open (stat) ← list')), first.join('\n'));
});
