#!/usr/bin/env node
// Check plugin submissions: what CI runs on every pull request, and what an
// author or the key holder can run locally.
//
//   node scripts/check.mjs [--all | --base <git-ref> | --plugin <name>…]
//                          [--smoke] [--sandbox auto|required|off] [--no-tests]
//                          [--summary check-summary.md] [--result check-result.json]
//
// For each plugin it checks (docs/plans/marketplace.md, CI):
//   - `octi plugin validate`, the marketplace.json schema, README.md and CHANGELOG.md;
//   - its own tests (`npm test` in its directory, when it has a test script);
//   - a smoke run of its server (`initialize`, `tools/list`), under bwrap when --smoke;
//   - the host's install limits (files, bytes, tarball size);
//   - no `runtime: in-process`;
//   - a version greater than the published one (published.json);
//   - the permissions diff against the published version.
// It writes a Markdown summary (the PR comment) and a JSON result, and exits
// 1 when any plugin has a problem.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkListing, LISTING_FILE, listingImages, unknownLicenses } from './lib/listing.mjs';
import { cli, octipusRef, REPO_ROOT } from './lib/octi.mjs';
import { diffPermissions } from './lib/permissions.mjs';
import { changedPluginDirs, gitChangedPaths, isSkipped, latestPublished, LIMITS, MANIFEST, measureTree, pluginDirs, PLUGINS_DIR, readPublished, RESERVED_NAMES } from './lib/repo.mjs';
import { compareSemver, isSemver } from './lib/semver.mjs';
import { chooseSandbox, smokeRun } from './lib/smoke.mjs';
import { renderSummary } from './lib/summary.mjs';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** Whether CHANGELOG.md has a heading naming `version` (`## 1.2.0`, `## [1.2.0] - 2026-11-10`). */
export function changelogHasVersion(text, version) {
  const v = version.replace(/[.+]/g, (c) => `\\${c}`);
  return new RegExp(`^#{1,6}\\s+\\[?v?${v}\\]?(\\s|$)`, 'm').test(text);
}

/** Run one plugin's own tests: `npm test` when its package.json has a test script. */
function runTests(dir) {
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) return { status: 'none' };
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch (err) { return { status: 'failed', detail: `package.json: ${err.message}` }; }
  if (!pkg?.scripts?.test) return { status: 'none' };
  const r = spawnSync('npm', ['test', '--silent'], { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, CI: 'true' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
  if (r.status === 0) return { status: 'passed' };
  return { status: 'failed', detail: r.error ? r.error.message : `exit ${r.status}`, output: out };
}

/**
 * Check the plugin in `plugins/<dirName>`.
 * @returns the result object renderSummary takes.
 */
export async function checkPlugin(root, dirName, { published, smoke = false, sandboxMode = 'plain', tests = true, log = () => {} } = {}) {
  const dir = join(root, PLUGINS_DIR, dirName);
  const template = isSkipped(dirName);
  const r = { dir: `${PLUGINS_DIR}/${dirName}`, name: null, version: null, publishedVersion: null, template, errors: [], warnings: [], steps: [], permissions: null, diff: null };
  const step = (name, status, detail) => r.steps.push({ name, status, ...(detail ? { detail } : {}) });

  if (!existsSync(dir)) {
    r.warnings.push(`${r.dir} was removed. Its published versions stay in the index; to withdraw them, list them in revoked.json.`);
    return r;
  }

  // The manifest, read only for its name, version and server (the CLI validates it).
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
    r.name = typeof manifest.name === 'string' ? manifest.name : null;
    r.version = typeof manifest.version === 'string' ? manifest.version : null;
  } catch (err) {
    r.errors.push(`${MANIFEST}: ${err.code === 'ENOENT' ? 'missing' : err.message}`);
  }
  if (r.name && !template) {
    if (r.name !== dirName) r.errors.push(`the directory is plugins/${dirName} but the manifest names "${r.name}": they must match`);
    if (RESERVED_NAMES.has(r.name)) r.errors.push(`"${r.name}" is reserved on plugins.octipus.cc; choose another name`);
  }
  if (r.version && !isSemver(r.version)) r.errors.push(`version "${r.version}" is not a semantic version`);
  if (existsSync(join(dir, 'octipus-plugin.sig'))) r.errors.push('octipus-plugin.sig is committed: a submission carries no signature (the key holder signs on publishing); remove it');

  // 1. The contract, by Octipus's own validator.
  try {
    const v = await cli.validate(dir);
    for (const p of v.problems ?? []) r.errors.push(`validate: ${typeof p === 'string' ? p : p.message ?? JSON.stringify(p)}`);
    for (const w of v.warnings ?? []) r.warnings.push(`validate: ${typeof w === 'string' ? w : w.message ?? JSON.stringify(w)}`);
    step('octi plugin validate', v.ok ? 'passed' : 'failed');
  } catch (err) {
    r.errors.push(`octi plugin validate: ${err.message}`);
    step('octi plugin validate', 'error');
  }

  // 2. The listing, README and CHANGELOG.
  const listingText = readText(join(dir, LISTING_FILE));
  if (listingText === null) {
    r.errors.push(`${LISTING_FILE} is missing (see plugins/_template/${LISTING_FILE})`);
    step('marketplace.json', 'missing');
  } else {
    let listing = null;
    try { listing = JSON.parse(listingText); } catch (err) { r.errors.push(`${LISTING_FILE}: ${err.message}`); }
    if (listing) {
      const problems = checkListing(listing);
      for (const p of problems) r.errors.push(`${LISTING_FILE}: ${p}`);
      for (const id of unknownLicenses(listing.license)) r.warnings.push(`licence ${id} is not on the list of known open source licences: the reviewer checks it`);
      for (const [i, img] of listingImages(listing).entries()) {
        const file = join(dir, img);
        if (!existsSync(file)) { r.errors.push(`${LISTING_FILE}: ${img} does not exist in the plugin directory`); continue; }
        const limit = i === 0 && listing.icon ? LIMITS.iconBytes : LIMITS.screenshotBytes;
        const size = statSync(file).size;
        if (size > limit) r.errors.push(`${img} is ${Math.ceil(size / 1024)} KB; at most ${limit / 1024} KB`);
      }
      step('marketplace.json', problems.length ? 'failed' : 'passed');
    }
  }
  const readme = readText(join(dir, 'README.md'));
  if (!readme || !readme.trim()) r.errors.push('README.md is missing or empty: say what it does, how to set it up and the secrets it needs');
  const changelog = readText(join(dir, 'CHANGELOG.md'));
  if (!changelog || !changelog.trim()) r.errors.push('CHANGELOG.md is missing or empty');
  else if (r.version && !template && !changelogHasVersion(changelog, r.version)) r.errors.push(`CHANGELOG.md has no heading for ${r.version} (e.g. "## ${r.version}")`);
  step('README.md and CHANGELOG.md', readme?.trim() && changelog?.trim() ? 'present' : 'missing');

  // 3. Dependencies: dependency-free or vendored.
  const pkgText = readText(join(dir, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const deps = Object.keys(pkg.dependencies ?? {});
      if (deps.length) r.errors.push(`package.json declares dependencies (${deps.join(', ')}): a package installs as it is, so vendor them or bundle the server into one file`);
    } catch (err) {
      r.errors.push(`package.json: ${err.message}`);
    }
  }

  // 4. Permissions: in-process refused; the diff against the published version.
  try {
    r.permissions = await cli.permissions(dir);
    if (r.permissions.runtime === 'in-process') r.errors.push('runtime "in-process" is refused: the marketplace carries sandboxed packages only');
    step('octi plugin permissions', 'read');
  } catch (err) {
    r.errors.push(`octi plugin permissions: ${err.message}`);
    step('octi plugin permissions', 'error');
  }

  // 5. The version against published.json.
  let contentHash = null;
  try {
    contentHash = (await cli.hash(dir)).contentHash;
  } catch (err) {
    r.errors.push(`octi plugin hash: ${err.message}`);
  }
  if (r.name && !template) {
    const latest = latestPublished(published, r.name);
    r.publishedVersion = latest;
    if (latest && r.version && isSemver(r.version)) {
      const cmp = compareSemver(r.version, latest);
      const same = published[r.name][r.version];
      if (same) {
        if (contentHash && same.contentHash !== contentHash) r.errors.push(`${r.version} is already published with other content: bump the version (and add it to CHANGELOG.md)`);
        else step('version', 'already published, unchanged');
      } else if (cmp < 0) {
        r.errors.push(`version ${r.version} is lower than the published ${latest}: a new version must be greater`);
      } else {
        step('version', `${latest} → ${r.version}`);
      }
    } else if (r.version) {
      step('version', `${r.version} (new plugin)`);
    }
    if (r.permissions) {
      const base = latest ? published[r.name][latest].permissions : null;
      const unchangedRelease = latest && r.version === latest;
      r.diff = unchangedRelease ? { widened: false, firstVersion: false, changes: [] } : diffPermissions(base, r.permissions);
    }
  }

  // 6. Size: the host's install limits.
  const tree = measureTree(dir);
  for (const l of tree.links) r.errors.push(`${l} is a link or special file: an install refuses those`);
  if (tree.files > LIMITS.files) r.errors.push(`${tree.files} files; an install takes at most ${LIMITS.files}`);
  if (tree.bytes > LIMITS.unpackedBytes) r.errors.push(`${mb(tree.bytes)}; an install takes at most ${mb(LIMITS.unpackedBytes)}`);
  const tmp = mkdtempSync(join(tmpdir(), 'octipus-check-'));
  try {
    const packed = await cli.pack(dir, join(tmp, 'p.tar.gz'));
    const size = statSync(packed.file ?? join(tmp, 'p.tar.gz')).size;
    if (size > LIMITS.tarballBytes) r.errors.push(`the tarball is ${mb(size)}; a remote install reads at most ${mb(LIMITS.tarballBytes)}`);
    step('size', `${tree.files} files, ${mb(tree.bytes)}, tarball ${mb(size)}`);
  } catch (err) {
    r.errors.push(`octi plugin pack: ${err.message}`);
    step('size', `${tree.files} files, ${mb(tree.bytes)}; pack failed`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 7. Its own tests.
  if (tests) {
    log(`  tests: ${dirName}`);
    const t = runTests(dir);
    if (t.status === 'failed') r.errors.push(`npm test failed (${t.detail})${t.output ? `:\n${t.output}` : ''}`);
    step('own tests', t.status === 'none' ? 'none (no test script)' : t.status);
    if (t.status === 'none' && !template) r.warnings.push('no tests: add a package.json with a "test" script (see plugins/_template)');
  }

  // 8. The smoke run.
  if (smoke && manifest && manifest.runtime !== 'in-process') {
    log(`  smoke run (${sandboxMode}): ${dirName}`);
    const s = await smokeRun(dir, manifest, { mode: sandboxMode });
    if (!s.ok) {
      r.errors.push(`smoke run: ${s.error}${s.stderr ? `\n${s.stderr.trim().split('\n').slice(-10).join('\n')}` : ''}`);
      step(`smoke run (${sandboxMode})`, 'failed');
    } else {
      const declared = Object.keys(manifest.tools ?? {});
      const missing = declared.filter((t) => !s.tools.includes(t));
      const undeclared = s.tools.filter((t) => !declared.includes(t));
      if (missing.length) r.errors.push(`smoke run: tools/list does not offer the declared ${missing.join(', ')}`);
      if (undeclared.length) r.warnings.push(`smoke run: the server offers ${undeclared.join(', ')}, not declared in the manifest (hidden from agents, refused if called)`);
      step(`smoke run (${sandboxMode})`, `${s.tools.length} tools listed`);
    }
  }
  return r;
}

function selectDirs(root, values) {
  if (values.plugin?.length) return values.plugin;
  if (values.all) return pluginDirs(root, { includeSkipped: true });
  if (values.base) return changedPluginDirs(gitChangedPaths(root, values.base));
  return pluginDirs(root, { includeSkipped: true });
}

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      base: { type: 'string' },
      plugin: { type: 'string', multiple: true },
      smoke: { type: 'boolean' },
      sandbox: { type: 'string', default: 'auto' },
      'no-tests': { type: 'boolean' },
      summary: { type: 'string', default: 'check-summary.md' },
      result: { type: 'string', default: 'check-result.json' },
      root: { type: 'string' },
    },
  });
  const root = resolve(values.root ?? REPO_ROOT);
  if (!['auto', 'required', 'off'].includes(values.sandbox)) throw new Error('--sandbox is auto, required or off');
  const published = readPublished(root);
  const dirs = selectDirs(root, values);
  let sandbox = { mode: 'plain' };
  const notes = [];
  if (values.smoke) {
    sandbox = chooseSandbox(values.sandbox);
    if (sandbox.warning) { notes.push(sandbox.warning); process.stderr.write(`warning: ${sandbox.warning}\n`); }
  }
  const results = [];
  for (const d of dirs) {
    process.stderr.write(`checking plugins/${d}\n`);
    const res = await checkPlugin(root, d, { published, smoke: values.smoke, sandboxMode: sandbox.mode, tests: !values['no-tests'], log: (m) => process.stderr.write(`${m}\n`) });
    if (values.smoke && sandbox.warning && !res.template) res.warnings.push(sandbox.warning);
    results.push(res);
  }
  let ref = null;
  try { ref = octipusRef(root); } catch { /* no OCTIPUS_REF */ }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.OCTIPUS || join(root, '..', 'octipus'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 12); } catch { /* not a git checkout */ }
  const summary = renderSummary(results, { octipusRef: commit ? `${ref} (${commit})` : ref, sandbox: values.smoke ? sandbox.mode : null });
  writeFileSync(resolve(values.summary), summary);
  const ok = results.every((r) => r.errors.length === 0);
  const widened = results.some((r) => r.diff?.widened);
  writeFileSync(resolve(values.result), `${JSON.stringify({ ok, widened, plugins: results.map((r) => ({ dir: r.dir, name: r.name, version: r.version, publishedVersion: r.publishedVersion, ok: r.errors.length === 0, widened: !!r.diff?.widened, errors: r.errors, warnings: r.warnings })), notes }, null, 2)}\n`);
  process.stdout.write(summary);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`check: ${err.message}\n`);
    process.exit(2);
  });
}
