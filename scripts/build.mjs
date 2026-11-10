#!/usr/bin/env node
// CI's build on main: pack every plugin version that published.json does not
// have yet and record its tarball's sha256 and its content hash.
//
//   node scripts/build.mjs [--out build/] [--record build-record.json]
//
// CI holds no key and signs nothing. The key holder's `npm run publish`
// rebuilds the same tarballs from the same commit and stops when its hashes
// differ from this record (docs/plans/marketplace.md, CI).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { headCommit } from './lib/git.mjs';
import { tarballName } from './lib/index-v2.mjs';
import { cli, REPO_ROOT } from './lib/octi.mjs';
import { MANIFEST, pluginDirs, PLUGINS_DIR, readPublished } from './lib/repo.mjs';

/** The plugins under `root` whose manifest version is not in published.json: [{ dir, name, version }]. */
export function unpublishedVersions(root, published = readPublished(root)) {
  const out = [];
  for (const d of pluginDirs(root)) {
    const file = join(root, PLUGINS_DIR, d, MANIFEST);
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (!published[m.name]?.[m.version]) out.push({ dir: d, name: m.name, version: m.version });
  }
  return out;
}

export async function build(root, outDir) {
  mkdirSync(outDir, { recursive: true });
  const packages = [];
  for (const p of unpublishedVersions(root)) {
    const r = await cli.pack(join(root, PLUGINS_DIR, p.dir), join(outDir, tarballName(p.name, p.version)));
    if (r.name !== p.name || r.version !== p.version) throw new Error(`pack of plugins/${p.dir} names ${r.name} ${r.version}, expected ${p.name} ${p.version}`);
    packages.push({ name: r.name, version: r.version, sha256: r.sha256, contentHash: r.contentHash });
  }
  return { commit: headCommit(root), packages };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'build' }, record: { type: 'string', default: 'build-record.json' }, root: { type: 'string' } } });
  const root = resolve(values.root ?? REPO_ROOT);
  const record = await build(root, resolve(values.out));
  writeFileSync(resolve(values.record), `${JSON.stringify(record, null, 2)}\n`);
  if (record.packages.length === 0) process.stdout.write(`Nothing new to build at ${record.commit}.\n`);
  for (const p of record.packages) process.stdout.write(`${p.name} ${p.version}  sha256 ${p.sha256}  ${p.contentHash}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`build: ${err.message}\n`);
    process.exit(1);
  });
}
