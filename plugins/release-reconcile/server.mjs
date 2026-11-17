// Release reconciliation: an MCP server over stdio, no dependencies.
//
// The plugin never reads files, runs commands or holds credentials. Profiles
// and run records live in the per-user, per-workspace store (store:read,
// store:write). Evidence is gathered by the Octipus host (repos:collect): a
// background run of fixed Git reads in the user's execution environment and
// paginated GETs through admin-approved connections. This server only builds
// the typed request, keeps the run id, and turns the evidence into a
// deterministic report (lib/reconcile.mjs). Every call goes through the host
// API with the token in `_meta["octipus/host"]`, through the egress proxy.
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { buildCollectorRequest, InputError, normaliseTickets, validateProfile, validateRunSettings } from './lib/profile.mjs';
import { reconcile } from './lib/reconcile.mjs';

const VERSION = '0.1.0';
const RUN_ID = /^[0-9a-f-]{36}$/i;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const s = (description) => ({ type: 'string', description });

export const TOOLS = [
  { name: 'profile_list', description: 'List your saved release-audit profiles (this workspace).', inputSchema: obj({}) },
  { name: 'profile_get', description: 'Read one saved profile.', inputSchema: obj({ id: s('Profile id') }, ['id']) },
  { name: 'profile_save', description: 'Save (create or replace) a reusable profile: environment, workspace root, repositories with source/release/testing branches and baseline, products, tracker and forge connections, ticket and status policies.', inputSchema: obj({ profile: { type: 'object', description: 'The profile (see the page for the format)' } }, ['profile']) },
  { name: 'profile_delete', description: 'Delete a saved profile.', inputSchema: obj({ id: s('Profile id') }, ['id']) },
  { name: 'collector_options', description: 'Your execution environments, approved folders and connections the evidence collector may use.', inputSchema: obj({}) },
  {
    name: 'audit_start',
    description: 'Start a read-only release audit for a saved profile and target versions per product: the host fetches audit refs and reads Git history and tracker data in the background. Returns a run id.',
    inputSchema: obj({
      profileId: s('Saved profile id'),
      versions: { type: 'object', description: 'Target version per product, e.g. { "billing": "2.4.0" }', additionalProperties: { type: 'string' } },
      includeTesting: { type: 'boolean', description: 'Compare the testing branches too (default true)' },
      fetch: { type: 'boolean', description: 'Fetch audit refs through the configured connections first (default true)' },
      maxCommits: { type: 'integer', description: 'Commits per range before the range counts as truncated (default 2000)' },
    }, ['profileId']),
  },
  { name: 'audit_status', description: 'Read an audit run; once done, the reconciliation report (findings, tickets with their exact branch/MR/commit evidence, branch checks, completeness).', inputSchema: obj({ runId: s('The run id audit_start returned') }, ['runId']) },
  { name: 'audit_list', description: 'List your recent audit runs (this workspace).', inputSchema: obj({}) },
  { name: 'audit_cancel', description: 'Cancel a running audit.', inputSchema: obj({ runId: s('The run id') }, ['runId']) },
];

class ToolError extends Error {}

// ── Host API ───────────────────────────────────────────────────────────────

function hostRequest(host, method, path, body) {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return Promise.reject(new ToolError('The Octipus host API is not reachable (no egress proxy); is the plugin enabled with its host scopes approved?'));
  const p = new URL(proxy);
  const target = new URL(`${host.url}/api/plugin-host${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      host: p.hostname, port: Number(p.port || 80), method, path: target.href,
      headers: { host: target.host, authorization: `Bearer ${host.token}`, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { json = { error: raw.slice(0, 500) }; }
        resolve({ status: res.statusCode ?? 0, body: json });
      });
    });
    req.on('error', (err) => reject(new ToolError(`The Octipus host API could not be reached: ${err.message}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function host(meta, scope, method, path, body, { allow404 = false } = {}) {
  if (!meta) throw new ToolError('This call carries no host API token: the plugin\'s host scopes are not approved, or your rules deny them');
  if (!meta.scopes?.includes(scope)) throw new ToolError(`This call may not use ${scope} (not approved, or denied by your rules)`);
  const res = await hostRequest(meta, method, path, body);
  if (allow404 && res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    const err = new ToolError(`${res.body?.error || `The host API answered ${res.status}`}${res.body?.code ? ` (${res.body.code})` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

const profileKey = (id) => `profiles/${id}`;
const runKey = (id) => `runs/${id}`;
const idOf = (v, re, what) => (typeof v === 'string' && re.test(v) ? v : (() => { throw new ToolError(`${what} is invalid`); })());

async function loadProfile(meta, id) {
  const entry = await host(meta, 'store:read', 'GET', `/store/${profileKey(idOf(id, PROFILE_ID, 'Profile id'))}`, undefined, { allow404: true });
  if (!entry) throw new ToolError(`No saved profile ${id} in this workspace`);
  return validateProfile(entry.value);
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const HANDLERS = {
  async profile_list(_args, meta) {
    const { keys, truncated } = await host(meta, 'store:read', 'GET', '/store?prefix=profiles/&limit=200');
    const profiles = [];
    for (const k of keys) {
      const e = await host(meta, 'store:read', 'GET', `/store/${k.key}`, undefined, { allow404: true });
      if (e) profiles.push({ id: e.value?.id, name: e.value?.name, repos: e.value?.repos?.length ?? 0, updatedAt: k.updatedAt });
    }
    return { profiles, truncated };
  },
  async profile_get(args, meta) {
    return { profile: await loadProfile(meta, args.id) };
  },
  async profile_save(args, meta) {
    const profile = validateProfile(args.profile);
    const out = await host(meta, 'store:write', 'PUT', `/store/${profileKey(profile.id)}`, { value: profile });
    return { saved: true, id: profile.id, version: out.version };
  },
  async profile_delete(args, meta) {
    await host(meta, 'store:write', 'DELETE', `/store/${profileKey(idOf(args.id, PROFILE_ID, 'Profile id'))}`);
    return { deleted: true, id: args.id };
  },
  async collector_options(_args, meta) {
    return host(meta, 'repos:collect', 'GET', '/collector/environments');
  },
  async audit_start(args, meta) {
    const profile = await loadProfile(meta, args.profileId);
    const run = validateRunSettings({ profileId: args.profileId, versions: args.versions, includeTesting: args.includeTesting, fetch: args.fetch, maxCommits: args.maxCommits }, profile);
    const started = await host(meta, 'repos:collect', 'POST', '/collector/runs', buildCollectorRequest(profile, run));
    try {
      // The profile as it was at the start: a report never mixes two versions of it.
      await host(meta, 'store:write', 'PUT', `/store/${runKey(started.id)}`, { value: { runId: started.id, profile, run, startedAt: new Date().toISOString() }, ifVersion: 0 });
    } catch (err) {
      await host(meta, 'repos:collect', 'DELETE', `/collector/runs/${started.id}`).catch((e) => process.stderr.write(`release-reconcile: cancelling ${started.id} failed: ${e.message}\n`));
      throw new ToolError(`The audit was not recorded and was cancelled: ${err.message}`);
    }
    return { runId: started.id, status: started.status, versions: run.versions };
  },
  async audit_status(args, meta) {
    const runId = idOf(args.runId, RUN_ID, 'runId');
    const record = await host(meta, 'store:read', 'GET', `/store/${runKey(runId)}`, undefined, { allow404: true });
    if (!record) throw new ToolError('No audit with this id in this workspace');
    const view = await host(meta, 'repos:collect', 'GET', `/collector/runs/${runId}`);
    const out = { runId, status: view.status, stage: view.stage, startedAt: view.startedAt, finishedAt: view.finishedAt, versions: record.value.run.versions, profile: record.value.profile.name };
    if (view.error) out.error = view.error;
    if (view.status === 'interrupted') out.error = view.error || 'Octipus restarted while collecting; start the audit again.';
    if (view.status === 'done') {
      if (view.withheld) out.error = `The evidence is classified above what this plugin may show (protection level ${view.withheld.protectionLevel}); an admin sets collector_protection_level.`;
      else if (!view.evidence) out.error = 'The collector finished without evidence';
      else out.report = reconcile(record.value.profile, record.value.run, view.evidence, normaliseTickets(record.value.profile, view.evidence));
    }
    return out;
  },
  async audit_list(_args, meta) {
    const { keys, truncated } = await host(meta, 'store:read', 'GET', '/store?prefix=runs/&limit=200');
    return { runs: keys.map((k) => ({ runId: k.key.slice('runs/'.length), updatedAt: k.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), truncated };
  },
  async audit_cancel(args, meta) {
    return host(meta, 'repos:collect', 'DELETE', `/collector/runs/${idOf(args.runId, RUN_ID, 'runId')}`);
  },
};

// ── MCP over stdio ─────────────────────────────────────────────────────────

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

export async function callTool(params) {
  const handler = Object.hasOwn(HANDLERS, params?.name) ? HANDLERS[params.name] : null;
  if (!handler) return { isError: true, ...text(`Unknown tool ${params?.name}`) };
  try {
    return text(await handler(params.arguments ?? {}, params._meta?.['octipus/host']));
  } catch (err) {
    if (err instanceof ToolError || err instanceof InputError) return { isError: true, ...text(err.message) };
    process.stderr.write(`release-reconcile: ${params.name} failed: ${err?.stack ?? err}\n`);
    return { isError: true, ...text(`The release-reconcile plugin failed: ${err?.message ?? String(err)}`) };
  }
}

function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'release-reconcile', version: VERSION } } });
      return;
    case 'tools/list':
      send({ id: msg.id, result: { tools: TOOLS } });
      return;
    case 'tools/call':
      callTool(msg.params).then((result) => send({ id: msg.id, result }));
      return;
    case 'ping':
    case 'shutdown':
      send({ id: msg.id, result: {} });
      return;
    default:
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createInterface({ input: process.stdin }).on('line', onLine);
