// The repository's plugins, published.json and revoked.json.
import { closeSync, constants as C, existsSync, lstatSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_NAMES, validatePublished, validateRevoked } from './records.mjs';
import { readFileUnder, walkRegular } from './safe-fs.mjs';
import { compareSemver, maxSemver } from './semver.mjs';

export { RESERVED_NAMES };
export { changedPluginDirs, isSkipped, outsidePluginPaths, PLUGINS_DIR } from './paths.mjs';
import { isSkipped, PLUGINS_DIR } from './paths.mjs';

export const MANIFEST = 'octipus-plugin.json';

/** The install limits of an Octipus host (docs/PLUGIN-PACKAGES.md#remote-install). */
export const LIMITS = {
  unpackedBytes: 200 * 1024 * 1024,
  files: 20_000,
  tarballBytes: 50 * 1024 * 1024,
  iconBytes: 256 * 1024,
  screenshotBytes: 1024 * 1024,
  indexBytes: 1024 * 1024,
};


/** The plugin directory names under `root`/plugins (sorted; real directories only), without the skipped ones unless asked. */
export function pluginDirs(root, { includeSkipped = false } = {}) {
  const dir = join(root, PLUGINS_DIR);
  if (!existsSync(dir)) return [];
  if (!lstatSync(dir).isDirectory()) throw new Error('plugins/ is not a directory');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (includeSkipped || !isSkipped(d.name)))
    .map((d) => d.name)
    .sort();
}



/** Parse JSON text, naming the file in the error. */
export function parseJson(text, what) {
  try { return JSON.parse(text); } catch (err) { throw new Error(`${what}: ${err.message}`); }
}

/** published.json under `root`, read without following links and validated strictly. */
export function readPublished(root) {
  const text = readFileUnder(root, 'published.json', { encoding: 'utf8', optional: true, maxBytes: 16 * 1024 * 1024 });
  return validatePublished(text === null ? {} : parseJson(text, 'published.json'));
}

/** revoked.json under `root`, read without following links and validated strictly. */
export function readRevoked(root) {
  const text = readFileUnder(root, 'revoked.json', { encoding: 'utf8', optional: true, maxBytes: 4 * 1024 * 1024 });
  return validateRevoked(text === null ? { packages: [], keys: [] } : parseJson(text, 'revoked.json'));
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

/** The text published.json is written as. */
export const serializePublished = (data) => `${JSON.stringify(data, null, 2)}\n`;

/** Overwrite the regular file `root/name` (never through a link). */
export function overwriteRegular(root, name, text) {
  const fd = openSync(join(root, name), C.O_WRONLY | C.O_TRUNC | C.O_NOFOLLOW);
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/**
 * Count the files and bytes under `dir`; a link or special file throws
 * (an install refuses them, and nothing here ever follows one).
 */
export function measureTree(dir) {
  const { files } = walkRegular(dir);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), links: [] };
}
