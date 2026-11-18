#!/usr/bin/env node
// Local publisher assistant. Built-ins only: the private key is opened solely
// by the isolated sign.mjs child. No key, token or passphrase enters this state.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const defaultConfig = join(homedir(), '.config', 'octipus-marketplace', 'publisher.json');
const defaultState = join(homedir(), '.local', 'state', 'octipus-marketplace', hash(ROOT).slice(0, 16));
const phases = ['prepare', 'sign', 'finish', 'deploy', 'record', 'verify', 'complete'];

export function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Refusing a symbolic-link state file.');
  const tmp = path + '.tmp-' + randomUUID();
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}
export function artifactHashes(directory) {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error('A release artifact is a symbolic link: ' + rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel + '/');
      else if (entry.isFile()) files[rel] = hash(readFileSync(join(dir, entry.name)));
      else throw Error('Unsupported release artifact: ' + rel);
    }
  };
  walk(directory);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export function verifyArtifacts(directory, expected) {
  if (JSON.stringify(artifactHashes(directory)) !== JSON.stringify(expected)) throw Error('Prepared artifacts changed. Nothing will be deployed. Rebuild and review a new release.');
}

/** The shipping orchestration and its recovery boundaries, shared with tests. */
export async function runRelease(state, operations, save) {
  for (const phase of phases.slice(0, -1)) {
    try {
      if (state.completed.includes(phase)) { await operations.verifyCompleted(phase, state); continue; }
      // A failed inspection is unknown, never permission to repeat the action.
      if (state.active === phase && await operations.reconcile(phase, state)) {
        state.completed.push(phase); state.active = null; state.error = null; await save(state); continue;
      }
    } catch (error) {
      state.error = { phase, message: error.message, at: new Date().toISOString() }; await save(state); throw error;
    }
    state.active = phase; state.error = null; await save(state);
    try {
      await operations[phase](state);
      state.completed.push(phase); state.active = null; await save(state);
    } catch (error) {
      state.error = { phase, message: error.message, at: new Date().toISOString() }; await save(state); throw error;
    }
  }
  state.active = null; state.finishedAt = new Date().toISOString(); await save(state);
  return state;
}

export function isPublicationCommit(state, parent, changedPaths, recordBytes) {
  return parent === state.commit && changedPaths === 'published.json' && hash(recordBytes) === state.publishedHash;
}

async function command(executable, args, { cwd = ROOT, capture = false } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(executable, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let output = '', error = '';
    if (capture) { child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; }); }
    child.on('error', fail);
    child.on('close', code => code === 0 ? ok(output.trim()) : fail(Error(`${executable} exited ${code}${capture ? ': ' + error.slice(-1500) : ''}`)));
  });
}
const git = (...args) => command('git', args, { capture: true });
async function confirm(message) {
  if (!process.stdin.isTTY) throw Error('Confirmation needs a terminal. Run node scripts/release.mjs locally.');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(y|yes)$/i.test((await rl.question(message + ' [y/N] ')).trim()); } finally { rl.close(); }
}
function regular(path) { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('Use a regular file: ' + path); return path; }
async function configure(path) {
  if (!process.stdin.isTTY) throw Error('Publisher setup needs a terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.log('Publisher setup — one time. Installing or privately using plugins needs no signing keys.');
    const previous=existsSync(path)?json(regular(path)):{};
    const expand=value=>value.startsWith('~/')?join(homedir(),value.slice(2)):resolve(value);
    const rootPub = regular(expand((await rl.question('Root public key file'+(previous.rootPub?' ['+previous.rootPub+']':'')+': ')).trim()||previous.rootPub||''));
    const key = regular(expand((await rl.question('Encrypted signing key file'+(previous.key?' ['+previous.key+']':'')+': ')).trim()||previous.key||''));
    for (const file of [rootPub, key]) if (file === ROOT || file.startsWith(ROOT + '/')) throw Error('Publisher keys must stay outside the repository.');
    const selectedHost=(await rl.question('SSH publishing host (user@host; blank keeps current, - prepares only)'+(previous.deploy?' ['+previous.deploy.host+']':'')+': ')).trim();
    const host=selectedHost==='-'?'':selectedHost||previous.deploy?.host||'';
    const directory = host ? (await rl.question('Website directory on that host'+(previous.deploy?' ['+previous.deploy.directory+']':'')+': ')).trim()||previous.deploy?.directory||'' : '';
    const publicUrl = host ? (await rl.question('Public marketplace URL (https://…)'+(previous.deploy?' ['+previous.deploy.publicUrl+']':'')+': ')).trim()||previous.deploy?.publicUrl||'' : '';
    const config = { schema: 1, rootPub, key, ...(host ? { deploy: { host, directory, publicUrl } } : {}) };
    validateConfig(config); writeState(path, config); console.log('Saved publisher settings. The passphrase is never saved.');
  } finally { rl.close(); }
}
export function validateConfig(config) {
  if (config.schema !== 1 || typeof config.rootPub !== 'string' || typeof config.key !== 'string') throw Error('Run publisher setup again.');
  if (config.deploy) {
    const { host, directory, publicUrl } = config.deploy;
    if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host) || !/^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?$/.test(directory) || directory.split('/').some(p => p === '..' || p === '.')) throw Error('Choose a valid SSH host and an explicit website directory below the filesystem root.');
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('The public marketplace URL must use HTTPS without credentials or query parameters.');
  }
  return config;
}
async function remoteMatches(config, state, dist) {
  if (!config.deploy) return false;
  verifyArtifacts(dist, state.artifacts);
  // Verify the whole shipped site, including its assets. stats.json is live telemetry
  // intentionally preserved by the transfer and is not a signed release artifact.
  const paths = Object.keys(state.artifacts).filter(p => p !== 'stats.json');
  for (const path of paths) {
    if (!Object.hasOwn(state.artifacts, path)) continue;
    const response = await fetch(new URL(path, config.deploy.publicUrl.replace(/\/?$/, '/')), { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) return false;
    const h = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 50 * 1024 * 1024) throw Error('Published artifact exceeded its download limit.'); h.update(chunk); }
    if (h.digest('hex') !== state.artifacts[path]) return false;
  }
  return true;
}

async function validatorCheckout(stateDir) {
  const ref = readFileSync(join(ROOT, 'OCTIPUS_REF'), 'utf8').split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#'));
  if (!/^[a-f0-9]{40}$/.test(ref || '')) throw Error('OCTIPUS_REF is invalid.');
  const destination = join(stateDir, 'validator', ref);
  if (!existsSync(join(destination, '.git'))) {
    mkdirSync(dirname(destination), { recursive: true });
    await command('git', ['clone', '--quiet', '--no-checkout', 'https://github.com/PatriceA/octipus.git', destination]);
    await command('git', ['checkout', '--quiet', '--detach', ref], { cwd: destination });
  }
  // A local clone can have a stale local main even when its remote-tracking main is current.
  // Resolve the reviewed pin against the official main, never a workstation feature branch.
  await command('git', ['remote', 'set-url', 'origin', 'https://github.com/PatriceA/octipus.git'], { cwd: destination });
  await command('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: destination });
  await command('git', ['merge-base', '--is-ancestor', ref, 'origin/main'], { cwd: destination });
  const head = await command('git', ['rev-parse', 'HEAD'], { cwd: destination, capture: true });
  const dirty = await command('git', ['status', '--porcelain'], { cwd: destination, capture: true });
  if (head !== ref || dirty) throw Error('The cached validator changed. Remove that managed validator directory and retry.');
  const marker = destination + '.dependencies-ready';
  if (!existsSync(marker)) {
    console.log('Preparing the pinned validator automatically (one time per version)…');
    await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination });
    writeState(marker, { commit: ref });
  }
  return destination;
}
async function usePinnedNode(args, stateDir) {
  const expected = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
  if (!/^24\.[0-9]+\.[0-9]+$/.test(expected)) throw Error('The publishing Node version is invalid.');
  if (process.versions.node === expected) return false;
  const cwd = join(stateDir, 'runtime'); mkdirSync(cwd, { recursive: true });
  console.log(`Preparing Node ${expected} for reproducible publishing…`);
  const executable = await command('npm', ['exec', '--yes', '--package=node@' + expected, '--', 'node', '-p', 'process.execPath'], { cwd, capture: true });
  regular(executable);
  if (await command(executable, ['--version'], { capture: true }) !== 'v' + expected) throw Error('The publishing Node runtime could not be verified.');
  process.env.PATH = dirname(executable) + delimiter + process.env.PATH;
  await command(executable, [fileURLToPath(import.meta.url), ...args]);
  return true;
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, json: { type: 'boolean' }, configure: { type: 'boolean' }, new: { type: 'boolean' }, status: { type: 'boolean' }, config: { type: 'string' }, state: { type: 'string' } } });
  if(values.help){console.log('node scripts/release.mjs [--configure | --status | --new]\nOne guided release: prepare → review/sign locally → assemble → publish → verify.\nRun the same command after a failure. --new archives an unfinished local release; never an unknown publication.\n--configure saves key paths and hosting choices, not key contents or passphrases. --status shows progress (--json for technical details).');return;}
  if (process.env.npm_lifecycle_event || process.env.npm_execpath) throw Error('Run with node, not npm: node scripts/release.mjs');
  const stateDir = resolve(values.state ?? defaultState);
  if (!values.status && await usePinnedNode(process.argv.slice(2), stateDir)) return;
  const configPath = resolve(values.config ?? defaultConfig);
  if (values.configure) { await configure(configPath); return; }
  const statePath = join(stateDir, 'release.json');
  if (values.status) {
    if(!existsSync(statePath)){console.log('No release has started.');return;}
    const state=json(regular(statePath));
    console.log(values.json?JSON.stringify(state,null,2):'Release '+state.commit.slice(0,8)+'\n'+phases.slice(0,-1).map(p=>(state.completed.includes(p)?'✓ ':state.active===p?'→ ':'  ')+p).join('\n')+(state.error?'\nNeeds attention: '+state.error.message:'')+'\n'+(state.finishedAt?'Publication completed at '+state.finishedAt:'Continue with node scripts/release.mjs'));return;
  }
  if (!existsSync(configPath)) await configure(configPath);
  const config = validateConfig(json(regular(configPath)));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, 'active.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(regular(lock), 'utf8')); let live = true;
    try { process.kill(pid, 0); } catch (failure) { if (failure.code === 'ESRCH') live = false; else throw failure; }
    if (live || !Number.isSafeInteger(pid) || pid <= 0) throw Error('Another publisher may be running. Inspect ' + lock);
    renameSync(lock, lock + '.interrupted-' + Date.now()); writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  try {
    await git('fetch', '--quiet', 'origin', 'main');
    let head = await git('rev-parse', 'HEAD');
    let state = existsSync(statePath) ? json(regular(statePath)) : null;
    if ((!state || state.finishedAt) && await git('branch','--show-current')==='main' && !await git('status','--porcelain')) {
      const upstream=await git('rev-parse','origin/main');
      if(upstream!==head){console.log('Updating clean main before preparing publication…');await git('merge','--ff-only','origin/main');head=await git('rev-parse','HEAD');}
    }
    if ((values.new || state?.finishedAt && Date.now()-Date.parse(state.finishedAt)>=7*86400_000) && state) {
      if (state.externalAttempted && ['deploy','record','verify'].includes(state.active) || state.completed.includes('deploy') && !state.finishedAt) throw Error('Reconcile the previous publication before starting another release.');
      const stamp = Date.now();
      renameSync(statePath, join(stateDir, 'release-' + state.commit + '-' + stamp + '.json'));
      const oldWork = join(stateDir, state.commit);
      if (existsSync(oldWork)) renameSync(oldWork, oldWork + '-archived-' + stamp);
      state = null;
    }
    if (state?.finishedAt && state.commit !== head && state.recordCommit !== head) { renameSync(statePath, join(stateDir, 'release-' + state.commit + '.json')); state = null; }
    if (!state) state = { schema: 1, commit: head, completed: [], active: null, error: null };
    // A commit may have succeeded immediately before the journal write was interrupted.
    if (state?.active === 'record' && !state.recordCommit && head !== state.commit) {
      const parent = await git('rev-parse', 'HEAD^');
      const changed = await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD');
      if (isPublicationCommit(state, parent, changed, readFileSync(join(ROOT, 'published.json')))) {
        state.recordCommit = head; writeState(statePath, state);
      }
    }
    if (state.completed?.some((p,index)=>p!==phases[index]) || state.active && state.active!==phases[state.completed?.length]) throw Error('The saved release sequence is inconsistent. Inspect the journal before continuing.');
    if (state.schema !== 1 || !Array.isArray(state.completed) || !/^[a-f0-9]{40}$/.test(state.commit) || head !== state.commit && head !== state.recordCommit) throw Error('The source commit changed during this release. Finish or explicitly archive the old release before starting another.');
    // Discover prerequisites before asking the publisher to unlock a key.
    await command('gh', ['auth', 'status'], { capture: true });
    if (config.deploy) {
      await command('rsync', ['--version'], { capture: true });
      await command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.deploy.host, 'test -d ' + config.deploy.directory + ' && test -w ' + config.deploy.directory], { capture: true });
    }
    process.env.OCTIPUS = await validatorCheckout(stateDir);
    const commit = state.commit, work = join(stateDir, commit), plan = join(work, 'release', 'release-plan.json'), dist = join(work, 'dist'), finishRoot = join(work, 'finish');
    const save = s => writeState(statePath, s);
    const planArgs = ['--plan', plan, '--root-pub', config.rootPub];
    const checkSource = async () => {
      const branch = await git('branch', '--show-current');
      const status = await git('status', '--porcelain');
      if (branch !== 'main' || (status && status !== 'M published.json' && status !== ' M published.json') || await git('rev-parse', 'origin/main') !== await git('rev-parse', 'HEAD')) throw Error('Use current main with no changes except this release’s verified publication record. Pull main before a new release.');
    };
    const operations = {
      verifyCompleted: async phase => {
        if (['prepare','sign'].includes(phase) && hash(readFileSync(plan)) !== state.planHash) throw Error('The release plan changed.');
        if (['finish','deploy','record','verify'].includes(phase)) verifyArtifacts(dist, state.artifacts);
        if (phase === 'verify' && !await remoteMatches(config, state, dist)) throw Error('The previously published artifacts are no longer visible at the configured URL.');
      },
      reconcile: async phase => {
        if (phase === 'prepare' && existsSync(plan)) { const value = json(plan); if (value.commit !== commit) throw Error('Prepared plan belongs to another commit.'); state.planHash = hash(readFileSync(plan)); return true; }
        if (phase === 'sign') return existsSync(join(work, 'release/signed/signed.json')) && json(join(work, 'release/signed/signed.json')).commit === commit;
        if (phase === 'finish') { const receipt = join(work, 'finished.json'); if (!existsSync(receipt)) return false; const completed = json(receipt); verifyArtifacts(dist, completed.artifacts); state.artifacts = completed.artifacts; state.publishedHash = completed.publishedHash; return true; }
        if (phase === 'deploy') return remoteMatches(config, state, dist);
        if (phase === 'record' && state.recordCommit) { await git('fetch', '--quiet', 'origin', 'main'); return (await git('merge-base', state.recordCommit, 'origin/main')) === state.recordCommit; }
        return false;
      },
      prepare: async () => {
        await checkSource(); mkdirSync(work, { recursive: true, mode: 0o700 });
        if (await git('status', '--porcelain')) throw Error('Commit or discard local publication changes before preparing a new release.');
        console.log('1/6 · Validate, compare CI and prepare the release');
        await command(process.execPath, [join(ROOT, 'scripts/publish.mjs'), 'build', '--out', join(work, 'release'), '--root-pub', config.rootPub]);
        state.planHash = hash(readFileSync(plan));
      },
      sign: async () => {
        console.log('2/6 · Review and sign locally · your key stays here');
        await command(process.execPath, [join(ROOT, 'scripts/sign.mjs'), ...planArgs, '--key', config.key, '--batch', ...(existsSync(join(work, 'release/signed')) ? ['--retry'] : [])]);
      },
      finish: async () => {
        console.log('3/6 · Verify signatures and assemble the website');
        if (existsSync(finishRoot) && await command('git', ['status','--porcelain'], { cwd: finishRoot, capture: true })) {
          console.log('Rechecking interrupted local assembly; signed packages are preserved.');
          renameSync(finishRoot, finishRoot + '.interrupted-' + Date.now());
        }
        if (!existsSync(finishRoot)) await command('git', ['clone', '--quiet', '--no-hardlinks', '--branch', 'main', '--single-branch', ROOT, finishRoot]);
        if (await command('git', ['rev-parse','HEAD'], { cwd: finishRoot, capture: true }) !== commit) throw Error('Finish workspace is not the reviewed commit.');
        await command(process.execPath, [join(ROOT, 'scripts/publish.mjs'), 'finish', ...planArgs, '--workspace', finishRoot, '--out', dist]);
        state.artifacts = artifactHashes(dist); state.publishedHash = hash(readFileSync(join(finishRoot, 'published.json')));
        writeState(join(work, 'finished.json'), { artifacts: state.artifacts, publishedHash: state.publishedHash });
      },
      deploy: async () => {
        verifyArtifacts(dist, state.artifacts);
        if (!config.deploy) throw Error('Release is signed and ready. Run node scripts/release.mjs --configure to choose its publishing host, then rerun this command. Completed build/signing steps are preserved.');
        if (await remoteMatches(config, state, dist)) { console.log('4/6 · This release is already live; no transfer repeated.'); return; }
        if (!await confirm(`Publish this reviewed release to ${config.deploy.host}:${config.deploy.directory} and commit/push its publication record?`)) throw Error('Publication parked. Rerun the assistant to continue.');
        state.externalAttempted=true; await save(state);
        console.log('4/6 · Publish the prepared website');
        await command('rsync', ['-a', '--delete', '--filter', 'P stats.json', dist + '/', config.deploy.host + ':' + config.deploy.directory + '/']);
        if (!await remoteMatches(config, state, dist)) throw Error('Transfer returned, but the expected signed release is not fully visible at the public URL. Check hosting/cache and resume; publication is not confirmed.');
      },
      record: async () => {
        console.log('5/6 · Record the verified publication');
        if (!await remoteMatches(config, state, dist)) throw Error('The signed release is not live; no publication record will be pushed.');
        const expected = readFileSync(join(finishRoot, 'published.json'));
        if (hash(expected) !== state.publishedHash) throw Error('The prepared publication record changed.');
        const current = readFileSync(join(ROOT, 'published.json'));
        const status = await git('status', '--porcelain');
        if (status && (status !== 'M published.json' && status !== ' M published.json' || hash(current) !== state.publishedHash)) throw Error('The worktree has unrelated changes. Resolve them before recording publication.');
        if (hash(current) !== state.publishedHash) writeFileSync(join(ROOT, 'published.json'), expected);
        if (await git('diff', 'HEAD', '--', 'published.json')) await git('commit', '--only', '-m', 'Publish reviewed plugin release', '--', 'published.json');
        state.recordCommit = await git('rev-parse', 'HEAD'); await save(state);
        await command('git', ['push', 'origin', 'HEAD:main']);
      },
      verify: async () => {
        console.log('6/6 · Verify published artifacts and remote record');
        if (!await remoteMatches(config, state, dist)) throw Error('Live artifacts no longer match the signed release.');
        await git('fetch', '--quiet', 'origin', 'main');
        if ((await git('merge-base', state.recordCommit, 'origin/main')) !== state.recordCommit) throw Error('The publication record has not reached origin/main.');
      },
    };
    await runRelease(state, operations, save);
    console.log('Release complete. The signed plugins, marketplace index, website and publication record were verified.');
  } finally { const { unlinkSync } = await import('node:fs'); unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error('\n' + error.message + '\nFix the named step, then rerun the same command. Completed stages are preserved.'); process.exitCode = 1; });
