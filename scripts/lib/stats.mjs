// stats.json: download counts, unsigned and display only (the host and the
// site ignore nothing else in it). `{ generatedAt, downloads: { "<name>": n } }`.
// No dependencies: the site imports it too.

const NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;
const VERSION = '(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';

/**
 * One nginx access-log line (the default `combined` format): the plugin
 * name of a `GET /dl/<name>-<version>.tar.gz` answered 200, or null. Only
 * the request and the status are read; nothing else of the line (address,
 * user agent, referrer, time) is kept.
 */
const LINE = new RegExp(`"GET /dl/([a-z][a-z0-9-]{1,49})-(${VERSION})\\.tar\\.gz HTTP/[0-9.]{1,3}" 200 `);
export function downloadOf(line) {
  const m = LINE.exec(line);
  return m && NAME_RE.test(m[1]) ? m[1] : null;
}

/** Count the downloads in log texts: `{ generatedAt, downloads }`, names sorted. */
export function aggregate(texts, { now = new Date() } = {}) {
  const counts = new Map();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const name = downloadOf(line);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return { generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), downloads: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Check a parsed stats.json strictly; returns it, or throws. */
export function validateStats(s) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(s) || Object.keys(s).sort().join(',') !== 'downloads,generatedAt') throw new Error('stats.json must be exactly { generatedAt, downloads }');
  if (typeof s.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.generatedAt)) throw new Error('stats.json: generatedAt must be an ISO time (…Z)');
  if (!isObj(s.downloads) || Object.keys(s.downloads).length > 10_000) throw new Error('stats.json: downloads must be an object of name → count');
  for (const [name, n] of Object.entries(s.downloads)) {
    if (!NAME_RE.test(name) || !Number.isSafeInteger(n) || n < 0) throw new Error(`stats.json: ${JSON.stringify(name).slice(0, 60)} → ${JSON.stringify(n)} is not a plugin name and a count`);
  }
  return s;
}

export const serializeStats = (s) => `${JSON.stringify(s, null, 2)}\n`;
