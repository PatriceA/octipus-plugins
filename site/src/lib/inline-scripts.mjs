// The only scripts the site's pages carry: these files, inline. Their
// sha256 hashes, computed here from the source files (never scraped from the
// built pages), are the only script-src the CSP allows; the build fails on a
// page with any other script, an on* attribute or a javascript: URL
// (astro.config.mjs, H3).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './data.mjs';

const read = (name) => readFileSync(join(repoRoot(), 'site', 'src', 'scripts', name), 'utf8').trim();

export const INLINE_SCRIPTS = {
  header: read('ocean-header.js'),
  finder: read('finder.js'),
};

/** The CSP source of a script's exact text. */
export const scriptHash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The allowed script hashes, sorted. */
export function scriptHashes() {
  return Object.values(INLINE_SCRIPTS).map(scriptHash).sort();
}
