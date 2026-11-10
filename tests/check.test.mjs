// The PR gate's data checks (scripts/check.mjs) on a throwaway repository:
// the base is `main`, each case a branch on top of it.
import './octipus.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkCommits } from '../scripts/check.mjs';
import { makeMarket } from './market.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-check-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let m;
let base;
let i = 0;
before(async () => {
  m = await makeMarket(tmp);
  base = m.g('rev-parse', 'HEAD');
});

/** Make a branch from main with `change()` applied and committed; return the check result. */
async function check(change, opts = {}) {
  m.g('checkout', '-q', '-B', `case-${i += 1}`, base);
  change(m.repo);
  m.g('add', '-A');
  m.g('commit', '-q', '--allow-empty', '-m', 'case');
  try {
    return await checkCommits({ repo: m.repo, base, head: 'HEAD', indexFrom: join(tmp, 'no-index.json'), keysFrom: m.keysFile, ...opts });
  } finally {
    m.g('checkout', '-q', 'main');
  }
}
const edit = (file, fn) => (r) => writeFileSync(join(r, file), fn(readFileSync(join(r, file), 'utf8')));
const listing = (fn) => edit('plugins/reader/marketplace.json', (t) => JSON.stringify(fn(JSON.parse(t))));

test('a new plugin passes and is reported as new; nothing outside plugins/', async () => {
  const r = await check(edit('plugins/reader/README.md', (t) => `${t}\nMore.\n`));
  assert.equal(r.ok, true, JSON.stringify(r.plugins[0]?.errors ?? r.problems));
  assert.deepEqual(r.outside, []);
  assert.equal(r.plugins[0].firstVersion, true);
  assert.equal(r.widened, true);
});

// M1, reproduced by the review: a directory with only a legacy plugin.json;
// `octi plugin validate` imported its index.mjs, which ran.
test('M1: a legacy plugin is refused before validate runs any of its code', async () => {
  const pwned = join(tmp, 'PWNED');
  process.env.PWNED_FILE = pwned;
  try {
    const r = await check((root) => {
      mkdirSync(join(root, 'plugins', 'evil'));
      writeFileSync(join(root, 'plugins', 'evil', 'index.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.PWNED_FILE, "ran at validate\\n"); export default {name:"evil",tools:{}};');
      writeFileSync(join(root, 'plugins', 'evil', 'plugin.json'), '{"name":"evil","version":"1.0.0","apiVersion":"1.0.0","main":"index.mjs","description":"x","tools":[]}');
    });
    assert.equal(r.ok, false);
    assert.match(r.plugins[0].errors.join('\n'), /legacy plugin/);
    assert.ok(!existsSync(pwned), 'the plugin\'s code ran');
  } finally {
    delete process.env.PWNED_FILE;
  }
});

test('C1, H1: a symlink anywhere in the pull request fails it', async () => {
  const r = await check((root) => {
    mkdirSync(join(root, 'tests', 'fixtures', 'x'), { recursive: true });
    symlinkSync('/etc/passwd', join(root, 'tests', 'fixtures', 'x', 'octipus-plugin.sig'));
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /octipus-plugin\.sig is a symbolic link/);
  assert.deepEqual(r.outside, ['tests/fixtures/x/octipus-plugin.sig']);
  const r2 = await check((root) => { rmSync(join(root, 'plugins/reader/README.md')); symlinkSync('/etc/hostname', join(root, 'plugins/reader/README.md')); });
  assert.equal(r2.ok, false);
  assert.match(r2.plugins[0].errors.join('\n'), /README\.md is a symbolic link/);
});

test('H2, L5: listing paths, invisible characters and size caps', async () => {
  const r = await check(listing((l) => ({ ...l, screenshots: ['../_headers'] })));
  assert.match(r.plugins[0].errors.join('\n'), /marketplace\.json/);
  const r2 = await check(listing((l) => ({ ...l, title: 'Reader\u202E' })));
  assert.match(r2.plugins[0].errors.join('\n'), /bidi/);
  const r3 = await check(edit('plugins/reader/README.md', (t) => t + 'x'.repeat(70 * 1024)));
  assert.match(r3.plugins[0].errors.join('\n'), /README\.md is \d+ bytes; at most 65536/);
});

test('L6, L7: names and versions', async () => {
  const r = await check(edit('plugins/reader/octipus-plugin.json', (t) => t.replace('"version": "1.0.0"', '"version": "1.0.0+x"')));
  assert.match(r.plugins[0].errors.join('\n'), /build metadata/);
});

test('H4, M4: published.json and revoked.json are append-only; a PR cannot add a record the signed index lacks', async () => {
  const r = await check(edit('revoked.json', () => JSON.stringify({ packages: [{ name: 'reader', version: '1.0.0', reason: 'x' }], keys: [] })));
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.outside, ['revoked.json']);
  assert.equal(r.needsMaintainer, true);
  // A record a pull request adds: checked against the live signed index, which is not there here.
  const rec = { sha256: 'cd'.repeat(32) };
  const r2 = await check(edit('published.json', () => JSON.stringify({ reader: { '1.0.0': rec } })));
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join('\n'), /published\.json/);
});

test('H5: every path outside plugins/<name>/ is listed', async () => {
  const r = await check((root) => {
    writeFileSync(join(root, 'OCTIPUS_REF'), `${'0'.repeat(40)}\n`);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'check.mjs'), '');
    writeFileSync(join(root, 'plugins', '_template', 'README.md'), 'x');
  });
  assert.deepEqual(r.outside.sort(), ['OCTIPUS_REF', 'plugins/_template/README.md', 'scripts/check.mjs']);
  assert.equal(r.needsMaintainer, true);
});

// M3: the diff reads what each contribution and page is bound to (the
// CLI's permissions), so a change that asks for nothing new is not a
// widening, and a change of the page files is.
test('M3: against a published version, only what asks for more widens', async () => {
  const { cli } = await import('../scripts/lib/octi.mjs');
  const { serializeSignature } = await import('../scripts/lib/records.mjs');
  m.g('checkout', '-q', '-B', 'published-base', base);
  const keyId = `ed25519:${'ab'.repeat(32)}`;
  const record = {
    sha256: 'cd'.repeat(32), contentHash: (await cli.hash(join(m.repo, 'plugins', 'reader'))).contentHash, permissions: await cli.permissions(join(m.repo, 'plugins', 'reader')),
    publishedAt: '2026-11-01T00:00:00Z', keyId, signatureFile: serializeSignature({ alg: 'ed25519', keyId, signature: `${'A'.repeat(86)}==` }),
    commit: base, dir: 'reader', description: 'Reads.', apiVersion: '1.0.0', minOctipus: null,
    listing: JSON.parse(readFileSync(join(m.repo, 'plugins', 'reader', 'marketplace.json'), 'utf8')),
  };
  writeFileSync(join(m.repo, 'published.json'), `${JSON.stringify({ reader: { '1.0.0': record } }, null, 2)}\n`);
  m.g('add', '-A');
  m.g('commit', '-q', '-m', 'reader 1.0.0 published');
  const pubBase = m.g('rev-parse', 'HEAD');
  const bump = (root) => edit('plugins/reader/octipus-plugin.json', (t) => t.replace('"version": "1.0.0"', '"version": "1.0.1"'))(root);
  const at = async (change) => {
    m.g('checkout', '-q', '-B', `case-${i += 1}`, pubBase);
    change(m.repo);
    m.g('add', '-A');
    m.g('commit', '-q', '-m', 'case');
    try {
      return (await checkCommits({ repo: m.repo, base: pubBase, head: 'HEAD', indexFrom: join(tmp, 'no-index.json'), keysFrom: m.keysFile })).plugins.find((p) => p.name === 'reader');
    } finally {
      m.g('checkout', '-q', 'main');
    }
  };
  const same = await at((root) => { bump(root); edit('plugins/reader/README.md', (t) => `${t}\nMore.\n`)(root); });
  assert.equal(same.publishedVersion, '1.0.0');
  assert.equal(same.widened, false, JSON.stringify(same.changes));
  assert.deepEqual(same.changes, []);
  const ui = await at((root) => { bump(root); edit('plugins/reader/ui/app.js', (t) => `${t}\n// changed\n`)(root); });
  assert.equal(ui.widened, true);
  assert.deepEqual(ui.changes, [{ change: 'changed', text: 'page files (ui/)', widens: true }]);
  const page = await at((root) => { bump(root); edit('plugins/reader/octipus-plugin.json', (t) => t.replace('"title": "Reader", "icon"', '"title": "Read it", "icon"'))(root); });
  assert.deepEqual(page.changes, [{ change: 'changed', text: 'page read: "Reader" index.html → "Read it" index.html', widens: true }]);
});
