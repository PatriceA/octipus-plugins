// The site builds with an empty marketplace and with fixture data, and its
// pages carry no external scripts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildIndex, serializeIndex } from '../scripts/lib/index-v2.mjs';
import { assertCleanPages, buildSite, htmlPages } from './helpers.mjs';
import { readerPermissions, withStore } from './fixtures/permissions.mjs';
import { scriptHashes } from '../site/src/lib/inline-scripts.mjs';
import { auditPage } from '../site/src/lib/page-audit.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'octipus-site-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const fixture = join(import.meta.dirname, 'fixtures', 'plugins', 'reader');
// The CLI's permissions for the reader fixture, with a command and a
// schedule added (octi plugin permissions --json).
// With the per-user store of a newer CLI (store:read and store:write, a 5 MB quota).
const permissions = withStore({ ...readerPermissions(), host: [...readerPermissions().host, 'store:read', 'store:write'].sort() }, { quotaBytes: 5 * 1024 * 1024 });
permissions.contributions.commands = [{ name: 'read', tool: 'read_url' }];
permissions.contributions.schedules = [{ id: 'digest', cron: '0 7 * * 1', tool: 'reader_action', input: { limit: 5 } }];
permissions.contributions.prompt = { file: 'prompt.md', sha256: 'ab'.repeat(32), roles: ['researcher'] };
const rec = (version, publishedAt) => ({ sha256: 'ab'.repeat(32), contentHash: `sha256:${'cd'.repeat(32)}`, permissions: { ...permissions, version }, publishedAt, keyId: `ed25519:${'ef'.repeat(32)}`, description: 'Read a web page in a clean view.', apiVersion: '1.0.0', minOctipus: '0.7.0' });

test('an empty marketplace', () => {
  const out = join(tmp, 'empty');
  buildSite(out);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /No plugins yet\./);
  assert.match(home, /CONTRIBUTING\.md/);
  assert.match(home, /class="ocean-header"/);
  assert.match(home, /class="ocean-navigation"/);
  assert.match(home, /class="ocean-footer/);
  assert.match(home, /aria-current="page">Plugins/);
  assert.match(home, /fonts\.googleapis\.com\/css2\?family=Manrope:wght@400;500;600;700;800/);
  assert.ok(existsSync(join(out, 'publish', 'index.html')));
  assert.match(readFileSync(join(out, 'publish', 'index.html'), 'utf8'), /The review checklist/);
  const headers = readFileSync(join(out, '_headers'), 'utf8');
  assert.match(headers, /Content-Security-Policy: default-src 'none'; script-src 'sha256-[^;]+; style-src/);
  assert.match(headers, /Strict-Transport-Security: max-age=\d+; includeSubDomains/);
  assert.match(headers, /Referrer-Policy: no-referrer\n/);
  assert.doesNotMatch(headers, /data:/, 'img-src data: is not needed');
  assert.match(headers, /^\/keys\.json$/m);
  assertCleanPages(assert, out);
});

test('with fixture data', () => {
  const out = join(tmp, 'fixture');
  const index = buildIndex({
    published: { reader: { '0.9.0': rec('0.9.0', '2026-10-01T00:00:00Z'), '1.0.0': rec('1.0.0', '2026-11-01T00:00:00Z') } },
    sources: { reader: { listing: JSON.parse(readFileSync(join(fixture, 'marketplace.json'), 'utf8')), readme: readFileSync(join(fixture, 'README.md'), 'utf8'), changelog: readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8') } },
    revoked: { packages: [{ name: 'reader', version: '0.9.0', reason: 'a test revocation' }], keys: [] },
    generatedAt: '2026-11-10T12:00:00Z',
    expires: '2026-12-10T12:00:00Z',
  });
  const indexFile = join(tmp, 'index.json');
  writeFileSync(indexFile, serializeIndex(index));
  const statsFile = join(tmp, 'stats.json');
  writeFileSync(statsFile, JSON.stringify({ generatedAt: '2026-11-10T00:00:00Z', downloads: { reader: 1234 } }));
  buildSite(out, indexFile, statsFile);
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /No plugins yet/);
  assert.match(home, /href="\/reader\/"/);
  assert.match(home, /data-search="reader \(test fixture\)/);
  assert.match(home, /<span data-downloads>1,234 downloads<\/span>/);
  const page = readFileSync(join(out, 'reader', 'index.html'), 'utf8');
  assert.match(page, /Reviewed and signed by Octipus/);
  assert.match(page, /1,234 downloads/);
  assert.match(page, /ed25519:efef/);
  assert.match(page, /What it asks for/);
  assert.match(page, /host API: model:complete, notes:write, store:read, store:write, tasks:write, web:read/);
  assert.match(page, /Keeps up to 5 MB of its own data per user/);
  assert.match(page, /store: up to 5242880 bytes per user \(store:read, store:write\)/);
  assert.match(page, /Changes data in the connected system/);
  assert.match(page, /schedule digest 0 7 \* \* 1 \(UTC\) → reader_action \(read\) with \{&quot;limit&quot;:5\}, run as the installing admin, unattended/);
  assert.match(page, /command \/read → read_url \(read\), run as the user who types it/);
  assert.match(page, /pages: Reader \(\/plugins\/reader\/read\)/);
  assert.match(page, /Adds the page &quot;Reader&quot;: \/read → index\.html/);
  assert.match(page, /Serves its page files: ui\/, sha256 be6a9400341b5851b0091846224ea4262fdbd496bc22645e2135b9c38488dbfd/);
  assert.match(page, /prompt: prompt\.md is added to the system prompt of agents of the roles researcher, for every user, fenced as third-party text \(sha256 (ab){32}\)/);
  assert.match(page, /Install in Octipus/);
  assert.match(page, /octi plugin install reader/);
  assert.match(page, /revoked: a test revocation/);
  assert.match(page, /First version \(fixture\)/);
  assert.match(page, /Licence <strong>MIT<\/strong>/);
  assert.match(page, /<img src="\/reader\/icon.png" alt="The icon"/);
  assert.doesNotMatch(page, /example\.com\/tracker\.png/);
  assert.doesNotMatch(page, /<script>alert/);
  assertCleanPages(assert, out);
});

// H3, reproduced by the review (mkidx.mjs): a description with a script and
// an event handler, and a README that is only a script. Before the fix the
// description went through set:html and the CSP hashed whatever inline
// script the pages had, so the injected script was allowed.
test('H3: an index description is text, and the CSP allows only the source scripts', () => {
  const out = join(tmp, 'evil');
  const evil = { ...rec('1.0.0', '2026-11-01T00:00:00Z'), permissions: { ...permissions, name: 'evil' }, description: '<script>alert(document.domain)</script><img src=x onerror=alert(2)>' };
  const index = buildIndex({
    published: { evil: { '1.0.0': evil } },
    sources: { evil: { listing: { title: 'Evil plugin', summary: 'An evil plugin here', category: 'utilities', license: 'MIT', author: { name: 'x' } }, readme: '<script>x</script>', changelog: '## 1.0.0\n' } },
    revoked: { packages: [], keys: [] },
    generatedAt: '2026-11-10T00:00:00Z',
    expires: '2026-12-10T00:00:00Z',
  });
  const indexFile = join(tmp, 'evil-index.json');
  writeFileSync(indexFile, serializeIndex(index));
  buildSite(out, indexFile);
  const page = readFileSync(join(out, 'evil', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /<img src=x/i);
  assert.match(page, /&lt;script&gt;alert\(document\.domain\)&lt;\/script&gt;/);
  const csp = readFileSync(join(out, 'csp.txt'), 'utf8');
  const allowed = [...csp.matchAll(/'sha256-[^']+'/g)].map((m) => m[0]).sort();
  assert.deepEqual(allowed, scriptHashes(), 'the CSP names exactly the scripts of site/src/scripts/');
  for (const [p, html] of htmlPages(out)) assert.deepEqual(auditPage(html, new Set(scriptHashes())), [], p);
  assertCleanPages(assert, out);
});

test('H3: the page audit refuses any script, handler or javascript: URL the allowlist does not name', () => {
  const ok = new Set(scriptHashes());
  assert.deepEqual(auditPage('<p>hi</p>', ok), []);
  assert.ok(auditPage('<script>alert(1)</script>', ok).some((p) => /not one of site\/src\/scripts/.test(p)));
  assert.ok(auditPage('<script src="/x.js"></script>', ok).some((p) => /attributes/.test(p)));
  assert.ok(auditPage('<img src=x onerror=alert(1)>', ok).some((p) => /event attribute onerror/.test(p)));
  assert.ok(auditPage('<a href="jav&#x61;script:alert(1)">x</a>', ok).some((p) => /javascript: URL/.test(p)));
  assert.ok(auditPage('<a href=" JaVaScRiPt:alert(1)">x</a>', ok).some((p) => /javascript: URL/.test(p)));
  assert.ok(auditPage('<p style="color:red">x</p>', ok).some((p) => /style attribute/.test(p)));
  assert.ok(auditPage('<iframe src="/"></iframe>', ok).some((p) => /<iframe>/.test(p)));
  assert.ok(auditPage('<script>', ok).some((p) => /without/.test(p)));
});

test('an invalid stats.json stops the site build (it is unsigned: nothing in it is taken as it is)', () => {
  const statsFile = join(tmp, 'bad-stats.json');
  writeFileSync(statsFile, JSON.stringify({ generatedAt: '2026-11-10T00:00:00Z', downloads: { '<script>': 1 } }));
  assert.throws(() => buildSite(join(tmp, 'bad'), join(tmp, 'index.json'), statsFile), /not a plugin name and a count/);
});
