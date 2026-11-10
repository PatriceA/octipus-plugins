import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSemver, isSemver, maxSemver, sortSemverDesc } from './semver.mjs';

test('orders versions as semver does', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-beta.11', '1.0.0-beta.2'), 1);
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0'), 0);
});

test('refuses what is not semver', () => {
  assert.equal(isSemver('1.0'), false);
  assert.equal(isSemver('01.0.0'), false);
  assert.equal(isSemver('v1.0.0'), false);
  assert.throws(() => compareSemver('1', '1.0.0'));
});

test('max and sort', () => {
  assert.equal(maxSemver([]), null);
  assert.equal(maxSemver(['1.2.0', '1.10.0', '1.9.9']), '1.10.0');
  assert.deepEqual(sortSemverDesc(['0.1.0', '1.0.0-rc.1', '1.0.0', '0.9.0']), ['1.0.0', '1.0.0-rc.1', '0.9.0', '0.1.0']);
});
