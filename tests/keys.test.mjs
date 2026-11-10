// keys.json: built from keys/, signed by the root key, verified with the
// root keys only; versions only go up, revocations only grow (M5).
import './octipus.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildKeysDoc, signKeys } from '../scripts/keys.mjs';
import { fingerprint, verifyKeysJson } from '../scripts/sign.mjs';
import { makeMarket, PASS } from './market.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-keys-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let m;
before(async () => { m = await makeMarket(tmp); });

const root = () => readFileSync(m.rootPub, 'utf8');

test('keys.json verifies with the root key only, over its exact bytes', () => {
  const bytes = readFileSync(m.keysFile);
  const sig = readFileSync(`${m.keysFile}.sig`, 'utf8');
  const v = verifyKeysJson(bytes, sig, [root()]);
  assert.equal(v.doc.version, 1);
  assert.deepEqual(v.endorsed.map((k) => k.keyId), [fingerprint(readFileSync(join(m.secrets, 'signing.pub'), 'utf8')).keyId]);
  assert.throws(() => verifyKeysJson(Buffer.concat([bytes, Buffer.from(' ')]), sig, [root()]), /does not verify/);
  assert.throws(() => verifyKeysJson(bytes, sig, [readFileSync(join(m.secrets, 'signing.pub'), 'utf8')]), /none of the root keys/);
  const doc = JSON.parse(bytes);
  doc.signingKeys[0].notAfter = '2020-01-01T00:00:00Z';
  m.writeKeys(doc, join(tmp, 'expired.json'));
  assert.deepEqual(verifyKeysJson(readFileSync(join(tmp, 'expired.json')), readFileSync(join(tmp, 'expired.json.sig'), 'utf8'), [root()]).endorsed, []);
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

// TODO(octipus): when `octi plugin sign-keys` exists, this signs and verifies.
test('keys sign goes through the pinned CLI only, and stops while it has no sign-keys', async () => {
  const passFile = join(tmp, 'pass');
  writeFileSync(passFile, PASS);
  await assert.rejects(signKeys({ repo: m.repo, key: join(m.secrets, 'root.key'), passphrase: PASS, outDir: join(tmp, 'k1'), roots: [root()] }), /cannot sign keys\.json yet/);
  await assert.rejects(signKeys({ repo: m.repo, key: join(m.repo, 'keys', 'root', 'root.pub'), passphrase: PASS, outDir: join(tmp, 'k2'), roots: [root()] }), /inside the repository/);
});
