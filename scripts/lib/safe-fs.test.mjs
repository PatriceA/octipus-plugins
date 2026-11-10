// C1, H1: nothing is read or written through a link.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkRelPath, isSafeRelPath, readFileUnder, SafeDir, walkRegular } from './safe-fs.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'safe-fs-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('metadata paths: no .., nothing absolute, no backslash, no NUL or control', () => {
  for (const ok of ['a', 'a/b.png', 'screenshots/one.png', 'a..b']) assert.equal(checkRelPath(ok), ok);
  for (const bad of ['', '..', '../_headers', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b', 'a\nb', 'a//b', './a', 'a/', 'a/.']) assert.equal(isSafeRelPath(bad), false, JSON.stringify(bad));
});

test('reads refuse a link anywhere on the way, and anything not a regular file', () => {
  const root = join(tmp, 'r');
  mkdirSync(join(root, 'd'), { recursive: true });
  writeFileSync(join(tmp, 'secret'), 'gho_SECRET');
  writeFileSync(join(root, 'd', 'ok.txt'), 'fine');
  symlinkSync(join(tmp, 'secret'), join(root, 'README.md'));
  symlinkSync(join(tmp), join(root, 'up'));
  execFileSync('mkfifo', [join(root, 'fifo')]);
  assert.equal(readFileUnder(root, 'd/ok.txt', { encoding: 'utf8' }), 'fine');
  assert.throws(() => readFileUnder(root, 'README.md'), /symbolic link/);
  assert.throws(() => readFileUnder(root, 'up/secret'), /symbolic link/);
  assert.throws(() => readFileUnder(root, 'fifo'), /not a regular file/);
  assert.throws(() => readFileUnder(root, '../secret'), /\.\./);
  assert.throws(() => readFileUnder(root, 'd/ok.txt', { maxBytes: 2 }), /at most 2/);
  assert.equal(readFileUnder(root, 'missing', { optional: true }), null);
  assert.throws(() => walkRegular(root), /symbolic link|not a regular file/);
});

test('writes go only into directories this run created, exclusively, never through a link', () => {
  const out = SafeDir.temp('safe-fs-out-');
  out.write('a/b.txt', 'x');
  assert.throws(() => out.write('a/b.txt', 'y'), /EEXIST/);
  // A link planted where a file is to be written.
  const victim = join(tmp, 'victim');
  writeFileSync(victim, 'original');
  symlinkSync(victim, out.path('a/link'));
  assert.throws(() => out.write('a/link', 'pwned'));
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  // A directory someone else made is never adopted.
  mkdirSync(out.path('theirs'));
  assert.throws(() => out.write('theirs/x', 'y'), /not created by this run/);
  symlinkSync(tmp, out.path('linkdir'));
  assert.throws(() => out.write('linkdir/x', 'y'));
  assert.throws(() => SafeDir.create(out.root), /EEXIST/);
  // copyTree copies regular files only.
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'sub', 'f'), 'f');
  assert.equal(out.copyTree(src, '', 'copy'), 1);
  symlinkSync(victim, join(src, 'sub', 'l'));
  assert.throws(() => out.copyTree(src, '', 'copy2'), /symbolic link/);
  rmSync(out.root, { recursive: true, force: true });
});
