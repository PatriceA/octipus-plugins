// The sandbox the `test` job runs a plugin's own code in (its `npm test` and
// a smoke run of its server: `initialize`, `tools/list` over stdio).
//
// bwrap, always (there is no unsandboxed fallback): no network
// (--unshare-all), a read-only view of the system directories and of Node,
// nothing of the runner's home or workspace, a fresh /tmp, the plugin's own
// copy at /work (writable only for its tests) and a data directory at /data
// for the server. It is a CI gate, not Octipus's sandbox: it shows that the
// tests pass and the server starts and answers without network.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/** Where Node lives (its prefix: bin/node, bin/npm, lib/node_modules/npm). */
export const NODE_PREFIX = dirname(dirname(process.execPath));

/** Whether bwrap can start a sandbox here (installed, and user namespaces allowed). */
export function bwrapWorks() {
  const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true'], { stdio: 'ignore', timeout: 10_000 });
  return r.status === 0;
}

const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc/alternatives', '/etc/ssl', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf'];

/**
 * The bwrap command line: `work` at /work (read-only unless `writable`),
 * `data` (if any) at /data, then `command args…` in /work.
 */
export function sandboxArgs({ work, writable = false, data = null }, command, args) {
  const out = [];
  for (const p of SYSTEM) if (existsSync(p)) out.push('--ro-bind', p, p);
  out.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home');
  if (!SYSTEM.some((p) => NODE_PREFIX === p || NODE_PREFIX.startsWith(`${p}/`))) out.push('--ro-bind', NODE_PREFIX, NODE_PREFIX);
  out.push(writable ? '--bind' : '--ro-bind', work, '/work');
  if (data) out.push('--bind', data, '/data');
  out.push('--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--chdir', '/work');
  return [...out, '--', command, ...args];
}

/** The environment inside the sandbox (bwrap --clearenv, then these, through `env`). */
export function sandboxEnv(extra = {}) {
  return { PATH: `${NODE_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: '/tmp/home', LANG: 'C.UTF-8', TMPDIR: '/tmp', CI: 'true', ...extra };
}

/** `env K=V… command args…`, so the environment survives --clearenv. */
function withEnv(env, command, args) {
  return ['/usr/bin/env', [...Object.entries(env).map(([k, v]) => `${k}=${v}`), command, ...args]];
}

/** Run `command args…` in the sandbox; resolves `{ code, signal, output }` (the last 64 KB of stdout and stderr). */
export function sandboxRun({ work, writable, data, env = {}, timeoutMs = 10 * 60_000 }, command, args) {
  const [exe, argv] = withEnv(sandboxEnv(env), command, args);
  return new Promise((resolvePromise) => {
    const child = spawn('bwrap', sandboxArgs({ work, writable, data }, exe, argv), { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-65536); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, signal: null, output: `cannot start bwrap: ${err.message}` }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, output }); });
  });
}

/**
 * Start the server of the package in `dir` (manifest `server.command`/`args`)
 * and return `{ ok, tools: string[], serverInfo, error?, stderr }`.
 */
export async function smokeRun(dir, manifest, { timeoutMs = 20_000 } = {}) {
  const command = manifest?.server?.command;
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args.map(String) : [];
  if (typeof command !== 'string' || !command) return { ok: false, tools: [], error: 'the manifest names no server.command', stderr: '' };
  const dataDir = mkdtempSync(join(tmpdir(), 'octipus-smoke-data-'));
  const [envExe, envArgv] = withEnv(sandboxEnv({ OCTIPUS_PLUGIN_DATA_DIR: '/data' }), command, args);
  const exe = 'bwrap';
  const argv = sandboxArgs({ work: dir, data: dataDir }, envExe, envArgv);
  const child = spawn(exe, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 20_000) stderr += d; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  let exited = null;
  const exitPromise = new Promise((r) => child.on('close', (code, signal) => { exited = { code, signal }; r(); }));
  const spawnError = new Promise((r) => child.on('error', (err) => r(err)));
  // Losers of a race reject later; mark them handled so that is not an unhandled rejection.
  const quiet = (p) => { p.catch(() => {}); return p; };
  const request = (id, method, params) => quiet(new Promise((resolveReq, rejectReq) => {
    pending.set(id, resolveReq);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => err && rejectReq(err));
  }));
  child.stdin.on('error', () => {}); // EPIPE when the server is gone: reported as "exited" instead
  const deadline = (ms, what) => quiet(new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer to ${what} within ${ms / 1000} s`)), ms).unref()));
  const died = () => quiet(exitPromise.then(() => { throw new Error(`the server exited (${exited.signal ?? `code ${exited.code}`}) before answering`); }));
  const failed = quiet(spawnError.then((err) => { throw new Error(`cannot start ${exe}: ${err.message}`); }));
  try {
    const init = await Promise.race([
      request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'octipus-plugins-check', version: '1.0.0' } }),
      deadline(timeoutMs, 'initialize'), died(), failed,
    ]);
    if (init.error) throw new Error(`initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await Promise.race([request(2, 'tools/list', {}), deadline(timeoutMs, 'tools/list'), died(), failed]);
    if (list.error) throw new Error(`tools/list failed: ${list.error.message ?? JSON.stringify(list.error)}`);
    const tools = (list.result?.tools ?? []).map((t) => t?.name).filter((n) => typeof n === 'string');
    return { ok: true, tools, serverInfo: init.result?.serverInfo ?? null, stderr };
  } catch (err) {
    return { ok: false, tools: [], error: err.message, stderr };
  } finally {
    child.stdin.end();
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);
      if (!exited) child.kill('SIGKILL');
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
