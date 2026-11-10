#!/usr/bin/env node
// CI's build on main: pack every plugin version that published.json does not
// have yet and record its tarball's sha256 and its content hash.
//
//   node scripts/build.mjs [--out build/] [--record build-record.json]
//
// CI holds no key and signs nothing. The key holder's `npm run publish --
// build` packs the same tarballs from the same commit, the same way, and
// stops when its hashes differ from this record. Both export the commit's
// tree from git's objects (no checkout, no .gitattributes filter) and refuse
// a commit with a symbolic link or a submodule anywhere.
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertTreeClean, exportTree, headCommit } from './lib/git.mjs';
import { tarballName } from './lib/index-v2.mjs';
import { cli, REPO_ROOT } from './lib/octi.mjs';
import { nameProblem, versionProblem } from './lib/records.mjs';
import { MANIFEST, parseJson, pluginDirs, PLUGINS_DIR, readPublished } from './lib/repo.mjs';
import { readFileUnder, SafeDir } from './lib/safe-fs.mjs';

/** The commit's tree, exported into a new temporary SafeDir. */
export function exportCommit(root, commit) {
  assertTreeClean(root, commit);
  const dir = SafeDir.temp('octipus-src-');
  exportTree(root, commit, dir);
  return dir;
}

/** The plugins of an exported tree whose manifest version is not in published.json: [{ dir, name, version }]. */
export function unpublishedVersions(src, published) {
  const out = [];
  for (const d of pluginDirs(src)) {
    const text = readFileUnder(src, `${PLUGINS_DIR}/${d}/${MANIFEST}`, { encoding: 'utf8', optional: true, maxBytes: 256 * 1024 });
    if (text === null) continue;
    const m = parseJson(text, `plugins/${d}/${MANIFEST}`);
    const problem = nameProblem(m.name) ?? versionProblem(m.version) ?? (m.name !== d ? `plugins/${d} names "${m.name}"` : null);
    if (problem) throw new Error(`plugins/${d}: ${problem}`);
    if (!published[m.name]?.[m.version]) out.push({ dir: d, name: m.name, version: m.version });
  }
  return out;
}

export async function build(root, outDir) {
  const commit = headCommit(root);
  const src = exportCommit(root, commit);
  try {
    const published = readPublished(src.root);
    const out = SafeDir.create(outDir);
    const packages = [];
    for (const p of unpublishedVersions(src.root, published)) {
      const r = await cli.pack(join(src.root, PLUGINS_DIR, p.dir), join(out.root, tarballName(p.name, p.version)));
      if (r.name !== p.name || r.version !== p.version) throw new Error(`pack of plugins/${p.dir} names ${r.name} ${r.version}, expected ${p.name} ${p.version}`);
      packages.push({ name: r.name, version: r.version, sha256: r.sha256.replace(/^sha256:/, ''), contentHash: r.contentHash });
    }
    return { schema: 1, commit, packages };
  } finally {
    rmSync(src.root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'build' }, record: { type: 'string', default: 'build-record.json' }, root: { type: 'string' } } });
  const root = resolve(values.root ?? REPO_ROOT);
  const record = await build(root, resolve(values.out));
  writeFileSync(resolve(values.record), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  if (record.packages.length === 0) process.stdout.write(`Nothing new to build at ${record.commit}.\n`);
  for (const p of record.packages) process.stdout.write(`${p.name} ${p.version}  sha256 ${p.sha256}  ${p.contentHash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`build: ${err.message}\n`);
    process.exit(1);
  });
}
