// The few git operations the scripts need.
//
// A tree is exported from git's objects (`git ls-tree` + `git cat-file
// --batch`), never with `git archive`/`tar` or from a checkout: no
// .gitattributes filter or export rule applies, and only regular files
// (modes 100644 and 100755) are written, each through a SafeDir. A symbolic
// link (mode 120000) or a submodule (mode 160000) anywhere in the tree stops
// everything (C1, H1).
import { execFileSync, spawnSync } from 'node:child_process';
import { checkRelPath, UnsafePathError } from './safe-fs.mjs';

export const COMMIT_RE = /^[0-9a-f]{40}$/;

export function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts }).trim();
}

export function headCommit(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

/** A full commit id, checked. */
export function checkCommit(sha, what = 'commit') {
  if (typeof sha !== 'string' || !COMMIT_RE.test(sha)) throw new Error(`${what}: ${JSON.stringify(sha)} is not a 40-hex commit id`);
  return sha;
}

/** Whether `ancestor` is an ancestor of (or equal to) `commit`. */
export function isAncestor(root, ancestor, commit) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: root, stdio: 'ignore' });
  return r.status === 0;
}

/** The file at `path` in `commit`, or null when the commit has none. */
export function showFile(root, commit, path) {
  checkCommit(commit);
  checkRelPath(path);
  const entries = lsTree(root, commit, [path]).filter((e) => e.path === path);
  if (entries.length === 0) return null;
  assertNoLinks(entries, `${path} at ${commit.slice(0, 12)}`);
  return catBlobs(root, [entries[0].sha])[0].toString('utf8');
}

/**
 * The entries of `commit`'s tree, recursively (`git ls-tree -r -z --full-tree`):
 * `[{ mode, type, sha, path }]`. Every path is checked with checkRelPath.
 */
export function lsTree(root, commit, paths = []) {
  checkCommit(commit);
  for (const p of paths) checkRelPath(p);
  const out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', commit, ...(paths.length ? ['--', ...paths] : [])], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  const entries = [];
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    entries.push({ mode, type, sha, path });
  }
  return entries;
}

/** Refuse links (120000), submodules (160000) and any mode but a regular file's; refuse unsafe paths. */
export function assertNoLinks(entries, where = 'the tree') {
  const bad = [];
  for (const e of entries) {
    if (e.mode === '120000') bad.push(`${e.path} is a symbolic link`);
    else if (e.mode === '160000' || e.type === 'commit') bad.push(`${e.path} is a submodule`);
    else if (e.mode !== '100644' && e.mode !== '100755') bad.push(`${e.path} has mode ${e.mode}`);
    else {
      try { checkRelPath(e.path); } catch (err) { bad.push(err.message); }
    }
  }
  if (bad.length) throw new UnsafePathError(`${where} has what this repository never accepts (no symbolic links, no submodules):\n${bad.map((b) => `  - ${b}`).join('\n')}`);
}

/** Refuse a commit whose whole tree has a link or a submodule anywhere. */
export function assertTreeClean(root, commit) {
  assertNoLinks(lsTree(root, commit), `commit ${commit.slice(0, 12)}`);
}

/** The bytes of each blob, in order (`git cat-file --batch`). */
export function catBlobs(root, shas) {
  if (shas.length === 0) return [];
  for (const s of shas) if (!/^[0-9a-f]{40,64}$/.test(s)) throw new Error(`not a blob id: ${s}`);
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: `${shas.join('\n')}\n`, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git cat-file failed: ${r.stderr.toString().trim()}`);
  const out = r.stdout;
  const blobs = [];
  let off = 0;
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, off);
    const head = out.subarray(off, nl).toString('utf8').split(' ');
    if (head[0] !== sha || head[1] !== 'blob') throw new Error(`git cat-file: expected blob ${sha}, got ${head.join(' ')}`);
    const size = Number(head[2]);
    blobs.push(out.subarray(nl + 1, nl + 1 + size));
    off = nl + 1 + size + 1;
  }
  return blobs;
}

/**
 * Write the regular files of `commit` under `prefix` (a directory in the
 * tree, or '' for all of it) into `safeDir` at `destRel`, with the prefix
 * stripped. Refuses the whole export on any link, submodule or unsafe path
 * in that part of the tree. Returns the number of files.
 */
export function exportTree(root, commit, safeDir, { prefix = '', destRel = '' } = {}) {
  if (prefix) checkRelPath(prefix);
  const entries = lsTree(root, commit, prefix ? [prefix] : []).filter((e) => !prefix || e.path.startsWith(`${prefix}/`));
  assertNoLinks(entries, `${prefix || 'the tree'} at ${commit.slice(0, 12)}`);
  const blobs = catBlobs(root, entries.map((e) => e.sha));
  safeDir.mkdir(destRel);
  entries.forEach((e, i) => {
    const rel = prefix ? e.path.slice(prefix.length + 1) : e.path;
    safeDir.write(destRel ? `${destRel}/${rel}` : rel, blobs[i], { mode: e.mode === '100755' ? 0o755 : 0o644 });
  });
  return entries.length;
}

/** Paths changed between `base` and `head` (`git diff --name-only base...head`), with renames split into both sides. */
export function changedPaths(root, base, head = 'HEAD') {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}
