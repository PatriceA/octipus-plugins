#!/usr/bin/env node
// Download counts for plugins.octipus.cc/stats.json, from nginx access logs.
//
//   npm run stats -- [--out stats.json] <access.log>… (plain or .gz)
//
// It counts `GET /dl/<name>-<version>.tar.gz` answered 200, per plugin, and
// writes `{ generatedAt, downloads: { "<name>": n } }`: counts only, never an
// address, a user agent or a time. The counts cover the logs given (pass
// every rotated log you keep). Run it on the web server or the deploy
// machine, never in the key session; stats.json is unsigned and display only.
// Deploy it beside the site (rsync --filter 'P stats.json' keeps it), or pass
// it to `npm run publish -- finish --stats stats.json` to show the counts on
// the site's pages.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { readRegularFile } from './lib/safe-fs.mjs';
import { aggregate, serializeStats, validateStats } from './lib/stats.mjs';

export function statsFromFiles(files, opts) {
  const texts = files.map((f) => {
    const buf = readRegularFile(resolve(f), { maxBytes: 2 * 1024 * 1024 * 1024 });
    return (f.endsWith('.gz') ? gunzipSync(buf, { maxOutputLength: 4 * 1024 * 1024 * 1024 }) : buf).toString('utf8');
  });
  return validateStats(aggregate(texts, opts));
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'stats.json' } } });
  if (!positionals.length) throw new Error('npm run stats -- [--out stats.json] <access.log>…');
  const stats = statsFromFiles(positionals);
  writeFileSync(resolve(values.out), serializeStats(stats));
  const total = Object.values(stats.downloads).reduce((a, b) => a + b, 0);
  process.stdout.write(`wrote ${values.out}: ${total} downloads of ${Object.keys(stats.downloads).length} plugin(s)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`stats: ${err.message}\n`); process.exit(1); });
}
