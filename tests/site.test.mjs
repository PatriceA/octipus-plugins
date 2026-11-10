// The site builds with an empty marketplace and with fixture data, and its
// pages carry no external scripts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildIndex, serializeIndex } from '../scripts/lib/index-v2.mjs';
import { assertCleanPages, buildSite } from './helpers.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-site-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fixture = join(import.meta.dirname, 'fixtures', 'plugins', 'reader');
// The CLI's permissions shape for the reader fixture (octi plugin permissions --json).
const permissions = {
  name: 'reader', version: '1.0.0', apiVersion: '1.0.0', runtime: 'package',
  host: ['model:complete', 'notes:write', 'tasks:write', 'web:read'], network: [],
  tools: [{ name: 'create_tasks', effect: 'write' }, { name: 'read_url', effect: 'read' }, { name: 'reader_action', effect: 'read' }, { name: 'save_note', effect: 'write' }],
  effects: { read: 2, write: 2, external: 0 },
  contributions: { commands: [{ name: 'read', tool: 'read_url', description: 'Read a page' }], schedules: [{ id: 'digest', cron: '0 7 * * 1', tool: 'reader_action' }], events: [], prompt: false, context: false },
  pages: 1, trustedInput: false, maxProtection: 1,
};
const rec = (version, publishedAt) => ({ sha256: 'ab'.repeat(32), contentHash: `sha256:${'cd'.repeat(32)}`, permissions: { ...permissions, version }, publishedAt, keyId: `ed25519:${'ef'.repeat(32)}`, description: 'Read a web page in a clean view.', apiVersion: '1.0.0', minOctipus: '0.7.0' });

test('an empty marketplace', () => {
  const out = join(tmp, 'empty');
  buildSite(out);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /No plugins yet\./);
  assert.match(home, /CONTRIBUTING\.md/);
  assert.match(home, /class="ocean-header"/);
  assert.match(home, /class="ocean-navigation"/);
  assert.match(home, /class="ocean-footer/);
  assert.match(home, /aria-current="page">Plugins/);
  assert.match(home, /fonts\.googleapis\.com\/css2\?family=Manrope:wght@400;500;600;700;800/);
  assert.ok(existsSync(join(out, 'publish', 'index.html')));
  assert.match(readFileSync(join(out, 'publish', 'index.html'), 'utf8'), /The review checklist/);
  assert.match(readFileSync(join(out, '_headers'), 'utf8'), /Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-/);
  assertCleanPages(assert, out);
});

test('with fixture data', () => {
  const out = join(tmp, 'fixture');
  const index = buildIndex({
    published: { reader: { '0.9.0': rec('0.9.0', '2026-10-01T00:00:00Z'), '1.0.0': rec('1.0.0', '2026-11-01T00:00:00Z') } },
    sources: { reader: { listing: JSON.parse(readFileSync(join(fixture, 'marketplace.json'), 'utf8')), readme: readFileSync(join(fixture, 'README.md'), 'utf8'), changelog: readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8') } },
    revoked: { packages: [{ name: 'reader', version: '0.9.0', reason: 'a test revocation' }], keys: [] },
    generatedAt: '2026-11-10T12:00:00Z',
  });
  const indexFile = join(tmp, 'index.json');
  writeFileSync(indexFile, serializeIndex(index));
  buildSite(out, indexFile);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /No plugins yet/);
  assert.match(home, /href="\/reader\/"/);
  assert.match(home, /data-search="reader \(test fixture\)/);
  const page = readFileSync(join(out, 'reader', 'index.html'), 'utf8');
  assert.match(page, /Reviewed and signed by Octipus/);
  assert.match(page, /ed25519:efef/);
  assert.match(page, /What it asks for/);
  assert.match(page, /host API: model:complete, notes:write, tasks:write, web:read/);
  assert.match(page, /Changes data in the connected system/);
  assert.match(page, /schedule digest 0 7 \* \* 1 \(UTC\) → reader_action \(read\), run as the installing admin, unattended/);
  assert.match(page, /command \/read → read_url \(read\), run as the user who types it/);
  assert.match(page, /pages: 1 page/);
  assert.match(page, /Install in Octipus/);
  assert.match(page, /octi plugin install reader/);
  assert.match(page, /revoked: a test revocation/);
  assert.match(page, /First version \(fixture\)/);
  assert.match(page, /Licence <strong>MIT<\/strong>/);
  assert.match(page, /<img src="\/reader\/icon.png" alt="The icon"/);
  assert.doesNotMatch(page, /example\.com\/tracker\.png/);
  assert.doesNotMatch(page, /<script>alert/);
  assertCleanPages(assert, out);
});
