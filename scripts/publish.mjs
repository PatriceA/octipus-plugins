#!/usr/bin/env node
// Publish the marketplace in three steps; only the middle one holds a key.
//
//   npm run publish -- build  [--index-from <file|url> | --no-previous-index] [--keys-from <file|url>]
//                             [--previous-keys-from <file|url>] [--root-pub <file>…]
//                             [--build-record <file> | --skip-ci-compare] [--confirm-bypass "<phrase>"]
//                             [--resign-to <keyId>] [--out release/]
//   node scripts/sign.mjs --plan release/release-plan.json --key <signing.key> --root-pub <root.pub> …
//   npm run publish -- finish --plan release/release-plan.json [--stats stats.json] [--out dist/]
//
// build (no key; it runs Astro-free repository code and the pinned CLI):
//  1. The worktree is clean, on main, equal to origin/main; the commit's
//     tree has no symbolic link or submodule; it is exported from git's
//     objects into a temporary directory and read from there only.
//  2. keys.json (the live one by default) verified with the root keys; the
//     endorsed signing keys come from it, never from keys/ (M5).
//  3. The last signed index (the live one by default) verified with an
//     endorsed key, and published.json and revoked.json checked against it:
//     no published version dropped or changed, no revocation undone, no
//     record that the index does not have (C1, H4, M4). Every record is
//     validated strictly (name, dir, version, commit an ancestor of HEAD,
//     signatureFile canonical).
//  4. The new versions: every check of scripts/check.mjs that needs no
//     network (names, versions, listing, README and CHANGELOG caps, validate,
//     permissions), packed unsigned and compared with CI's build record for
//     this commit (a push run on main; a bypass needs a typed confirmation,
//     recorded in the plan: L1, L2).
//  5. Every version published before, rebuilt byte for byte from its commit
//     and recorded signature (its sha256 must be the signed index's).
//  6. The index v2 template (each new tarball's sha256 and key id left null:
//     they exist only once the package is signed) and release-plan.json.
// sign: see scripts/sign.mjs. finish (no key): verify what sign wrote, add
// the records to published.json, and assemble dist/ with the site.
// Nothing here pushes or uploads: you deploy dist/ and commit published.json.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { exportCommit } from './build.mjs';
import { assertNoLinks, exportTree, git, headCommit, isAncestor, lsTree } from './lib/git.mjs';
import { BASE_URL, buildIndex, serializeIndex, tarballName } from './lib/index-v2.mjs';
import { checkListing, LISTING_FILE, listingImages } from './lib/listing.mjs';
import { permissionsProblems } from './lib/permissions.mjs';
import { cli, missingSubcommands, octipusRef, REPO_ROOT } from './lib/octi.mjs';
import { anchorProblems, nameProblem, validatePublished, versionProblem } from './lib/records.mjs';
import { isSkipped, LIMITS, MANIFEST, overwriteRegular, parseJson, pluginDirs, PLUGINS_DIR, readPublished, readRevoked, serializePublished, withPublished } from './lib/repo.mjs';
import { readFileUnder, readRegularFile, SafeDir } from './lib/safe-fs.mjs';
import { compareSemver, maxSemver } from './lib/semver.mjs';
import { serializeStats, validateStats } from './lib/stats.mjs';
import { TEXT_LIMITS } from './lib/text.mjs';
import { checkPlan, LIVE_INDEX, LIVE_KEYS, readSource, sha256Hex, verifyKeysJson } from './sign.mjs';
import { repoRootPubs } from './keys.mjs';

const SIGNATURE_FILE = 'octipus-plugin.sig';
const RELEASE_MARKER = '.octipus-plugins-release';
const DIST_MARKER = '.octipus-plugins-dist';
export const DEFAULT_GITHUB_REPO = 'PatriceA/octipus-plugins';

export class PublishError extends Error {}
const stop = (msg) => { throw new PublishError(msg); };
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** sha256 hex without a `sha256:` prefix, lower case. */
export const hex = (s) => String(s ?? '').replace(/^sha256:/, '').toLowerCase();

/** The phrase that confirms a bypass of the CI compare (L2). */
export const bypassPhrase = (commit) => `bypass the CI compare for ${commit.slice(0, 12)}`;

/** Clean, on main, equal to origin/main. */
export function checkWorktree(root, { remote = 'origin', branch = 'main', fetch = true } = {}) {
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch) stop(`on branch ${current}: publish from ${branch}`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) stop(`the worktree is not clean:\n${dirty}\nCommit or stash it: what is published is exactly the committed ${branch}.`);
  if (fetch) {
    try { git(root, ['fetch', '--quiet', remote, branch]); } catch (err) { stop(`git fetch ${remote} ${branch} failed: ${err.stderr?.toString().trim() || err.message}`); }
  }
  const head = headCommit(root);
  let upstream;
  try { upstream = git(root, ['rev-parse', `${remote}/${branch}`]); } catch { stop(`no ${remote}/${branch} to compare with`); }
  if (head !== upstream) stop(`${branch} (${head.slice(0, 12)}) is not ${remote}/${branch} (${upstream.slice(0, 12)}): pull or push first, so what you sign is what CI built.`);
  return head;
}

/** Empty a directory an earlier run of this script wrote (its marker), or refuse; then create it new. */
function freshOut(out, marker, root) {
  const abs = resolve(out);
  const plugins = resolve(root, PLUGINS_DIR);
  if (abs === resolve(root) || abs.startsWith(`${plugins}/`) || abs === plugins) stop(`--out ${out} cannot be the repository or inside plugins/`);
  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) stop(`--out ${out} is a symbolic link`);
    const entries = readdirSync(abs);
    // Ours: written by publish (the marker), or by npm run build:site (csp.txt) for dist/.
    if (entries.length && !entries.includes(marker) && !(marker === DIST_MARKER && entries.includes('csp.txt'))) stop(`--out ${out} is not empty and was not written by publish: choose another directory or empty it yourself`);
    rmSync(abs, { recursive: true, force: true });
  }
  const dir = SafeDir.create(abs);
  dir.write(marker, `Written by npm run publish (octipus-plugins) at ${new Date().toISOString()}.\n`);
  return dir;
}

async function askLine(prompt) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((ok) => rl.question(prompt, (a) => { rl.close(); ok(a); }));
}

/** The newest commit published.json names (the last publish), or null. */
export function lastPublishCommit(published) {
  let best = null;
  for (const versions of Object.values(published)) for (const r of Object.values(versions)) {
    const at = r.resignedAt ?? r.publishedAt;
    if (!best || at > best.at) best = { at, commit: r.commit };
  }
  return best?.commit ?? null;
}

/** keys.json from `keysFrom`, verified with `rootPubs`: `{ bytes, sig, doc, endorsed }`. */
async function loadKeys(keysFrom, rootPubs, { now = new Date() } = {}) {
  const bytes = await readSource(keysFrom);
  const sig = await readSource(`${keysFrom}.sig`, 4096);
  const v = verifyKeysJson(bytes, sig.toString('utf8'), rootPubs, { now });
  return { bytes, sig, ...v };
}

/** CI's build record for `commit` (L1): a successful `push` run of build.yml on main for exactly this commit. */
function ciBuildRecord({ commit, gh, githubRepo, log }) {
  const ver = spawnSync(gh, ['--version'], { stdio: 'ignore' });
  if (ver.status !== 0) stop(`gh is not available to fetch CI's build-record.json for ${commit.slice(0, 12)}: install gh and log in, or (after checking the record yourself) pass --build-record <file> with the typed confirmation.`);
  const list = spawnSync(gh, ['run', 'list', '--repo', githubRepo, '--workflow', 'build.yml', '--event', 'push', '--branch', 'main', '--commit', commit, '--json', 'databaseId,status,conclusion,headSha,event,headBranch', '--limit', '20'], { encoding: 'utf8' });
  if (list.status !== 0) stop(`gh run list failed: ${list.stderr.trim()}`);
  let runs;
  try { runs = JSON.parse(list.stdout || '[]'); } catch { stop('gh run list: not JSON'); }
  const run = runs.find((r) => r.headSha === commit && r.event === 'push' && r.headBranch === 'main' && r.status === 'completed' && r.conclusion === 'success');
  if (!run) stop(`no successful build.yml push run on main for ${commit.slice(0, 12)} in ${githubRepo}${runs.length ? ` (${runs.map((r) => `${r.event}/${r.headBranch}/${r.status}/${r.conclusion || '…'}`).join(', ')})` : ''}: wait for CI, then run publish again.`);
  const dir = SafeDir.temp('octipus-build-record-');
  try {
    const dl = spawnSync(gh, ['run', 'download', String(run.databaseId), '--repo', githubRepo, '--name', 'build-record', '--dir', join(dir.root, 'x')], { encoding: 'utf8' });
    if (dl.status !== 0) stop(`gh run download ${run.databaseId} failed: ${dl.stderr.trim()}`);
    log(`CI build record: run ${run.databaseId} (push to main, ${commit.slice(0, 12)})`);
    return { record: parseJson(readFileUnder(dir.root, 'x/build-record.json', { encoding: 'utf8', maxBytes: 1024 * 1024 }), 'build-record.json'), runId: run.databaseId };
  } finally {
    rmSync(dir.root, { recursive: true, force: true });
  }
}

/** The record to compare with, and how it was obtained (recorded in the plan). */
async function loadBuildRecord({ file, skip, confirmBypass, commit, gh, githubRepo, log }) {
  if (file && skip) stop('--build-record or --skip-ci-compare, not both');
  if (!file && !skip) {
    const { record, runId } = ciBuildRecord({ commit, gh, githubRepo, log });
    return { record, ciCompare: { mode: 'ci-run', runId, repo: githubRepo } };
  }
  const reason = skip ? 'skip-ci-compare' : 'local-build-record';
  log([
    '',
    '!'.repeat(78),
    skip ? '!!  --skip-ci-compare: the tarballs are NOT compared with what CI built.' : '!!  --build-record: the record is a local file, not fetched from CI\'s push run.',
    '!!  A tampered checkout or record on this machine would be signed without notice.',
    `!!  To go on, type: ${bypassPhrase(commit)}`,
    '!'.repeat(78),
    '',
  ].join('\n'));
  const typed = confirmBypass ?? await askLine('> ');
  if (typed === null || typed.trim() !== bypassPhrase(commit)) stop(`the bypass was not confirmed (type exactly "${bypassPhrase(commit)}")`);
  const record = file ? parseJson(readRegularFile(resolve(file), { encoding: 'utf8', maxBytes: 1024 * 1024 }), 'build-record.json') : null;
  return { record, ciCompare: { mode: 'bypass', reason, confirmation: typed.trim(), at: iso(new Date()) } };
}

/** The listing, README and CHANGELOG of each plugin in the exported tree, checked (H2, L5). */
function readSources(src) {
  const sources = {};
  const plugins = [];
  for (const d of pluginDirs(src.root)) {
    if (isSkipped(d)) continue;
    const base = `${PLUGINS_DIR}/${d}`;
    const text = readFileUnder(src.root, `${base}/${MANIFEST}`, { encoding: 'utf8', optional: true, maxBytes: TEXT_LIMITS.manifestBytes });
    if (text === null) stop(`plugins/${d} has no ${MANIFEST}: run npm run check`);
    const manifest = parseJson(text, `plugins/${d}/${MANIFEST}`);
    const problem = nameProblem(manifest.name) ?? versionProblem(manifest.version);
    if (problem) stop(`plugins/${d}: ${problem}`);
    if (manifest.name !== d) stop(`plugins/${d} names "${manifest.name}" in its manifest: they must match (run npm run check)`);
    if (readFileUnder(src.root, `${base}/plugin.json`, { optional: true, maxBytes: 1024 * 1024 }) !== null) stop(`plugins/${d} has a legacy plugin.json`);
    const listing = parseJson(readFileUnder(src.root, `${base}/${LISTING_FILE}`, { encoding: 'utf8', maxBytes: TEXT_LIMITS.listingBytes }), `plugins/${d}/${LISTING_FILE}`);
    const lp = checkListing(listing);
    if (lp.length) stop(`plugins/${d}/${LISTING_FILE}:\n${lp.map((x) => `  - ${x}`).join('\n')}`);
    for (const [i, img] of listingImages(listing).entries()) readFileUnder(src.root, `${base}/${img}`, { maxBytes: i === 0 && listing.icon ? LIMITS.iconBytes : LIMITS.screenshotBytes });
    const readme = readFileUnder(src.root, `${base}/README.md`, { encoding: 'utf8', maxBytes: TEXT_LIMITS.readmeBytes });
    const changelog = readFileUnder(src.root, `${base}/CHANGELOG.md`, { encoding: 'utf8', maxBytes: TEXT_LIMITS.changelogBytes });
    sources[manifest.name] = { listing, readme, changelog };
    plugins.push({ dir: d, name: manifest.name, version: manifest.version, manifest, listing });
  }
  return { sources, plugins };
}

/** Rebuild a published version's signed tarball from its commit and recorded signature; its sha256 must be the anchored one. */
async function rebuildPublished(root, name, version, rec, work, outFile) {
  const prefix = `${PLUGINS_DIR}/${name}`;
  assertNoLinks(lsTree(root, rec.commit, [prefix]), `${prefix} at ${rec.commit.slice(0, 12)}`);
  const rel = `old/${name}-${version}`;
  const n = exportTree(root, rec.commit, work, { prefix, destRel: rel });
  if (n === 0) stop(`${name} ${version}: ${prefix} is empty at ${rec.commit.slice(0, 12)}`);
  if (readFileUnder(work.root, `${rel}/${SIGNATURE_FILE}`, { optional: true, maxBytes: 4096 }) !== null) stop(`${name} ${version}: ${prefix} at ${rec.commit.slice(0, 12)} has a committed signature`);
  work.write(`${rel}/${SIGNATURE_FILE}`, rec.signatureFile);
  const packed = await cli.pack(work.path(rel), outFile);
  if (hex(packed.sha256) !== hex(rec.sha256) || packed.contentHash !== rec.contentHash) stop(`${name} ${version} rebuilt from ${rec.commit.slice(0, 12)} has sha256 ${hex(packed.sha256)}, not the published ${hex(rec.sha256)}: stop and find out why before publishing anything.`);
}

/** Pack a published version again without its signature (a key rotation re-signs it). */
async function rebuildUnsigned(root, name, version, rec, work, outFile) {
  const prefix = `${PLUGINS_DIR}/${name}`;
  assertNoLinks(lsTree(root, rec.commit, [prefix]), `${prefix} at ${rec.commit.slice(0, 12)}`);
  const rel = `resign/${name}-${version}`;
  exportTree(root, rec.commit, work, { prefix, destRel: rel });
  const packed = await cli.pack(work.path(rel), outFile);
  if (packed.contentHash !== rec.contentHash) stop(`${name} ${version} rebuilt from ${rec.commit.slice(0, 12)} hashes to ${packed.contentHash}, not the published ${rec.contentHash}`);
  return packed;
}

export async function publishBuild(opts) {
  const {
    root = REPO_ROOT, out = join(root, 'release'), indexFrom = LIVE_INDEX, keysFrom = LIVE_KEYS, previousKeysFrom, noPreviousIndex = false,
    rootPubs = repoRootPubs(root), buildRecord, skipCiCompare = false, confirmBypass, gh = 'gh', githubRepo = DEFAULT_GITHUB_REPO, resignTo = null,
    fetch = true, baseUrl = BASE_URL, now = new Date(), log = (m) => process.stderr.write(`${m}\n`),
  } = opts;
  const warnings = [];

  // 0. Node and the CLI. The tarball's deflate stream comes from Node's
  // bundled zlib: the same Node as CI (.node-version) gives the same bytes.
  const pinned = (readFileUnder(REPO_ROOT, '.node-version', { encoding: 'utf8', optional: true, maxBytes: 64 }) ?? '').trim().replace(/^v/, '');
  if (pinned && pinned !== process.versions.node) {
    if (pinned.split('.')[0] !== process.versions.node.split('.')[0]) stop(`this is Node ${process.versions.node}; CI builds with ${pinned} (.node-version). Use Node ${pinned.split('.')[0]} here, or the tarballs will not match CI's.`);
    warnings.push(`Node ${process.versions.node} here, ${pinned} in CI (.node-version): if the hash compare fails, use ${pinned}`);
  }
  const missing = await missingSubcommands();
  if (missing.length) stop(`the Octipus CLI has no ${missing.map((c) => `\`octi plugin ${c}\``).join(', ')}: update the checkout ($OCTIPUS) to the commit in OCTIPUS_REF`);

  // 1. Clean, main, up to date; the committed tree, links refused.
  const commit = checkWorktree(root, { fetch });
  log(`building a release from ${commit.slice(0, 12)}`);
  const src = exportCommit(root, commit);
  const work = SafeDir.temp('octipus-publish-');
  try {
    const published = readPublished(src.root);
    const revoked = readRevoked(src.root);
    for (const [name, versions] of Object.entries(published)) for (const [version, rec] of Object.entries(versions)) {
      if (!isAncestor(root, rec.commit, commit)) stop(`published.json ${name} ${version}: commit ${rec.commit.slice(0, 12)} is not an ancestor of ${commit.slice(0, 12)}`);
    }

    // 2. keys.json, with the root keys.
    if (!rootPubs.length) stop('no root public key: keys/root/*.pub, or --root-pub');
    const keys = await loadKeys(keysFrom, rootPubs, { now });
    if (!keys.endorsed.length) stop('keys.json endorses no signing key');
    log(`keys.json v${keys.doc.version} (root ${keys.rootKeyId}); endorsed: ${keys.endorsed.map((k) => k.keyId).join(', ')}`);
    const pubFiles = keys.endorsed.map((k, i) => work.write(`endorsed-${i}.pub`, k.publicKey));
    if (resignTo && !keys.endorsed.some((k) => k.keyId === resignTo)) stop(`--resign-to ${resignTo} is not endorsed by keys.json`);

    // 3. The anchor.
    let prev = null;
    let prevBytes = null;
    let prevSig = null;
    if (noPreviousIndex) {
      if (Object.keys(published).length || revoked.packages.length || revoked.keys.length) stop('--no-previous-index, but published.json or revoked.json is not empty: only the first publish has no signed index');
      log('no previous index: the first publish of the marketplace');
    } else {
      prevBytes = await readSource(indexFrom);
      prevSig = await readSource(`${indexFrom}.sig`, 4096);
      const f = work.write('previous/index.json', prevBytes);
      work.write('previous/index.json.sig', prevSig);
      let verifiers = pubFiles;
      if (previousKeysFrom) {
        const old = await loadKeys(previousKeysFrom, rootPubs, { now: new Date(0) });
        if (old.doc.version >= keys.doc.version) stop('--previous-keys-from must be an older keys.json');
        verifiers = [...pubFiles, ...old.doc.signingKeys.map((k, i) => work.write(`previous-${i}.pub`, k.publicKey))];
      }
      const v = await cli.verifyIndex(f, verifiers);
      if (!v.valid) stop(`the last signed index (${indexFrom}) does not verify with an endorsed key: ${v.error ?? 'invalid'}`);
      prev = parseJson(prevBytes.toString('utf8'), 'the last signed index');
      const problems = anchorProblems(prev, published, revoked);
      if (problems.length) stop(`published.json and revoked.json do not match the last signed index:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
      log(`anchored to the last signed index (${prev.packages.length} versions, ${v.keyId})`);
    }

    // 4. The sources and the new versions.
    const { sources, plugins } = readSources(src);
    const fresh = [];
    for (const p of plugins) {
      if (published[p.name]?.[p.version]) continue;
      const latest = maxSemver(Object.keys(published[p.name] ?? {}));
      if (latest && compareSemver(p.version, latest) <= 0) stop(`${p.name} ${p.version} is not greater than the published ${latest}`);
      fresh.push(p);
    }
    log(fresh.length ? `new: ${fresh.map((p) => `${p.name} ${p.version}`).join(', ')}` : 'no new versions');

    const out_ = freshOut(out, RELEASE_MARKER, root);
    const { record, ciCompare } = fresh.length
      ? await loadBuildRecord({ file: buildRecord, skip: skipCiCompare, confirmBypass, commit, gh, githubRepo, log })
      : { record: null, ciCompare: { mode: 'none-needed' } };
    if (record && record.commit !== commit) stop(`the build record is for ${String(record.commit).slice(0, 12)}, not ${commit.slice(0, 12)}`);
    const planned = [];
    const pending = [];
    for (const p of fresh) {
      const dir = join(src.root, PLUGINS_DIR, p.dir);
      if (readFileUnder(src.root, `${PLUGINS_DIR}/${p.dir}/${SIGNATURE_FILE}`, { optional: true, maxBytes: 4096 }) !== null) stop(`plugins/${p.dir}/${SIGNATURE_FILE} is committed: a submission carries no signature; remove it`);
      const v = await cli.validate(dir);
      if (!v.ok) stop(`${p.name} ${p.version} does not validate:\n${(v.problems ?? []).map((x) => `  - ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}`);
      const permissions = await cli.permissions(dir);
      const pp = permissionsProblems(permissions);
      if (pp.length) stop(`${p.name} ${p.version}: octi plugin permissions is not in the shape an index carries:\n${pp.map((x) => `  - ${x}`).join('\n')}`);
      if (permissions.runtime === 'in-process') stop(`${p.name} is runtime "in-process": the marketplace carries sandboxed packages only`);
      const rel = `unsigned/${tarballName(p.name, p.version)}`;
      out_.mkdir('unsigned');
      const unsigned = await cli.pack(dir, out_.path(rel));
      if (unsigned.name !== p.name || unsigned.version !== p.version) stop(`pack of plugins/${p.dir} names ${unsigned.name} ${unsigned.version}`);
      if (readRegularFile(out_.path(rel)).length > LIMITS.tarballBytes) stop(`${rel} is over ${LIMITS.tarballBytes / 1024 / 1024} MB, more than a remote install reads`);
      if (record) {
        const ci = (record.packages ?? []).find((x) => x.name === p.name && x.version === p.version);
        if (!ci) stop(`CI's build record for ${commit.slice(0, 12)} has no ${p.name} ${p.version}`);
        if (hex(ci.sha256) !== hex(unsigned.sha256) || ci.contentHash !== unsigned.contentHash) {
          stop(`${p.name} ${p.version} differs from what CI built:\n  here: sha256 ${hex(unsigned.sha256)}  ${unsigned.contentHash}\n  CI:   sha256 ${hex(ci.sha256)}  ${ci.contentHash}\nDo not sign it. Find out which side changed.`);
        }
        log(`  ${p.name} ${p.version}: matches CI (${unsigned.contentHash})`);
      }
      planned.push({ kind: 'new', name: p.name, version: p.version, contentHash: unsigned.contentHash, sha256: hex(unsigned.sha256), tarball: rel });
      pending.push({
        name: p.name,
        version: p.version,
        record: {
          contentHash: unsigned.contentHash,
          permissions,
          publishedAt: iso(now),
          commit,
          dir: p.dir,
          description: typeof p.manifest.description === 'string' ? p.manifest.description : '',
          apiVersion: p.manifest.apiVersion ?? null,
          minOctipus: p.listing.minOctipus ?? null,
          listing: p.listing,
        },
      });
    }

    // 5. Every version published before: re-signed (a key rotation) or rebuilt byte for byte.
    out_.mkdir('dl');
    const revokedSet = new Set(revoked.packages.map((r) => `${r.name}@${r.version}`));
    const resigned = new Set();
    for (const [name, versions] of Object.entries(published)) {
      for (const [version, rec] of Object.entries(versions)) {
        if (resignTo && rec.keyId !== resignTo && !revokedSet.has(`${name}@${version}`)) {
          out_.mkdir('unsigned');
          const rel = `unsigned/${tarballName(name, version)}`;
          const packed = await rebuildUnsigned(root, name, version, rec, work, out_.path(rel));
          planned.push({ kind: 'resign', name, version, contentHash: rec.contentHash, sha256: hex(packed.sha256), tarball: rel });
          resigned.add(`${name}@${version}`);
          log(`  ${name} ${version}: to be re-signed with ${resignTo}`);
        } else {
          await rebuildPublished(root, name, version, rec, work, out_.path(`dl/${tarballName(name, version)}`));
        }
      }
    }

    // 6. The index template: what sign fills in and signs.
    let next = published;
    for (const p of pending) next = withPublished(next, p.name, p.version, { ...p.record, sha256: null, keyId: null });
    for (const k of resigned) {
      const [name, version] = k.split('@');
      next = withPublished(next, name, version, { ...next[name][version], sha256: null, keyId: null });
    }
    const index = buildIndex({ published: next, sources, revoked, generatedAt: iso(now), baseUrl });
    const template = serializeIndex(index);
    // Each filled-in entry grows by its sha256 and key id.
    if (Buffer.byteLength(template) + 200 * planned.length > LIMITS.indexBytes) stop(`index.json would be over ${LIMITS.indexBytes} bytes, more than a host reads: shorten READMEs or CHANGELOGs`);
    out_.write('index.template.json', template);
    out_.write('keys/keys.json', keys.bytes);
    out_.write('keys/keys.json.sig', keys.sig);
    if (prevBytes) { out_.write('previous/index.json', prevBytes); out_.write('previous/index.json.sig', prevSig); }
    out_.write('pending.json', `${JSON.stringify({ schema: 1, commit, records: pending }, null, 2)}\n`);
    const plan = {
      schema: 1,
      kind: 'octipus-plugins-release-plan',
      commit,
      octipusRef: octipusRef(),
      createdAt: iso(now),
      lastPublishCommit: lastPublishCommit(published),
      previousIndex: prevBytes ? { sha256: sha256Hex(prevBytes) } : null,
      keys: { sha256: sha256Hex(keys.bytes), version: keys.doc.version, endorsedKeyIds: keys.endorsed.map((k) => k.keyId) },
      resignTo,
      packages: planned,
      index: { template: 'index.template.json', sha256: sha256Hex(Buffer.from(template)) },
      revocations: { packages: revoked.packages, keys: revoked.keys },
      ciCompare,
    };
    checkPlan(plan);
    const planFile = out_.write('release-plan.json', `${JSON.stringify(plan, null, 2)}\n`);

    const since = plan.lastPublishCommit ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const stat = git(root, ['diff', '--stat=160', `${since}..${commit}`, '--', '.', ':(exclude,glob)plugins/[!_]*/**']);
    log([
      '',
      `Release plan: ${planFile}`,
      ...planned.map((p) => `  ${p.kind}: ${p.name} ${p.version}  ${p.contentHash}`),
      ...warnings.map((w) => `  warning: ${w}`),
      '',
      `Changed outside plugins/<name>/ since ${plan.lastPublishCommit ? `the last publish (${since.slice(0, 12)})` : 'the first commit'}:`,
      stat || '  (nothing)',
      '',
      'Next, in the key session (node, not npm):',
      `  node scripts/sign.mjs --plan ${planFile} --key <signing.key> --root-pub <your root.pub>${noPreviousIndex ? ' --no-previous-index' : ''}`,
    ].join('\n'));
    return { commit, out: out_.root, planFile, plan, warnings };
  } finally {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(work.root, { recursive: true, force: true });
  }
}

/** Build the site from `indexFile` into `siteOut` (Astro, static). */
function buildSite(indexFile, siteOut, log, statsFile) {
  const astro = join(REPO_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
  if (!existsSync(astro)) stop('Astro is not installed: run npm ci --ignore-scripts in octipus-plugins first');
  log('building the site');
  const env = { ...process.env, MARKETPLACE_INDEX: indexFile, SITE_OUT: siteOut, ASTRO_TELEMETRY_DISABLED: '1' };
  delete env.MARKETPLACE_STATS;
  if (statsFile) env.MARKETPLACE_STATS = statsFile;
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [astro, 'build', '--root', join(REPO_ROOT, 'site'), '--silent'], { cwd: REPO_ROOT, encoding: 'utf8', env });
  if (r.status !== 0) stop(`the site build failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-30).join('\n')}`);
}

const SIGNED_RECORD = 'keyId,kind,name,sha256,signatureFile,version';

export async function publishFinish(opts) {
  const { root = REPO_ROOT, planFile, out = join(root, 'dist'), rootPubs = repoRootPubs(root), stats, fetch = true, now = new Date(), log = (m) => process.stderr.write(`${m}\n`) } = opts;
  if (!planFile) stop('--plan <release/release-plan.json> is required');
  const commit = checkWorktree(root, { fetch });
  const planPath = resolve(planFile);
  const relDir = planPath.slice(0, planPath.lastIndexOf('/'));
  const plan = checkPlan(parseJson(readRegularFile(planPath, { encoding: 'utf8' }), 'release-plan.json'));
  if (plan.commit !== commit) stop(`the plan is for ${plan.commit.slice(0, 12)}, HEAD is ${commit.slice(0, 12)}`);
  const signed = parseJson(readFileUnder(relDir, 'signed/signed.json', { encoding: 'utf8' }), 'signed.json');
  if (!signed || signed.schema !== 1 || signed.kind !== 'octipus-plugins-signed' || signed.commit !== commit || !Array.isArray(signed.records)) stop('signed/signed.json is not for this plan');
  const pending = parseJson(readFileUnder(relDir, 'pending.json', { encoding: 'utf8' }), 'pending.json');
  if (pending.schema !== 1 || pending.commit !== commit) stop('pending.json is not for this plan');

  const work = SafeDir.temp('octipus-finish-');
  const src = exportCommit(root, commit);
  try {
    // What sign wrote, verified again here.
    const keysBytes = readFileUnder(relDir, 'keys/keys.json');
    const keysSig = readFileUnder(relDir, 'keys/keys.json.sig', { maxBytes: 4096 });
    if (sha256Hex(keysBytes) !== plan.keys.sha256) stop('release/keys/keys.json is not the plan\'s');
    const keys = verifyKeysJson(keysBytes, keysSig.toString('utf8'), rootPubs, { now });
    const pubs = keys.endorsed.map((k, i) => work.write(`k${i}.pub`, k.publicKey));
    const indexBytes = readFileUnder(relDir, 'signed/index.json', { maxBytes: LIMITS.indexBytes });
    const indexSig = readFileUnder(relDir, 'signed/index.json.sig', { maxBytes: 4096 });
    if (sha256Hex(indexBytes) !== signed.indexSha256) stop('signed/index.json is not the one sign wrote');
    const vf = work.write('index.json', indexBytes);
    work.write('index.json.sig', indexSig);
    const v = await cli.verifyIndex(vf, pubs);
    if (!v.valid) stop(`signed/index.json does not verify with an endorsed key: ${v.error ?? 'invalid'}`);
    const index = parseJson(indexBytes.toString('utf8'), 'signed/index.json');

    // published.json with the signed records, which must equal the signed index.
    const published = readPublished(src.root);
    const revoked = readRevoked(src.root);
    let next = published;
    for (const r of signed.records) {
      if (!r || Object.keys(r).sort().join(',') !== SIGNED_RECORD) stop(`signed.json: a record is { ${SIGNED_RECORD} }`);
      const planned = plan.packages.find((p) => p.name === r.name && p.version === r.version && p.kind === r.kind);
      if (!planned) stop(`signed.json: ${r.name} ${r.version} is not in the plan`);
      if (r.kind === 'new') {
        const p = (pending.records ?? []).find((x) => x.name === r.name && x.version === r.version);
        if (!p) stop(`pending.json has no ${r.name} ${r.version}`);
        if (p.record?.commit !== commit || p.record?.dir !== r.name || p.record?.contentHash !== planned.contentHash) stop(`pending.json: ${r.name} ${r.version} is not for this plan`);
        next = withPublished(next, r.name, r.version, { sha256: r.sha256, ...p.record, keyId: r.keyId, signatureFile: r.signatureFile });
      } else {
        next = withPublished(next, r.name, r.version, { ...next[r.name][r.version], sha256: r.sha256, keyId: r.keyId, signatureFile: r.signatureFile, resignedAt: iso(now) });
      }
    }
    if (signed.records.length !== plan.packages.length) stop('signed.json does not sign every package of the plan');
    validatePublished(next);
    const problems = anchorProblems(index, next, revoked);
    if (problems.length) stop(`the signed index and the new published.json disagree:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

    // dist/.
    const dist = freshOut(out, DIST_MARKER, root);
    for (const e of index.packages) {
      const name = tarballName(e.name, e.version);
      const fromSigned = signed.records.some((r) => r.name === e.name && r.version === e.version);
      const bytes = readFileUnder(relDir, `${fromSigned ? 'signed/dl' : 'dl'}/${name}`, { maxBytes: LIMITS.tarballBytes });
      if (sha256Hex(bytes) !== hex(e.sha256)) stop(`dl/${name} does not match its index entry`);
      dist.write(`dl/${name}`, bytes);
    }
    dist.write('index.json', indexBytes);
    dist.write('index.json.sig', indexSig);
    dist.write('keys.json', keysBytes);
    dist.write('keys.json.sig', keysSig);
    for (const k of keys.endorsed) dist.write(`keys/${k.keyId.slice('ed25519:'.length, 'ed25519:'.length + 16)}.pub`, k.publicKey);

    // The site, built into a directory of its own and copied (regular files only).
    // stats.json (unsigned, display only), validated and written anew.
    let statsFile = null;
    if (stats) {
      const text = serializeStats(validateStats(parseJson(readRegularFile(resolve(stats), { encoding: 'utf8', maxBytes: 4 * 1024 * 1024 }), 'stats.json')));
      statsFile = work.write('stats.json', text);
      dist.write('stats.json', text);
    }
    const siteOut = work.path('site');
    buildSite(vf, siteOut, log, statsFile);
    dist.copyTree(siteOut, '', '');
    // The listing images, from the committed tree, at paths checkListing accepted.
    const { sources } = readSources(src);
    for (const [name, s] of Object.entries(sources)) {
      if (!next[name]) continue;
      for (const img of new Set(listingImages(s.listing))) dist.copyFile(src.root, `${PLUGINS_DIR}/${name}/${img}`, `${name}/${img}`, { maxBytes: LIMITS.screenshotBytes });
    }

    overwriteRegular(root, 'published.json', serializePublished(next));
    const names = signed.records.map((r) => `${r.name} ${r.version}`);
    log([
      '',
      `Published to ${dist.root}.`,
      '',
      'Next:',
      `  1. Deploy ${dist.root}/ to plugins.octipus.cc as it is, e.g.`,
      `       rsync -a --delete --filter 'P stats.json' ${dist.root}/ <server>:/var/www/plugins.octipus.cc/`,
      '     (serve _headers as the site\'s headers, or the nginx config in README.md).',
      names.length ? `  2. Commit and push published.json: git commit -m "Publish ${names.join(', ')}" published.json` : '  2. published.json is unchanged: nothing to commit.',
    ].join('\n'));
    return { commit, outDir: dist.root, index, published: next, newVersions: signed.records.filter((r) => r.kind === 'new').map((r) => ({ name: r.name, version: r.version })) };
  } finally {
    rmSync(work.root, { recursive: true, force: true });
    rmSync(src.root, { recursive: true, force: true });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' }, plan: { type: 'string' },
      'index-from': { type: 'string' }, 'no-previous-index': { type: 'boolean' }, 'keys-from': { type: 'string' }, 'previous-keys-from': { type: 'string' }, 'root-pub': { type: 'string', multiple: true },
      'build-record': { type: 'string' }, stats: { type: 'string' }, 'skip-ci-compare': { type: 'boolean' }, 'confirm-bypass': { type: 'string' }, 'resign-to': { type: 'string' },
      'github-repo': { type: 'string' }, 'no-fetch': { type: 'boolean' }, 'base-url': { type: 'string' },
    },
  });
  const root = REPO_ROOT;
  const rootPubs = values['root-pub'] ? values['root-pub'].map((p) => readRegularFile(resolve(p), { encoding: 'utf8', maxBytes: 64 * 1024 })) : undefined;
  if (cmd === 'build') {
    await publishBuild({
      root,
      out: values.out ? resolve(values.out) : undefined,
      indexFrom: values['index-from'] ?? LIVE_INDEX,
      noPreviousIndex: values['no-previous-index'] === true,
      keysFrom: values['keys-from'] ?? LIVE_KEYS,
      previousKeysFrom: values['previous-keys-from'],
      ...(rootPubs ? { rootPubs } : {}),
      buildRecord: values['build-record'],
      skipCiCompare: values['skip-ci-compare'] === true,
      confirmBypass: values['confirm-bypass'],
      resignTo: values['resign-to'] ?? null,
      githubRepo: values['github-repo'] ?? DEFAULT_GITHUB_REPO,
      fetch: values['no-fetch'] !== true,
      baseUrl: values['base-url'] ?? BASE_URL,
    });
  } else if (cmd === 'finish') {
    await publishFinish({ root, planFile: values.plan, stats: values.stats, out: values.out ? resolve(values.out) : undefined, ...(rootPubs ? { rootPubs } : {}), fetch: values['no-fetch'] !== true });
  } else {
    stop('npm run publish -- build … | finish --plan release/release-plan.json (signing is node scripts/sign.mjs)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`\npublish stopped: ${err.message}\n`);
    process.exit(1);
  });
}

