#!/usr/bin/env node
// The key session: sign what `npm run publish -- build` prepared.
//
//   node scripts/sign.mjs --plan release/release-plan.json --key <signing.key>
//        --root-pub <root.pub>… [--passphrase-file <path|->] [--yes]
//        [--keys-from <file|url>] [--index-from <file|url> | --no-previous-index]
//        [--previous-keys-from <file|url>]
//
// Run it with `node`, never through npm (npm would run a `presign` script of
// package.json, and read an .npmrc of the repository). It imports nothing
// but Node's built-ins, runs no other script of this repository, no npm, no
// Astro: the only program it starts is git and the pinned Octipus CLI
// ($OCTIPUS/node_modules/.bin/tsx … scripts/plugin.ts at OCTIPUS_REF, checked
// clean and an ancestor of its origin/main). Read it whole before a publish
// when `git diff` shows it changed.
//
// What it does, in order, stopping at the first doubt:
//  1. The pinned CLI; this repository clean at the plan's commit.
//  2. keys.json verified with the root public keys YOU hold (--root-pub,
//     outside the repository): the endorsed signing keys come from there,
//     never from keys/ in the repository (M5).
//  3. The last signed index (the live one by default) verified with an
//     endorsed key: the anchor.
//  4. The git diff stat of everything outside the plugin directories since
//     the last publish, for you to read.
//  5. For each package: the tarball build made, extracted here (regular
//     files only), its name, version, content hash and permissions from the
//     pinned CLI, compared with the plan, shown to you, and confirmed by you.
//     Then signed (the signature covers the content hash, not the tarball),
//     verified, and packed again with its signature by the pinned CLI.
//  6. The index: the plan's template with each new tarball's sha256 and key
//     id filled in, checked against the anchor (nothing published before
//     dropped or changed, no revocation undone), signed and verified.
// It writes only into a new directory (<plan dir>/signed), with O_EXCL.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { closeSync, constants as C, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_INDEX = 'https://plugins.octipus.cc/index.json';
export const LIVE_KEYS = 'https://plugins.octipus.cc/keys.json';
/** The domain prefix of a keys.json signature (agreed with Octipus's host side). */
export const KEYS_PREFIX = 'octipus-marketplace-keys/v1\n';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class SignError extends Error {}
const stop = (m) => { throw new SignError(m); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

/** JSON with sorted keys, so equal values compare equal. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** A relative path from a plan or a tarball: no `..`, nothing absolute, no backslash, no control character. */
export function safeRel(p, what = 'path') {
  if (typeof p !== 'string' || !p || p.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(p) || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) stop(`${what} ${JSON.stringify(String(p).slice(0, 200))} is not a safe relative path`);
  return p;
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Read a regular file without following a link at its last component. */
export function readRegular(file, maxBytes = 256 * 1024 * 1024) {
  let fd;
  try { fd = openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch (err) {
    if (err.code === 'ELOOP') stop(`${file} is a symbolic link`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) stop(`${file} is not a regular file`);
    if (st.size > maxBytes) stop(`${file} is larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size) stop(`${file} changed while it was read`);
    return buf;
  } finally { closeSync(fd); }
}

/** Write a new file (O_CREAT|O_EXCL|O_NOFOLLOW) in a directory this run created. */
export function writeNew(file, data, mode = 0o644) {
  const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally { closeSync(fd); }
}

/** Bytes from a file or an https URL (no redirects), at most `maxBytes`. */
export async function readSource(spec, maxBytes = 2 * 1024 * 1024) {
  if (/^https:\/\//.test(spec)) {
    const res = await fetch(spec, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) stop(`${spec}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) stop(`${spec} is larger than ${maxBytes} bytes`);
    return buf;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) stop(`${spec}: only a file or an https:// URL`);
  return readRegular(resolve(spec), maxBytes);
}

// ---------------------------------------------------------------- keys.json

/** The key id of a PEM public key: `ed25519:<sha256 hex of the raw 32 bytes>`. */
export function fingerprint(pem) {
  let key;
  try { key = createPublicKey(String(pem)); } catch (err) { stop(`not a readable public key: ${err.message}`); }
  if (key.asymmetricKeyType !== 'ed25519') stop('not an Ed25519 public key');
  const der = key.export({ format: 'der', type: 'spki' });
  return { key, keyId: `ed25519:${sha256Hex(der.subarray(ED25519_SPKI_PREFIX.length))}` };
}

/** A signature file in its canonical form only (as `octi plugin sign` writes it). */
export function parseSig(text) {
  let s;
  try { s = JSON.parse(text); } catch { stop('a signature file is not JSON'); }
  if (!isObj(s) || Object.keys(s).join(',') !== 'alg,keyId,signature' || s.alg !== 'ed25519' || !KEY_ID.test(s.keyId) || !/^[A-Za-z0-9+/]{86}==$/.test(s.signature)) stop('a signature file must be exactly { alg: "ed25519", keyId, signature }');
  if (`${JSON.stringify({ alg: s.alg, keyId: s.keyId, signature: s.signature }, null, 2)}\n` !== text) stop('a signature file is not in its canonical form');
  return s;
}

/** The bytes a keys.json signature is made over. */
export const keysMessage = (bytes) => Buffer.from(`${KEYS_PREFIX}sha256:${sha256Hex(bytes)}`, 'utf8');

/** Check a parsed keys.json strictly; returns it. */
export function checkKeysDoc(doc) {
  if (!isObj(doc) || Object.keys(doc).sort().join(',') !== 'generatedAt,revokedKeys,schema,signingKeys,version') stop('keys.json must have exactly schema, version, generatedAt, signingKeys and revokedKeys');
  if (doc.schema !== 1) stop('keys.json: schema must be 1');
  if (!Number.isSafeInteger(doc.version) || doc.version < 1) stop('keys.json: version must be a positive integer');
  if (typeof doc.generatedAt !== 'string' || !ISO_Z.test(doc.generatedAt)) stop('keys.json: generatedAt must be an ISO time (…Z)');
  if (!Array.isArray(doc.signingKeys) || !Array.isArray(doc.revokedKeys)) stop('keys.json: signingKeys and revokedKeys must be lists');
  const ids = new Set();
  for (const k of doc.signingKeys) {
    const keys = isObj(k) ? Object.keys(k).sort().join(',') : '';
    if (keys !== 'keyId,publicKey' && keys !== 'keyId,notAfter,publicKey') stop(`keys.json: a signing key is { keyId, publicKey, notAfter? }: ${stable(k).slice(0, 200)}`);
    if (typeof k.publicKey !== 'string' || fingerprint(k.publicKey).keyId !== k.keyId) stop(`keys.json: ${k.keyId} does not match its publicKey`);
    if ('notAfter' in k && (typeof k.notAfter !== 'string' || !ISO_Z.test(k.notAfter))) stop(`keys.json: ${k.keyId}: notAfter must be an ISO time (…Z)`);
    if (ids.has(k.keyId)) stop(`keys.json: ${k.keyId} is listed twice`);
    ids.add(k.keyId);
  }
  for (const r of doc.revokedKeys) {
    if (!isObj(r) || Object.keys(r).sort().join(',') !== 'keyId,reason' || !KEY_ID.test(r.keyId) || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 300) stop(`keys.json: a revoked key is { keyId, reason }: ${stable(r).slice(0, 200)}`);
    if (ids.has(r.keyId)) stop(`keys.json: ${r.keyId} is both a signing key and revoked`);
    ids.add(r.keyId);
  }
  return doc;
}

/**
 * Verify keys.json (its exact bytes) and keys.json.sig with the root public
 * keys. Returns `{ doc, rootKeyId, endorsed: [{ keyId, publicKey }] }`; the
 * endorsed keys are the signing keys not revoked and not past notAfter.
 *
 * Verification needs only node:crypto. TODO(octipus): signing keys.json is
 * `octi plugin sign-keys` (scripts/keys.mjs); once Octipus also has
 * `octi plugin verify-keys`, call that here instead.
 */
export function verifyKeysJson(bytes, sigText, rootPems, { now = new Date() } = {}) {
  if (!rootPems.length) stop('no root public key to verify keys.json with');
  const sig = parseSig(sigText);
  const roots = rootPems.map((p) => fingerprint(p));
  const root = roots.find((r) => r.keyId === sig.keyId);
  if (!root) stop(`keys.json is signed by ${sig.keyId}, which is none of the root keys (${roots.map((r) => r.keyId).join(', ')})`);
  if (!edVerify(null, keysMessage(bytes), root.key, Buffer.from(sig.signature, 'base64'))) stop('keys.json.sig does not verify: keys.json was changed, or the signature is not over it');
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { stop('keys.json is not JSON'); }
  checkKeysDoc(doc);
  const endorsed = doc.signingKeys.filter((k) => !k.notAfter || Date.parse(k.notAfter) > now.getTime()).map((k) => ({ keyId: k.keyId, publicKey: k.publicKey }));
  return { doc, rootKeyId: root.keyId, endorsed };
}

// ---------------------------------------------------------------- the pinned CLI

/** The commit in OCTIPUS_REF of `repo`: 40 hex, nothing else. */
export function readOctipusRef(repo) {
  const text = readRegular(join(repo, 'OCTIPUS_REF'), 4096).toString('utf8');
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line || !HEX40.test(line)) stop('OCTIPUS_REF must name a full 40-hex commit');
  return line;
}

const gitIn = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * The pinned Octipus CLI: $OCTIPUS (default ../octipus) at exactly
 * OCTIPUS_REF, clean, OCTIPUS_REF an ancestor of its origin/main, started
 * as $OCTIPUS/node_modules/.bin/tsx. $OCTI_CLI is refused. Returns
 * `{ dir, ref, run(cmd, args, { input, okCodes }) → { code, stdout, stderr } }`.
 */
export function pinnedCli({ repo = REPO, refRepo = repo, env = process.env } = {}) {
  if (env.OCTI_CLI !== undefined) stop('OCTI_CLI is set: the key session runs only the pinned Octipus CLI. Unset it.');
  const ref = readOctipusRef(refRepo);
  const dir = resolve(env.OCTIPUS || join(repo, '..', 'octipus'));
  let head;
  try { head = gitIn(dir, ['rev-parse', 'HEAD']); } catch { stop(`${dir} is not a git checkout of PatriceA/octipus (set OCTIPUS)`); }
  if (head !== ref) stop(`${dir} is at ${head}, not OCTIPUS_REF ${ref}`);
  const dirty = gitIn(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) stop(`${dir} is not clean:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  try { gitIn(dir, ['merge-base', '--is-ancestor', ref, 'origin/main']); } catch { stop(`OCTIPUS_REF ${ref} is not an ancestor of origin/main in ${dir} (git -C ${dir} fetch origin main)`); }
  const tsx = join(dir, 'node_modules', '.bin', 'tsx');
  try { lstatSync(tsx); } catch { stop(`${tsx} is missing: npm ci --ignore-scripts in ${dir}`); }
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS;
  const run = (cmd, args, { input, okCodes = [0] } = {}) => new Promise((ok, fail) => {
    const child = spawn(tsx, ['--tsconfig', join(dir, 'tsconfig.json'), join(dir, 'scripts', 'plugin.ts'), cmd, ...args], { env: childEnv, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => fail(new SignError(`octi plugin ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (!okCodes.includes(code)) fail(new SignError(`octi plugin ${cmd} exited ${code}: ${(stderr || stdout).trim().split('\n').slice(-10).join('\n')}`));
      else ok({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
  const json = async (cmd, args, opts) => {
    const r = await run(cmd, [...args, '--json'], opts);
    try { return JSON.parse(r.stdout); } catch { stop(`octi plugin ${cmd}: no JSON on stdout`); }
  };
  return { dir, ref, run, json };
}

// ---------------------------------------------------------------- the tarball

/**
 * Extract a package tarball (the format `octi plugin pack` writes: ustar
 * files and directories, pax `path` records) into the empty directory
 * `dest`. Anything else (a link, a device, an unknown pax key, a path
 * leaving the single top directory) stops it. Returns the top directory name.
 */
export function extractTarball(gz, dest) {
  const tar = gunzipSync(gz, { maxOutputLength: 260 * 1024 * 1024 });
  const str = (b, o, n) => { const s = b.subarray(o, o + n); const z = s.indexOf(0); return (z === -1 ? s : s.subarray(0, z)).toString('utf8'); };
  const oct = (b, o, n) => { const s = str(b, o, n).trim(); if (!/^[0-7]*$/.test(s)) stop('tarball: a bad number field'); return s ? parseInt(s, 8) : 0; };
  let off = 0;
  let paxPath = null;
  let top = null;
  const made = new Set();
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== oct(h, 148, 8)) stop('tarball: a header checksum does not match');
    if (str(h, 257, 6) !== 'ustar') stop('tarball: not ustar');
    const type = String.fromCharCode(h[156] || 48);
    const size = oct(h, 124, 12);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (body.length !== size) stop('tarball: truncated');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const text = body.toString('utf8');
      let i = 0;
      while (i < text.length) {
        const sp = text.indexOf(' ', i);
        const len = Number(text.slice(i, sp));
        const rec = text.slice(sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (!Number.isSafeInteger(len) || len <= 0 || rec.slice(0, eq) !== 'path') stop('tarball: a pax record other than path');
        paxPath = rec.slice(eq + 1);
        i += len;
      }
      continue;
    }
    const prefix = str(h, 345, 155);
    let path = paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    paxPath = null;
    if (type === '5') path = path.replace(/\/$/, '');
    safeRel(path, 'tarball entry');
    const first = path.split('/')[0];
    if (top === null) top = first;
    if (first !== top) stop('tarball: entries outside its one top directory');
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && !made.has(parent)) stop(`tarball: ${path} comes before its directory`);
    if (type === '5') {
      mkdirSync(join(dest, path), { mode: 0o755 });
      made.add(path);
    } else if (type === '0') {
      if (path === top) stop('tarball: a file at the top');
      writeNew(join(dest, path), body, oct(h, 100, 8) & 0o111 ? 0o755 : 0o644);
    } else {
      stop(`tarball: ${path} is of type ${JSON.stringify(type)}; only files and directories are accepted`);
    }
  }
  if (!top || !made.has(top)) stop('tarball: no top directory');
  return top;
}

// ---------------------------------------------------------------- the plan

/** Check a release plan strictly; returns it. */
export function checkPlan(plan) {
  const want = ['schema', 'kind', 'commit', 'octipusRef', 'createdAt', 'lastPublishCommit', 'previousIndex', 'keys', 'resignTo', 'packages', 'index', 'revocations', 'ciCompare'].sort().join(',');
  if (!isObj(plan) || Object.keys(plan).sort().join(',') !== want) stop(`the plan must have exactly ${want}`);
  if (plan.schema !== 1 || plan.kind !== 'octipus-plugins-release-plan') stop('not a release plan (schema 1)');
  if (!HEX40.test(plan.commit) || !HEX40.test(plan.octipusRef)) stop('plan: commit and octipusRef must be 40 hex');
  if (plan.lastPublishCommit !== null && !HEX40.test(plan.lastPublishCommit)) stop('plan: lastPublishCommit');
  if (plan.previousIndex !== null && (!isObj(plan.previousIndex) || !HEX64.test(plan.previousIndex.sha256))) stop('plan: previousIndex');
  if (!isObj(plan.keys) || !HEX64.test(plan.keys.sha256) || !Number.isSafeInteger(plan.keys.version) || !Array.isArray(plan.keys.endorsedKeyIds) || !plan.keys.endorsedKeyIds.every((k) => KEY_ID.test(k))) stop('plan: keys');
  if (plan.resignTo !== null && !KEY_ID.test(plan.resignTo)) stop('plan: resignTo');
  if (!isObj(plan.index) || !HEX64.test(plan.index.sha256)) stop('plan: index');
  safeRel(plan.index.template, 'plan index template');
  if (!Array.isArray(plan.packages) || plan.packages.length > 500) stop('plan: packages');
  const seen = new Set();
  for (const p of plan.packages) {
    if (!isObj(p) || Object.keys(p).sort().join(',') !== 'contentHash,kind,name,sha256,tarball,version') stop(`plan: a package is { kind, name, version, contentHash, sha256, tarball }: ${stable(p).slice(0, 200)}`);
    if (!['new', 'resign'].includes(p.kind) || !/^[a-z][a-z0-9-]{1,49}$/.test(p.name) || typeof p.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(p.version) || !/^sha256:[0-9a-f]{64}$/.test(p.contentHash) || !HEX64.test(p.sha256)) stop(`plan: package ${stable(p).slice(0, 200)}`);
    if (p.tarball !== `unsigned/${p.name}-${p.version}.tar.gz`) stop(`plan: ${p.name} ${p.version}: tarball must be unsigned/${p.name}-${p.version}.tar.gz`);
    if (seen.has(`${p.name}@${p.version}`)) stop(`plan: ${p.name} ${p.version} twice`);
    seen.add(`${p.name}@${p.version}`);
  }
  if (!isObj(plan.revocations) || !Array.isArray(plan.revocations.packages) || !Array.isArray(plan.revocations.keys)) stop('plan: revocations');
  if (!isObj(plan.ciCompare) || !['ci-run', 'none-needed', 'bypass'].includes(plan.ciCompare.mode)) stop('plan: ciCompare');
  return plan;
}

/**
 * The anchor, checked here as well as in build: every entry of the previous
 * index is in the new one with the same contentHash, permissions and
 * publishedAt (and the same sha256 and keyId unless re-signed now); every
 * new entry is a package signed now; no revocation is undone.
 */
export function anchorCheck(prev, next, plan, signingKeyId) {
  const byKey = new Map(next.packages.map((e) => [`${e.name}@${e.version}`, e]));
  const planned = new Map(plan.packages.map((p) => [`${p.name}@${p.version}`, p]));
  const prevKeys = new Set();
  for (const e of prev?.packages ?? []) {
    const k = `${e.name}@${e.version}`;
    prevKeys.add(k);
    const n = byKey.get(k);
    if (!n) stop(`${k} is in the last signed index and not in the new one: a published version is never dropped`);
    for (const f of ['contentHash', 'permissions', 'publishedAt']) if (stable(n[f]) !== stable(e[f])) stop(`${k}: ${f} differs from the last signed index`);
    const p = planned.get(k);
    if (p?.kind === 'new') stop(`${k} is already published: it cannot be signed as new`);
    if (p?.kind === 'resign') {
      if (n.keyId !== signingKeyId) stop(`${k}: re-signed, but not by ${signingKeyId}`);
    } else if (n.sha256 !== e.sha256 || n.keyId !== e.keyId) stop(`${k}: sha256 or keyId differs from the last signed index`);
  }
  for (const [k, p] of planned) {
    if (p.kind === 'resign' && !prevKeys.has(k)) stop(`${k} is to be re-signed but is not in the last signed index`);
  }
  for (const k of byKey.keys()) if (!prevKeys.has(k) && planned.get(k)?.kind !== 'new') stop(`${k} is in the new index but neither published before nor signed now`);
  const nextRevoked = new Set((next.revoked ?? []).map(stable));
  for (const r of prev?.revoked ?? []) if (!nextRevoked.has(stable(r))) stop(`the revocation ${stable(r)} of the last signed index is missing: a revocation is never undone`);
  if (prev && next.url !== prev.url) stop(`the index url changed: ${prev.url} → ${next.url}`);
  const origin = new URL(next.url).origin;
  for (const e of next.packages) if (e.url !== `${origin}/dl/${e.name}-${e.version}.tar.gz`) stop(`${e.name}@${e.version}: url ${e.url} is not ${origin}/dl/${e.name}-${e.version}.tar.gz`);
  return (next.revoked ?? []).filter((r) => !(prev?.revoked ?? []).some((q) => stable(q) === stable(r)));
}

// ---------------------------------------------------------------- the terminal

function askLine(prompt, { hidden = false } = {}) {
  return new Promise((ok, fail) => {
    if (!process.stdin.isTTY) { fail(new SignError(`no terminal to ask: ${prompt.trim()}`)); return; }
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stderr.write(prompt); };
    rl.question(prompt, (a) => { rl.close(); if (hidden) process.stderr.write('\n'); ok(a); });
    rl.on('SIGINT', () => { rl.close(); fail(new SignError('cancelled')); });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const loud = (lines) => ['', '!'.repeat(78), ...lines.map((l) => `!!  ${l}`), '!'.repeat(78), ''].join('\n');

// ---------------------------------------------------------------- the session

/** The newest commit published.json at HEAD names (the last publish), or null. */
function lastPublishCommit(repo) {
  let text;
  try { text = gitIn(repo, ['show', 'HEAD:published.json']); } catch { return null; }
  let best = null;
  for (const versions of Object.values(JSON.parse(text) ?? {})) {
    for (const r of Object.values(versions ?? {})) {
      if (!isObj(r) || !HEX40.test(r.commit)) stop('published.json at HEAD has a record without a 40-hex commit');
      const at = r.resignedAt ?? r.publishedAt;
      if (!best || at > best.at) best = { at, commit: r.commit };
    }
  }
  return best?.commit ?? null;
}

export async function sign(opts) {
  const { repo = REPO, planFile, key, rootPubs = [], passphraseFile, yes = false, keysFrom = LIVE_KEYS, indexFrom = LIVE_INDEX, noPreviousIndex = false, previousKeysFrom, env = process.env, log = (m) => process.stderr.write(`${m}\n`), now = new Date() } = opts;
  // 1. The CLI and the repository.
  const cli = pinnedCli({ repo, env });
  log(`Octipus CLI: ${cli.dir} at ${cli.ref} (clean, on origin/main)`);
  if (gitIn(repo, ['status', '--porcelain', '--untracked-files=all'])) stop(`${repo} is not clean`);
  const head = gitIn(repo, ['rev-parse', 'HEAD']);
  const planPath = resolve(planFile);
  const planDir = dirname(planPath);
  const plan = checkPlan(JSON.parse(readRegular(planPath, 4 * 1024 * 1024).toString('utf8')));
  if (plan.commit !== head) stop(`the plan is for ${plan.commit}, this checkout is at ${head}`);
  if (plan.octipusRef !== cli.ref) stop(`the plan was built with Octipus ${plan.octipusRef}, OCTIPUS_REF is ${cli.ref}`);
  if (lastPublishCommit(repo) !== plan.lastPublishCommit) stop('the plan names another last publish commit than published.json does');

  // The private key: outside the repository, encrypted, private.
  if (!key) stop('--key <signing key> is required');
  const keyPath = realpathSync(resolve(key));
  if (inside(keyPath, realpathSync(repo))) stop(`--key ${key} is inside the repository`);
  const pem = readRegular(keyPath, 64 * 1024).toString('utf8');
  if (!pem.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) stop(`--key ${key} is not an encrypted key (octi plugin keygen --passphrase-file -)`);
  if ((lstatSync(keyPath).mode & 0o077) !== 0) stop(`--key ${key} is readable by other users: chmod 600 it`);

  // 2. keys.json, with the root keys the key holder holds.
  if (!rootPubs.length) stop('--root-pub <file> is required: the root public key(s) you hold, outside the repository');
  const roots = rootPubs.map((p) => {
    const real = realpathSync(resolve(p));
    if (inside(real, realpathSync(repo))) stop(`--root-pub ${p} is inside the repository: use your own copy (a repository change must not choose the root)`);
    return readRegular(real, 64 * 1024).toString('utf8');
  });
  const keysBytes = await readSource(keysFrom);
  const keys = verifyKeysJson(keysBytes, (await readSource(`${keysFrom}.sig`, 4096)).toString('utf8'), roots, { now });
  if (sha256Hex(keysBytes) !== plan.keys.sha256) stop('keys.json is not the one the plan was built with');
  if (stable(keys.endorsed.map((k) => k.keyId)) !== stable(plan.keys.endorsedKeyIds)) stop('the endorsed keys differ from the plan');
  log(`keys.json v${keys.doc.version}, signed by root ${keys.rootKeyId}; endorsed: ${keys.endorsed.map((k) => k.keyId).join(', ') || 'none'}`);
  if (!keys.endorsed.length) stop('keys.json endorses no signing key');

  const work = mkdtempSync(join(tmpdir(), 'octipus-sign-'));
  try {
    const pubFiles = keys.endorsed.map((k, i) => { const f = join(work, `endorsed-${i}.pub`); writeNew(f, k.publicKey); return { ...k, file: f }; });

    // 3. The anchor.
    let prev = null;
    if (noPreviousIndex) {
      if (plan.previousIndex !== null) stop('--no-previous-index, but the plan was built against a previous index');
      log(loud(['--no-previous-index: there is no signed index to anchor to.', 'Use it ONLY for the very first publish of the marketplace.']));
    } else {
      if (plan.previousIndex === null) stop('the plan was built without a previous index: pass --no-previous-index (first publish only)');
      const bytes = await readSource(indexFrom);
      if (sha256Hex(bytes) !== plan.previousIndex.sha256) stop('the last signed index is not the one the plan was built against');
      const f = join(work, 'previous-index.json');
      writeNew(f, bytes);
      writeNew(`${f}.sig`, await readSource(`${indexFrom}.sig`, 4096));
      let verifiers = pubFiles;
      if (previousKeysFrom) {
        const old = await readSource(previousKeysFrom);
        const ok = verifyKeysJson(old, (await readSource(`${previousKeysFrom}.sig`, 4096)).toString('utf8'), roots, { now: new Date(0) });
        if (ok.doc.version >= keys.doc.version) stop('--previous-keys-from must be an older keys.json');
        log(loud([`--previous-keys-from: the last index may be signed by a key of keys.json v${ok.doc.version}.`, 'Only for a rotation after an emergency revocation.']));
        verifiers = [...pubFiles, ...ok.doc.signingKeys.map((k, i) => { const g = join(work, `previous-${i}.pub`); writeNew(g, k.publicKey); return { ...k, file: g }; })];
      }
      const v = await cli.json('verify-index', [f, ...verifiers.flatMap((k) => ['--pub', k.file])], { okCodes: [0, 1] });
      if (!v.valid) stop(`the last signed index does not verify with an endorsed key: ${v.error ?? 'invalid'}`);
      prev = JSON.parse(bytes.toString('utf8'));
      log(`last signed index: ${prev.packages?.length ?? 0} versions, signed by ${v.keyId}`);
    }

    // 4. What changed outside the plugins since the last publish.
    const since = plan.lastPublishCommit ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const stat = gitIn(repo, ['diff', '--stat=160', `${since}..${head}`, '--', '.', ':(exclude,glob)plugins/[!_]*/**']);
    log(`\nChanged outside plugins/<name>/ since ${plan.lastPublishCommit ? `the last publish (${since.slice(0, 12)})` : 'the first commit'}:\n${stat || '  (nothing)'}\n`);
    if (plan.ciCompare.mode === 'bypass') log(loud(['The CI compare was BYPASSED when this plan was built:', `  ${stable(plan.ciCompare).slice(0, 300)}`]));

    // The passphrase.
    let passphrase;
    if (passphraseFile === '-') { if (!yes) stop('--passphrase-file - reads stdin: pass --yes too (there is no terminal left to confirm on)'); passphrase = await readStdin(); } else if (passphraseFile) passphrase = readRegular(resolve(passphraseFile), 4096).toString('utf8');
    else passphrase = await askLine('Passphrase for the signing key: ', { hidden: true });
    if (yes) log(loud(['--yes: every package below is signed WITHOUT asking you.']));

    // 5. Each package.
    const out = join(planDir, 'signed');
    mkdirSync(out, { mode: 0o755 }); // EEXIST: never reuse an earlier signing's output
    mkdirSync(join(out, 'dl'), { mode: 0o755 });
    const records = [];
    let signingKeyId = null;
    for (const p of plan.packages) {
      const gz = readRegular(join(planDir, safeRel(p.tarball)));
      if (sha256Hex(gz) !== p.sha256) stop(`${p.tarball} is not the tarball the plan names`);
      const x = join(work, `x-${p.name}-${p.version}`);
      mkdirSync(x);
      const top = extractTarball(gz, x);
      if (top !== `${p.name}-${p.version}`) stop(`${p.tarball}: its directory is ${top}`);
      const dir = join(x, top);
      try { lstatSync(join(dir, 'octipus-plugin.sig')); stop(`${p.tarball} is already signed`); } catch (err) { if (err instanceof SignError) throw err; }
      readRegular(join(dir, 'octipus-plugin.json'), 256 * 1024);
      const h = await cli.json('hash', [dir]);
      if (h.name !== p.name || h.version !== p.version || h.contentHash !== p.contentHash) stop(`${p.tarball}: the CLI hashes it as ${h.name} ${h.version} ${h.contentHash}, the plan says ${p.name} ${p.version} ${p.contentHash}`);
      const again = await cli.json('pack', [dir, '--out', join(x, 'repack.tar.gz')]);
      if (again.sha256.replace(/^sha256:/, '') !== p.sha256) stop(`${p.tarball}: repacking it here gives another tarball`);
      const perm = await cli.json('permissions', [dir]);
      const known = prev?.packages?.find((e) => e.name === p.name && e.version === p.version);
      if (p.kind === 'new' && known) stop(`${p.name} ${p.version} is already published`);
      if (p.kind === 'resign' && (!known || known.contentHash !== p.contentHash)) stop(`${p.name} ${p.version}: re-signing must keep the published content hash`);
      log([
        '',
        `── ${p.kind === 'new' ? 'NEW' : 'RE-SIGN'} ${p.name} ${p.version}`,
        `   content hash  ${p.contentHash}`,
        `   tarball       sha256 ${p.sha256} (unsigned)`,
        `   permissions   ${JSON.stringify(perm, null, 2).split('\n').join('\n                 ')}`,
      ].join('\n'));
      if (!yes) {
        const a = await askLine(`Sign ${p.name} ${p.version}? Type "sign ${p.name} ${p.version}": `);
        if (a.trim() !== `sign ${p.name} ${p.version}`) stop(`not confirmed: ${p.name} ${p.version} is not signed, nothing is`);
      }
      await cli.run('sign', [dir, '--key', keyPath, '--passphrase-file', '-'], { input: passphrase });
      const sigText = readRegular(join(dir, 'octipus-plugin.sig'), 1024).toString('utf8');
      const sig = parseSig(sigText);
      const pub = pubFiles.find((k) => k.keyId === sig.keyId);
      if (!pub) stop(`--key is ${sig.keyId}, which keys.json does not endorse`);
      if (signingKeyId && signingKeyId !== sig.keyId) stop('the key changed between packages');
      signingKeyId = sig.keyId;
      if (plan.resignTo && plan.resignTo !== signingKeyId) stop(`the plan re-signs with ${plan.resignTo}, --key is ${signingKeyId}`);
      const v = await cli.json('verify', [dir, '--pub', pub.file], { okCodes: [0, 1] });
      if (!v.valid || v.contentHash !== p.contentHash || v.keyId !== signingKeyId) stop(`${p.name} ${p.version}: the signature does not verify (${v.error ?? 'mismatch'})`);
      const file = join(out, 'dl', `${p.name}-${p.version}.tar.gz`);
      const packed = await cli.json('pack', [dir, '--out', file]);
      if (packed.contentHash !== p.contentHash) stop(`${p.name} ${p.version}: the signed tarball has another content hash`);
      const sha256 = sha256Hex(readRegular(file));
      records.push({ name: p.name, version: p.version, kind: p.kind, sha256, keyId: signingKeyId, signatureFile: sigText });
      log(`   signed by ${signingKeyId} → dl/${p.name}-${p.version}.tar.gz (sha256 ${sha256})`);
    }

    // 6. The index.
    const tBytes = readRegular(join(planDir, plan.index.template), 2 * 1024 * 1024);
    if (sha256Hex(tBytes) !== plan.index.sha256) stop('the index template is not the one the plan names');
    const index = JSON.parse(tBytes.toString('utf8'));
    if (!isObj(index) || index.schema !== 2 || !Array.isArray(index.packages) || !Array.isArray(index.revoked)) stop('the index template is not an index v2');
    for (const e of index.packages) {
      const r = records.find((x) => x.name === e.name && x.version === e.version);
      if (r) {
        if (e.sha256 !== null || e.keyId !== null) stop(`template ${e.name} ${e.version}: sha256 and keyId must be null, to be filled in here`);
        e.sha256 = r.sha256;
        e.keyId = r.keyId;
      } else if (!HEX64.test(e.sha256 ?? '') || !KEY_ID.test(e.keyId ?? '')) stop(`template ${e.name} ${e.version}: no sha256 or keyId, and it is not signed now`);
    }
    for (const r of records) if (!index.packages.some((e) => e.name === r.name && e.version === r.version)) stop(`the template has no entry for ${r.name} ${r.version}`);
    if (stable(index.revoked) !== stable([...plan.revocations.packages.map((p) => ({ name: p.name, version: p.version, reason: p.reason })), ...plan.revocations.keys.map((k) => ({ keyId: k.keyId, reason: k.reason }))])) stop('the index revocations differ from the plan');
    const fresh = anchorCheck(prev, index, plan, signingKeyId);
    log(`\nIndex: ${index.packages.length} versions at ${index.url}`);
    log(fresh.length ? `New revocations:\n${fresh.map((r) => `  - ${r.keyId ?? `${r.name} ${r.version}`}: ${r.reason}`).join('\n')}` : 'No new revocations.');
    if (!yes) {
      const a = await askLine('Sign the index? Type "sign the index": ');
      if (a.trim() !== 'sign the index') stop('not confirmed: the index is not signed');
    }
    const bytes = `${JSON.stringify(index, null, 2)}\n`;
    const indexFile = join(out, 'index.json');
    writeNew(indexFile, bytes);
    // With no package to sign (a listing or a revocation only), --key still
    // signs the index, and must be endorsed: verify-index below says so.
    await cli.run('sign-index', [indexFile, '--key', keyPath, '--passphrase-file', '-'], { input: passphrase });
    const vi = await cli.json('verify-index', [indexFile, ...pubFiles.flatMap((k) => ['--pub', k.file])], { okCodes: [0, 1] });
    if (!vi.valid) stop(`the new index does not verify with an endorsed key: ${vi.error ?? 'invalid'}`);
    if (signingKeyId && vi.keyId !== signingKeyId) stop('the index is signed by another key than the packages');
    writeNew(join(out, 'signed.json'), `${JSON.stringify({ schema: 1, kind: 'octipus-plugins-signed', commit: head, keyId: vi.keyId, indexSha256: sha256Hex(Buffer.from(bytes)), records }, null, 2)}\n`);
    log(`\nSigned: ${records.length} package(s) and the index (${vi.keyId}), in ${out}.\nNext (no key needed): npm run publish -- finish --plan ${planFile}`);
    return { out, records, keyId: vi.keyId };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' }, key: { type: 'string' }, 'root-pub': { type: 'string', multiple: true }, 'passphrase-file': { type: 'string' },
      yes: { type: 'boolean' }, 'keys-from': { type: 'string' }, 'index-from': { type: 'string' }, 'no-previous-index': { type: 'boolean' }, 'previous-keys-from': { type: 'string' },
    },
  });
  if (!values.plan) stop('--plan <release/release-plan.json> is required');
  await sign({
    planFile: values.plan, key: values.key, rootPubs: values['root-pub'] ?? [], passphraseFile: values['passphrase-file'], yes: values.yes === true,
    keysFrom: values['keys-from'] ?? LIVE_KEYS, indexFrom: values['index-from'] ?? LIVE_INDEX, noPreviousIndex: values['no-previous-index'] === true, previousKeysFrom: values['previous-keys-from'],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`\nsign stopped: ${err.message}\n`); process.exit(1); });
}
