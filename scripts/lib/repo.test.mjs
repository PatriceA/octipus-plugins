import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedPluginDirs, isSkipped, latestPublished, withPublished } from './repo.mjs';

test('changed plugins from changed paths', () => {
  assert.deepEqual(changedPluginDirs(['README.md', 'plugins/a/server.mjs', 'plugins/a/ui/x.js', 'plugins/_template/README.md', 'plugins/b/marketplace.json', 'plugins']), ['_template', 'a', 'b']);
});

test('skipped directories', () => {
  assert.equal(isSkipped('_template'), true);
  assert.equal(isSkipped('.hidden'), true);
  assert.equal(isSkipped('reader'), false);
});

test('published.json updates', () => {
  const p = withPublished({}, 'b', '1.0.0', { sha256: '1' });
  const q = withPublished(withPublished(p, 'a', '0.1.0', { sha256: '2' }), 'b', '1.10.0', { sha256: '3' });
  const r = withPublished(q, 'b', '1.2.0', { sha256: '4' });
  assert.deepEqual(Object.keys(r), ['a', 'b']);
  assert.deepEqual(Object.keys(r.b), ['1.0.0', '1.2.0', '1.10.0']);
  assert.equal(latestPublished(r, 'b'), '1.10.0');
  assert.equal(latestPublished(r, 'c'), null);
  assert.deepEqual(p, { b: { '1.0.0': { sha256: '1' } } }, 'not mutated');
});
