// The few git operations the scripts need.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

export function headCommit(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

/**
 * Export the tree of `commit` (optionally only `paths`) into `dest`, exactly as
 * committed: what CI checks out, never ignored or untracked files of the
 * working tree.
 */
export function exportTree(root, commit, dest, paths = []) {
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', commit, ...(paths.length ? ['--', ...paths] : [])], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${archive.stderr.toString().trim()}`);
  const untar = spawnSync('tar', ['-x', '-f', '-', '-C', dest], { input: archive.stdout, maxBuffer: 16 * 1024 * 1024 });
  if (untar.status !== 0) throw new Error(`tar -x failed: ${untar.stderr.toString().trim()}`);
}
