// The whole publish flow, end to end, against the real Octipus CLI ($OCTIPUS,
// default ../octipus): a throwaway marketplace repository in a temp directory
// (with a bare origin), the reader fixture as its one plugin, a throwaway
// encrypted key pair and a backup, CI's build (scripts/build.mjs) for the
// build record, then publish. Then a second version, and the refusals.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from '../scripts/build.mjs';
import { cli, missingSubcommands, REPO_ROOT } from '../scripts/lib/octi.mjs';
import { publish } from '../scripts/publish.mjs';
import { assertCleanPages } from './helpers.mjs';

const missing = await missingSubcommands().catch((err) => [`(no CLI: ${err.message})`]);
const skip = missing.length ? `the Octipus CLI lacks ${missing.join(', ')}` : false;

const tmp = mkdtempSync(join(tmpdir(), 'octipus-publish-e2e-'));
const repo = join(tmp, 'repo');
const origin = join(tmp, 'origin.git');
const secrets = join(tmp, 'secrets');
const key = join(secrets, 'octipus.key');
const passFile = join(secrets, 'passphrase');
const quiet = () => {};
after(() => rmSync(tmp, { recursive: true, force: true }));

const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const commitAll = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); g('push', '-q', 'origin', 'main'); };
async function ciRecord(name = 'build-record.json') {
  const record = await build(repo, join(tmp, 'ci-build'));
  const file = join(tmp, name);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

before(async () => {
  if (skip) return;
  mkdirSync(secrets, { recursive: true });
  writeFileSync(passFile, 'correct horse battery staple\n', { mode: 0o600 });
  const k1 = await cli.keygen(join(secrets, 'octipus'), { passphrase: 'correct horse battery staple\n' });
  const k2 = await cli.keygen(join(secrets, 'octipus-backup'), { passphrase: 'another passphrase\n' });
  assert.equal(k1.code, 0);
  assert.equal(k2.code, 0);
  assert.match(readFileSync(key, 'utf8'), /BEGIN ENCRYPTED PRIVATE KEY/);

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('remote', 'add', 'origin', origin);
  mkdirSync(join(repo, 'keys'));
  cpSync(join(secrets, 'octipus.pub'), join(repo, 'keys', 'octipus.pub'));
  cpSync(join(secrets, 'octipus-backup.pub'), join(repo, 'keys', 'octipus-backup.pub'));
  for (const f of ['revoked.json', 'published.json', 'OCTIPUS_REF', '.gitignore']) cpSync(join(REPO_ROOT, f), join(repo, f));
  writeFileSync(join(repo, 'published.json'), '{}\n');
  cpSync(join(REPO_ROOT, 'plugins', '_template'), join(repo, 'plugins', '_template'), { recursive: true });
  cpSync(join(REPO_ROOT, 'tests', 'fixtures', 'plugins', 'reader'), join(repo, 'plugins', 'reader'), { recursive: true });
  commitAll('A marketplace with the reader fixture');
});

test('publishes a first version end to end', { skip }, async () => {
  const record = await ciRecord();
  const out = join(tmp, 'dist');
  const res = await publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: record, log: quiet });
  assert.deepEqual(res.newVersions, [{ name: 'reader', version: '1.0.0' }]);

  const tarball = join(out, 'dl', 'reader-1.0.0.tar.gz');
  assert.ok(existsSync(tarball));
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.equal(index.schema, 2);
  const entry = index.packages[0];
  assert.equal(entry.url, 'https://plugins.octipus.cc/dl/reader-1.0.0.tar.gz');
  assert.equal(entry.sha256, sha256(tarball));
  assert.equal(entry.publisher, 'Octipus');
  assert.equal(entry.minOctipus, '0.7.0');
  assert.equal(entry.permissions.runtime, 'package');
  assert.match(entry.keyId, /^ed25519:[0-9a-f]{64}$/);

  // The tarball carries its signature: unpack it and verify with the public key.
  const unpacked = join(tmp, 'unpacked');
  mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
  const pkg = join(unpacked, 'reader-1.0.0');
  assert.ok(existsSync(join(pkg, 'octipus-plugin.sig')));
  assert.ok(!existsSync(join(pkg, 'marketplace.json')), 'marketplace.json is not in the package');
  const v = await cli.verify(pkg, join(repo, 'keys', 'octipus.pub'));
  assert.equal(v.valid, true);
  assert.equal(v.contentHash, entry.contentHash);

  // The index signature verifies with the marketplace key, not with the backup alone.
  assert.ok(existsSync(join(out, 'index.json.sig')));
  assert.equal((await cli.verifyIndex(join(out, 'index.json'), [join(repo, 'keys', 'octipus.pub')])).valid, true);
  assert.equal((await cli.verifyIndex(join(out, 'index.json'), [join(repo, 'keys', 'octipus-backup.pub')])).valid, false);

  // published.json records it; nothing else in the worktree changed.
  const published = JSON.parse(readFileSync(join(repo, 'published.json'), 'utf8'));
  assert.equal(published.reader['1.0.0'].sha256, entry.sha256);
  assert.equal(published.reader['1.0.0'].contentHash, entry.contentHash);
  assert.ok(published.reader['1.0.0'].publishedAt);
  assert.deepEqual(published.reader['1.0.0'].permissions, entry.permissions);
  assert.equal(g('status', '--porcelain'), 'M published.json');

  // The site, with the plugin's page, its icon and the keys.
  assert.ok(existsSync(join(out, 'index.html')));
  assert.match(readFileSync(join(out, 'reader', 'index.html'), 'utf8'), /Reviewed and signed by Octipus/);
  assert.ok(existsSync(join(out, 'reader', 'icon.png')));
  assert.ok(existsSync(join(out, 'keys', 'octipus.pub')));
  assert.ok(existsSync(join(out, '_headers')));
  assert.ok(!existsSync(join(out, 'my-plugin')), 'the template is never published');
  assertCleanPages(assert, out);
  commitAll('Publish reader 1.0.0');
});

test('publishes a second version and rebuilds the first byte for byte', { skip }, async () => {
  const out = join(tmp, 'dist');
  const first = sha256(join(out, 'dl', 'reader-1.0.0.tar.gz'));
  const manifestFile = join(repo, 'plugins', 'reader', 'octipus-plugin.json');
  writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.0.0"', '"version": "1.1.0"'));
  writeFileSync(join(repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.1.0\n\n- Second version (fixture).\n\n## 1.0.0\n\n- First version (fixture).\n');
  commitAll('reader 1.1.0');
  const record = await ciRecord();
  const res = await publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: record, log: quiet });
  assert.deepEqual(res.newVersions, [{ name: 'reader', version: '1.1.0' }]);
  assert.equal(sha256(join(out, 'dl', 'reader-1.0.0.tar.gz')), first);
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.packages.map((p) => p.version), ['1.1.0', '1.0.0']);
  assert.match(readFileSync(join(out, 'reader', 'index.html'), 'utf8'), /Second version/);
  commitAll('Publish reader 1.1.0');
});

test('a dry run signs nothing and leaves published.json alone', { skip }, async () => {
  const manifestFile = join(repo, 'plugins', 'reader', 'octipus-plugin.json');
  writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.1.0"', '"version": "1.2.0"'));
  writeFileSync(join(repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Third.\n');
  commitAll('reader 1.2.0');
  const before = readFileSync(join(repo, 'published.json'), 'utf8');
  const out = join(tmp, 'dist-dry');
  const res = await publish({ root: repo, out, buildRecord: await ciRecord(), dryRun: true, log: quiet });
  assert.deepEqual(res.newVersions, [{ name: 'reader', version: '1.2.0' }]);
  assert.equal(readFileSync(join(repo, 'published.json'), 'utf8'), before);
  assert.ok(!existsSync(join(out, 'index.json.sig')));
  assert.ok(existsSync(join(out, 'dl', 'reader-1.2.0.tar.gz')));
  assert.equal(g('status', '--porcelain'), '');
});

test('refuses what it must refuse', { skip }, async () => {
  const out = join(tmp, 'dist-refused');
  const record = await ciRecord();
  // A build record that differs from the rebuilt tarball.
  const tampered = JSON.parse(readFileSync(record, 'utf8'));
  tampered.packages[0].sha256 = '0'.repeat(64);
  const bad = join(tmp, 'tampered.json');
  writeFileSync(bad, JSON.stringify(tampered));
  await assert.rejects(publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: bad, log: quiet }), /differs from what CI built/);
  // No build record, no gh, no --skip-ci-compare.
  await assert.rejects(publish({ root: repo, key, passphraseFile: passFile, out, log: quiet }), /gh/);
  // A key inside the repository.
  const inside = join(repo, 'octipus.key');
  cpSync(key, inside);
  await assert.rejects(publish({ root: repo, key: inside, passphraseFile: passFile, out, buildRecord: record, log: quiet }), /inside the repository/);
  rmSync(inside);
  // A dirty worktree.
  writeFileSync(join(repo, 'stray.txt'), 'x');
  await assert.rejects(publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: record, log: quiet }), /not clean/);
  rmSync(join(repo, 'stray.txt'));
  // Not on main.
  g('checkout', '-q', '-b', 'other');
  await assert.rejects(publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: record, log: quiet }), /on branch other/);
  g('checkout', '-q', 'main');
  // Behind origin.
  const clone = join(tmp, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone]);
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'ahead'], { cwd: clone });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: clone });
  await assert.rejects(publish({ root: repo, key, passphraseFile: passFile, out, buildRecord: record, log: quiet }), /is not origin\/main/);
  g('pull', '-q', '--ff-only', 'origin', 'main');
  // A wrong passphrase.
  const wrong = join(secrets, 'wrong');
  writeFileSync(wrong, 'nope\n');
  await assert.rejects(publish({ root: repo, key, passphraseFile: wrong, out, buildRecord: await ciRecord('rec2.json'), log: quiet }));
  assert.equal(g('status', '--porcelain'), '');
});

test('check.mjs passes the fixture and reports an unchanged published version', { skip }, () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check.mjs'), '--root', repo, '--plugin', 'reader', '--smoke', '--sandbox', 'auto', '--summary', join(tmp, 's.md'), '--result', join(tmp, 'r.json')], { encoding: 'utf8' });
  const result = JSON.parse(readFileSync(join(tmp, 'r.json'), 'utf8'));
  // 1.2.0 is not published (dry run): a new version over 1.1.0 with the same permissions.
  assert.equal(result.ok, true, r.stdout + r.stderr);
  assert.equal(result.widened, false);
  assert.match(readFileSync(join(tmp, 's.md'), 'utf8'), /unchanged since `1\.1\.0`/);
});
