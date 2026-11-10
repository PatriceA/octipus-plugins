// The repository's plugins, published.json and revoked.json.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { compareSemver, maxSemver } from './semver.mjs';

export const PLUGINS_DIR = 'plugins';
export const MANIFEST = 'octipus-plugin.json';

/**
 * Names a plugin cannot take because the site uses the path
 * (`plugins.octipus.cc/<name>/`), on top of Octipus's own reserved names.
 */
export const RESERVED_NAMES = new Set(['octipus', 'mcp', 'system', 'plugin', 'publish', 'dl', 'index', 'schema', 'keys', 'design', 'icons', 'assets', 'search', 'category', 'categories', 'about', 'docs']);

/** The install limits of an Octipus host (docs/PLUGIN-PACKAGES.md#remote-install). */
export const LIMITS = {
  unpackedBytes: 200 * 1024 * 1024,
  files: 20_000,
  tarballBytes: 50 * 1024 * 1024,
  iconBytes: 256 * 1024,
  screenshotBytes: 1024 * 1024,
  indexBytes: 1024 * 1024,
};

/** A plugin directory that is never published: `_template`, `.anything`. */
export function isSkipped(dirName) {
  return dirName.startsWith('_') || dirName.startsWith('.');
}

/** The plugin directory names under plugins/ (sorted), without the skipped ones unless asked. */
export function pluginDirs(root, { includeSkipped = false } = {}) {
  const dir = join(root, PLUGINS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (includeSkipped || !isSkipped(d.name)))
    .map((d) => d.name)
    .sort();
}

/** The plugin directory names touched by a list of changed paths (repo-relative, `/`-separated). */
export function changedPluginDirs(paths) {
  const out = new Set();
  for (const p of paths) {
    const m = /^plugins\/([^/]+)\//.exec(p.replaceAll('\\', '/'));
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/** Paths changed between `base` and HEAD (`git diff --name-only base...HEAD`). */
export function gitChangedPaths(root, base) {
  const out = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** published.json: name → version → { sha256, contentHash, permissions, publishedAt, … }. */
export function readPublished(root) {
  const file = join(root, 'published.json');
  if (!existsSync(file)) return {};
  const data = readJson(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('published.json: expected an object of name → version → record');
  return data;
}

/** The newest published version of `name`, or null. */
export function latestPublished(published, name) {
  const versions = Object.keys(published[name] ?? {});
  return versions.length ? maxSemver(versions) : null;
}

/** published.json with `record` added under name and version (a new object; keys sorted). */
export function withPublished(published, name, version, record) {
  const next = structuredClone(published);
  next[name] = { ...(next[name] ?? {}), [version]: record };
  const sortedVersions = Object.fromEntries(Object.entries(next[name]).sort(([a], [b]) => compareSemver(a, b)));
  next[name] = sortedVersions;
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** revoked.json: `{ packages: [{ name, version, reason }], keys: [{ keyId, reason }] }`. */
export function readRevoked(root) {
  const file = join(root, 'revoked.json');
  const data = existsSync(file) ? readJson(file) : { packages: [], keys: [] };
  const problems = [];
  if (!Array.isArray(data.packages)) problems.push('revoked.json: "packages" must be a list');
  if (!Array.isArray(data.keys)) problems.push('revoked.json: "keys" must be a list');
  for (const p of data.packages ?? []) if (!p?.name || !p?.version || !p?.reason) problems.push(`revoked.json: a package entry needs name, version and reason: ${JSON.stringify(p)}`);
  for (const k of data.keys ?? []) if (!/^ed25519:[0-9a-f]{64}$/.test(k?.keyId ?? '') || !k?.reason) problems.push(`revoked.json: a key entry needs keyId (ed25519:<64 hex>) and reason: ${JSON.stringify(k)}`);
  if (problems.length) throw new Error(problems.join('\n'));
  return { packages: data.packages, keys: data.keys };
}

/**
 * Count the files and bytes under `dir` (regular files; links are counted as
 * problems, since an install refuses them).
 */
export function measureTree(dir) {
  let files = 0;
  let bytes = 0;
  const links = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) links.push(relative(dir, p).split(sep).join('/'));
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) { files += 1; bytes += st.size; }
      else links.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return { files, bytes, links };
}
