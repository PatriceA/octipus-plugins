// The sandbox smoke run: start a package's server the way its manifest says,
// say `initialize` and ask for `tools/list` over stdio, and stop it.
//
// Under bwrap (when it is there and works) the server gets a read-only view
// of the system and its own directory, a fresh /tmp, its data directory as
// the only writable place, and no network (--unshare-all). It is a smoke
// test, not Octipus's sandbox: it shows that the server starts and answers
// without network or a writable package directory, as it will have to.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Whether bwrap can start a sandbox here (installed, and user namespaces allowed). */
export function bwrapWorks() {
  const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true'], { stdio: 'ignore', timeout: 10_000 });
  return r.status === 0;
}

/**
 * Pick how to run: `required` fails without bwrap, `auto` falls back to a
 * plain process with a warning, `off` runs plain.
 * @returns {{ mode: 'bwrap'|'plain', warning?: string }}
 */
export function chooseSandbox(want) {
  if (want === 'off') return { mode: 'plain' };
  if (bwrapWorks()) return { mode: 'bwrap' };
  if (want === 'required') throw new Error('bwrap is required for the smoke run but cannot start a sandbox here (install bubblewrap; on Ubuntu 24.04 allow unprivileged user namespaces)');
  return { mode: 'plain', warning: 'bwrap is not available here: the smoke run started the server without a sandbox' };
}

function bwrapArgs(dir, dataDir, command, args) {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--ro-bind', dir, dir,
    '--bind', dataDir, dataDir,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--chdir', dir,
    '--', command, ...args,
  ];
}

/**
 * Start the server of the package in `dir` (manifest `server.command`/`args`)
 * and return `{ ok, tools: string[], serverInfo, error?, stderr }`.
 */
export async function smokeRun(dir, manifest, { mode = 'plain', timeoutMs = 20_000 } = {}) {
  const command = manifest?.server?.command;
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args.map(String) : [];
  if (typeof command !== 'string' || !command) return { ok: false, tools: [], error: 'the manifest names no server.command', stderr: '' };
  const dataDir = mkdtempSync(join(tmpdir(), 'octipus-smoke-data-'));
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dataDir,
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    OCTIPUS_PLUGIN_DATA_DIR: dataDir,
  };
  const [exe, argv] = mode === 'bwrap' ? ['bwrap', bwrapArgs(dir, dataDir, command, args)] : [command, args];
  const child = spawn(exe, argv, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
