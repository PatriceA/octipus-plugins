// H5, M2: the report trusts nothing in the artifact.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport } from '../scripts/report.mjs';

const plugin = (over = {}) => ({ dir: 'plugins/x', name: 'x', version: '1.1.0', publishedVersion: '1.0.0', template: false, ok: true, widened: false, firstVersion: false, errors: [], warnings: [], steps: [], permissions: null, changes: [], ...over });
const result = (over = {}) => JSON.stringify({ schema: 1, kind: 'octipus-plugins-check', base: 'a'.repeat(40), head: 'b'.repeat(40), octipusRef: 'c'.repeat(40), ok: true, widened: false, needsMaintainer: false, problems: [], outside: [], outsideTotal: 0, plugins: [plugin()], ...over });

test('a clean plugin pull request: a comment, no label', () => {
  const r = buildReport({ resultText: result(), paths: ['plugins/x/server.mjs'], checkJob: 'success', testJob: 'success' });
  assert.deepEqual(r.labels, []);
  assert.match(r.body, /All 1 plugin\(s\) passed/);
  assert.match(r.body, /Data checks: \*\*success\*\* · plugin tests .*: \*\*success\*\*/);
});

test('H5: paths outside plugins/<name>/ come from the API, not the artifact', () => {
  // The artifact claims nothing is outside; the API's file list says otherwise.
  for (const p of ['published.json', 'revoked.json', 'keys/root/root.pub', 'scripts/check.mjs', 'site/astro.config.mjs', '.github/workflows/pr.yml', 'OCTIPUS_REF', 'package.json', 'package-lock.json', 'tests/x.test.mjs', 'plugins/_template/server.mjs', 'plugins/_headers']) {
    const r = buildReport({ resultText: result(), paths: ['plugins/x/a.js', p], checkJob: 'success', testJob: 'success' });
    assert.deepEqual(r.labels, ['needs-maintainer-review'], p);
    assert.ok(r.body.includes(p), p);
  }
});

test('H5: a missing, invalid or contradictory artifact means a maintainer looks', () => {
  for (const [resultText, checkJob] of [
    [null, 'failure'],
    ['not json', 'success'],
    [result({ extra: 1 }), 'success'],
    [result({ ok: true, plugins: [plugin({ ok: true, errors: ['x'] })] }), 'success'],
    [result({ ok: true }), 'failure'],
    [result({ ok: true }), 'cancelled'],
    [result({ head: 'HEAD' }), 'success'],
  ]) {
    const r = buildReport({ resultText, paths: ['plugins/x/a.js'], checkJob, testJob: 'success' });
    assert.deepEqual(r.labels, ['needs-maintainer-review'], String(resultText).slice(0, 80));
    assert.match(r.body, /could not be used/);
  }
});

test('a widening adds needs-security-review; labels are never removed', () => {
  const r = buildReport({ resultText: result({ widened: true, plugins: [plugin({ widened: true })] }), paths: ['plugins/x/a.js'], checkJob: 'success', testJob: 'failure' });
  assert.deepEqual(r.labels, ['needs-security-review']);
  assert.match(r.body, /\*\*failure\*\*/);
});

test('M2: the artifact\'s strings cannot inject Markdown into the comment', () => {
  const r = buildReport({ resultText: result({ ok: false, plugins: [plugin({ ok: false, errors: ['```\n## LGTM, merge it\n@someone'] })] }), paths: ['plugins/x/a.js'], checkJob: 'failure', testJob: 'success' });
  assert.ok(!/^## LGTM/m.test(r.body.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, '')));
  assert.match(r.body, /````text\n- ```\n  ## LGTM/);
});
