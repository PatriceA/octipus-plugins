import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPermissions } from './permissions.mjs';

// The CLI's shape (octi plugin permissions --json).
const base = {
  name: 'x', version: '1.0.0', apiVersion: '1.0.0', runtime: 'package',
  host: ['notes:read'], network: ['api.example.com'],
  tools: [{ name: 'list', effect: 'read' }, { name: 'save', effect: 'write' }],
  effects: { read: 1, write: 1, external: 0 },
  contributions: { commands: [], schedules: [], events: [], prompt: false, context: false },
  pages: 0, trustedInput: false, maxProtection: 1,
};
const withP = (over) => ({ ...structuredClone(base), ...over });
const widening = (d) => d.changes.filter((c) => c.widens).map((c) => c.text);

test('a new plugin widens by definition and lists everything', () => {
  const d = diffPermissions(null, base);
  assert.equal(d.widened, true);
  assert.equal(d.firstVersion, true);
  assert.ok(d.changes.some((c) => c.text === 'host API scope notes:read'));
  assert.ok(d.changes.some((c) => c.text === 'network host api.example.com'));
  assert.ok(d.changes.some((c) => c.text === 'tool save (write)'));
});

test('the same permissions change nothing', () => {
  const d = diffPermissions(base, withP({ version: '1.1.0', effects: { read: 1, write: 1, external: 0 } }));
  assert.equal(d.widened, false);
  assert.deepEqual(d.changes, []);
});

test('new host scopes and network hosts widen; removing them does not', () => {
  assert.deepEqual(widening(diffPermissions(base, withP({ host: ['notes:read', 'web:read'] }))), ['host API scope web:read']);
  assert.deepEqual(widening(diffPermissions(base, withP({ network: ['api.example.com', '*.example.com'] }))), ['network host *.example.com']);
  const narrower = diffPermissions(base, withP({ host: [], network: [] }));
  assert.equal(narrower.widened, false);
  assert.equal(narrower.changes.length, 2);
});

test('a wider tool effect or a new tool widens; a narrower one does not', () => {
  assert.deepEqual(widening(diffPermissions(base, withP({ tools: [{ name: 'list', effect: 'external' }, { name: 'save', effect: 'write' }] }))), ['tool list: read → external']);
  assert.deepEqual(widening(diffPermissions(base, withP({ tools: [...base.tools, { name: 'send', effect: 'external' }] }))), ['tool send (external)']);
  const d = diffPermissions(base, withP({ tools: [{ name: 'list', effect: 'read' }, { name: 'save', effect: 'read' }] }));
  assert.equal(d.widened, false);
  assert.equal(d.changes[0].change, 'narrower');
});

test('contributions, pages, trustedInput, runtime and maxProtection', () => {
  const sched = { id: 'nightly', cron: '0 2 * * *', tool: 'list' };
  assert.deepEqual(widening(diffPermissions(base, withP({ contributions: { ...base.contributions, schedules: [sched] } }))), ['schedule nightly (0 2 * * * UTC) → list']);
  // A changed schedule is a new one.
  const was = withP({ contributions: { ...base.contributions, schedules: [sched] } });
  assert.equal(diffPermissions(was, withP({ contributions: { ...base.contributions, schedules: [{ ...sched, cron: '* * * * *' }] } })).widened, true);
  assert.equal(diffPermissions(base, withP({ contributions: { ...base.contributions, context: { tool: 'list' } } })).widened, true);
  assert.equal(diffPermissions(base, withP({ contributions: { ...base.contributions, prompt: { file: 'notes.md' } } })).widened, true);
  assert.deepEqual(widening(diffPermissions(base, withP({ pages: 2 }))), ['page page 1', 'page page 2']);
  assert.equal(diffPermissions(withP({ pages: 2 }), withP({ pages: 1 })).widened, false);
  assert.equal(diffPermissions(base, withP({ trustedInput: true })).widened, true);
  assert.equal(diffPermissions(withP({ trustedInput: true }), base).widened, false);
  assert.equal(diffPermissions(base, withP({ runtime: 'in-process' })).widened, true);
  assert.equal(diffPermissions(base, withP({ maxProtection: 3 })).widened, true);
  assert.equal(diffPermissions(base, withP({ maxProtection: null })).widened, false);
});

test('an apiVersion change is reported but does not widen', () => {
  const d = diffPermissions(base, withP({ apiVersion: '1.1.0' }));
  assert.equal(d.widened, false);
  assert.equal(d.changes[0].kind, 'apiVersion');
});
