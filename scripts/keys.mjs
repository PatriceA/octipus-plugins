#!/usr/bin/env node
// keys.json: which signing keys the marketplace's offline ROOT key endorses.
//
//   node scripts/keys.mjs build  (--previous <file|url> | --first) [--out keys.json]
//   node scripts/keys.mjs sign   (--previous <file|url> | --first) --key <root.key>
//                                [--passphrase-file <path|->] [--out-dir release-keys/]
//   node scripts/keys.mjs verify <keys.json> [--root-pub <file>…]
//
// (`npm run keys -- …` is the same; in the root key session run it with
// `node`, as scripts/sign.mjs, so no npm script or .npmrc of the repository
// runs next to the key.)
//
// keys.json is built from keys/endorsements.json and the .pub files it
// names (keys/README.md):
//
//   { "schema": 1, "version": <previous + 1>, "generatedAt": "…Z",
//     "signingKeys": [{ "keyId", "publicKey", "notAfter"? }],
//     "revokedKeys": [{ "keyId", "reason" }] }
//
// and signed over `octipus-marketplace-keys/v1\nsha256:<hex of its exact
// bytes>` into keys.json.sig (the canonical signature file form). Its
// version only goes up and its revocations only grow: both are checked
// against the previous keys.json (the live one), which must verify with a
// root key first. Like sign.mjs it imports Node's built-ins and sign.mjs only.
import { realpathSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkKeysDoc, fingerprint, LIVE_KEYS, pinnedCli, readRegular, readSource, REPO, safeRel, SignError, stable, verifyKeysJson, writeNew } from './sign.mjs';

const stop = (m) => { throw new SignError(m); };
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The root public keys in keys/root/ (PEM texts). */
export function repoRootPubs(repo = REPO) {
  let names;
  try { names = readdirSync(join(repo, 'keys', 'root')); } catch { return []; }
  return names.filter((n) => n.endsWith('.pub')).sort().map((n) => readRegular(join(repo, 'keys', 'root', safeRel(n)), 64 * 1024).toString('utf8'));
}

/**
 * The keys.json document for `keys/endorsements.json`, after `previous` (a
 * verified keys.json document, or null for the first one).
 */
export function buildKeysDoc({ repo = REPO, previous = null, now = new Date() } = {}) {
  const e = JSON.parse(readRegular(join(repo, 'keys', 'endorsements.json'), 64 * 1024).toString('utf8'));
  if (!e || typeof e !== 'object' || Object.keys(e).sort().join(',') !== 'revokedKeys,signingKeys') stop('keys/endorsements.json must have exactly signingKeys and revokedKeys');
  const signingKeys = e.signingKeys.map((k) => {
    if (!k || typeof k !== 'object' || !Object.keys(k).every((x) => x === 'file' || x === 'notAfter')) stop(`keys/endorsements.json: a signing key is { file, notAfter? }: ${stable(k)}`);
    const rel = safeRel(k.file, 'keys/endorsements.json file');
    if (!rel.startsWith('signing/') || !rel.endsWith('.pub')) stop(`keys/endorsements.json: ${rel} is not keys/signing/<name>.pub`);
    const publicKey = readRegular(join(repo, 'keys', rel), 64 * 1024).toString('utf8');
    const out = { keyId: fingerprint(publicKey).keyId, publicKey };
    if (k.notAfter !== undefined) {
      if (typeof k.notAfter !== 'string' || !ISO_Z.test(k.notAfter)) stop(`keys/endorsements.json: ${rel}: notAfter is an ISO time (…Z)`);
      out.notAfter = k.notAfter;
    }
    return out;
  });
  const roots = new Set(repoRootPubs(repo).map((p) => fingerprint(p).keyId));
  for (const k of signingKeys) if (roots.has(k.keyId)) stop(`${k.keyId} is a root key: a root key never signs packages`);
  const revokedKeys = [...(previous?.revokedKeys ?? [])];
  for (const r of e.revokedKeys) if (!revokedKeys.some((q) => q.keyId === r.keyId)) revokedKeys.push({ keyId: r.keyId, reason: r.reason });
  for (const r of previous?.revokedKeys ?? []) if (!e.revokedKeys.some((q) => q.keyId === r.keyId)) stop(`keys/endorsements.json drops the revocation of ${r.keyId}: a revocation is never undone`);
  const doc = {
    schema: 1,
    version: previous ? previous.version + 1 : 1,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    signingKeys,
    revokedKeys,
  };
  checkKeysDoc(doc);
  if (!doc.signingKeys.length) stop('keys.json would endorse no signing key');
  return doc;
}

export const serializeKeys = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * Build keys.json into the new directory `outDir` and sign it with the root
 * key through the pinned CLI; verify the result with `roots`.
 */
export async function signKeys({ repo = REPO, key, passphrase, previous = null, outDir, roots, env = process.env, now = new Date() }) {
  if (!key) stop('--key <root.key> is required');
  if (!roots?.length) stop('no root public key (keys/root/*.pub, or --root-pub)');
  const keyPath = realpathSync(resolve(key));
  if (keyPath.startsWith(`${realpathSync(repo)}/`)) stop('--key is inside the repository');
  const doc = buildKeysDoc({ repo, previous, now });
  mkdirSync(outDir); // a new directory, never an old one
  const file = join(outDir, 'keys.json');
  writeNew(file, serializeKeys(doc));
  const cli = pinnedCli({ repo, env });
  // TODO(octipus): `octi plugin sign-keys <keys.json> --key <root.key>
  // [--passphrase-file <path|->] [--json]` does not exist in the pinned CLI
  // yet. Until it does, this stops here and nothing is signed (there is no
  // fallback signer next to the root key). It must write <keys.json>.sig,
  // the canonical signature file, over
  // `octipus-marketplace-keys/v1\nsha256:<hex of the exact bytes>`, and print
  // {"sigFile","sha256","keyId"} with --json, as sign-index does.
  try {
    await cli.run('sign-keys', [file, '--key', keyPath, '--passphrase-file', '-'], { input: passphrase });
  } catch (err) {
    stop(`the pinned Octipus CLI cannot sign keys.json yet (octi plugin sign-keys is missing or failed): ${err.message}`);
  }
  const v = verifyKeysJson(readRegular(file), readRegular(`${file}.sig`, 4096).toString('utf8'), roots, { now });
  return { file, doc, rootKeyId: v.rootKeyId };
}

async function previousDoc(values, roots) {
  if (values.first) {
    if (values.previous) stop('--first or --previous, not both');
    return null;
  }
  const spec = values.previous ?? LIVE_KEYS;
  const bytes = await readSource(spec);
  return verifyKeysJson(bytes, (await readSource(`${spec}.sig`, 4096)).toString('utf8'), roots, { now: new Date(0) }).doc;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { previous: { type: 'string' }, first: { type: 'boolean' }, out: { type: 'string' }, 'out-dir': { type: 'string' }, key: { type: 'string' }, 'passphrase-file': { type: 'string' }, 'root-pub': { type: 'string', multiple: true } },
  });
  const [cmd, file] = positionals;
  const roots = values['root-pub']?.length ? values['root-pub'].map((p) => readRegular(resolve(p), 64 * 1024).toString('utf8')) : repoRootPubs();
  if (cmd === 'verify') {
    if (!file) stop('verify <keys.json>');
    const v = verifyKeysJson(readRegular(resolve(file)), readRegular(resolve(`${file}.sig`), 4096).toString('utf8'), roots);
    process.stdout.write(`${file}: v${v.doc.version}, signed by root ${v.rootKeyId}; endorsed: ${v.endorsed.map((k) => k.keyId).join(', ') || 'none'}\n`);
    return;
  }
  if (cmd === 'build') {
    const doc = buildKeysDoc({ previous: await previousDoc(values, roots) });
    writeNew(resolve(values.out ?? 'keys.json'), serializeKeys(doc));
    process.stdout.write(`wrote ${values.out ?? 'keys.json'} (v${doc.version}, unsigned)\n`);
    return;
  }
  if (cmd === 'sign') {
    let passphrase;
    if (values['passphrase-file'] === '-') passphrase = await new Response(process.stdin).text();
    else if (values['passphrase-file']) passphrase = readRegular(resolve(values['passphrase-file']), 4096).toString('utf8');
    else stop('--passphrase-file <path|-> is required');
    const r = await signKeys({ key: values.key, passphrase, previous: await previousDoc(values, roots), outDir: resolve(values['out-dir'] ?? 'release-keys'), roots });
    process.stdout.write(`signed ${r.file} (v${r.doc.version}) with root ${r.rootKeyId}\nDeploy keys.json and keys.json.sig to plugins.octipus.cc/ before the next publish.\n`);
    return;
  }
  stop('keys.mjs build | sign | verify (see the comment at the top of scripts/keys.mjs)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`keys: ${err.message}\n`); process.exit(1); });
}
