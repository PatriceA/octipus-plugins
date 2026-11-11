// H5, M2: the report trusts nothing in the artifact.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../scripts/lib/octi.mjs';
import { buildReport } from '../scripts/report.mjs';
import { smallPermissions } from './fixtures/permissions.mjs';

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
    assert.deepEqual(r.labels, ['needs-maintainer-review', 'needs-security-review'], p);
    assert.ok(r.body.includes(p), p);
    assert.match(r.body, /Not checked: this pull request changes repository files outside plugins\//);
  }
});

// Review finding 8 (the reviewer's forge.mjs): a pull request that edits a
// workflow runs its own checks, so its artifact (and the job outcomes) say
// whatever it likes. With any path outside plugins/<name>/, the report shows
// no verdict from them: "Not checked", both labels, decided from the API's
// paths before the artifact is read.
test('finding 8: a pull request that changes a workflow gets no verdict from its own artifact', () => {
  const h = 'a'.repeat(40);
  const perms = smallPermissions({ name: 'notes-helper', version: '1.1.0', tools: [{ name: 'list', effect: 'read' }] });
  const forged = { schema: 1, kind: 'octipus-plugins-check', base: h, head: h, octipusRef: h, ok: true, widened: false, needsMaintainer: false, problems: [], outside: [], outsideTotal: 0,
    plugins: [{ dir: 'plugins/notes-helper', name: 'notes-helper', version: '1.1.0', publishedVersion: '1.0.0', template: false, ok: true, widened: false, firstVersion: false, errors: [], warnings: [], steps: [{ name: 'octi plugin validate', status: 'passed' }], permissions: perms, changes: [] }] };
  const paths = ['plugins/notes-helper/octipus-plugin.json', 'plugins/notes-helper/server.mjs', '.github/workflows/pr.yml'];
  for (const resultText of [JSON.stringify(forged), null, 'not json']) {
    const r = buildReport({ resultText, paths, checkJob: 'success', testJob: 'success' });
    assert.deepEqual(r.labels, ['needs-maintainer-review', 'needs-security-review']);
    assert.match(r.body, /\*\*Not checked: this pull request changes repository files outside plugins\/ \(the 1 path\(s\) below\)\. A maintainer must review it by hand\.\*\*/);
    assert.match(r.body, /```text\n\.github\/workflows\/pr\.yml\n```/);
    assert.doesNotMatch(r.body, /passed|nothing asks for more|success|notes-helper/i);
  }
  // The same with more files than the API lists.
  const t = buildReport({ resultText: JSON.stringify(forged), paths: paths.slice(0, 2), filesTruncated: true, checkJob: 'success', testJob: 'success' });
  assert.deepEqual(t.labels, ['needs-maintainer-review', 'needs-security-review']);
  assert.match(t.body, /Not checked/);
  // The workflow passes the API's list (pulls.listFiles), never the artifact's.
  const wf = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'pr-report.yml'), 'utf8');
  assert.match(wf, /const files = await github\.paginate\(github\.rest\.pulls\.listFiles,/);
  assert.match(wf, /paths,\n\s+filesTruncated: files\.length >= 3000,/);
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
    // M3: permissions in the old shape, or not the CLI's exact object.
    [result({ plugins: [plugin({ permissions: { ...smallPermissions(), pages: 0 } })] }), 'success'],
    [result({ plugins: [plugin({ permissions: { ...smallPermissions(), effects: { read: 9, write: 0, external: 0 } } })] }), 'success'],
  ]) {
    const r = buildReport({ resultText, paths: ['plugins/x/a.js'], checkJob, testJob: 'success' });
    assert.deepEqual(r.labels, ['needs-maintainer-review'], String(resultText).slice(0, 80));
    assert.match(r.body, /could not be used/);
  }
});

test('a first version lists what it asks for, from the CLI\'s permissions', () => {
  const permissions = smallPermissions({ name: 'x', version: '1.1.0', host: ['notes:read'] });
  const r = buildReport({ resultText: result({ widened: true, plugins: [plugin({ widened: true, firstVersion: true, publishedVersion: null, permissions })] }), paths: ['plugins/x/a.js'], checkJob: 'success', testJob: 'success' });
  assert.match(r.body, /What it asks for/);
  assert.match(r.body, /host API: notes:read/);
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
