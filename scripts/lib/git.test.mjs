// C1, H1: a link or a submodule anywhere in a commit stops everything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assertTreeClean, exportTree, headCommit, showFile } from './git.mjs';
import { SafeDir } from './safe-fs.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'git-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(tmp, 'repo');
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
mkdirSync(join(repo, 'plugins', 'a'), { recursive: true });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@e'); g('config', 'user.name', 't');
writeFileSync(join(repo, 'plugins', 'a', 'x.txt'), 'x');
writeFileSync(join(repo, 'plugins', 'a', 'run.sh'), '#!/bin/sh\n');
execFileSync('chmod', ['+x', join(repo, 'plugins', 'a', 'run.sh')]);
writeFileSync(join(repo, '.gitattributes'), '* text eol=crlf\nplugins/a/x.txt export-ignore\n');
g('add', '-A'); g('commit', '-q', '-m', 'one');
const clean = headCommit(repo);

test('exports regular files from git objects: no .gitattributes filter or export rule applies', () => {
  const out = SafeDir.temp('git-export-');
  exportTree(repo, clean, out, { prefix: 'plugins/a', destRel: 'p' });
  assert.equal(readFileSync(out.path('p/x.txt'), 'utf8'), 'x');
  assert.ok(lstatSync(out.path('p/run.sh')).mode & 0o100);
  assert.equal(showFile(repo, clean, 'plugins/a/x.txt'), 'x');
  rmSync(out.root, { recursive: true, force: true });
});

test('a symbolic link or a submodule anywhere in the tree is refused', () => {
  assertTreeClean(repo, clean);
  symlinkSync('/etc/passwd', join(repo, 'tests-link'));
  g('add', '-A'); g('commit', '-q', '-m', 'link');
  const linked = headCommit(repo);
  assert.throws(() => assertTreeClean(repo, linked), /tests-link is a symbolic link/);
  symlinkSync('/etc/passwd', join(repo, 'plugins', 'a', 'README.md'));
  g('add', '-A'); g('commit', '-q', '-m', 'link in plugin');
  const out = SafeDir.temp('git-export-');
  assert.throws(() => exportTree(repo, headCommit(repo), out, { prefix: 'plugins/a' }), /README\.md is a symbolic link/);
  rmSync(out.root, { recursive: true, force: true });
  g('rm', '-q', 'tests-link', 'plugins/a/README.md'); g('commit', '-q', '-m', 'unlink');
  g('update-index', '--add', '--cacheinfo', `160000,${clean},vendor/sub`);
  g('commit', '-q', '-m', 'submodule');
  assert.throws(() => assertTreeClean(repo, headCommit(repo)), /vendor\/sub is a submodule/);
});
