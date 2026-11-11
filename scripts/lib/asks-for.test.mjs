import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFor, asksForLines, egressReadWarning, STORE_NOTE } from './asks-for.mjs';
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
