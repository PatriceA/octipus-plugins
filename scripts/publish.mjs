#!/usr/bin/env node
// Publish the marketplace: run by the key holder on the publishing machine.
//
//   npm run publish -- --key <path> [--backup-pub <path>] [--passphrase-file <path|->]
//                      [--out dist/] [--build-record <file> | --skip-ci-compare] [--dry-run]
//
//  1. The worktree is clean, on main, and up to date with origin.
//  2. The new versions: plugins whose version is not in published.json.
//  3. Each is packed from the committed tree and compared with CI's
//     build-record.json for this commit (gh run download, or --build-record).
//  4. The package copy is signed (so the tarball carries octipus-plugin.sig)
//     and verified against keys/octipus.pub.
//  5. dist/dl/<name>-<version>.tar.gz, for the new versions and, rebuilt from
//     their commit and recorded signature, for every version published before.
//  6. Index v2 (docs/plans/marketplace.md), 7. signed and verified against keys/.
//  8. published.json updated.  9. The site built into dist/.  10. What to deploy and commit.
//
// --dry-run does all of it except signing and writing published.json.
// It never pushes and never uploads: you deploy dist/ yourself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { exportTree, git, headCommit } from './lib/git.mjs';
import { BASE_URL, buildIndex, serializeIndex, tarballName } from './lib/index-v2.mjs';
import { LISTING_FILE, listingImages } from './lib/listing.mjs';
import { cli, missingSubcommands, REPO_ROOT } from './lib/octi.mjs';
import { isSkipped, LIMITS, MANIFEST, PLUGINS_DIR, readPublished, readRevoked, withPublished, writeJson } from './lib/repo.mjs';
import { compareSemver, maxSemver } from './lib/semver.mjs';

const SIGNATURE_FILE = 'octipus-plugin.sig';
const DIST_MARKER = '.octipus-plugins-dist';

export class PublishError extends Error {}
const stop = (msg) => { throw new PublishError(msg); };

/** sha256 hex without a `sha256:` prefix, lower case. */
export const hex = (s) => String(s ?? '').replace(/^sha256:/, '').toLowerCase();

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** Ask for a passphrase at the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolvePromise, reject) => {
    if (!process.stdin.isTTY) { reject(new PublishError('the key is encrypted and there is no terminal to ask for its passphrase: pass --passphrase-file <path|->')); return; }
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stderr.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stderr.write('\n'); resolvePromise(answer); });
    rl.on('SIGINT', () => { rl.close(); reject(new PublishError('cancelled')); });
  });
}

async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** The checks on the key file: outside the repository, readable, encrypted. */
export function checkKeyFile(keyPath, root, { allowUnencrypted = false } = {}) {
  if (!existsSync(keyPath)) stop(`--key ${keyPath}: no such file`);
  const real = realpathSync(keyPath);
  const repo = realpathSync(root);
  if (isInside(real, repo)) stop(`--key ${keyPath} is inside the repository (${repo}). The private key never lives in octipus-plugins: keep it on the publishing machine, outside any checkout.`);
  const pem = readFileSync(real, 'utf8');
  const encrypted = pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
  if (!encrypted && !allowUnencrypted) stop(`--key ${keyPath} is not encrypted. Make the key with \`octi plugin keygen <prefix> --passphrase-file -\` (or pass --allow-unencrypted-key for a throwaway key).`);
  const warnings = [];
  if ((statSync(real).mode & 0o077) !== 0) warnings.push(`${keyPath} is readable by other users (mode ${(statSync(real).mode & 0o777).toString(8)}); chmod 600 it`);
  return { real, encrypted, warnings };
}

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

/** CI's build record for `commit`: from --build-record, or `gh run download`. */
function loadBuildRecord({ file, commit, skip, log }) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  if (skip) {
    log([
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '!!  --skip-ci-compare: the tarballs are NOT compared with what CI built.     !!',
      '!!  A tampered checkout on this machine would be signed without notice.      !!',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
    ].join('\n'));
    return null;
  }
  const gh = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  if (gh.status !== 0) stop('gh is not available to fetch CI\'s build-record.json: install gh, or download the build-record artifact of the build workflow for this commit and pass --build-record <file>.');
  const list = spawnSync('gh', ['run', 'list', '--workflow', 'build.yml', '--commit', commit, '--json', 'databaseId,status,conclusion', '--limit', '10'], { encoding: 'utf8' });
  if (list.status !== 0) stop(`gh run list failed: ${list.stderr.trim()}`);
  const runs = JSON.parse(list.stdout || '[]');
  const run = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (!run) stop(`no successful build workflow run for ${commit.slice(0, 12)} yet${runs.length ? ` (${runs.map((r) => `${r.status}/${r.conclusion || '…'}`).join(', ')})` : ''}: wait for CI, then run publish again.`);
  const dir = mkdtempSync(join(tmpdir(), 'octipus-build-record-'));
  try {
    const dl = spawnSync('gh', ['run', 'download', String(run.databaseId), '--name', 'build-record', '--dir', dir], { encoding: 'utf8' });
    if (dl.status !== 0) stop(`gh run download ${run.databaseId} failed: ${dl.stderr.trim()}`);
    return JSON.parse(readFileSync(join(dir, 'build-record.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The plugins of the exported tree: [{ dir, name, version, manifest }]. */
function exportedPlugins(src) {
  const base = join(src, PLUGINS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isSkipped(d.name))
    .map((d) => d.name)
    .sort()
    .flatMap((d) => {
      const text = readText(join(base, d, MANIFEST));
      if (text === null) return [];
      const manifest = JSON.parse(text);
      return [{ dir: d, name: manifest.name, version: manifest.version, manifest }];
    });
}

/** Prepare an empty output directory; refuse to empty one this script did not write. */
function prepareOut(out, root) {
  if (isInside(resolve(out), resolve(root, PLUGINS_DIR))) stop(`--out ${out} is inside plugins/`);
  if (existsSync(out)) {
    const entries = readdirSync(out);
    // Ours: written by publish (the marker) or by npm run build:site (csp.txt).
    if (entries.length && !entries.includes(DIST_MARKER) && !entries.includes('csp.txt')) stop(`--out ${out} is not empty and was not written by publish: choose another directory or empty it yourself`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(join(out, 'dl'), { recursive: true });
  writeFileSync(join(out, DIST_MARKER), 'Written by npm run publish (octipus-plugins). Deploy this directory to plugins.octipus.cc.\n');
}

/** Build the site from `indexFile` into `siteOut` (Astro, static). */
function buildSite(indexFile, siteOut, log) {
  const astro = join(REPO_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
  if (!existsSync(astro)) stop('Astro is not installed: run npm ci in octipus-plugins first');
  log('building the site');
  const r = spawnSync(process.execPath, [astro, 'build', '--root', join(REPO_ROOT, 'site'), '--silent'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, MARKETPLACE_INDEX: indexFile, SITE_OUT: siteOut, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  if (r.status !== 0) stop(`the site build failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-30).join('\n')}`);
}

/** Rebuild an older version's tarball from its commit and recorded signature, and check its sha256. */
async function rebuildPublished(root, name, version, rec, work, outFile) {
  if (!rec.commit || !rec.signatureFile) stop(`published.json: ${name} ${version} has no commit or signatureFile to rebuild its tarball from`);
  const src = join(work, `old-${name}-${version}`);
  exportTree(root, rec.commit, src, [`${PLUGINS_DIR}/${rec.dir ?? name}`]);
  const dir = join(src, PLUGINS_DIR, rec.dir ?? name);
  writeFileSync(join(dir, SIGNATURE_FILE), rec.signatureFile);
  const packed = await cli.pack(dir, outFile);
  if (hex(packed.sha256) !== hex(rec.sha256)) stop(`${name} ${version} rebuilt from ${rec.commit.slice(0, 12)} has sha256 ${hex(packed.sha256)}, not the published ${hex(rec.sha256)}: stop and find out why before publishing anything.`);
}

export async function publish(opts) {
  const {
    root = REPO_ROOT, key, backupPub, passphraseFile, out = join(root, 'dist'), buildRecord, skipCiCompare = false,
    dryRun = false, allowUnencryptedKey = false, fetch = true, baseUrl = BASE_URL, now = new Date(), log = (m) => process.stderr.write(`${m}\n`),
  } = opts;
  const outDir = resolve(out);
  const warnings = [];

  // 0. Node, the CLI, the keys.
  // The tarball's deflate stream comes from Node's bundled zlib: the same
  // Node as CI (.node-version) gives the same bytes. The hash compare below
  // catches any difference; this says why up front.
  const pinned = (readText(join(REPO_ROOT, '.node-version')) ?? '').trim().replace(/^v/, '');
  if (pinned && pinned !== process.versions.node) {
    if (pinned.split('.')[0] !== process.versions.node.split('.')[0]) stop(`this is Node ${process.versions.node}; CI builds with ${pinned} (.node-version). Use Node ${pinned.split('.')[0]} here, or the tarballs will not match CI's.`);
    warnings.push(`Node ${process.versions.node} here, ${pinned} in CI (.node-version): if the hash compare fails, use ${pinned}`);
  }
  const missing = await missingSubcommands();
  if (missing.length) stop(`the Octipus CLI has no ${missing.map((c) => `\`octi plugin ${c}\``).join(', ')}: update the checkout ($OCTIPUS) to the ref in OCTIPUS_REF`);
  const primaryPub = join(root, 'keys', 'octipus.pub');
  const backup = backupPub ? resolve(backupPub) : join(root, 'keys', 'octipus-backup.pub');
  const need = (msg) => { if (dryRun) warnings.push(msg); else stop(msg); };
  if (!existsSync(primaryPub)) need('keys/octipus.pub is missing: add the public half of the marketplace key (README, "Publishing")');
  if (!existsSync(backup)) need(`${backupPub ? backup : 'keys/octipus-backup.pub'} is missing: add the public half of the backup key (or pass --backup-pub)`);
  if (existsSync(primaryPub) && existsSync(backup) && readFileSync(primaryPub, 'utf8').trim() === readFileSync(backup, 'utf8').trim()) stop('the backup public key is the same as keys/octipus.pub: the backup must be a second key');
  let keyInfo = null;
  let passphrase;
  if (!dryRun) {
    if (!key) stop('--key <path> is required (the encrypted marketplace key, outside the repository)');
    keyInfo = checkKeyFile(resolve(key), root, { allowUnencrypted: allowUnencryptedKey });
    warnings.push(...keyInfo.warnings);
    if (keyInfo.encrypted) {
      if (passphraseFile === '-') passphrase = await readAllStdin();
      else if (passphraseFile) passphrase = readFileSync(resolve(passphraseFile), 'utf8');
      else passphrase = await askHidden('Passphrase for the marketplace key: ');
    }
  } else if (key) {
    checkKeyFile(resolve(key), root, { allowUnencrypted: true });
  }

  // 1. Clean, main, up to date.
  const commit = checkWorktree(root, { fetch });
  log(`publishing from ${commit.slice(0, 12)}${dryRun ? ' (dry run: nothing is signed, published.json is not written)' : ''}`);

  const published = readPublished(root);
  const revoked = readRevoked(root);
  const work = mkdtempSync(join(tmpdir(), 'octipus-publish-'));
  try {
    // The committed tree, exactly: never the working tree's ignored files.
    const src = join(work, 'src');
    exportTree(root, commit, src);
    const plugins = exportedPlugins(src);

    // 2. The new versions.
    const fresh = [];
    for (const p of plugins) {
      if (p.name !== p.dir) stop(`plugins/${p.dir} names "${p.name}" in its manifest: they must match (run npm run check)`);
      if (published[p.name]?.[p.version]) continue;
      const latest = maxSemver(Object.keys(published[p.name] ?? {}));
      if (latest && compareSemver(p.version, latest) <= 0) stop(`${p.name} ${p.version} is not greater than the published ${latest}`);
      fresh.push(p);
    }
    log(fresh.length ? `new: ${fresh.map((p) => `${p.name} ${p.version}`).join(', ')}` : 'no new versions: rebuilding the index and the site');

    // 3. Pack each from the committed tree and compare with CI's record.
    const record = fresh.length ? loadBuildRecord({ file: buildRecord, commit, skip: skipCiCompare, log }) : null;
    if (record && record.commit && record.commit !== commit) stop(`the build record is for ${record.commit.slice(0, 12)}, not ${commit.slice(0, 12)}`);
    const prepared = [];
    for (const p of fresh) {
      const dir = join(src, PLUGINS_DIR, p.dir);
      if (existsSync(join(dir, SIGNATURE_FILE))) stop(`plugins/${p.dir}/${SIGNATURE_FILE} is committed: a submission carries no signature; remove it`);
      const v = await cli.validate(dir);
      if (!v.ok) stop(`${p.name} ${p.version} does not validate:\n${(v.problems ?? []).map((x) => `  - ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}`);
      const permissions = await cli.permissions(dir);
      if (permissions.runtime === 'in-process') stop(`${p.name} is runtime "in-process": the marketplace carries sandboxed packages only`);
      const unsigned = await cli.pack(dir, join(work, `unsigned-${tarballName(p.name, p.version)}`));
      if (record) {
        const ci = (record.packages ?? []).find((x) => x.name === p.name && x.version === p.version);
        if (!ci) stop(`CI's build record for ${commit.slice(0, 12)} has no ${p.name} ${p.version}`);
        if (hex(ci.sha256) !== hex(unsigned.sha256) || ci.contentHash !== unsigned.contentHash) {
          stop(`${p.name} ${p.version} differs from what CI built:\n  here: sha256 ${hex(unsigned.sha256)}  ${unsigned.contentHash}\n  CI:   sha256 ${hex(ci.sha256)}  ${ci.contentHash}\nDo not sign it. Find out which side changed.`);
        }
        log(`  ${p.name} ${p.version}: matches CI (${unsigned.contentHash})`);
      }
      prepared.push({ ...p, dirName: p.dir, dir, permissions, contentHash: unsigned.contentHash });
    }

    // 4.-5. Sign the copy, verify it, pack the signed tarball.
    prepareOut(outDir, root);
    const records = {};
    for (const p of prepared) {
      let keyId = null;
      let signatureFile = null;
      if (!dryRun) {
        await cli.sign(p.dir, keyInfo.real, { passphrase });
        const v = await cli.verify(p.dir, primaryPub);
        if (!v.valid) stop(`${p.name} ${p.version}: the signature does not verify with keys/octipus.pub (${v.error ?? 'invalid'}). Is --key the marketplace key?`);
        if (v.contentHash !== p.contentHash) stop(`${p.name} ${p.version}: signed ${v.contentHash}, expected ${p.contentHash}`);
        keyId = v.keyId;
        signatureFile = readFileSync(join(p.dir, SIGNATURE_FILE), 'utf8');
      }
      const file = join(outDir, 'dl', tarballName(p.name, p.version));
      const packed = await cli.pack(p.dir, file);
      if (packed.contentHash !== p.contentHash) stop(`${p.name} ${p.version}: the signed tarball hashes to ${packed.contentHash}, expected ${p.contentHash}`);
      if (statSync(file).size > LIMITS.tarballBytes) stop(`${tarballName(p.name, p.version)} is over ${LIMITS.tarballBytes / 1024 / 1024} MB, more than a remote install reads`);
      const listing = JSON.parse(readText(join(p.dir, LISTING_FILE)) ?? '{}');
      records[p.name] = {
        version: p.version,
        record: {
          sha256: hex(packed.sha256),
          contentHash: p.contentHash,
          permissions: p.permissions,
          publishedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          keyId,
          signatureFile,
          commit,
          dir: p.dirName,
          description: p.manifest.description ?? '',
          apiVersion: p.manifest.apiVersion ?? null,
          minOctipus: listing.minOctipus ?? null,
          listing,
        },
      };
      log(`  ${p.name} ${p.version}: ${dryRun ? 'packed (unsigned: dry run)' : `signed by ${keyId}`} → dl/${tarballName(p.name, p.version)}`);
    }

    // Every version published before: rebuilt from its commit and recorded signature.
    for (const [name, versions] of Object.entries(published)) {
      for (const [version, rec] of Object.entries(versions)) {
        await rebuildPublished(root, name, version, rec, work, join(outDir, 'dl', tarballName(name, version)));
      }
    }

    // 6. Index v2.
    let next = published;
    for (const [name, { version, record: rec }] of Object.entries(records)) next = withPublished(next, name, version, rec);
    const sources = {};
    for (const p of plugins) {
      const d = join(src, PLUGINS_DIR, p.dir);
      const listing = JSON.parse(readText(join(d, LISTING_FILE)) ?? 'null');
      if (listing) sources[p.name] = { listing, readme: readText(join(d, 'README.md')), changelog: readText(join(d, 'CHANGELOG.md')) };
    }
    const index = buildIndex({ published: next, sources, revoked, generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), baseUrl });
    const indexBytes = serializeIndex(index);
    if (Buffer.byteLength(indexBytes) > LIMITS.indexBytes) stop(`index.json is ${Buffer.byteLength(indexBytes)} bytes; a host reads at most ${LIMITS.indexBytes}`);
    const indexFile = join(outDir, 'index.json');
    writeFileSync(indexFile, indexBytes);
    for (const e of index.packages) {
      const f = join(outDir, 'dl', tarballName(e.name, e.version));
      if (sha256File(f) !== hex(e.sha256)) stop(`dl/${tarballName(e.name, e.version)} does not match its index entry`);
    }

    // 7. Sign the index, verify it with keys/.
    if (!dryRun) {
      await cli.signIndex(indexFile, keyInfo.real, { passphrase });
      const v1 = await cli.verifyIndex(indexFile, [primaryPub]);
      if (!v1.valid) stop(`index.json.sig does not verify with keys/octipus.pub: ${v1.error ?? 'invalid'}`);
      const v2 = await cli.verifyIndex(indexFile, [primaryPub, backup]);
      if (!v2.valid) stop(`index.json.sig does not verify with the trusted keys: ${v2.error ?? 'invalid'}`);
      log(`index.json signed by ${v1.keyId}`);
    }

    // 8. published.json.
    if (!dryRun) writeJson(join(root, 'published.json'), next);

    // 9. The site, and the listing images it serves.
    const siteOut = join(work, 'site');
    buildSite(indexFile, siteOut, log);
    cpSync(siteOut, outDir, { recursive: true });
    for (const p of plugins) {
      const listing = sources[p.name]?.listing;
      if (!listing || !next[p.name]) continue;
      for (const img of listingImages(listing)) {
        const from = join(src, PLUGINS_DIR, p.dir, img);
        if (!existsSync(from)) continue;
        const to = join(outDir, p.name, img);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to);
      }
    }

    // The public keys, for admins setting up the registry by hand (the trust
    // anchor stays the repository's keys/ and Octipus's built-in entry).
    mkdirSync(join(outDir, 'keys'), { recursive: true });
    for (const [from, to] of [[primaryPub, 'octipus.pub'], [backup, 'octipus-backup.pub']]) if (existsSync(from)) cpSync(from, join(outDir, 'keys', to));

    // 10. What to do next.
    const lines = [
      '',
      dryRun ? 'Dry run done: nothing was signed and published.json is unchanged. Do NOT deploy this output.' : 'Published.',
      `  output: ${outDir}`,
      ...Object.entries(records).map(([n, { version }]) => `  new: ${n} ${version}`),
      ...warnings.map((w) => `  warning: ${w}`),
    ];
    if (!dryRun) {
      lines.push(
        '',
        'Next:',
        `  1. Deploy ${outDir}/ to plugins.octipus.cc as it is, e.g.`,
        `       rsync -a --delete ${outDir}/ <server>:/var/www/plugins.octipus.cc/`,
        '     (serve _headers as the site\'s headers, or set the CSP it names: see README.md).',
        ...(Object.keys(records).length ? [
          '  2. Commit and push the record of what is published:',
          `       git add published.json && git commit -m "Publish ${Object.entries(records).map(([n, { version }]) => `${n} ${version}`).join(', ')}" && git push`,
        ] : ['  2. published.json is unchanged: nothing to commit.']),
      );
    }
    log(lines.join('\n'));
    return { commit, outDir, index, published: next, newVersions: Object.entries(records).map(([name, { version }]) => ({ name, version })), warnings };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      'backup-pub': { type: 'string' },
      'passphrase-file': { type: 'string' },
      out: { type: 'string' },
      'build-record': { type: 'string' },
      'skip-ci-compare': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'allow-unencrypted-key': { type: 'boolean' },
      'no-fetch': { type: 'boolean' },
      root: { type: 'string' },
      'base-url': { type: 'string' },
    },
  });
  const root = resolve(values.root ?? REPO_ROOT);
  await publish({
    root,
    key: values.key,
    backupPub: values['backup-pub'],
    passphraseFile: values['passphrase-file'],
    out: values.out ? resolve(values.out) : join(root, 'dist'),
    buildRecord: values['build-record'] ? resolve(values['build-record']) : undefined,
    skipCiCompare: values['skip-ci-compare'] === true,
    dryRun: values['dry-run'] === true,
    allowUnencryptedKey: values['allow-unencrypted-key'] === true,
    fetch: values['no-fetch'] !== true,
    baseUrl: values['base-url'] ?? BASE_URL,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`\npublish stopped: ${err.message}\n`);
    process.exit(1);
  });
}

