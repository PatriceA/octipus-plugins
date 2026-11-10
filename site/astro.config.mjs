// plugins.octipus.cc: a static Astro site, built from the signed index.
//
//   npm run build:site                       an empty marketplace, into dist/
//   MARKETPLACE_INDEX=dist/index.json SITE_OUT=/tmp/site npm run build:site
//
// publish (scripts/publish.mjs) builds it with the index it just wrote.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

/** Every *.html under `dir`. */
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// The repository root, for pages that read its files at build time
// (CONTRIBUTING.md, the schema): bundled page code has no stable import.meta.url.
process.env.OCTIPUS_PLUGINS_ROOT = fileURLToPath(new URL('..', import.meta.url));

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The CSP the site needs: its own files, the inline scripts and styles it
 * ships (by hash) and Google Fonts. Written to `_headers` (the format of
 * Netlify, Cloudflare Pages and others) and `csp.txt` for a server config.
 */
function cspHeaders() {
  return {
    name: 'octipus-plugins-csp',
    hooks: {
      'astro:build:done': ({ dir }) => {
        const out = fileURLToPath(dir);
        const scripts = new Set();
        const styles = new Set();
        for (const file of htmlFiles(out)) {
          const html = readFileSync(file, 'utf8');
          for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) if (m[1].trim()) scripts.add(hash(m[1]));
          for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) if (m[1].trim()) styles.add(hash(m[1]));
          if (/<script[^>]*\bsrc=["']?(https?:)?\/\//.test(html)) throw new Error(`${file}: an external script; the site loads none`);
        }
        const csp = [
          "default-src 'none'",
          `script-src 'self' ${[...scripts].sort().join(' ')}`.trim(),
          `style-src 'self' https://fonts.googleapis.com ${[...styles].sort().join(' ')}`.trim(),
          'font-src https://fonts.gstatic.com',
          "img-src 'self' data:",
          "connect-src 'none'",
          "manifest-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; ');
        const headers = [
          '/*',
          `  Content-Security-Policy: ${csp}`,
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: strict-origin-when-cross-origin',
          '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
          '  Cross-Origin-Opener-Policy: same-origin',
          '/dl/*',
          '  Content-Type: application/gzip',
          '  Cache-Control: public, max-age=31536000, immutable',
          '/index.json',
          '  Content-Type: application/json; charset=utf-8',
          '  Cache-Control: public, max-age=300',
          '/index.json.sig',
          '  Content-Type: application/json; charset=utf-8',
          '  Cache-Control: public, max-age=300',
          '',
        ].join('\n');
        writeFileSync(join(out, '_headers'), headers);
        writeFileSync(join(out, 'csp.txt'), `${csp}\n`);
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
