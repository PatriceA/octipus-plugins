// The per-user store end to end: a plugin that declares `store` (the memo
// fixture, `store: {}`) published through build, sign and finish, and its
// index entry carrying `store` exactly as `octi plugin permissions --json`
// prints it ({ quotaBytes: 5242880 }, right after `settings`).
//
// Only a CLI with the per-user store (Octipus 5b050a2f and later) knows the
// manifest's `store` and the store:read / store:write scopes: with an older
// OCTIPUS_REF this file is skipped, and it runs once OCTIPUS_REF moves past it.
import { pinnedOctipus } from './octipus.mjs';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { build } from '../scripts/build.mjs';
import { cli, REPO_ROOT } from '../scripts/lib/octi.mjs';
import { STORE_DEFAULT_QUOTA_BYTES, STORE_PERMISSION_KEYS, permissionsProblems } from '../scripts/lib/permissions.mjs';
import { validatePublished } from '../scripts/lib/records.mjs';
import { publishBuild, publishFinish } from '../scripts/publish.mjs';
import { sign } from '../scripts/sign.mjs';
import { makeMarket } from './market.mjs';

const hasStore = existsSync(join(pinnedOctipus(), 'src', 'plugins', 'packages', 'manifest-store.ts'));
const skip = hasStore ? false : 'the CLI at OCTIPUS_REF has no per-user store (Octipus 5b050a2f and later)';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-store-e2e-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};
let n = 0;
const fresh = (name) => join(tmp, `${name}-${n += 1}`);

test('a plugin with a per-user store publishes, and the index carries store as the CLI prints it', { skip }, async () => {
  const m = await makeMarket(tmp);
  cpSync(join(REPO_ROOT, 'tests', 'fixtures', 'plugins', 'memo'), join(m.repo, 'plugins', 'memo'), { recursive: true });
  m.commitAll('Add the memo fixture (a per-user store)');

  m.serveRecord(await build(m.repo, fresh('ci-build')));
  const b = await publishBuild({ root: m.repo, out: fresh('release'), keysFrom: m.keysFile, gh: m.gh, log: quiet, noPreviousIndex: true });
  await sign({ repo: m.repo, planFile: b.planFile, key: m.signingKey, rootPubs: [m.rootPub], passphraseFile: m.passFile, yes: true, keysFrom: m.keysFile, gh: m.gh, log: quiet, noPreviousIndex: true });
  const out = fresh('dist');
  const f = await publishFinish({ root: m.repo, planFile: b.planFile, out, log: quiet });
  assert.deepEqual(f.newVersions.map((v) => v.name).sort(), ['memo', 'reader']);

  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  const memo = index.packages.find((p) => p.name === 'memo');
  const printed = await cli.permissions(join(m.repo, 'plugins', 'memo'));
  // Byte for byte what the CLI prints: the host recomputes it and compares the whole object.
  assert.equal(JSON.stringify(memo.permissions), JSON.stringify(printed));
  assert.deepEqual(Object.keys(memo.permissions), STORE_PERMISSION_KEYS);
  assert.deepEqual(memo.permissions.store, { quotaBytes: STORE_DEFAULT_QUOTA_BYTES });
  assert.deepEqual(memo.permissions.host, ['store:read', 'store:write']);
  assert.deepEqual(permissionsProblems(memo.permissions), []);
  // A plugin without a store prints null.
  const reader = index.packages.find((p) => p.name === 'reader');
  assert.equal(reader.permissions.store, null);
  assert.equal(JSON.stringify(reader.permissions), JSON.stringify(await cli.permissions(join(m.repo, 'plugins', 'reader'))));

  // The host side accepts the index, and published.json keeps the same object.
  assert.equal((await cli.verifyIndex(join(out, 'index.json'), [join(m.secrets, 'signing.pub')])).valid, true);
  const published = validatePublished(JSON.parse(readFileSync(join(m.repo, 'published.json'), 'utf8')));
  assert.equal(JSON.stringify(published.memo['1.0.0'].permissions), JSON.stringify(printed));
});
