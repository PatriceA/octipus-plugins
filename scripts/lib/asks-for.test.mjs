import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFor, asksForLines, CALENDAR_NOTE, DASHBOARD_NOTE, egressReadWarning, MAIL_DRAFT_NOTE, MAIL_READ_NOTE, MAIL_SEND_NOTE, STORE_NOTE } from './asks-for.mjs';
import { smallPermissions } from '../../tests/fixtures/permissions.mjs';

// The per-user store, in the words of Octipus's ask-summary and install consent.
test('what it asks for: the per-user store', () => {
  const p = smallPermissions({ host: ['store:read', 'store:write'], tools: [{ name: 'recall', effect: 'read' }, { name: 'remember', effect: 'write' }], store: { quotaBytes: 5 * 1024 * 1024 } });
  const s = asksFor(p).find((x) => x.id === 'store');
  assert.equal(s.lead, 'Keeps up to 5 MB of its own data per user');
  assert.deepEqual(s.items, [{ text: 'store: up to 5242880 bytes per user (store:read, store:write)' }]);
  assert.deepEqual(s.notes, [STORE_NOTE]);
  assert.ok(asksForLines(p).includes('Keeps up to 5 MB of its own data per user'));
  assert.equal(asksFor({ ...p, store: { quotaBytes: 10 * 1024 * 1024 } }).find((x) => x.id === 'store').lead, 'Keeps up to 10 MB of its own data per user');
  // No store, or a listing from before the store: no section.
  assert.equal(asksFor(smallPermissions({ store: null })).find((x) => x.id === 'store'), undefined);
  assert.equal(asksFor(smallPermissions()).find((x) => x.id === 'store'), undefined);
});

test('store:read reads back what the package stored: no egress warning for it', () => {
  assert.equal(egressReadWarning(['store:read', 'web:read']), '');
  assert.match(egressReadWarning(['notes:read', 'store:read', 'web:read']), /with web:read and notes:read together/);
});

// Mail and calendar (Octipus #498), in the words of Octipus's install consent.
test('mail and calendar: their notes; mail:send carries data out', () => {
  const p = smallPermissions({ host: ['calendar:read', 'mail:draft', 'mail:read', 'mail:send'], tools: [{ name: 'send', effect: 'external' }] });
  const notes = asksFor(p).find((x) => x.id === 'host').notes.map((n) => (typeof n === 'string' ? n : n.text));
  for (const note of [MAIL_READ_NOTE, MAIL_DRAFT_NOTE, MAIL_SEND_NOTE, CALENDAR_NOTE]) assert.ok(notes.includes(note), note.slice(0, 30));
  assert.match(egressReadWarning(['mail:read', 'mail:send']), /with mail:send and mail:read together/);
  assert.equal(egressReadWarning(['mail:draft', 'mail:read']), '');
});

// Dashboards (Octipus #501), in the words of Octipus's install consent.
test('dashboards: one item each, with every widget\'s tool and input', () => {
  const p = { ...smallPermissions(), dashboards: [{ id: 'main', title: 'Money', widgets: [{ id: 'open', type: 'stat', title: 'Open', tool: 't', input: { status: 'open' } }] }] };
  const s = asksFor(p).find((x) => x.id === 'dashboards');
  assert.equal(s.lead, 'dashboards: Money');
  assert.deepEqual(s.items, [{ text: 'Adds the dashboard "Money": Open (stat) ← t {"status":"open"}' }]);
  assert.deepEqual(s.notes, [DASHBOARD_NOTE]);
  assert.equal(asksFor(smallPermissions()).find((x) => x.id === 'dashboards'), undefined);
});
