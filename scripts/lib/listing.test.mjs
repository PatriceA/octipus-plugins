import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATEGORIES, checkListing, listingImages, unknownLicenses } from './listing.mjs';

const good = {
  title: 'Weekly review',
  summary: 'A weekly review of your tasks and notes, every Friday.',
  category: 'productivity',
  tags: ['tasks', 'notes'],
  icon: 'icon.png',
  screenshots: ['screenshots/one.png'],
  homepage: 'https://example.com/weekly',
  license: 'MIT',
  author: { name: 'Ada', url: 'https://example.com' },
  minOctipus: '0.7.0',
};

test('a good listing passes, and so does the template', () => {
  assert.deepEqual(checkListing(good), []);
  const template = JSON.parse(readFileSync(new URL('../../plugins/_template/marketplace.json', import.meta.url), 'utf8'));
  assert.deepEqual(checkListing(template), []);
});

test('the limits of the schema', () => {
  const bad = (over) => checkListing({ ...good, ...over });
  assert.match(bad({ summary: 'x'.repeat(141) }).join(), /at most 140/);
  assert.match(bad({ category: 'games' }).join(), /must be one of/);
  assert.match(bad({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }).join(), /at most 8/);
  assert.match(bad({ screenshots: Array.from({ length: 7 }, (_, i) => `s${i}.png`) }).join(), /at most 6/);
  assert.ok(bad({ icon: 'https://example.com/i.png' }).length > 0, 'a remote icon');
  assert.ok(bad({ icon: '../outside.png' }).length > 0, 'an icon outside the plugin');
  assert.ok(bad({ icon: 'icon.svg' }).length > 0, 'svg is not an accepted image');
  assert.ok(bad({ homepage: 'http://example.com' }).length > 0, 'http homepage');
  assert.ok(bad({ license: 'MIT; rm -rf' }).length > 0);
  assert.ok(bad({ author: { url: 'https://x' } }).length > 0, 'author without name');
  assert.ok(bad({ minOctipus: '0.7' }).length > 0);
  assert.match(bad({ extra: 1 }).join(), /unknown field "extra"/);
  const { title, ...noTitle } = good;
  assert.match(checkListing(noTitle).join(), /missing "title"/);
});

test('licences', () => {
  assert.deepEqual(unknownLicenses('MIT'), []);
  assert.deepEqual(unknownLicenses('(Apache-2.0 OR MIT)'), []);
  assert.deepEqual(unknownLicenses('GPL-2.0-only WITH Classpath-exception-2.0'), []);
  assert.deepEqual(unknownLicenses('Proprietary-1.0 OR MIT'), ['Proprietary-1.0']);
});

test('categories and images', () => {
  assert.ok(CATEGORIES.includes('productivity'));
  assert.deepEqual(listingImages(good), ['icon.png', 'screenshots/one.png']);
});
