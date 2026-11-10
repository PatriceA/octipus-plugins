import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, downloadOf, validateStats } from './stats.mjs';

const line = (req, status = 200) => `203.0.113.7 - - [10/Nov/2026:12:00:00 +0000] "${req}" ${status} 12345 "-" "curl/8.5"`;

test('counts GET /dl/<name>-<version>.tar.gz answered 200, per plugin, and keeps nothing else', () => {
  const log = [
    line('GET /dl/reader-1.0.0.tar.gz HTTP/1.1'),
    line('GET /dl/reader-1.1.0-rc.1.tar.gz HTTP/2.0'),
    line('GET /dl/foo-bar-2-0.1.0.tar.gz HTTP/1.1'),
    line('GET /dl/reader-1.0.0.tar.gz HTTP/1.1', 404),
    line('HEAD /dl/reader-1.0.0.tar.gz HTTP/1.1'),
    line('GET /dl/reader-1.0.0.tar.gz?x=1 HTTP/1.1'),
    line('GET /dl/../etc-1.0.0.tar.gz HTTP/1.1'),
    line('GET /index.json HTTP/1.1'),
    'garbage',
  ].join('\n');
  const s = aggregate([log, line('GET /dl/reader-1.0.0.tar.gz HTTP/1.1')], { now: new Date('2026-11-10T12:00:00Z') });
  assert.deepEqual(s, { generatedAt: '2026-11-10T12:00:00Z', downloads: { 'foo-bar-2': 1, reader: 3 } });
  assert.equal(downloadOf(line('GET /dl/Reader-1.0.0.tar.gz HTTP/1.1')), null);
  assert.ok(!JSON.stringify(s).includes('203.0.113.7') && !JSON.stringify(s).includes('curl'));
  validateStats(s);
});

test('stats.json is validated strictly', () => {
  assert.throws(() => validateStats({ generatedAt: '2026-11-10T12:00:00Z', downloads: { reader: -1 } }), /count/);
  assert.throws(() => validateStats({ generatedAt: '2026-11-10T12:00:00Z', downloads: { '../x': 1 } }), /plugin name/);
  assert.throws(() => validateStats({ generatedAt: 'now', downloads: {} }), /ISO/);
  assert.throws(() => validateStats({ generatedAt: '2026-11-10T12:00:00Z', downloads: {}, ip: [] }), /exactly/);
});
