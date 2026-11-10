import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPermissions, diffPermissions, permissionsProblems, PERMISSION_KEYS } from './permissions.mjs';

const H = (c) => c.repeat(64);

// The CLI's shape (octi plugin permissions --json), Octipus bf9551be.
const base = {
  name: 'x', version: '1.0.0', apiVersion: '1.0.0', runtime: 'package',
  host: ['notes:read'], network: ['api.example.com'],
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
  const narrower = diffPermissions(base, t([{ name: 'list', effect: 'read' }, { name: 'save', effect: 'read' }]));
  assert.equal(narrower.widened, false);
  assert.equal(narrower.changes[0].change, 'narrower');
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
