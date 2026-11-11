#!/usr/bin/env node
// keys.json: which signing keys the marketplace's offline ROOT key endorses.
//
//   node scripts/keys.mjs sign   --root-pub <root.pub>… --key <root.key> (--previous <file|url> | --first)
//                                [--passphrase-file <path>] [--out-dir release-keys/] [--expires-days <n>]
//   node scripts/keys.mjs build  --root-pub <root.pub>… (--previous <file|url> | --first)
//                                [--out keys.json] [--expires-days <n>]
//   node scripts/keys.mjs verify --root-pub <root.pub>… <keys.json>
//
// Run it with `node`, never through npm (it refuses npm: npm would run a
// script of package.json and read an .npmrc of the repository next to the
// root key). Like scripts/sign.mjs it imports Node's built-ins and sign.mjs
// only, and the only programs it starts are git and the pinned Octipus CLI
// (pinnedCli: $OCTIPUS at exactly OCTIPUS_REF, clean, an ancestor of its
// origin/main). Read it whole before a root key session when it changed.
//
// keys.json is built from keys/endorsements.json and the .pub files it
// names (keys/README.md):
//
//   { "schema": 1, "version": <previous + 1>, "generatedAt": "…Z", "expires": "…Z",
//     "signingKeys": [{ "keyId", "publicKey", "notAfter"? }],
//     "revokedKeys": [{ "keyId", "reason" }] }
//
// and signed over `octipus-marketplace-keys/v1\nsha256:<hex of its exact
// bytes>` into keys.json.sig (the canonical signature file form) by the
// pinned Octipus CLI's `octi plugin sign-keys`.
//
// `sign`, in order, stopping at the first doubt:
//  1. This repository clean, on main, equal to origin/main (fetched); the
//     pinned CLI.
//  2. The root public keys from --root-pub, outside the repository (never
//     keys/root/: a pull request must not choose the root); the root key
//     outside the repository, encrypted, readable by you only.
//  3. The previous keys.json (the live one by default) verified with those
//     root keys; the new one built after it: its version only goes up, its
//     revocations only grow.
//  4. What changes, shown: signing keys added and removed, notAfter
//     changes, revocations added, the expiry. You type each added key id
//     (check it against the key holder's own record of the key), then
//     confirm.
//  5. Signed by the pinned CLI, verified with your root keys.
//
// `expires` is required (Octipus requires it, at most 90 days after
// generatedAt): generatedAt + 60 days by default (--expires-days, at most
// 90). Hosts refuse an expired keys.json, and with it the whole marketplace,
// so the root key holder signs a new one before then (a reminder is theirs
// to set).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  askLine, checkKeysDoc, checkPrivateKey, fingerprint, KEYS_MAX_DAYS, LIVE_KEYS, pinnedCli, readRegular, readRootPubs, readSource, refuseNpm, REPO, safeRel,
  SignError, stable, verifyKeysJson, writeNew,
} from './sign.mjs';

const stop = (m) => { throw new SignError(m); };
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** How long a keys.json is valid by default (days); hosts accept at most KEYS_MAX_DAYS (90). */
export const KEYS_EXPIRES_DAYS = 60;

/** `--expires-days`: a whole number of days, 1 to KEYS_MAX_DAYS. */
export function expiresDays(value, fallback = KEYS_EXPIRES_DAYS) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) stop(`--expires-days must be a whole number of days from 1 to ${KEYS_MAX_DAYS}, not ${JSON.stringify(value)}`);
  if (n > KEYS_MAX_DAYS) stop(`--expires-days ${n} is over the ${KEYS_MAX_DAYS} days hosts accept for keys.json`);
  return n;
}

/** The PEM texts of keys/root/*.pub: only to refuse a root key as a signing key, never to verify anything. */
function repoRootPems(repo) {
  let names;
  try { names = readdirSync(join(repo, 'keys', 'root')); } catch { return []; }
  return names.filter((n) => n.endsWith('.pub')).sort().map((n) => readRegular(join(repo, 'keys', 'root', safeRel(n)), 64 * 1024).toString('utf8'));
}

/** keys/endorsements.json, read strictly: { signingKeys: [{ file, keyId, publicKey, notAfter? }], revokedKeys }. */
export function readEndorsements(repo = REPO) {
  const e = JSON.parse(readRegular(join(repo, 'keys', 'endorsements.json'), 64 * 1024).toString('utf8'));
  if (!e || typeof e !== 'object' || Object.keys(e).sort().join(',') !== 'revokedKeys,signingKeys' || !Array.isArray(e.signingKeys) || !Array.isArray(e.revokedKeys)) stop('keys/endorsements.json must have exactly signingKeys and revokedKeys (lists)');
  const signingKeys = e.signingKeys.map((k) => {
    if (!k || typeof k !== 'object' || !Object.keys(k).every((x) => x === 'file' || x === 'notAfter')) stop(`keys/endorsements.json: a signing key is { file, notAfter? }: ${stable(k)}`);
    const rel = safeRel(k.file, 'keys/endorsements.json file');
    if (!rel.startsWith('signing/') || !rel.endsWith('.pub')) stop(`keys/endorsements.json: ${rel} is not keys/signing/<name>.pub`);
    const publicKey = readRegular(join(repo, 'keys', rel), 64 * 1024).toString('utf8');
    const out = { file: `keys/${rel}`, keyId: fingerprint(publicKey).keyId, publicKey };
    if (k.notAfter !== undefined) {
      if (typeof k.notAfter !== 'string' || !ISO_Z.test(k.notAfter)) stop(`keys/endorsements.json: ${rel}: notAfter is an ISO time (…Z)`);
      out.notAfter = k.notAfter;
    }
    return out;
  });
  for (const r of e.revokedKeys) if (!r || typeof r !== 'object') stop('keys/endorsements.json: a revoked key is { keyId, reason }');
  return { signingKeys, revokedKeys: e.revokedKeys };
}

/**
 * The keys.json document for `keys/endorsements.json`, after `previous` (a
 * verified keys.json document, or null for the first one). `roots`: root
 * public keys (PEM) that must not be endorsed as signing keys, besides
 * keys/root/*.pub.
 */
export function buildKeysDoc({ repo = REPO, previous = null, now = new Date(), expiresInDays = KEYS_EXPIRES_DAYS, roots = [] } = {}) {
  const e = readEndorsements(repo);
  const signingKeys = e.signingKeys.map(({ keyId, publicKey, notAfter }) => ({ keyId, publicKey, ...(notAfter !== undefined ? { notAfter } : {}) }));
  const rootIds = new Set([...repoRootPems(repo), ...roots].map((p) => fingerprint(p).keyId));
  for (const k of signingKeys) if (rootIds.has(k.keyId)) stop(`${k.keyId} is a root key: a root key never signs packages`);
  const revokedKeys = [...(previous?.revokedKeys ?? [])];
  for (const r of e.revokedKeys) if (!revokedKeys.some((q) => q.keyId === r.keyId)) revokedKeys.push({ keyId: r.keyId, reason: r.reason });
  for (const r of previous?.revokedKeys ?? []) if (!e.revokedKeys.some((q) => q.keyId === r.keyId)) stop(`keys/endorsements.json drops the revocation of ${r.keyId}: a revocation is never undone`);
  const doc = {
    schema: 1,
    version: previous ? previous.version + 1 : 1,
    generatedAt: isoZ(now),
    expires: isoZ(new Date(now.getTime() + expiresDays(expiresInDays) * 86_400_000)),
    signingKeys,
    revokedKeys,
  };
  checkKeysDoc(doc);
  if (!doc.signingKeys.length) stop('keys.json would endorse no signing key');
  return doc;
}

export const serializeKeys = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * What `next` changes against `previous` (null: the first keys.json):
 * `{ added, removed, notAfter, revoked }`, signing keys by key id.
 */
export function diffKeys(previous, next) {
  const was = new Map((previous?.signingKeys ?? []).map((k) => [k.keyId, k]));
  const now = new Map(next.signingKeys.map((k) => [k.keyId, k]));
  const wasRevoked = new Set((previous?.revokedKeys ?? []).map((r) => r.keyId));
  return {
    added: next.signingKeys.filter((k) => !was.has(k.keyId)),
    removed: [...was.values()].filter((k) => !now.has(k.keyId)),
    notAfter: next.signingKeys.filter((k) => was.has(k.keyId) && was.get(k.keyId).notAfter !== k.notAfter).map((k) => ({ keyId: k.keyId, from: was.get(k.keyId).notAfter ?? null, to: k.notAfter ?? null })),
    revoked: next.revokedKeys.filter((r) => !wasRevoked.has(r.keyId)),
  };
}

/** The diff as lines for the root key holder. */
export function describeKeysDiff(previous, next, files = new Map()) {
  const d = diffKeys(previous, next);
  const where = (k) => (files.get(k.keyId) ? ` (${files.get(k.keyId)})` : '');
  return [
    `keys.json ${previous ? `v${previous.version} (the published one)` : '(none published yet)'} → v${next.version}, expires ${next.expires}`,
    `Signing keys ADDED (${d.added.length}):`, ...(d.added.length ? d.added.map((k) => `  + ${k.keyId}${where(k)}${k.notAfter ? `, notAfter ${k.notAfter}` : ''}`) : ['  (none)']),
    `Signing keys REMOVED (${d.removed.length}):`, ...(d.removed.length ? d.removed.map((k) => `  - ${k.keyId}`) : ['  (none)']),
    ...(d.notAfter.length ? ['notAfter changed:', ...d.notAfter.map((x) => `  ~ ${x.keyId}: ${x.from ?? 'none'} → ${x.to ?? 'none'}`)] : []),
    `Revocations ADDED (${d.revoked.length}):`, ...(d.revoked.length ? d.revoked.map((r) => `  ! ${r.keyId}: ${r.reason}`) : ['  (none)']),
    `Signing keys endorsed after this: ${next.signingKeys.map((k) => k.keyId).join(', ')}`,
  ];
}

/**
 * Write `doc` as keys.json into the new directory `outDir` and sign it with
 * the root key through the pinned CLI (`octi plugin sign-keys`); verify the
 * result with `roots`. There is no other signer: no key is ever read here.
 */
export async function signKeysDoc({ repo = REPO, refRepo = repo, doc, key, passphrase, outDir, roots, env = process.env, now = new Date() }) {
  if (!roots?.length) stop('no root public key (--root-pub)');
  const keyPath = checkPrivateKey(key, repo, 'root.key');
  checkKeysDoc(doc);
  const cli = pinnedCli({ repo, refRepo, env });
  mkdirSync(outDir); // a new directory, never an old one
  const file = join(outDir, 'keys.json');
  writeNew(file, serializeKeys(doc));
  try {
    await cli.run('sign-keys', [file, '--key', keyPath, '--passphrase-file', '-'], { input: passphrase });
  } catch (err) {
    stop(`the pinned Octipus CLI did not sign keys.json (octi plugin sign-keys, Octipus bf9551be or later): ${err.message}`);
  }
  const v = verifyKeysJson(readRegular(file), readRegular(`${file}.sig`, 4096).toString('utf8'), roots, { now });
  if (stable(v.doc) !== stable(doc)) stop('the signed keys.json is not the one built');
  return { file, doc, rootKeyId: v.rootKeyId };
}

const gitIn = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Clean, on main, equal to origin/main (fetched first unless `fetch` is false). Returns HEAD. */
export function checkCleanMain(repo, { fetch = true } = {}) {
  const dirty = gitIn(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) stop(`${repo} is not clean:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  const branch = gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') stop(`on branch ${branch}: sign keys.json from main`);
  if (fetch) {
    try { gitIn(repo, ['fetch', '--quiet', 'origin', 'main']); } catch (err) { stop(`git fetch origin main failed: ${String(err.stderr ?? err.message).trim()}`); }
  }
  const head = gitIn(repo, ['rev-parse', 'HEAD']);
  let upstream;
  try { upstream = gitIn(repo, ['rev-parse', 'refs/remotes/origin/main']); } catch { stop('no origin/main to compare with'); }
  if (head !== upstream) stop(`main (${head.slice(0, 12)}) is not origin/main (${upstream.slice(0, 12)}): keys/ must be what was reviewed and merged`);
  return head;
}

/** The previous keys.json, verified with `roots` (whatever its age), or null with --first. */
export async function previousKeys({ first = false, previous, roots }) {
  if (first) {
    if (previous) stop('--first or --previous, not both');
    return null;
  }
  const spec = previous ?? LIVE_KEYS;
  const bytes = await readSource(spec);
  return verifyKeysJson(bytes, (await readSource(`${spec}.sig`, 4096)).toString('utf8'), roots, { now: new Date(0) }).doc;
}

/**
 * The root key session (`keys.mjs sign`): see the comment at the top.
 * `ask(prompt)` reads a line the key holder types (the terminal in main).
 */
export async function keysSession(opts) {
  const {
    repo = REPO, rootPubs = [], key, first = false, previous: previousFrom, passphrase, outDir, expiresInDays = KEYS_EXPIRES_DAYS,
    ask = (p) => askLine(p), env = process.env, fetch = true, now = new Date(), log = (m) => process.stderr.write(`${m}\n`),
  } = opts;
  // 1. The repository and the CLI.
  const head = checkCleanMain(repo, { fetch });
  const cli = pinnedCli({ repo, env });
  log(`Octipus CLI: ${cli.dir} at ${cli.ref} (clean, on origin/main); keys/ at ${head.slice(0, 12)} (clean, origin/main)`);
  // 2. The root keys you hold, and the root key.
  const roots = readRootPubs(rootPubs, repo);
  log(`root keys (--root-pub): ${roots.map((p) => fingerprint(p).keyId).join(', ')}`);
  checkPrivateKey(key, repo, 'root.key');
  // 3. The previous keys.json, and the new one.
  const prev = await previousKeys({ first, previous: previousFrom, roots });
  const doc = buildKeysDoc({ repo, previous: prev, now, expiresInDays, roots });
  // 4. What changes, typed and confirmed.
  const files = new Map(readEndorsements(repo).signingKeys.map((k) => [k.keyId, k.file]));
  log(['', ...describeKeysDiff(prev, doc, files), ''].join('\n'));
  const d = diffKeys(prev, doc);
  for (const k of d.added) {
    const a = String(await ask(`Endorse ${files.get(k.keyId) ?? 'a new key'}? Type its key id: `)).trim();
    if (a !== k.keyId) stop(`not confirmed: ${a ? `${a} is not ${k.keyId}` : `${k.keyId} was not typed`}; nothing is signed`);
  }
  const phrase = `sign keys.json v${doc.version}`;
  const a = String(await ask(`Type "${phrase}": `)).trim();
  if (a !== phrase) stop('not confirmed: keys.json is not signed');
  // 5. Signed and verified.
  let pass = passphrase;
  if (pass === undefined) pass = await askLine('Passphrase for the root key: ', { hidden: true });
  return signKeysDoc({ repo, doc, key, passphrase: pass, outDir, roots, env, now });
}

async function main() {
  refuseNpm();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'expires-days': { type: 'string' }, previous: { type: 'string' }, first: { type: 'boolean' }, out: { type: 'string' }, 'out-dir': { type: 'string' }, key: { type: 'string' }, 'passphrase-file': { type: 'string' }, 'root-pub': { type: 'string', multiple: true } },
  });
  const [cmd, file] = positionals;
  const expiresInDays = expiresDays(values['expires-days']);
  const roots = readRootPubs(values['root-pub'], REPO);
  if (cmd === 'verify') {
    if (!file) stop('verify <keys.json>');
    const v = verifyKeysJson(readRegular(resolve(file)), readRegular(resolve(`${file}.sig`), 4096).toString('utf8'), roots);
    process.stdout.write(`${file}: v${v.doc.version}, signed by root ${v.rootKeyId}, expires ${v.doc.expires}; endorsed: ${v.endorsed.map((k) => k.keyId).join(', ') || 'none'}\n`);
    return;
  }
  if (cmd === 'build') {
    const prev = await previousKeys({ first: values.first, previous: values.previous, roots });
    const doc = buildKeysDoc({ previous: prev, expiresInDays, roots });
    process.stderr.write(`${describeKeysDiff(prev, doc).join('\n')}\n`);
    writeNew(resolve(values.out ?? 'keys.json'), serializeKeys(doc));
    process.stdout.write(`wrote ${values.out ?? 'keys.json'} (v${doc.version}, unsigned)\n`);
    return;
  }
  if (cmd === 'sign') {
    if (values['passphrase-file'] === '-') stop('--passphrase-file -: the confirmations need the terminal; give a file, or type the passphrase when asked');
    const passphrase = values['passphrase-file'] ? readRegular(resolve(values['passphrase-file']), 4096).toString('utf8') : undefined;
    const r = await keysSession({ rootPubs: values['root-pub'], key: values.key, first: values.first === true, previous: values.previous, passphrase, outDir: resolve(values['out-dir'] ?? 'release-keys'), expiresInDays });
    process.stdout.write(`signed ${r.file} (v${r.doc.version}) with root ${r.rootKeyId}\nDeploy keys.json and keys.json.sig to plugins.octipus.cc/ before the next publish.\n`);
    process.stdout.write(`It expires at ${r.doc.expires}: hosts refuse it after that. Sign and deploy a new one before it is 60 days old; set yourself a reminder.\n`);
    return;
  }
  stop('keys.mjs sign | build | verify (see the comment at the top of scripts/keys.mjs)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`keys: ${err.message}\n`); process.exit(1); });
}
