// The pinned Octipus CLI for the tests: a clean clone of $OCTIPUS (default
// ../octipus) at OCTIPUS_REF, whose node_modules is a link to the source
// checkout's (ignored by Octipus's .gitignore, so the clone stays clean).
// The scripts refuse a checkout that is not exactly OCTIPUS_REF and clean,
// and the source checkout may have local work in progress: the clone never
// does. Import this module first; it sets process.env.OCTIPUS.
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { octipusRef, pinProblem, REPO_ROOT } from '../scripts/lib/octi.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function hasRef(dir, ref) {
  try { g(dir, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
}

/**
 * OCTIPUS_REF while it is not merged into PatriceA/octipus main yet
 * (bf9551be, on branch ccr-c3873536-snjite: `octi plugin sign-keys` and the
 * M3 permissions shape). scripts/sign.mjs refuses a CLI whose OCTIPUS_REF is
 * not an ancestor of origin/main, and so it should; in the tests' own clone
 * only, and only for this commit, the commit stands in for origin/main so
 * the publish flow can run end to end. Once the branch is merged and
 * OCTIPUS_REF moves to the merge, this is unused (and can go).
 */
export const UNMERGED_REF = 'bf9551befc179a4da647e963fafa330f02c3232f';

export function pinnedOctipus(ref = octipusRef()) {
  const src = resolve(process.env.OCTIPUS_SOURCE || process.env.OCTIPUS || join(REPO_ROOT, '..', 'octipus'));
  const dir = join(tmpdir(), `octipus-plugins-test-cli-${ref.slice(0, 16)}`);
  if (!existsSync(join(dir, '.git')) || pinProblem(dir, ref)) {
    rmSync(dir, { recursive: true, force: true });
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', src, tmp], { stdio: 'ignore' });
    g(tmp, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', ref);
    // origin/main, for the ancestry check of scripts/sign.mjs.
    const main = ['refs/remotes/origin/main', 'refs/heads/main'].find((r) => hasRef(src, r));
    if (main) g(tmp, 'fetch', '--quiet', src, `+${main}:refs/remotes/origin/main`);
    // Not merged yet (UNMERGED_REF): test-only, its own commit stands in
    // for origin/main so the ancestry check of sign.mjs passes.
    if (ref === UNMERGED_REF) {
      let merged = false;
      try { g(tmp, 'merge-base', '--is-ancestor', ref, 'refs/remotes/origin/main'); merged = true; } catch { /* not merged yet */ }
      if (!merged) g(tmp, 'update-ref', 'refs/remotes/origin/main', ref);
    }
    symlinkSync(join(src, 'node_modules'), join(tmp, 'node_modules'));
    renameSync(tmp, dir);
  }
  const problem = pinProblem(dir, ref);
  if (problem) throw new Error(`the test CLI clone is not pinned: ${problem}`);
  return dir;
}

process.env.OCTIPUS_SOURCE ??= resolve(process.env.OCTIPUS || join(REPO_ROOT, '..', 'octipus'));
process.env.OCTIPUS = pinnedOctipus();
delete process.env.OCTI_CLI;
