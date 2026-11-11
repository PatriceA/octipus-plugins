import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, isRevoked, serializeIndex } from './index-v2.mjs';
import { smallPermissions } from '../../tests/fixtures/permissions.mjs';

const perm = smallPermissions({ name: 'weekly-review', version: '1.1.0', host: ['tasks:read'] });
const rec = (v, at) => ({ sha256: 'a'.repeat(64), contentHash: `sha256:${'b'.repeat(64)}`, permissions: { ...perm, version: v }, publishedAt: at, keyId: `ed25519:${'c'.repeat(64)}`, description: 'Weekly review', apiVersion: '1.0.0', minOctipus: '0.7.0' });

const published = { 'weekly-review': { '1.0.0': rec('1.0.0', '2026-11-01T00:00:00Z'), '1.1.0': rec('1.1.0', '2026-11-08T00:00:00Z') } };
const sources = { 'weekly-review': { listing: { title: 'Weekly review', summary: 'Review the week.', category: 'productivity', tags: ['tasks'], icon: 'icon.png', screenshots: ['s/1.png'], license: 'MIT', author: { name: 'Ada' } }, readme: '# Weekly', changelog: '## 1.1.0' } };
const revoked = { packages: [{ name: 'weekly-review', version: '1.0.0', reason: 'bug' }], keys: [{ keyId: `ed25519:${'d'.repeat(64)}`, reason: 'leaked' }] };

test('index v2: v1 fields, listing metadata, every version, absolute URLs, revocations', () => {
  const index = buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  assert.equal(index.schema, 2);
  assert.equal(index.packages.length, 2);
  const [latest, older] = index.packages;
  assert.equal(latest.version, '1.1.0');
  for (const k of ['name', 'version', 'description', 'url', 'sha256']) assert.ok(latest[k], k);
  assert.equal(latest.url, 'https://plugins.octipus.cc/dl/weekly-review-1.1.0.tar.gz');
  assert.equal(latest.icon, 'https://plugins.octipus.cc/weekly-review/icon.png');
  assert.deepEqual(latest.screenshots, ['https://plugins.octipus.cc/weekly-review/s/1.png']);
  assert.equal(latest.publisher, 'Octipus');
  assert.equal(latest.minOctipus, '0.7.0');
  assert.equal(latest.apiVersion, '1.0.0');
  assert.deepEqual(latest.permissions, { ...perm, version: '1.1.0' });
  assert.equal(latest.readme, '# Weekly');
  assert.equal(older.readme, null);
  assert.equal(older.deprecated, null);
  assert.deepEqual(index.revoked, [{ name: 'weekly-review', version: '1.0.0', reason: 'bug' }, { keyId: `ed25519:${'d'.repeat(64)}`, reason: 'leaked' }]);
  assert.ok(isRevoked(index, 'weekly-review', '1.0.0'));
  assert.equal(isRevoked(index, 'weekly-review', '1.1.0'), null);
});

test('expires: required, after generatedAt, at most 45 days after it (review finding 7)', () => {
  const index = buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  assert.deepEqual(Object.keys(index).slice(0, 3), ['schema', 'generatedAt', 'expires']);
  assert.equal(index.expires, '2026-12-10T12:00:00Z');
  assert.throws(() => buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z' }), /after generatedAt/);
  assert.throws(() => buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-11-10T12:00:00Z' }), /after generatedAt/);
  assert.equal(buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-25T12:00:00Z' }).expires, '2026-12-25T12:00:00Z');
  assert.throws(() => buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-25T12:00:01Z' }), /more than 45 days/);
});

test('an entry whose permissions are not the CLI\'s exact object, or not its own, is refused', () => {
  const bad = (permissions) => () => buildIndex({ published: { 'weekly-review': { '1.1.0': { ...rec('1.1.0', '2026-11-08T00:00:00Z'), permissions } } }, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  assert.throws(bad({ ...perm, pages: 0 }), /old shape/);
  assert.throws(bad({ ...perm, version: '1.0.0' }), /permissions are for weekly-review 1\.0\.0/);
  assert.throws(bad({ ...perm, apiVersion: '2.0.0' }), /apiVersion 2\.0\.0/);
});

// The per-user store: the entry carries the CLI's object as it is, with
// `store` right after `settings`, a quota or null.
test('store: carried exactly as the CLI prints it, next to records without one', () => {
  const stored = smallPermissions({ name: 'weekly-review', version: '1.1.0', host: ['store:read', 'tasks:read'], store: { quotaBytes: 1048576 } });
  const pub = { 'weekly-review': { '1.0.0': rec('1.0.0', '2026-11-01T00:00:00Z'), '1.1.0': { ...rec('1.1.0', '2026-11-08T00:00:00Z'), permissions: stored } } };
  const index = buildIndex({ published: pub, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  const [latest, older] = index.packages;
  assert.equal(JSON.stringify(latest.permissions), JSON.stringify(stored));
  assert.deepEqual(Object.keys(latest.permissions).slice(5, 10), ['network', 'secrets', 'settings', 'store', 'tools']);
  assert.equal(older.permissions.store, null);
  const bad = (permissions) => () => buildIndex({ published: { 'weekly-review': { '1.1.0': { ...rec('1.1.0', '2026-11-08T00:00:00Z'), permissions } } }, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  assert.throws(bad({ ...stored, store: { quotaBytes: 20971521 } }), /permissions\.store/);
  assert.throws(bad({ ...stored, store: {} }), /permissions\.store/);
});

test('the same inputs give the same bytes', () => {
  const args = { published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' };
  assert.equal(serializeIndex(buildIndex(args)), serializeIndex(buildIndex(structuredClone(args))));
  assert.ok(serializeIndex(buildIndex(args)).endsWith('}\n'));
});

test('an empty marketplace', () => {
  const index = buildIndex({ published: {}, sources: {}, revoked: { packages: [], keys: [] }, generatedAt: '2026-11-10T12:00:00Z', expires: '2026-12-10T12:00:00Z' });
  assert.deepEqual(index.packages, []);
  assert.deepEqual(index.revoked, []);
});
