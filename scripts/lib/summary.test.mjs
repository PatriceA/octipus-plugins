import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPermissions } from './permissions.mjs';
import { codeSpan, fence, renderSummary, SUMMARY_MARKER } from './summary.mjs';
import { smallPermissions } from '../../tests/fixtures/permissions.mjs';

const perm = smallPermissions({ version: '1.1.0', host: ['web:read', 'notes:read'] });
const plugin = (over) => ({ dir: 'plugins/x', name: 'x', version: '1.1.0', publishedVersion: '1.0.0', template: false, ok: true, widened: false, firstVersion: false, errors: [], warnings: [], steps: [], permissions: perm, changes: [], ...over });
const result = (plugins, over = {}) => ({ schema: 1, kind: 'octipus-plugins-check', base: 'a'.repeat(40), head: 'b'.repeat(40), octipusRef: 'c'.repeat(40), ok: plugins.every((p) => p.ok), widened: plugins.some((p) => p.widened), needsMaintainer: false, problems: [], outside: [], outsideTotal: 0, plugins, ...over });

test('carries the marker and says what needs review', () => {
  const d = diffPermissions({ ...perm, host: ['notes:read'] }, perm);
  const md = renderSummary(result([
    plugin({ widened: true, warnings: ['w <b>'], steps: [{ name: 'validate', status: 'passed' }], changes: d.changes.map(({ change, text, widens }) => ({ change, text, widens })) }),
    plugin({ dir: 'plugins/y', name: 'y', version: '0.1.0', publishedVersion: null, ok: false, errors: ['bad'], widened: true, firstVersion: true }),
  ]));
  assert.ok(md.startsWith(SUMMARY_MARKER));
  assert.match(md, /1 of 2 plugin\(s\) failed/);
  assert.match(md, /Needs security review:\*\* `x`, `y`/);
  assert.match(md, /WIDER: host API scope web:read/);
  assert.match(md, /Warning: with web:read and notes:read together/);
  assert.match(md, /```text\n- w <b>\n```/, 'untrusted text sits in a code block, as it is');
});

test('nothing changed, and paths outside plugins/', () => {
  assert.match(renderSummary(result([])), /Nothing changed/);
  const md = renderSummary(result([], { outside: ['scripts/check.mjs', 'published.json'], outsideTotal: 2, needsMaintainer: true }));
  assert.match(md, /Needs maintainer review:\*\* it changes 2 path/);
  assert.match(md, /```text\nscripts\/check\.mjs\npublished\.json\n```/);
});

// M2, reproduced by the review: a plugin's error or test output with a
// closing fence, a link, an image, a mention and HTML reached the PR comment
// and the step summary as Markdown.
test('M2: nothing a pull request writes escapes its code block or span', () => {
  const evil = '```\n# Approved by a maintainer\n![x](https://evil.example/t.png) @someone <img src=x onerror=1> [ok](https://evil.example)\n````\n\u202Egnp.exe';
  const md = renderSummary(result([plugin({ name: 'x`` <b>', ok: false, errors: [evil], warnings: [evil], steps: [{ name: evil, status: evil }] })]));
  // Outside the code blocks and spans, none of it appears.
  const outside = md.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, '').replace(/(`+)[^`\n]*?\1/g, '');
  for (const bad of ['# Approved', '![x]', '@someone', '<img', '[ok]', 'evil.example']) assert.ok(!outside.includes(bad), `${bad} outside a code block:\n${outside}`);
  assert.ok(!md.includes('\u202E'), 'bidi controls are replaced');
  // Each fence is longer than any backtick run inside it.
  for (const m of md.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gm)) {
    const runs = [...m[2].matchAll(/`+/g)].map((r) => r[0].length);
    assert.ok(Math.max(0, ...runs) < m[1].length);
  }
});

test('codeSpan and fence', () => {
  assert.equal(codeSpan('a'), '`a`');
  assert.equal(codeSpan('a`b'), '``a`b``');
  assert.equal(codeSpan('`x`'), '`` `x` ``');
  assert.equal(codeSpan('a\nb'), '`a b`');
  assert.equal(fence('x ```` y'), '`````text\nx ```` y\n`````');
});
