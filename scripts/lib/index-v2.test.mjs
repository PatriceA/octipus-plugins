import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, isRevoked, serializeIndex } from './index-v2.mjs';

const perm = { name: 'w', version: '1.1.0', apiVersion: '1.0.0', runtime: 'package', host: ['tasks:read'], network: [], tools: [{ name: 't', effect: 'read' }], effects: { read: 1, write: 0, external: 0 }, contributions: { commands: [], schedules: [], events: [], prompt: false, context: false }, pages: 0, trustedInput: false, maxProtection: 1 };
const rec = (v, at) => ({ sha256: 'a'.repeat(64), contentHash: `sha256:${'b'.repeat(64)}`, permissions: { ...perm, version: v }, publishedAt: at, keyId: `ed25519:${'c'.repeat(64)}`, description: 'Weekly review', apiVersion: '1.0.0', minOctipus: '0.7.0' });

const published = { 'weekly-review': { '1.0.0': rec('1.0.0', '2026-11-01T00:00:00Z'), '1.1.0': rec('1.1.0', '2026-11-08T00:00:00Z') } };
const sources = { 'weekly-review': { listing: { title: 'Weekly review', summary: 'Review the week.', category: 'productivity', tags: ['tasks'], icon: 'icon.png', screenshots: ['s/1.png'], license: 'MIT', author: { name: 'Ada' } }, readme: '# Weekly', changelog: '## 1.1.0' } };
const revoked = { packages: [{ name: 'weekly-review', version: '1.0.0', reason: 'bug' }], keys: [{ keyId: `ed25519:${'d'.repeat(64)}`, reason: 'leaked' }] };

test('index v2: v1 fields, listing metadata, every version, absolute URLs, revocations', () => {
  const index = buildIndex({ published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z' });
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

test('the same inputs give the same bytes', () => {
  const args = { published, sources, revoked, generatedAt: '2026-11-10T12:00:00Z' };
  assert.equal(serializeIndex(buildIndex(args)), serializeIndex(buildIndex(structuredClone(args))));
  assert.ok(serializeIndex(buildIndex(args)).endsWith('}\n'));
});

test('an empty marketplace', () => {
  const index = buildIndex({ published: {}, sources: {}, revoked: { packages: [], keys: [] }, generatedAt: 'x' });
  assert.deepEqual(index.packages, []);
  assert.deepEqual(index.revoked, []);
});
