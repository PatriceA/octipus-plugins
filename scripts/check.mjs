#!/usr/bin/env node
// Check a pull request, or local commits, as data: what CI's `check` job
// runs, from the BASE branch's copy of this script, on the pull request's
// tree. It runs none of the pull request's code (no `npm test`, no server:
// those run in the separate sandboxed `test` job, scripts/test-plugins.mjs).
//
//   node scripts/check.mjs [--repo <git dir>] [--base <rev>] [--head <rev>]
//                          [--plugin <name>… | --all]
//                          [--index-from <file|url>] [--keys-from <file|url>] [--root-pub <file>…]
//                          [--summary check-summary.md] [--result check-result.json]
//
// --base defaults to origin/main and --head to HEAD: it checks what is
// committed, never the working tree. It reads everything from git's objects
// (scripts/lib/git.mjs): a symbolic link or a submodule anywhere in the head
// tree fails the check.
//
// For the pull request as a whole:
//   - no link or submodule anywhere (C1, H1);
//   - published.json and revoked.json append-only against the base (H4, M4);
//     a record added to published.json must be one the live signed index
//     already has (only publish appends);
//   - every changed path outside plugins/<name>/ is listed: the report labels
//     the pull request needs-maintainer-review (H5).
// For each changed plugin directory, exported from git into a temporary
// directory (regular files only):
//   - octipus-plugin.json present before anything else runs (M1);
//   - name and version rules (L6, L7), the name matches the directory;
//   - `octi plugin validate`, the marketplace.json schema and text rules (L5),
//     README.md and CHANGELOG.md present and within their caps (L5);
//   - the host's install limits; no `runtime: in-process`; no dependencies;
//   - a version greater than the base's published one, the permissions diff (M3).
// It writes check-result.json (the only thing the report reads, validated
// there) and a Markdown summary rendered from it, and exits 1 on any problem.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateCheckResult } from './lib/check-result.mjs';
import { assertTreeClean, changedPaths, checkCommit, exportTree, git, lsTree, showFile } from './lib/git.mjs';
import { checkListing, LISTING_FILE, listingImages, listingWarnings, unknownLicenses } from './lib/listing.mjs';
import { cli, octipusRef, REPO_ROOT } from './lib/octi.mjs';
import { diffPermissions, networkWarnings, permissionsProblems, stableStringify } from './lib/permissions.mjs';
import { nameProblem, publishedDiff, revokedDiff, validatePublished, validateRevoked, versionProblem } from './lib/records.mjs';
import { changedPluginDirs, isSkipped, latestPublished, LIMITS, MANIFEST, measureTree, outsidePluginPaths, parseJson, PLUGINS_DIR } from './lib/repo.mjs';
import { checkRelPath, readFileUnder, SafeDir } from './lib/safe-fs.mjs';
import { compareSemver } from './lib/semver.mjs';
import { renderSummary } from './lib/summary.mjs';
import { TEXT_LIMITS } from './lib/text.mjs';
import { LIVE_INDEX, LIVE_KEYS, readSource, verifyKeysJson } from './sign.mjs';

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const cap = (s, n = 3900) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/** Whether CHANGELOG.md has a heading naming `version` (`## 1.2.0`, `## [1.2.0] - 2026-11-10`). */
export function changelogHasVersion(text, version) {
  const v = version.replace(/[.+]/g, (c) => `\\${c}`);
  return new RegExp(`^#{1,6}\\s+\\[?v?${v}\\]?(\\s|$)`, 'm').test(text);
}

/** A text file of the plugin: null when absent; an error string when it is not a regular file or too large. */
function readCapped(dir, name, maxBytes) {
  try {
    return { text: readFileUnder(dir, name, { encoding: 'utf8', optional: true, maxBytes }) };
  } catch (err) {
    return { error: `${name}: ${err.message}` };
  }
}

/**
 * Check the plugin exported into `dir` (from plugins/<dirName>).
 * @returns a plugin entry of check-result.json
 */
export async function checkPlugin(dir, dirName, { published = {} } = {}) {
  const template = isSkipped(dirName);
  const r = { dir: `${PLUGINS_DIR}/${dirName}`, name: null, version: null, publishedVersion: null, template, ok: false, widened: false, firstVersion: false, errors: [], warnings: [], steps: [], permissions: null, changes: [] };
  const step = (name, status) => r.steps.push({ name, status: cap(status, 900) });
  const finish = () => {
    r.errors = r.errors.map((e) => cap(e));
    r.warnings = r.warnings.map((w) => cap(w));
    r.ok = r.errors.length === 0;
    return r;
  };

  // 0. A plugin package, before any tool looks at it (M1): Octipus's validate
  // imports a legacy plugin (plugin.json) to check it, which runs its code.
  const legacy = readCapped(dir, 'plugin.json', 1);
  if (legacy.error || legacy.text !== null) r.errors.push('plugin.json is a legacy plugin, which the marketplace does not take: convert it (octi plugin convert) to a plugin package with octipus-plugin.json');
  const m = readCapped(dir, MANIFEST, TEXT_LIMITS.manifestBytes);
  if (m.error) r.errors.push(m.error);
  else if (m.text === null) r.errors.push(`${MANIFEST} is missing: a plugin is a plugin package (see plugins/_template)`);
  if (r.errors.length) { step('plugin package', 'refused before any check'); return finish(); }

  let manifest = null;
  try {
    manifest = parseJson(m.text, MANIFEST);
    r.name = typeof manifest.name === 'string' ? cap(manifest.name, 100) : null;
    r.version = typeof manifest.version === 'string' ? cap(manifest.version, 100) : null;
  } catch (err) {
    r.errors.push(err.message);
  }
  if (!template) {
    const np = nameProblem(manifest?.name);
    if (np) r.errors.push(np);
    else if (manifest.name !== dirName) r.errors.push(`the directory is plugins/${dirName} but the manifest names "${manifest.name}": they must match`);
  }
  const vp = versionProblem(manifest?.version);
  if (vp) r.errors.push(vp);
  const sigFile = readCapped(dir, 'octipus-plugin.sig', 4096);
  if (sigFile.error || sigFile.text !== null) r.errors.push('octipus-plugin.sig is committed: a submission carries no signature (the key holder signs on publishing); remove it');

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
  const lt = readCapped(dir, LISTING_FILE, TEXT_LIMITS.listingBytes);
  if (lt.error) r.errors.push(lt.error);
  else if (lt.text === null) { r.errors.push(`${LISTING_FILE} is missing (see plugins/_template/${LISTING_FILE})`); step(LISTING_FILE, 'missing'); } else {
    let listing = null;
    try { listing = parseJson(lt.text, LISTING_FILE); } catch (err) { r.errors.push(err.message); }
    if (listing) {
      const problems = checkListing(listing);
      for (const p of problems) r.errors.push(`${LISTING_FILE}: ${p}`);
      if (!problems.length) {
        for (const w of listingWarnings(listing)) r.warnings.push(`${LISTING_FILE}: ${w}`);
        for (const id of unknownLicenses(listing.license)) r.warnings.push(`licence ${id} is not on the list of known open source licences: the reviewer checks it`);
        for (const [i, img] of listingImages(listing).entries()) {
          const limit = i === 0 && listing.icon ? LIMITS.iconBytes : LIMITS.screenshotBytes;
          try {
            const bytes = readFileUnder(dir, img, { optional: true, maxBytes: limit });
            if (bytes === null) r.errors.push(`${LISTING_FILE}: ${img} does not exist in the plugin directory`);
          } catch (err) {
            r.errors.push(`${LISTING_FILE}: ${err.message}`);
          }
        }
      }
      step(LISTING_FILE, problems.length ? 'failed' : 'passed');
    }
  }
  const readme = readCapped(dir, 'README.md', TEXT_LIMITS.readmeBytes);
  if (readme.error) r.errors.push(readme.error);
  else if (!readme.text?.trim()) r.errors.push('README.md is missing or empty: say what it does, how to set it up and the secrets it needs');
  const changelog = readCapped(dir, 'CHANGELOG.md', TEXT_LIMITS.changelogBytes);
  if (changelog.error) r.errors.push(changelog.error);
  else if (!changelog.text?.trim()) r.errors.push('CHANGELOG.md is missing or empty');
  else if (r.version && !vp && !template && !changelogHasVersion(changelog.text, r.version)) r.errors.push(`CHANGELOG.md has no heading for ${r.version} (e.g. "## ${r.version}")`);
  step('README.md and CHANGELOG.md', readme.text?.trim() && changelog.text?.trim() ? 'present' : 'missing');

  // 3. Dependencies: dependency-free or vendored.
  const pkg = readCapped(dir, 'package.json', 256 * 1024);
  if (pkg.error) r.errors.push(pkg.error);
  else if (pkg.text !== null) {
    try {
      const deps = Object.keys(parseJson(pkg.text, 'package.json').dependencies ?? {});
      if (deps.length) r.errors.push(`package.json declares dependencies (${deps.join(', ')}): a package installs as it is, so vendor them or bundle the server into one file`);
    } catch (err) {
      r.errors.push(err.message);
    }
  }

  // 4. Permissions: in the exact shape an index carries (the host compares
  // the whole object with what it recomputes), in-process refused.
  try {
    const perm = await cli.permissions(dir);
    const problems = permissionsProblems(perm);
    if (problems.length) {
      r.errors.push(...problems.map((p) => `octi plugin permissions: ${p}`));
      step('octi plugin permissions', 'not the index shape');
    } else {
      r.permissions = perm;
      if (perm.runtime === 'in-process') r.errors.push('runtime "in-process" is refused: the marketplace carries sandboxed packages only');
      for (const w of networkWarnings(perm)) r.warnings.push(w);
      step('octi plugin permissions', 'read');
    }
  } catch (err) {
    r.errors.push(`octi plugin permissions: ${err.message}`);
    step('octi plugin permissions', 'error');
  }

  // 5. The version against the base's published.json, and the diff.
  let contentHash = null;
  try {
    contentHash = (await cli.hash(dir)).contentHash;
  } catch (err) {
    r.errors.push(`octi plugin hash: ${err.message}`);
  }
  if (r.name && !template && !nameProblem(r.name) && !vp) {
    const latest = latestPublished(published, r.name);
    r.publishedVersion = latest;
    const same = published[r.name]?.[r.version];
    if (same) {
      if (!contentHash || same.contentHash !== contentHash) r.errors.push(`${r.version} is already published with other content: bump the version (and add it to CHANGELOG.md)`);
      else step('version', 'already published, unchanged');
    } else if (latest && compareSemver(r.version, latest) <= 0) {
      r.errors.push(`version ${r.version} is not greater than the published ${latest}: a new version must be greater`);
    } else {
      step('version', latest ? `${latest} → ${r.version}` : `${r.version} (new plugin)`);
    }
    if (r.permissions) {
      const base = latest ? published[r.name][latest].permissions : null;
      const d = same && same.contentHash === contentHash ? { widened: false, firstVersion: false, changes: [] } : diffPermissions(base, r.permissions);
      r.widened = d.widened;
      r.firstVersion = d.firstVersion;
      r.changes = d.firstVersion ? [] : d.changes.map((c) => ({ change: c.change, text: cap(c.text, 900), widens: c.widens }));
    }
  }

  // 6. Size: the host's install limits.
  try {
    const tree = measureTree(dir);
    if (tree.files > LIMITS.files) r.errors.push(`${tree.files} files; an install takes at most ${LIMITS.files}`);
    if (tree.bytes > LIMITS.unpackedBytes) r.errors.push(`${mb(tree.bytes)}; an install takes at most ${mb(LIMITS.unpackedBytes)}`);
    const tmp = mkdtempSync(join(tmpdir(), 'octipus-check-pack-'));
    try {
      const packed = await cli.pack(dir, join(tmp, 'p.tar.gz'));
      const size = statSync(join(tmp, 'p.tar.gz')).size;
      if (size > LIMITS.tarballBytes) r.errors.push(`the tarball is ${mb(size)}; a remote install reads at most ${mb(LIMITS.tarballBytes)}`);
      if (contentHash && packed.contentHash !== contentHash) r.errors.push('pack and hash disagree on the content hash');
      step('size', `${tree.files} files, ${mb(tree.bytes)}, tarball ${mb(size)}`);
    } catch (err) {
      r.errors.push(`octi plugin pack: ${err.message}`);
      step('size', `${tree.files} files, ${mb(tree.bytes)}; pack failed`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    r.errors.push(err.message);
  }
  return finish();
}

/** The root public keys in the base commit's keys/root/. */
function baseRootPubs(repo, base) {
  return lsTree(repo, base, ['keys/root']).filter((e) => e.path.endsWith('.pub')).map((e) => showFile(repo, base, e.path));
}

/**
 * Records a pull request adds to published.json must be exactly entries of
 * the live signed index (verified with the root keys of the base): only
 * publish appends, after signing.
 */
async function additionsProblems(added, head, { repo, base, indexFrom, keysFrom, rootPubs }) {
  if (!added.length) return [];
  const p = [];
  const work = SafeDir.temp('octipus-check-index-');
  try {
    const roots = rootPubs?.length ? rootPubs : baseRootPubs(repo, base);
    const keysBytes = await readSource(keysFrom);
    const keys = verifyKeysJson(keysBytes, (await readSource(`${keysFrom}.sig`, 4096)).toString('utf8'), roots);
    const bytes = await readSource(indexFrom);
    const f = work.write('index.json', bytes);
    work.write('index.json.sig', await readSource(`${indexFrom}.sig`, 4096));
    const pubs = keys.endorsed.map((k, i) => work.write(`k${i}.pub`, k.publicKey));
    const v = await cli.verifyIndex(f, pubs);
    if (!v.valid) return [`published.json adds ${added.join(', ')}, but the signed index does not verify: ${v.error ?? 'invalid'}`];
    const index = JSON.parse(bytes.toString('utf8'));
    for (const key of added) {
      const [name, version] = key.split('@');
      const e = index.packages.find((x) => x.name === name && x.version === version);
      const rec = head[name][version];
      if (!e) { p.push(`published.json adds ${key}, which the signed index does not have: only publish adds records`); continue; }
      for (const fld of ['sha256', 'contentHash', 'keyId', 'permissions', 'publishedAt']) if (stableStringify(e[fld]) !== stableStringify(rec[fld])) p.push(`published.json adds ${key} with a ${fld} other than the signed index's`);
    }
  } catch (err) {
    p.push(`published.json adds ${added.join(', ')}, which could not be checked against the signed index: ${err.message}`);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
  return p;
}

/** Check `head` against `base` in the git repository `repo`; returns check-result.json. */
export async function checkCommits({ repo, base, head, plugins: only, all = false, indexFrom = LIVE_INDEX, keysFrom = LIVE_KEYS, rootPubs, log = () => {} }) {
  const rev = (x) => checkCommit(git(repo, ['rev-parse', '--verify', '--quiet', `${x}^{commit}`]), x);
  const baseSha = rev(base);
  const headSha = rev(head);
  const problems = [];
  try { assertTreeClean(repo, headSha); } catch (err) { problems.push(err.message); }

  const changed = changedPaths(repo, baseSha, headSha);
  const outside = outsidePluginPaths(changed);

  // published.json and revoked.json: append-only against the base.
  const readRecords = (commit, file, validate, empty) => {
    const text = showFile(repo, commit, file);
    return validate(text === null ? empty : parseJson(text, file));
  };
  let basePublished = {};
  try { basePublished = readRecords(baseSha, 'published.json', validatePublished, {}); } catch (err) { problems.push(`the base's published.json: ${err.message}`); }
  try {
    const headPublished = readRecords(headSha, 'published.json', validatePublished, {});
    const d = publishedDiff(basePublished, headPublished);
    for (const k of d.removed) problems.push(`published.json: ${k} was removed. A published version stays published; to withdraw it, add it to revoked.json`);
    for (const k of d.changed) problems.push(`published.json: ${k} was changed. A published record never changes (re-signing it with other content is refused)`);
    problems.push(...await additionsProblems(d.added, headPublished, { repo, base: baseSha, indexFrom, keysFrom, rootPubs }));
  } catch (err) {
    problems.push(err.message.startsWith('published.json') ? err.message : `published.json: ${err.message}`);
  }
  try {
    const baseRevoked = readRecords(baseSha, 'revoked.json', validateRevoked, { packages: [], keys: [] });
    const headRevoked = readRecords(headSha, 'revoked.json', validateRevoked, { packages: [], keys: [] });
    problems.push(...revokedDiff(baseRevoked, headRevoked));
  } catch (err) {
    problems.push(err.message);
  }

  // The plugin directories.
  let dirs;
  if (only?.length) dirs = only;
  else if (all) dirs = [...new Set(lsTree(repo, headSha, ['plugins']).map((e) => e.path.split('/')[1]).filter(Boolean))].sort();
  else dirs = changedPluginDirs(changed);
  const results = [];
  for (const d of dirs) {
    try { checkRelPath(`${PLUGINS_DIR}/${d}`); if (d.includes('/')) throw new Error('nested'); } catch { problems.push(`${JSON.stringify(d)} is not a plugin directory name`); continue; }
    log(`checking plugins/${d}`);
    const work = SafeDir.temp('octipus-check-');
    try {
      let n;
      try {
        n = exportTree(repo, headSha, work, { prefix: `${PLUGINS_DIR}/${d}`, destRel: 'p' });
      } catch (err) {
        results.push({ dir: `${PLUGINS_DIR}/${d}`, name: null, version: null, publishedVersion: null, template: isSkipped(d), ok: false, widened: false, firstVersion: false, errors: [cap(err.message)], warnings: [], steps: [], permissions: null, changes: [] });
        continue;
      }
      if (n === 0) {
        problems.push(`plugins/${d} was removed. Its published versions stay in the index; to withdraw them, list them in revoked.json.`);
        continue;
      }
      results.push(await checkPlugin(work.path('p'), d, { published: basePublished }));
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  }

  const result = {
    schema: 1,
    kind: 'octipus-plugins-check',
    base: baseSha,
    head: headSha,
    octipusRef: octipusRef(),
    ok: problems.length === 0 && results.every((r) => r.ok),
    widened: results.some((r) => r.widened),
    needsMaintainer: outside.length > 0,
    problems: problems.slice(0, 200).map((p) => cap(p)),
    outside: outside.slice(0, 500).map((p) => cap(p, 1000)),
    outsideTotal: outside.length,
    plugins: results.slice(0, 100),
  };
  return validateCheckResult(result);
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      base: { type: 'string', default: 'origin/main' },
      head: { type: 'string', default: 'HEAD' },
      plugin: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      'index-from': { type: 'string' },
      'keys-from': { type: 'string' },
      'root-pub': { type: 'string', multiple: true },
      summary: { type: 'string', default: 'check-summary.md' },
      result: { type: 'string', default: 'check-result.json' },
    },
  });
  const repo = resolve(values.repo ?? REPO_ROOT);
  const result = await checkCommits({
    repo,
    base: values.base,
    head: values.head,
    plugins: values.plugin,
    all: values.all === true,
    indexFrom: values['index-from'] ?? LIVE_INDEX,
    keysFrom: values['keys-from'] ?? LIVE_KEYS,
    rootPubs: values['root-pub'] ? await Promise.all(values['root-pub'].map(async (p) => (await readSource(p)).toString('utf8'))) : undefined,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const summary = renderSummary(result);
  writeFileSync(resolve(values.summary), summary);
  writeFileSync(resolve(values.result), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(summary);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`check: ${err.message}\n`);
    process.exit(2);
  });
}
