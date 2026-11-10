#!/usr/bin/env node
// Run the changed plugins' own code in the sandbox: what CI's `test` job
// runs (from the base branch's copy of this script), apart from the `check`
// job, with a read-only token and no artifact: its only output is pass or
// fail and its log, never anything the report reads (H5).
//
//   node scripts/test-plugins.mjs [--repo <git dir>] [--base <rev>] [--head <rev>] [--plugin <name>…]
//
// For each changed plugin directory, exported from git (regular files only)
// into a temporary copy:
//   - its tests: `npm test --ignore-scripts` when its package.json has a
//     test script (no pre/post scripts, no install), in bwrap, no network;
//   - a smoke run of its server (`initialize`, `tools/list`), in bwrap, no network.
// There is no unsandboxed fallback: without a working bwrap it fails.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { changedPaths, checkCommit, exportTree, git } from './lib/git.mjs';
import { REPO_ROOT } from './lib/octi.mjs';
import { changedPluginDirs, MANIFEST, PLUGINS_DIR } from './lib/repo.mjs';
import { checkRelPath, readFileUnder, SafeDir } from './lib/safe-fs.mjs';
import { bwrapWorks, sandboxRun, smokeRun } from './lib/smoke.mjs';

/** Test one exported plugin directory; returns the problems (empty when it passed). */
export async function testPlugin(dir, { log = () => {} } = {}) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileUnder(dir, MANIFEST, { encoding: 'utf8', maxBytes: 256 * 1024 }));
  } catch (err) {
    return [`${MANIFEST}: ${err.message}`];
  }
  let pkg = null;
  try { pkg = JSON.parse(readFileUnder(dir, 'package.json', { encoding: 'utf8', optional: true, maxBytes: 256 * 1024 }) ?? 'null'); } catch (err) { problems.push(`package.json: ${err.message}`); }
  if (pkg?.scripts?.test) {
    log('  npm test (sandboxed, no network)');
    const r = await sandboxRun({ work: dir, writable: true, env: { npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: '/tmp/home/.npm' } }, 'npm', ['test', '--ignore-scripts', '--silent']);
    log(r.output.trim().split('\n').slice(-40).map((l) => `    ${l}`).join('\n'));
    if (r.code !== 0) problems.push(`npm test failed (${r.signal ?? `exit ${r.code}`})`);
  } else {
    log('  no test script');
  }
  if (manifest?.runtime !== 'in-process') {
    log('  smoke run (sandboxed, no network)');
    const s = await smokeRun(dir, manifest);
    if (!s.ok) {
      problems.push(`smoke run: ${s.error}`);
      log(s.stderr.trim().split('\n').slice(-20).map((l) => `    ${l}`).join('\n'));
    } else {
      const declared = Object.keys(manifest.tools ?? {});
      const missing = declared.filter((t) => !s.tools.includes(t));
      if (missing.length) problems.push(`smoke run: tools/list does not offer the declared ${missing.join(', ')}`);
      log(`    ${s.tools.length} tools listed`);
    }
  }
  return problems;
}

export async function testCommits({ repo, base, head, plugins: only, log = () => {} }) {
  if (!bwrapWorks()) throw new Error('bwrap cannot start a sandbox here: the plugins\' code never runs without one (install bubblewrap; on Ubuntu 24.04 allow unprivileged user namespaces)');
  const rev = (x) => checkCommit(git(repo, ['rev-parse', '--verify', '--quiet', `${x}^{commit}`]), x);
  const headSha = rev(head);
  const dirs = only?.length ? only : changedPluginDirs(changedPaths(repo, rev(base), headSha));
  const failed = [];
  for (const d of dirs) {
    checkRelPath(`${PLUGINS_DIR}/${d}`);
    log(`plugins/${d}`);
    const work = SafeDir.temp('octipus-test-');
    try {
      const n = exportTree(repo, headSha, work, { prefix: `${PLUGINS_DIR}/${d}`, destRel: 'p' });
      if (n === 0) { log('  removed'); continue; }
      const problems = await testPlugin(work.path('p'), { log });
      for (const p of problems) log(`  ✗ ${p}`);
      if (problems.length) failed.push(d);
    } catch (err) {
      log(`  ✗ ${err.message}`);
      failed.push(d);
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  }
  return { tested: dirs, failed };
}

async function main() {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, base: { type: 'string', default: 'origin/main' }, head: { type: 'string', default: 'HEAD' }, plugin: { type: 'string', multiple: true } } });
  const r = await testCommits({ repo: resolve(values.repo ?? REPO_ROOT), base: values.base, head: values.head, plugins: values.plugin, log: (m) => process.stdout.write(`${m}\n`) });
  process.stdout.write(r.failed.length ? `\nFailed: ${r.failed.join(', ')}\n` : `\nPassed: ${r.tested.length} plugin(s).\n`);
  process.exitCode = r.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`test-plugins: ${err.message}\n`); process.exit(2); });
}
