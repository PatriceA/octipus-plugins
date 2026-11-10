import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPermissions } from './permissions.mjs';
import { renderSummary, SUMMARY_MARKER } from './summary.mjs';

const perm = { name: 'x', version: '1.1.0', runtime: 'package', host: ['web:read', 'notes:read'], network: [], tools: [{ name: 't', effect: 'read' }], contributions: {}, pages: 0, trustedInput: false };

test('carries the marker and says what needs review', () => {
  const md = renderSummary([
    { dir: 'plugins/x', name: 'x', version: '1.1.0', publishedVersion: '1.0.0', errors: [], warnings: ['w <b>'], steps: [{ name: 'validate', status: 'passed' }], permissions: perm, diff: diffPermissions({ ...perm, host: ['notes:read'] }, perm) },
    { dir: 'plugins/y', name: 'y', version: '0.1.0', publishedVersion: null, errors: ['bad'], warnings: [], steps: [], permissions: perm, diff: diffPermissions(null, perm) },
  ]);
  assert.ok(md.startsWith(SUMMARY_MARKER));
  assert.match(md, /1 of 2 failed/);
  assert.match(md, /Needs security review:\*\* `x`, `y`/);
  assert.match(md, /\*\*wider\*\*: host API scope web:read/);
  assert.match(md, /Warning: with web:read and notes:read together/);
  assert.match(md, /w &lt;b&gt;/);
});

test('no plugin changed', () => {
  assert.match(renderSummary([]), /No plugin changed/);
});
