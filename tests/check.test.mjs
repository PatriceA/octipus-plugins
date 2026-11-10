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
  const r2 = await check(listing((l) => ({ ...l, title: 'Reader‮' })));
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
