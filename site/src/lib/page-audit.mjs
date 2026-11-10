// What no built page may carry (H3): a script other than the allowlisted
// inline ones (by hash), a <script src>, an on* event attribute, a
// javascript:/vbscript:/data: URL in an attribute, a <style> element or a
// style attribute, or an element that loads or frames other content.
import { createHash } from 'node:crypto';

const hashOf = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const FORBIDDEN_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'form', 'style', 'template', 'svg', 'math', 'portal']);

/** Decode the character references an attribute value may hide a scheme behind. */
function decode(v) {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(colon|tab|newline);/gi, (_, n) => ({ colon: ':', tab: '\t', newline: '\n' }[n.toLowerCase()]));
}

/** The problems with one page's HTML; `allowed` is the set of CSP script hashes. */
export function auditPage(html, allowed) {
  const problems = [];
  // Scripts: inline only, no attributes, and exactly an allowlisted text.
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const opened = (html.match(/<script\b/gi) ?? []).length;
  if (opened !== scripts.length) problems.push('a <script> without its </script>');
  for (const [, attrs, body] of scripts) {
    if (attrs.trim()) problems.push(`a <script> with attributes (${attrs.trim().slice(0, 80)}): only plain inline scripts are allowed`);
    if (!allowed.has(hashOf(body))) problems.push(`an inline script that is not one of site/src/scripts/ (${hashOf(body)})`);
  }
  // Every tag's name and attributes.
  for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1].toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) problems.push(`a <${tag}> element`);
    for (const a of m[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const name = a[1].toLowerCase();
      const value = decode((a[2] ?? '').replace(/^["']|["']$/g, '')).replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
      if (name.startsWith('on')) problems.push(`an event attribute ${name} on <${tag}>`);
      if (name === 'style') problems.push(`a style attribute on <${tag}>`);
      if (name === 'srcdoc' || name === 'formaction') problems.push(`a ${name} attribute on <${tag}>`);
      if (/^(javascript|vbscript|data):/.test(value) && !(name === 'content' || name === 'class' || name.startsWith('data-') || name === 'alt' || name === 'title' || name === 'aria-label')) problems.push(`a ${value.split(':')[0]}: URL in ${name} on <${tag}>`);
      if (tag === 'meta' && name === 'http-equiv') problems.push('a <meta http-equiv>');
    }
  }
  return problems;
}
