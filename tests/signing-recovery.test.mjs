import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireSigningLock, prepareSigningOutput } from '../scripts/sign.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-sign-recovery-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh signing creates its output directory', (t) => {
  const dir = fixture(t);
  assert.equal(prepareSigningOutput(dir), join(dir, 'signed'));
  assert.deepEqual(readdirSync(join(dir, 'signed')), ['dl']);
});

test('interrupted signing needs explicit retry and preserves earlier output', (t) => {
  const dir = fixture(t);
  const out = prepareSigningOutput(dir);
  writeFileSync(join(out, 'dl', 'partial.tar.gz'), 'partial signed package');
  assert.throws(() => prepareSigningOutput(dir), /incomplete.*--retry/);
  assert.equal(readFileSync(join(out, 'dl', 'partial.tar.gz'), 'utf8'), 'partial signed package');
  const logs = [];
  prepareSigningOutput(dir, { retry: true, log: (m) => logs.push(m) });
  const archive = readdirSync(dir).find((p) => p.startsWith('signing-recovery-'));
  assert.equal(readFileSync(join(dir, archive, 'signed', 'dl', 'partial.tar.gz'), 'utf8'), 'partial signed package');
  assert.deepEqual(readdirSync(join(out, 'dl')), []);
  assert.match(logs.join('\n'), /All verification and confirmations will run again/);
  prepareSigningOutput(dir, { retry: true, log: () => {} });
  assert.equal(readdirSync(dir).filter((p) => p.startsWith('signing-recovery-')).length, 2);
});

test('completed signing cannot be replaced, including with retry', (t) => {
  const dir = fixture(t);
  const out = prepareSigningOutput(dir);
  writeFileSync(join(out, 'signed.json'), 'completed receipt');
  for (const retry of [false, true]) {
    assert.throws(() => prepareSigningOutput(dir, { retry }), /already complete.*publish finish/);
  }
  assert.equal(readFileSync(join(out, 'signed.json'), 'utf8'), 'completed receipt');
  assert.deepEqual(readdirSync(dir), ['signed']);
});

test('symlink output is refused and never followed or moved', (t) => {
  const dir = fixture(t);
  const other = fixture(t);
  writeFileSync(join(other, 'keep'), 'untouched');
  symlinkSync(other, join(dir, 'signed'), 'dir');
  assert.throws(() => prepareSigningOutput(dir, { retry: true }), /not a regular directory/);
  assert.equal(readFileSync(join(other, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(readdirSync(dir), ['signed']);
});

test('a live signer blocks a concurrent retry; an exited signer does not', async (t) => {
  const dir = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireSigningLock} from ${JSON.stringify(new URL('../scripts/sign.mjs', import.meta.url).href)}; acquireSigningLock(process.argv[1]); console.log('locked'); setInterval(()=>{},1000);`, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  const out = prepareSigningOutput(dir);
  writeFileSync(join(out, 'partial'), 'keep');
  assert.throws(() => acquireSigningLock(dir), /Another signing process.*active/);
  assert.equal(readFileSync(join(out, 'partial'), 'utf8'), 'keep');
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  const logs = [];
  const release = acquireSigningLock(dir, { log: (m) => logs.push(m) });
  try {
    assert.match(logs.join('\n'), /Ignoring stale signing marker/);
    assert.throws(() => acquireSigningLock(dir), /Another signing process/);
    prepareSigningOutput(dir, { retry: true, log: () => {} });
  } finally { release(); }
  const again = acquireSigningLock(dir, { log: () => {} });
  again();
});
