import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from './markdown.mjs';

test('no scripts, no remote images, safe links', () => {
  const html = renderMarkdown([
    '# Title',
    '![icon](icon.png) ![remote](https://example.com/t.png) ![other](other.png)',
    '<script>alert(1)</script><img src="https://evil.example/x.png" onerror="alert(1)"><iframe src="https://x"></iframe>',
    '[js](javascript:alert(1)) [web](https://octipus.cc/) [rel](server.mjs) [anchor](#setup)',
    '<a href="//evil.example/">pr</a>',
  ].join('\n\n'), { images: { 'icon.png': '/reader/icon.png' }, linkBase: 'https://github.com/o/r/blob/main/plugins/reader/' });
  assert.doesNotMatch(html, /<script|<iframe|onerror|javascript:|evil\.example|example\.com\/t\.png/);
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<img src="\/reader\/icon.png" alt="icon" loading="lazy" \/>|<img src="\/reader\/icon.png" alt="icon" loading="lazy">/);
  assert.match(html, /\[image: remote\]/);
  assert.match(html, /\[image: other\]/);
  assert.match(html, /href="https:\/\/octipus.cc\/" rel="nofollow noopener noreferrer"/);
  assert.match(html, /href="https:\/\/github.com\/o\/r\/blob\/main\/plugins\/reader\/server.mjs"/);
  assert.match(html, /href="#setup"/);
});

test('relative links without a base lose their href; empty input is empty', () => {
  assert.doesNotMatch(renderMarkdown('[x](a/b.md)'), /href/);
  assert.equal(renderMarkdown(''), '');
});
