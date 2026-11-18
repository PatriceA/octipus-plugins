// The shipping path: server.mjs spawned as the host spawns it (node, stdio),
// every host call through an HTTP proxy (a fake host here) with the call's token.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { buildFixture, PROFILE, repoEvidence, trackerHttp } from './fixture.mjs';

const PKG = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(PKG, 'octipus-plugin.json'), 'utf8'));
const tokens = new Map();
const store = new Map();
const runs = new Map();
const calls = [];
let failRunRecord = false;
let proxy; let child; let fx;
const waiting = new Map();
let nextId = 1;

function hostHandler(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url);
    const grant = tokens.get((req.headers.authorization ?? '').replace('Bearer ', ''));
    const reply = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (!grant) return reply(401, { error: 'invalid token', code: 'invalid_token' });
    const path = url.pathname.replace('/api/plugin-host', '');
    calls.push({ user: grant.user, method: req.method, path, body: body ? JSON.parse(body) : undefined });
    const scope = grant.user + '|' + grant.ws + '|';
    if (path === '/store' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      return reply(200, { keys: [...store.keys()].filter((k) => k.startsWith(scope + prefix)).map((k) => ({ key: k.slice(scope.length), size: 1, version: store.get(k).version, updatedAt: '2026-01-01T00:00:00.000Z' })), truncated: false });
    }
    if (path.startsWith('/store/')) {
      const key = scope + path.slice('/store/'.length);
      if (req.method === 'GET') return store.has(key) ? reply(200, store.get(key)) : reply(404, { error: 'not found', code: 'not_found' });
      if (req.method === 'PUT') {
        const { value, ifVersion } = JSON.parse(body);
        if (failRunRecord && key.includes('|runs/')) return reply(409, { error: 'version conflict', code: 'version_conflict' });
        if (ifVersion === 0 && store.has(key)) return reply(409, { error: 'version conflict', code: 'version_conflict' });
        const version = (store.get(key)?.version ?? 0) + 1;
        store.set(key, { value, version });
        return reply(200, { version });
      }
      if (req.method === 'DELETE') { store.delete(key); return reply(200, { deleted: true }); }
    }
    if (path === '/collector/environments') return reply(200, { environments: [{ id: 'env-1', name: 'Workstation', roots: ['/workspace'] }], connections: ['tracker'] });
    if (path === '/collector/runs' && req.method === 'POST') {
      const id = globalThis.crypto.randomUUID();
      runs.set(id, { user: grant.user, request: JSON.parse(body), status: 'running' });
      return reply(202, { id, status: 'running' });
    }
    const m = path.match(/^\/collector\/runs\/([0-9a-f-]{36})$/);
    if (m) {
      const r = runs.get(m[1]);
      if (!r || r.user !== grant.user) return reply(404, { error: 'Run not found', code: 'not_found' });
      if (req.method === 'DELETE') { r.status = 'cancelled'; return reply(200, { id: m[1], status: 'cancelled' }); }
      return reply(200, { id: m[1], status: r.status, stage: r.status === 'running' ? 'repository api' : 'done', evidence: r.evidence ?? null, ...(r.withheld ? { withheld: { protectionLevel: 3 } } : {}), error: null, startedAt: 't0', finishedAt: r.status === 'done' ? 't1' : null });
    }
    return reply(404, { error: 'unknown endpoint' });
  });
}

function token(user, scopes, ws = 'ws-1') {
  const t = `ocph_${user}_${scopes.join('_')}_${ws}`;
  tokens.set(t, { user, ws });
  return { url: 'http://octipus-host.internal', token: t, scopes, expiresAt: '2099-01-01T00:00:00.000Z' };
}
const ALL = ['repos:collect', 'store:read', 'store:write'];
const READ = ['repos:collect', 'store:read'];

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
}
async function call(name, args, meta) {
  const res = await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: { 'octipus/host': meta } } : {}) });
  const text = res.result.content[0].text;
  return { isError: !!res.result.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

before(async () => {
  fx = buildFixture();
  proxy = createServer(hostHandler);
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  child = spawn(process.execPath, ['server.mjs'], { cwd: PKG, env: { PATH: process.env.PATH, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', (line) => { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
});
after(() => { child?.kill(); proxy?.close(); rmSync(fx.root, { recursive: true, force: true }); });

test('lists exactly the declared tools', async () => {
  const res = await rpc('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name).sort(), Object.keys(manifest.tools).sort());
  assert.deepEqual(manifest.host, ['repos:collect', 'store:read', 'store:write']);
  assert.equal(manifest.network, undefined, 'no network of its own: everything goes through the host');
});

test('profiles are per user and workspace; a read token cannot write; no token is refused', async () => {
  assert.equal((await call('profile_save', { profile: PROFILE }, token('alice', ALL))).isError, false);
  assert.equal((await call('profile_get', { id: 'example' }, token('bob', ALL))).isError, true);
  assert.equal((await call('profile_get', { id: 'example' }, token('alice', ALL, 'ws-2'))).isError, true);
  assert.equal((await call('profile_get', { id: 'example' }, token('alice', READ))).json.profile.name, 'Example');
  await call('profile_save', { profile: { ...PROFILE, name: 'Bob own' } }, token('bob', ALL));
  assert.equal((await call('profile_get', { id: 'example' }, token('alice', READ))).json.profile.name, 'Example');
  const denied = await call('profile_save', { profile: PROFILE }, token('alice', READ));
  assert.match(denied.text, /may not use store:write/);
  assert.match((await call('profile_list', {})).text, /no host API token/);
  assert.match((await call('profile_save', { profile: { ...PROFILE, repos: [{ ...PROFILE.repos[0], path: '/etc' }] } }, token('alice', ALL))).text, /relative folder/);
});

test('audit: start, record, poll, deterministic report; collector ownership', async () => {
  const started = await call('audit_start', { profileId: 'example', versions: { svc: '1.1.0' }, fetch: false }, token('alice', ALL));
  assert.equal(started.isError, false, started.text);
  const post = calls.find((c) => c.path === '/collector/runs' && c.method === 'POST');
  assert.equal(post.body.environmentId, 'env-1');
  assert.ok(post.body.repos.every((r) => !r.fetch), 'fetch: false collects local refs only');
  const runId = started.json.runId;
  assert.equal((await call('audit_status', { runId }, token('alice', READ))).json.status, 'running');
  assert.equal((await call('audit_status', { runId }, token('bob', READ))).isError, true, 'another user cannot read the run');
  const repos = [repoEvidence(fx.api, 'api', 'v1.0.0', { source: 'develop', release: 'release/1.1.0', testing: 'testing/1.1.0' }), repoEvidence(fx.web, 'web', 'v1.0.0', { source: 'develop', release: 'release/1.1.0' })];
  Object.assign(runs.get(runId), { status: 'done', evidence: { environmentId: 'env-1', startedAt: 't0', finishedAt: 't1', complete: true, repos, http: trackerHttp() } });
  const done = await call('audit_status', { runId }, token('alice', READ));
  assert.equal(done.isError, false, done.text);
  assert.equal(done.json.report.complete, true);
  assert.ok(done.json.report.findings.some((f) => f.kind === 'version_without_code' && f.ticket === 'ABC-10'));
  assert.deepEqual((await call('audit_status', { runId }, token('alice', READ))).json.report, done.json.report);
  runs.get(runId).withheld = true; runs.get(runId).evidence = null;
  assert.match((await call('audit_status', { runId }, token('alice', READ))).json.error, /protection level 3/);
});

test('a run whose record cannot be stored is cancelled, not left running', async () => {
  failRunRecord = true;
  const res = await call('audit_start', { profileId: 'example', versions: { svc: '1.1.0' } }, token('alice', ALL));
  failRunRecord = false;
  assert.equal(res.isError, true);
  assert.match(res.text, /cancelled/);
  const last = [...runs.values()].at(-1);
  assert.equal(last.status, 'cancelled');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/collector/runs/')));
});
