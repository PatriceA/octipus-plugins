// The one door to the Octipus CLI (`octi plugin …`).
//
// Hashing, packing, signing, permissions and validation are Octipus's own:
// this repository never reimplements them, it calls the CLI of an Octipus
// checkout. Locally that checkout is $OCTIPUS (default ../octipus, next to
// this repository); CI checks out PatriceA/octipus at the commit in
// OCTIPUS_REF and points $OCTIPUS at it.
//
// The CLI is started one way only (H7):
//
//   $OCTIPUS/node_modules/.bin/tsx --tsconfig $OCTIPUS/tsconfig.json $OCTIPUS/scripts/plugin.ts <cmd> <args…>
//
// never through npx (which installs a missing tsx from the registry without
// asking), and there is no override: $OCTI_CLI is refused. Before the first
// call the checkout is checked: its HEAD is exactly the 40-hex commit in
// OCTIPUS_REF and `git status` shows nothing (no modified, staged or
// untracked file; ignored files such as node_modules are not code under
// review here, see README "Trust").
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Octipus checkout the CLI runs from. */
export function octipusDir(env = process.env) {
  return resolve(env.OCTIPUS || join(REPO_ROOT, '..', 'octipus'));
}

/** The commit in OCTIPUS_REF: its first line that is neither blank nor a comment, 40 lower-case hex. */
export function octipusRef(root = REPO_ROOT) {
  const text = readFileSync(join(root, 'OCTIPUS_REF'), 'utf8');
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error('OCTIPUS_REF names no commit');
  if (!/^[0-9a-f]{40}$/.test(line)) throw new Error(`OCTIPUS_REF must be a full 40-hex commit id, not ${JSON.stringify(line.slice(0, 80))} (a branch, tag or refs/pull/… can move)`);
  return line;
}

export class OctiError extends Error {
  constructor(message, { code, stdout, stderr, cmd } = {}) {
    super(message);
    this.name = 'OctiError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.cmd = cmd;
  }
}

/**
 * Why the checkout at `dir` is not the pinned CLI, or null: HEAD must be
 * `ref` and the worktree clean.
 */
export function pinProblem(dir, ref) {
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let head;
  try { head = g(['rev-parse', 'HEAD']); } catch { return `${dir} is not a git checkout of PatriceA/octipus`; }
  if (head !== ref) return `${dir} is at ${head.slice(0, 12)}, not OCTIPUS_REF ${ref.slice(0, 12)}: git -C ${dir} checkout ${ref}`;
  const dirty = g(['status', '--porcelain', '--untracked-files=all']);
  if (dirty) return `${dir} has local changes; the CLI must be exactly OCTIPUS_REF:\n${dirty.split('\n').slice(0, 10).join('\n')}`;
  return null;
}

const checked = new Map();

/** The command line (executable, leading arguments, cwd) that runs `octi plugin <cmd>`, after checking the pin. */
export function cliCommand(env = process.env) {
  if (env.OCTI_CLI !== undefined) throw new OctiError('OCTI_CLI is set: this repository runs only the pinned Octipus CLI ($OCTIPUS at OCTIPUS_REF). Unset OCTI_CLI.');
  const dir = octipusDir(env);
  if (!existsSync(join(dir, 'scripts', 'plugin.ts'))) {
    throw new OctiError(`No Octipus checkout at ${dir} (scripts/plugin.ts is missing). Set OCTIPUS to a checkout of PatriceA/octipus at the commit in OCTIPUS_REF, with npm ci --ignore-scripts run in it.`);
  }
  const tsx = join(dir, 'node_modules', '.bin', 'tsx');
  try { lstatSync(tsx); } catch { throw new OctiError(`${tsx} is missing: run npm ci --ignore-scripts in ${dir} (never npx, which would fetch tsx from the registry)`); }
  if (!checked.has(dir)) {
    const problem = pinProblem(dir, octipusRef());
    checked.set(dir, problem);
  }
  const problem = checked.get(dir);
  if (problem) throw new OctiError(problem);
  return {
    exe: tsx,
    pre: ['--tsconfig', join(dir, 'tsconfig.json'), join(dir, 'scripts', 'plugin.ts')],
    cwd: process.cwd(),
  };
}

/**
 * Run `octi plugin <cmd> <args…>`.
 *
 * - `json`: parse stdout as JSON (the CLI's `--json` output) and return it;
 *   otherwise return `{ code, stdout, stderr }`.
 * - `input`: written to the CLI's stdin (a passphrase for `--passphrase-file -`);
 *   without it stdin is inherited only when `interactive` is set.
 * - `okCodes`: exit codes that are not an error (validate exits 1 when not ok,
 *   with its JSON on stdout).
 */
export function octi(cmd, args = [], { json = false, input, interactive = false, okCodes = [0], env = process.env, timeoutMs = 300_000 } = {}) {
  const { exe, pre, cwd } = cliCommand(env);
  const argv = [...pre, cmd, ...args];
  const shown = `octi plugin ${cmd} ${args.join(' ')}`.trim();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, argv, {
      cwd,
      env: cliEnv(env),
      stdio: [input !== undefined ? 'pipe' : interactive ? 'inherit' : 'ignore', 'pipe', interactive ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(new OctiError(`${shown}: ${err.message}`, { cmd: shown })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!okCodes.includes(code)) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-15).join('\n');
        reject(new OctiError(`${shown} exited ${code}${detail ? `:\n${detail}` : ''}`, { code, stdout, stderr, cmd: shown }));
        return;
      }
      if (!json) { resolvePromise({ code, stdout, stderr }); return; }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new OctiError(`${shown}: expected JSON on stdout, got:\n${stdout.slice(0, 2000)}${stderr ? `\n${stderr.slice(-2000)}` : ''}`, { code, stdout, stderr, cmd: shown }));
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** The CLI's environment: the caller's, without NODE_OPTIONS (which could load code into it). */
function cliEnv(env) {
  const out = { ...env, OCTI_USER_CWD: process.cwd() };
  delete out.NODE_OPTIONS;
  return out;
}

const abs = (p) => (isAbsolute(p) ? p : resolve(p));

/** Passphrase options: `{ passphrase }` is piped to `--passphrase-file -`. */
function passArgs(opts) {
  return opts.passphrase !== undefined ? ['--passphrase-file', '-'] : [];
}

export const cli = {
  /** `{ ok, problems[], warnings[] }`. */
  validate: (dir) => octi('validate', [abs(dir), '--json'], { json: true, okCodes: [0, 1] }),
  /** `{ name, version, contentHash }`. */
  hash: (dir) => octi('hash', [abs(dir), '--json'], { json: true }),
  /** `{ file, sha256, contentHash, name, version }`. */
  pack: (dir, out) => octi('pack', [abs(dir), '--out', abs(out), '--json'], { json: true }),
  /** The permissions summary (docs/plans/marketplace.md, Index v2). */
  permissions: (dir) => octi('permissions', [abs(dir), '--json'], { json: true }),
  /** `{ valid, keyId, contentHash, error? }`; exit 1 when not valid. */
  verify: (dir, pub) => octi('verify', [abs(dir), '--pub', abs(pub), '--json'], { json: true, okCodes: [0, 1] }),
  /** `{ valid, keyId, … }`; exit 1 when not valid. */
  verifyIndex: (file, pubs) => octi('verify-index', [abs(file), ...pubs.flatMap((p) => ['--pub', abs(p)]), '--json'], { json: true, okCodes: [0, 1] }),
  sign: (dir, key, opts = {}) => octi('sign', [abs(dir), '--key', abs(key), ...passArgs(opts)], { input: opts.passphrase }),
  signIndex: (file, key, opts = {}) => octi('sign-index', [abs(file), '--key', abs(key), ...passArgs(opts)], { input: opts.passphrase }),
  keygen: (prefix, opts = {}) => octi('keygen', [abs(prefix), ...passArgs(opts)], { input: opts.passphrase }),
};

/** The subcommands the CLI in use lists in its help, to tell a missing command from a failing one. */
export async function cliSubcommands() {
  const { stdout } = await octi('help');
  return new Set([...stdout.matchAll(/^\s+octi plugin ([a-z][a-z-]*)/gm)].map((m) => m[1]));
}

export const REQUIRED_SUBCOMMANDS = ['validate', 'hash', 'pack', 'permissions', 'verify', 'verify-index', 'sign', 'sign-index', 'keygen'];

/** The required subcommands the CLI does not have yet. */
export async function missingSubcommands() {
  const have = await cliSubcommands();
  return REQUIRED_SUBCOMMANDS.filter((c) => !have.has(c));
}

/** Whether keygen, sign and sign-index take `--passphrase-file` (encrypted keys). */
export async function cliHasPassphrase() {
  const { stdout } = await octi('help');
  return stdout.includes('--passphrase-file');
}
