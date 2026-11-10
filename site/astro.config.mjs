// plugins.octipus.cc: a static Astro site, built from the signed index.
//
//   npm run build:site                       an empty marketplace, into dist/
//   MARKETPLACE_INDEX=release/signed/index.json SITE_OUT=/tmp/site npm run build:site
//
// `npm run publish -- finish` builds it with the index sign just signed.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { scriptHashes } from './src/lib/inline-scripts.mjs';
import { auditPage } from './src/lib/page-audit.mjs';

/** Every *.html under `dir`. */
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// The repository root, for pages that read its files at build time
// (CONTRIBUTING.md, the schema, src/scripts/): bundled page code has no stable import.meta.url.
process.env.OCTIPUS_PLUGINS_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The CSP: the site's own files, the two inline scripts of src/scripts/ by
 * the hash of their source (H3: never what a page happens to contain), and
 * Google Fonts. No inline style, no data: images.
 */
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    `script-src ${scriptHashes().join(' ')}`,
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self'",
    "connect-src 'none'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** The headers every response carries (the /* block of _headers; README's nginx config repeats them in every location). */
export function securityHeaders() {
  return {
    'Content-Security-Policy': contentSecurityPolicy(),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}

/**
 * After the build: audit every page (fail on any script, event attribute,
 * javascript: URL or style the allowlist does not name), then write
 * `_headers` (the format of Netlify, Cloudflare Pages and others) and
 * `csp.txt` for a server config.
 */
function cspHeaders() {
  return {
    name: 'octipus-plugins-csp',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const out = fileURLToPath(dir);
        const allowed = new Set(scriptHashes());
        const problems = [];
        for (const file of htmlFiles(out)) for (const p of auditPage(readFileSync(file, 'utf8'), allowed)) problems.push(`${file.slice(out.length)}: ${p}`);
        if (problems.length) throw new Error(`the built pages carry what the CSP does not allow:\n${problems.slice(0, 50).map((p) => `  - ${p}`).join('\n')}`);
        // /* carries the security headers; a host applying _headers merges
        // every matching block, so the paths below keep them and add their
        // own type and caching (nginx does not merge: see README).
        const sec = Object.entries(securityHeaders()).map(([k, v]) => `  ${k}: ${v}`);
        const json = ['  Content-Type: application/json; charset=utf-8', '  Cache-Control: public, max-age=300'];
        const headers = [
          '/*', ...sec,
          '/dl/*', '  Content-Type: application/gzip', '  Cache-Control: public, max-age=31536000, immutable',
          '/index.json', ...json,
          '/index.json.sig', ...json,
          '/keys.json', ...json,
          '/keys.json.sig', ...json,
          '/stats.json', ...json,
          '',
        ].join('\n');
        writeFileSync(join(out, '_headers'), headers);
        writeFileSync(join(out, 'csp.txt'), `${contentSecurityPolicy()}\n`);
      },
    },
  };
}

export default defineConfig({
  site: 'https://plugins.octipus.cc',
  outDir: process.env.SITE_OUT || fileURLToPath(new URL('../dist/', import.meta.url)),
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  integrations: [cspHeaders()],
});
