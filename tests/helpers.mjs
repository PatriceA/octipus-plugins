// Shared by the integration tests.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../scripts/lib/octi.mjs';

/** Build the site from `indexFile` (or none: an empty marketplace) into `out`. */
export function buildSite(out, indexFile, statsFile) {
  const env = { ...process.env, SITE_OUT: out, ASTRO_TELEMETRY_DISABLED: '1' };
  if (indexFile) env.MARKETPLACE_INDEX = indexFile;
  else delete env.MARKETPLACE_INDEX;
  if (statsFile) env.MARKETPLACE_STATS = statsFile;
  else delete env.MARKETPLACE_STATS;
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--root', join(REPO_ROOT, 'site'), '--silent'], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`site build failed:\n${r.stdout}\n${r.stderr}`);
}

/** Every HTML file under `dir`, as [path, text]. */
export function htmlPages(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => { const p = join(e.parentPath, e.name); return [p, readFileSync(p, 'utf8')]; });
}

/** What no page may contain: external scripts, analytics, cookies. */
export function assertCleanPages(assert, dir) {
  const pages = htmlPages(dir);
  assert.ok(pages.length > 0);
  for (const [p, html] of pages) {
    assert.doesNotMatch(html, /<script[^>]+src=["']?https?:/i, `${p}: an external script`);
    assert.doesNotMatch(html, /<script[^>]+src=["']?\/\//i, `${p}: an external script`);
    assert.doesNotMatch(html, /document\.cookie|google-analytics|googletagmanager|plausible|gtag\(/i, `${p}: tracking`);
    assert.doesNotMatch(html, /style="/, `${p}: an inline style attribute (blocked by the CSP)`);
    for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) assert.ok(m[1].startsWith('/') && !m[1].startsWith('//'), `${p}: a remote image ${m[1]}`);
  }
}
