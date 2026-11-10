// published.json and revoked.json: strict validation, the append-only rule,
// and the anchor to the last signed index (C1, H4, M4, L6, L7).
//
// Every value in these files ends up in a path, a command line or the signed
// index, so nothing is taken on trust: a record has exactly the fields
// publish writes, each in its exact form.
import { stableStringify } from './permissions.mjs';
import { checkListing } from './listing.mjs';
import { COMMIT_RE } from './git.mjs';

/** Octipus's package name rule (src/plugins/packages/manifest.ts). */
export const NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;

/**
 * Names a plugin cannot take: Octipus's own reserved names, and the paths the
 * site uses (`plugins.octipus.cc/<name>/`).
 */
export const RESERVED_NAMES = new Set(['octipus', 'mcp', 'system', 'plugin', 'publish', 'dl', 'index', 'schema', 'keys', 'design', 'icons', 'assets', 'search', 'category', 'categories', 'about', 'docs', '_astro', 'favicon', 'robots', 'sitemap', 'well-known', 'api', 'csp', 'headers', 'release', '404']);

/** semver.org without build metadata (L7): build metadata makes `1.0.0+x` equal `1.0.0`, so it is refused everywhere. */
export const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d{0,8}|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d{0,8}|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

const HEX64 = /^[0-9a-f]{64}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[0-9a-f]{64}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const SHORT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class RecordError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'RecordError';
    this.problems = problems;
  }
}

/** Why `name` cannot be a plugin name, or null. */
export function nameProblem(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return `${JSON.stringify(name)} is not a plugin name (lower-case letters, digits and -, starting with a letter, 2-50)`;
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved on plugins.octipus.cc; choose another name`;
  return null;
}

/** Why `version` cannot be a published version, or null. */
export function versionProblem(version) {
  if (typeof version !== 'string' || version.length > 64) return `${JSON.stringify(version)} is not a version`;
  if (version.includes('+')) return `version ${JSON.stringify(version)} has build metadata (+…): it compares equal to the version without it, so it is refused`;
  if (!VERSION_RE.test(version)) return `version ${JSON.stringify(version)} is not a semantic version (MAJOR.MINOR.PATCH[-pre])`;
  return null;
}

/** The canonical form of a signature file (Octipus's serializeSignature). */
export function serializeSignature(sig) {
  return `${JSON.stringify({ alg: sig.alg, keyId: sig.keyId, signature: sig.signature }, null, 2)}\n`;
}

/** Parse an `octipus-plugin.sig` text, accepting only its canonical form. Throws. */
export function parseSignatureFile(text) {
  if (typeof text !== 'string' || text.length > 1024) throw new Error('signatureFile is not a signature file (a string of at most 1 KiB)');
  let sig;
  try { sig = JSON.parse(text); } catch { throw new Error('signatureFile is not JSON'); }
  if (!sig || typeof sig !== 'object' || Array.isArray(sig) || Object.keys(sig).join(',') !== 'alg,keyId,signature') throw new Error('signatureFile must have exactly alg, keyId and signature');
  if (sig.alg !== 'ed25519' || !KEY_ID.test(sig.keyId) || !SIGNATURE.test(sig.signature)) throw new Error('signatureFile: alg ed25519, keyId ed25519:<64 hex>, signature base64 of 64 bytes');
  if (serializeSignature(sig) !== text) throw new Error('signatureFile is not in the canonical form octi plugin sign writes');
  return sig;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The exact fields of a published.json record; `resignedAt` only after a key rotation. */
const RECORD_FIELDS = ['sha256', 'contentHash', 'permissions', 'publishedAt', 'keyId', 'signatureFile', 'commit', 'dir', 'description', 'apiVersion', 'minOctipus', 'listing'];
const OPTIONAL_FIELDS = ['resignedAt'];

/** Problems with one record (empty when it is exactly what publish writes). */
export function recordProblems(name, version, rec) {
  const at = `published.json ${name} ${version}`;
  const p = [];
  if (!isObj(rec)) return [`${at}: not an object`];
  for (const k of Object.keys(rec)) if (!RECORD_FIELDS.includes(k) && !OPTIONAL_FIELDS.includes(k)) p.push(`${at}: unknown field "${k}"`);
  for (const k of RECORD_FIELDS) if (!(k in rec)) p.push(`${at}: missing "${k}"`);
  if (p.length) return p;
  if (typeof rec.sha256 !== 'string' || !HEX64.test(rec.sha256)) p.push(`${at}: sha256 must be 64 lower-case hex`);
  if (typeof rec.contentHash !== 'string' || !CONTENT_HASH.test(rec.contentHash)) p.push(`${at}: contentHash must be sha256:<64 hex>`);
  if (typeof rec.keyId !== 'string' || !KEY_ID.test(rec.keyId)) p.push(`${at}: keyId must be ed25519:<64 hex>`);
  if (typeof rec.commit !== 'string' || !COMMIT_RE.test(rec.commit)) p.push(`${at}: commit must be a 40-hex commit id`);
  if (rec.dir !== name) p.push(`${at}: dir must be "${name}" (plugins/<name>)`);
  if (typeof rec.publishedAt !== 'string' || !ISO_Z.test(rec.publishedAt) || Number.isNaN(Date.parse(rec.publishedAt))) p.push(`${at}: publishedAt must be an ISO time (…Z)`);
  if ('resignedAt' in rec && (typeof rec.resignedAt !== 'string' || !ISO_Z.test(rec.resignedAt))) p.push(`${at}: resignedAt must be an ISO time (…Z)`);
  if (typeof rec.description !== 'string' || rec.description.length > 2000) p.push(`${at}: description must be a string of at most 2000 characters`);
  if (rec.apiVersion !== null && (typeof rec.apiVersion !== 'string' || !SHORT_SEMVER.test(rec.apiVersion))) p.push(`${at}: apiVersion must be x.y.z or null`);
  if (rec.minOctipus !== null && (typeof rec.minOctipus !== 'string' || !SHORT_SEMVER.test(rec.minOctipus))) p.push(`${at}: minOctipus must be x.y.z or null`);
  try {
    const sig = parseSignatureFile(rec.signatureFile);
    if (sig.keyId !== rec.keyId) p.push(`${at}: signatureFile is by ${sig.keyId}, the record says ${rec.keyId}`);
  } catch (err) {
    p.push(`${at}: ${err.message}`);
  }
  if (!isObj(rec.permissions)) p.push(`${at}: permissions must be an object`);
  else if (rec.permissions.name !== name || rec.permissions.version !== version) p.push(`${at}: permissions are for ${rec.permissions.name} ${rec.permissions.version}`);
  if (!isObj(rec.listing)) p.push(`${at}: listing must be an object`);
  else for (const l of checkListing(rec.listing)) p.push(`${at}: listing: ${l}`);
  return p;
}

/** Validate a parsed published.json; returns it, or throws RecordError with every problem. */
export function validatePublished(data) {
  const p = [];
  if (!isObj(data)) throw new RecordError(['published.json: expected an object of name → version → record']);
  for (const [name, versions] of Object.entries(data)) {
    const np = nameProblem(name);
    if (np) { p.push(`published.json: ${np}`); continue; }
    if (!isObj(versions) || Object.keys(versions).length === 0) { p.push(`published.json ${name}: expected an object of version → record`); continue; }
    for (const [version, rec] of Object.entries(versions)) {
      const vp = versionProblem(version);
      if (vp) { p.push(`published.json ${name}: ${vp}`); continue; }
      p.push(...recordProblems(name, version, rec));
    }
  }
  if (p.length) throw new RecordError(p);
  return data;
}

/** Validate a parsed revoked.json (`{ packages: [{ name, version, reason }], keys: [{ keyId, reason }] }`). */
export function validateRevoked(data) {
  const p = [];
  if (!isObj(data) || Object.keys(data).sort().join(',') !== 'keys,packages') throw new RecordError(['revoked.json: expected exactly { "packages": [...], "keys": [...] }']);
  if (!Array.isArray(data.packages)) p.push('revoked.json: "packages" must be a list');
  if (!Array.isArray(data.keys)) p.push('revoked.json: "keys" must be a list');
  if (p.length) throw new RecordError(p);
  const reasonOk = (r) => typeof r === 'string' && r.trim().length > 0 && r.length <= 300 && !/[\p{Cc}\p{Cf}]/u.test(r);
  const seen = new Set();
  for (const e of data.packages) {
    const at = `revoked.json package ${JSON.stringify(e)}`;
    if (!isObj(e) || Object.keys(e).sort().join(',') !== 'name,reason,version') { p.push(`${at}: needs exactly name, version and reason`); continue; }
    const np = typeof e.name === 'string' && NAME_RE.test(e.name) ? null : 'not a plugin name';
    const vp = versionProblem(e.version);
    if (np || vp) p.push(`${at}: ${np ?? vp}`);
    if (!reasonOk(e.reason)) p.push(`${at}: reason must be plain text of at most 300 characters`);
    const k = `${e.name}@${e.version}`;
    if (seen.has(k)) p.push(`${at}: listed twice`);
    seen.add(k);
  }
  for (const e of data.keys) {
    const at = `revoked.json key ${JSON.stringify(e)}`;
    if (!isObj(e) || Object.keys(e).sort().join(',') !== 'keyId,reason') { p.push(`${at}: needs exactly keyId and reason`); continue; }
    if (typeof e.keyId !== 'string' || !KEY_ID.test(e.keyId)) p.push(`${at}: keyId must be ed25519:<64 hex>`);
    if (!reasonOk(e.reason)) p.push(`${at}: reason must be plain text of at most 300 characters`);
    if (seen.has(e.keyId)) p.push(`${at}: listed twice`);
    seen.add(e.keyId);
  }
  if (p.length) throw new RecordError(p);
  return data;
}

/**
 * The append-only rule between a base and a head published.json (CI, H4):
 * every base record is in head, unchanged. Returns `{ changed: [], removed: [], added: [] }`
 * as `name@version` strings.
 */
export function publishedDiff(base, head) {
  const changed = [];
  const removed = [];
  const added = [];
  for (const [name, versions] of Object.entries(base ?? {})) {
    for (const [version, rec] of Object.entries(versions ?? {})) {
      const now = head?.[name]?.[version];
      if (now === undefined) removed.push(`${name}@${version}`);
      else if (stableStringify(now) !== stableStringify(rec)) changed.push(`${name}@${version}`);
    }
  }
  for (const [name, versions] of Object.entries(head ?? {})) {
    for (const version of Object.keys(versions ?? {})) if (base?.[name]?.[version] === undefined) added.push(`${name}@${version}`);
  }
  return { changed, removed, added };
}

/**
 * The append-only rule for revoked.json (M4): head's lists start with base's
 * lists, entry for entry. Returns the problems.
 */
export function revokedDiff(base, head) {
  const p = [];
  for (const list of ['packages', 'keys']) {
    const b = base?.[list] ?? [];
    const h = head?.[list] ?? [];
    for (let i = 0; i < b.length; i += 1) {
      if (i >= h.length) p.push(`revoked.json: ${list} entry ${stableStringify(b[i])} was removed (un-revoking is refused)`);
      else if (stableStringify(b[i]) !== stableStringify(h[i])) p.push(`revoked.json: ${list} entry ${stableStringify(b[i])} was changed or moved (entries are append-only)`);
    }
  }
  return p;
}

/** The fields of an index entry that never change once a version is published (a key rotation changes sha256 and keyId together). */
export const ANCHORED_FIELDS = ['contentHash', 'permissions', 'publishedAt'];

/**
 * The anchor (C1, H4, M4): the local published.json and revoked.json against
 * the last signed index. Every `name@version` of the index is in
 * published.json with the same sha256, contentHash, keyId, permissions and
 * publishedAt; every published.json record is in the index (only publish
 * appends, after signing); every revocation of the index is in revoked.json.
 * Returns the problems.
 */
export function anchorProblems(signedIndex, published, revoked) {
  const p = [];
  const inIndex = new Set();
  for (const e of signedIndex?.packages ?? []) {
    const key = `${e.name}@${e.version}`;
    inIndex.add(key);
    const rec = published?.[e.name]?.[e.version];
    if (!rec) { p.push(`${key} is in the last signed index but not in published.json: a published version is never dropped (commit the published.json of the last publish)`); continue; }
    for (const f of [...ANCHORED_FIELDS, 'sha256', 'keyId']) {
      const a = f === 'sha256' ? String(e.sha256 ?? '').replace(/^sha256:/, '') : e[f];
      if (stableStringify(a) !== stableStringify(rec[f])) p.push(`${key}: published.json's ${f} differs from the last signed index`);
    }
  }
  for (const [name, versions] of Object.entries(published ?? {})) {
    for (const version of Object.keys(versions ?? {})) {
      if (!inIndex.has(`${name}@${version}`)) p.push(`${name}@${version} is in published.json but not in the last signed index: only publish adds records, after it signs`);
    }
  }
  const revokedKeys = new Set([...(revoked?.packages ?? []).map((r) => `${r.name}@${r.version}`), ...(revoked?.keys ?? []).map((r) => r.keyId)]);
  for (const r of signedIndex?.revoked ?? []) {
    const k = r.keyId ?? `${r.name}@${r.version}`;
    if (!revokedKeys.has(k)) p.push(`${k} is revoked in the last signed index but not in revoked.json: a revocation is never undone`);
  }
  return p;
}
