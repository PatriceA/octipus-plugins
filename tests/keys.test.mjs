// keys.json: built from keys/, signed by the root key, verified with the
// root keys only; versions only go up, revocations only grow (M5).
import './octipus.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildKeysDoc, diffKeys, expiresDays, KEYS_EXPIRES_DAYS, keysSession, signKeysDoc } from '../scripts/keys.mjs';
import { checkKeysDoc, fingerprint, verifyKeysJson } from '../scripts/sign.mjs';
import { REPO_ROOT } from '../scripts/lib/octi.mjs';
import { makeMarket, PASS } from './market.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-keys-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let m;
before(async () => { m = await makeMarket(tmp); });

const root = () => readFileSync(m.rootPub, 'utf8');
/** The environment without npm's variables (keys.mjs refuses to run under npm). */
const nodeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_')));

test('keys.json, signed by octi plugin sign-keys, verifies with the root key only, over its exact bytes', async () => {
  const bytes = readFileSync(m.keysFile);
  const sig = readFileSync(`${m.keysFile}.sig`, 'utf8');
  const v = verifyKeysJson(bytes, sig, [root()]);
  assert.equal(v.doc.version, 1);
  assert.deepEqual(v.endorsed.map((k) => k.keyId), [fingerprint(readFileSync(join(m.secrets, 'signing.pub'), 'utf8')).keyId]);
  assert.throws(() => verifyKeysJson(Buffer.concat([bytes, Buffer.from(' ')]), sig, [root()]), /does not verify/);
  assert.throws(() => verifyKeysJson(bytes, sig, [readFileSync(join(m.secrets, 'signing.pub'), 'utf8')]), /none of the root keys/);
  const doc = JSON.parse(bytes);
  doc.signingKeys[0].notAfter = '2020-01-01T00:00:00Z';
  await m.writeKeys(doc, join(tmp, 'expired.json'));
  assert.deepEqual(verifyKeysJson(readFileSync(join(tmp, 'expired.json')), readFileSync(join(tmp, 'expired.json.sig'), 'utf8'), [root()]).endorsed, []);
});

// Review finding 7: Octipus requires `expires` on keys.json, at most 90 days after generatedAt.
test('keys.json expires 60 days after it is made, never more than 90; without expires, or expired, it is refused', async () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const doc = buildKeysDoc({ repo: m.repo, now });
  assert.deepEqual(Object.keys(doc), ['schema', 'version', 'generatedAt', 'expires', 'signingKeys', 'revokedKeys']);
  assert.equal(doc.expires, '2027-01-09T12:00:00Z');
  assert.equal(buildKeysDoc({ repo: m.repo, now, expiresInDays: 7 }).expires, '2026-11-17T12:00:00Z');
  assert.equal(buildKeysDoc({ repo: m.repo, now, expiresInDays: 90 }).expires, '2027-02-08T12:00:00Z');
  assert.throws(() => buildKeysDoc({ repo: m.repo, now, expiresInDays: 91 }), /over the 90 days/);
  assert.throws(() => buildKeysDoc({ repo: m.repo, now, expiresInDays: null }), /--expires-days/);
  assert.equal(expiresDays(undefined, KEYS_EXPIRES_DAYS), 60);
  assert.equal(expiresDays('30'), 30);
  for (const bad of ['0', '-1', '1.5', 'x']) assert.throws(() => expiresDays(bad), /--expires-days/);
  assert.throws(() => expiresDays('91'), /over the 90 days/);
  const file = await m.writeKeys(doc, join(tmp, 'expiring.json'));
  const bytes = readFileSync(file);
  const sig = readFileSync(`${file}.sig`, 'utf8');
  assert.equal(verifyKeysJson(bytes, sig, [root()], { now }).doc.expires, '2027-01-09T12:00:00Z');
  assert.throws(() => verifyKeysJson(bytes, sig, [root()], { now: new Date('2027-01-09T12:00:00Z') }), /expired at 2027-01-09T12:00:00Z/);
  // The previous keys.json is read whatever its age (new Date(0)), to chain the versions.
  assert.equal(verifyKeysJson(bytes, sig, [root()], { now: new Date(0) }).doc.version, 1);
  assert.throws(() => checkKeysDoc({ ...doc, expires: doc.generatedAt }), /after generatedAt/);
  assert.throws(() => checkKeysDoc({ ...doc, expires: '2027-05-09' }), /expires is required/);
  assert.throws(() => checkKeysDoc({ ...doc, expires: '2027-02-08T12:00:01Z' }), /more than 90 days/);
  const { expires: _, ...noExpires } = doc;
  assert.throws(() => checkKeysDoc(noExpires), /exactly schema, version, generatedAt, expires/);
  // --no-expires is gone.
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'keys.mjs'), 'build', '--first', '--no-expires', '--root-pub', m.rootPub, '--out', join(tmp, 'nx.json')], { encoding: 'utf8', env: nodeEnv() });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no-expires/);
});

test('versions go up, revocations are never dropped, a root key never signs packages', () => {
  const v1 = buildKeysDoc({ repo: m.repo });
  const signingId = v1.signingKeys[0].keyId;
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }], revokedKeys: [{ keyId: `ed25519:${'ab'.repeat(32)}`, reason: 'lost' }] }));
  const v2 = buildKeysDoc({ repo: m.repo, previous: v1 });
  assert.equal(v2.version, 2);
  assert.equal(v2.revokedKeys.length, 1);
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }], revokedKeys: [] }));
  assert.throws(() => buildKeysDoc({ repo: m.repo, previous: v2 }), /never undone/);
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }], revokedKeys: [{ keyId: signingId, reason: 'x' }] }));
  assert.throws(() => buildKeysDoc({ repo: m.repo }), /both a signing key and revoked/);
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: '../root/root.pub' }], revokedKeys: [] }));
  assert.throws(() => buildKeysDoc({ repo: m.repo }), /safe relative path/);
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }], revokedKeys: [] }));
});

test('keys.json is signed through the pinned CLI only, and never with a key inside the repository', async () => {
  const doc = buildKeysDoc({ repo: m.repo });
  const r = await signKeysDoc({ repo: m.repo, doc, key: join(m.secrets, 'root.key'), passphrase: PASS, outDir: join(tmp, 'k1'), roots: [root()] });
  assert.equal(r.doc.version, 1);
  await assert.rejects(signKeysDoc({ repo: m.repo, doc, key: join(m.repo, 'keys', 'root', 'root.pub'), passphrase: PASS, outDir: join(tmp, 'k2'), roots: [root()] }), /inside the repository/);
  await assert.rejects(signKeysDoc({ repo: m.repo, doc, key: join(m.secrets, 'root.key'), passphrase: PASS, outDir: join(tmp, 'k3'), roots: [root()], env: { ...process.env, OCTI_CLI: 'octi plugin' } }), /OCTI_CLI is set/);
});

test('keys sign with a CLI that has sign-keys: the signature verifies, the wrong root does not', async () => {
  const doc = buildKeysDoc({ repo: m.repo });
  const file = await m.writeKeys(doc, join(tmp, 'again.json'));
  const v = verifyKeysJson(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), [root()]);
  assert.equal(v.doc.version, doc.version);
  assert.throws(() => verifyKeysJson(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), [readFileSync(join(m.secrets, 'rogue.pub'), 'utf8')]), /none of the root keys/);
});

// Review finding 6: the root key session shows what changes against the
// published keys.json, has each added key id typed, takes the root keys
// only from outside the repository, and runs only from a clean main equal to
// origin/main, with the pinned CLI and an encrypted root key.
test('finding 6: keys sign shows the diff, has each added key id typed, and refuses what it cannot trust', async () => {
  const saved = m.g('rev-parse', 'HEAD');
  const prevFile = m.keysFile; // v1: signing.pub
  const prevDoc = JSON.parse(readFileSync(prevFile, 'utf8'));
  cpSync(join(m.secrets, 'rogue.pub'), join(m.repo, 'keys', 'signing', 'second.pub'));
  writeFileSync(join(m.repo, 'keys', 'endorsements.json'), JSON.stringify({ signingKeys: [{ file: 'signing/signing.pub' }, { file: 'signing/second.pub', notAfter: '2027-12-31T00:00:00Z' }], revokedKeys: [{ keyId: `ed25519:${'ab'.repeat(32)}`, reason: 'lost laptop' }] }, null, 2));
  m.commitAll('Endorse a second signing key');
  const added = fingerprint(readFileSync(join(m.secrets, 'rogue.pub'), 'utf8')).keyId;
  let n = 0;
  const session = (over = {}) => {
    const logs = [];
    const prompts = [];
    const answers = over.answers ?? [added, 'sign keys.json v2'];
    const p = keysSession({
      repo: m.repo, rootPubs: [m.rootPub], key: join(m.secrets, 'root.key'), previous: prevFile, passphrase: PASS, outDir: join(tmp, `session-${n += 1}`),
      ask: async (q) => { prompts.push(q); return answers.shift() ?? ''; }, log: (x) => logs.push(x), ...over,
    });
    return { p, logs, prompts };
  };
  try {
    // The diff, against the published keys.json.
    const d = diffKeys(prevDoc, buildKeysDoc({ repo: m.repo, previous: prevDoc }));
    assert.deepEqual(d.added.map((k) => k.keyId), [added]);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.revoked.map((r) => r.reason), ['lost laptop']);

    // The root keys come from --root-pub, outside the repository; never keys/root/.
    await assert.rejects(session({ rootPubs: [] }).p, /--root-pub <file> is required/);
    await assert.rejects(session({ rootPubs: [join(m.repo, 'keys', 'root', 'root.pub')] }).p, /--root-pub .* is inside the repository/);
    // Each added key id is typed.
    // Change the last hex digit (never to itself: a random id can already end in 0).
    const mistyped = added.slice(0, -1) + (added.endsWith('0') ? '1' : '0');
    assert.notEqual(mistyped, added);
    const wrong = session({ answers: [mistyped, 'sign keys.json v2'] });
    await assert.rejects(wrong.p, /not confirmed: .* is not ed25519:/);
    assert.match(wrong.logs.join('\n'), new RegExp(`Signing keys ADDED \\(1\\):\\n  \\+ ${added} \\(keys/signing/second\\.pub\\), notAfter 2027-12-31T00:00:00Z`));
    assert.match(wrong.logs.join('\n'), /Signing keys REMOVED \(0\)/);
    assert.match(wrong.logs.join('\n'), /Revocations ADDED \(1\):\n  ! ed25519:(ab){32}: lost laptop/);
    assert.match(wrong.logs.join('\n'), /keys\.json v1 \(the published one\) → v2/);
    await assert.rejects(session({ answers: [added, 'yes'] }).p, /not confirmed: keys\.json is not signed/);
    // The pinned CLI, exactly as sign.mjs.
    await assert.rejects(session({ env: { ...process.env, OCTI_CLI: 'octi plugin' } }).p, /OCTI_CLI is set/);
    // An encrypted root key only.
    const { privateKey } = generateKeyPairSync('ed25519');
    const plain = join(m.secrets, 'plain.key');
    writeFileSync(plain, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await assert.rejects(session({ key: plain }).p, /not an encrypted key/);
    // A clean main at origin/main.
    writeFileSync(join(m.repo, 'keys', 'signing', 'third.pub'), readFileSync(join(m.secrets, 'signing.pub')));
    await assert.rejects(session().p, /is not clean/);
    rmSync(join(m.repo, 'keys', 'signing', 'third.pub'));
    m.g('commit', '-q', '--allow-empty', '-m', 'not pushed');
    await assert.rejects(session().p, /is not origin\/main/);
    m.g('reset', '-q', '--hard', 'HEAD~1');
    assert.equal(readdirSync(tmp).filter((x) => x.startsWith('session-')).length, 0, 'nothing was signed');

    // Typed and confirmed: signed, and it verifies with the root key.
    const ok = session();
    const r = await ok.p;
    assert.deepEqual(ok.prompts, ['Endorse keys/signing/second.pub? Type its key id: ', 'Type "sign keys.json v2": ']);
    assert.equal(r.doc.version, 2);
    const v = verifyKeysJson(readFileSync(r.file), readFileSync(`${r.file}.sig`, 'utf8'), [root()]);
    assert.deepEqual(v.endorsed.map((k) => k.keyId).sort(), [...prevDoc.signingKeys.map((k) => k.keyId), added].sort());
  } finally {
    m.g('reset', '-q', '--hard', saved);
    m.g('push', '-q', '-f', 'origin', 'main');
  }
});

test('finding 6: keys.mjs is a built-ins-only script that refuses npm and never defaults the root keys', () => {
  const text = readFileSync(join(REPO_ROOT, 'scripts', 'keys.mjs'), 'utf8');
  for (const im of text.matchAll(/^import [\s\S]*? from '([^']+)';$/gm)) assert.match(im[1], /^(node:|\.\/sign\.mjs$)/, im[1]);
  const run = (args, env = nodeEnv()) => spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'keys.mjs'), ...args], { encoding: 'utf8', env, cwd: tmp });
  assert.match(run(['verify', m.keysFile]).stderr, /--root-pub <file> is required/);
  assert.match(run(['verify', m.keysFile, '--root-pub', join(REPO_ROOT, 'package.json')]).stderr, /inside the repository/);
  assert.match(run(['verify', m.keysFile, '--root-pub', m.rootPub]).stdout, /v1, signed by root ed25519:/);
  assert.match(run(['verify', m.keysFile, '--root-pub', m.rootPub], { ...nodeEnv(), npm_lifecycle_event: 'keys' }).stderr, /run this with node, not through npm/);
  assert.match(run(['sign', '--first', '--root-pub', m.rootPub, '--key', join(m.secrets, 'root.key'), '--passphrase-file', '-']).stderr, /the confirmations need the terminal/);
  assert.ok(!JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts.keys, 'no npm script for keys.mjs');
});
