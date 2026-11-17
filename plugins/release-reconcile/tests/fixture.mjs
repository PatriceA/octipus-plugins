// Real temporary Git repositories and evidence in the exact shape of the
// Octipus collector (src/plugins/packages/host-collector.ts `CollectorEvidence`),
// produced by the same Git operations it runs. Synthetic, generic content only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null' };
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const gitCode = (cwd, ...args) => { try { execFileSync('git', args, { cwd, env: ENV, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
export const commit = (cwd, file, content, message) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };

const parseLog = (out) => out.split('\x1e').filter((r) => r.trim()).map((rec) => {
  const [sha, parents, ct, subject, body = ''] = rec.replace(/^\n/, '').split('\x1f');
  return { sha, parents: parents ? parents.split(' ') : [], committedAt: new Date(Number(ct) * 1000).toISOString(), subject, body: body.trim() };
});
const cherry = (cwd, upstream, head) => git(cwd, 'cherry', upstream, head).split('\n').filter(Boolean).map((l) => ({ sha: l.slice(2), equivalent: l.startsWith('-') }));

/** Collector-shaped evidence for one repository; `missing` names refs to report as failed fetches. */
export function repoEvidence(cwd, key, baselineRev, refs, { missing = [] } = {}) {
  const at = '2026-01-01T00:00:00.000Z';
  const rev = (r) => { try { return git(cwd, 'rev-parse', '--verify', '--end-of-options', `${r}^{commit}`); } catch { return null; } };
  const baseSha = rev(baselineRev);
  const out = { key, shallow: false, fetches: [], baseline: { name: 'baseline', input: baselineRev, resolvedRef: baselineRev, sha: baseSha, tree: baseSha && git(cwd, 'rev-parse', `${baseSha}^{tree}`), status: baseSha ? 'ok' : 'missing', source: 'local', at }, refs: [], ranges: [], pairs: [], complete: true, problems: [] };
  for (const [name, ref] of Object.entries(refs)) {
    if (missing.includes(name)) {
      out.refs.push({ name, input: ref, resolvedRef: ref, sha: null, tree: null, status: 'fetch_failed', source: 'fetched', at });
      out.fetches.push({ ref: name, refspec: `+refs/heads/${ref}:refs/remotes/octipus-audit/heads/${ref}`, ok: false, error: 'remote ref not found', at });
      out.complete = false; out.problems.push(`fetch of ${name} failed: its state is unknown`);
      continue;
    }
    const sha = rev(ref);
    out.refs.push({ name, input: ref, resolvedRef: ref, sha, tree: git(cwd, 'rev-parse', `${sha}^{tree}`), status: 'ok', source: 'local', at });
    out.ranges.push({ ref: name, baseSha, refSha: sha, baselineIsAncestor: gitCode(cwd, 'merge-base', '--is-ancestor', baseSha, sha) === 0, commits: parseLog(git(cwd, 'log', '--format=%x1e%H%x1f%P%x1f%ct%x1f%s%x1f%b', `${baseSha}..${sha}`, '--')), truncated: false });
  }
  const ok = out.refs.filter((r) => r.sha);
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const a = ok[i]; const b = ok[j];
    const [onlyInA, onlyInB] = git(cwd, 'rev-list', '--left-right', '--count', `${a.sha}...${b.sha}`).split(/\s+/).map(Number);
    const files = a.tree === b.tree ? [] : git(cwd, 'diff', '--name-only', a.sha, b.sha).split('\n').filter(Boolean);
    out.pairs.push({ a: a.name, b: b.name, aInB: gitCode(cwd, 'merge-base', '--is-ancestor', a.sha, b.sha) === 0, bInA: gitCode(cwd, 'merge-base', '--is-ancestor', b.sha, a.sha) === 0, onlyInA, onlyInB, sameTree: a.tree === b.tree, changedFiles: files, changedFilesTruncated: false, cherryAtoB: cherry(cwd, b.sha, a.sha), cherryBtoA: cherry(cwd, a.sha, b.sha), cherryTruncated: false });
  }
  return out;
}

/**
 * Two repositories of one product:
 *  api: ABC-1 merged (MR !7), ABC-2 cherry-picked, ABC-3 source-only, ABC-4 merged then reverted on release,
 *       ABC-5/ABC-6 in one commit (ambiguous), ABC-8 (subtask of ABC-7), an unticketed commit, a testing
 *       branch = release + version bump only.
 *  web: ABC-1 source-only (partial multi-repo delivery), release identical in tree to source minus ABC-1.
 */
export function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-fixture-'));
  const api = join(root, 'api');
  execFileSync('mkdir', ['-p', api]);
  git(api, 'init', '-q', '-b', 'main');
  writeFileSync(join(api, 'package.json'), '{"version":"1.0.0"}\n');
  git(api, 'add', '.'); git(api, 'commit', '-q', '-m', 'Initial');
  git(api, 'tag', 'v1.0.0');
  git(api, 'checkout', '-q', '-b', 'develop');
  const s = {};
  s.a1 = commit(api, 'one.txt', '1\n', 'ABC-1: first feature');
  s.a2 = commit(api, 'two.txt', '2\n', 'ABC-2: second feature');
  s.a3 = commit(api, 'three.txt', '3\n', 'ABC-3: third feature');
  git(api, 'checkout', '-q', '-b', 'feature/ABC-4', 'v1.0.0');
  s.a4 = commit(api, 'four.txt', '4\n', 'ABC-4: fourth feature');
  git(api, 'checkout', '-q', 'develop');
  git(api, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/ABC-4' into 'develop'", 'feature/ABC-4');
  s.a56 = commit(api, 'five.txt', '5\n', 'ABC-5 ABC-6: shared change');
  s.a8 = commit(api, 'eight.txt', '8\n', 'ABC-8: subtask work');
  git(api, 'checkout', '-q', '-b', 'release/1.1.0', 'v1.0.0');
  git(api, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/ABC-1_first' into 'release/1.1.0'\n\nSee merge request group/api!7", s.a1);
  git(api, 'cherry-pick', s.a2);
  git(api, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/ABC-4' into 'release/1.1.0'", s.a4);
  git(api, 'revert', '--no-edit', '-m', '1', 'HEAD');
  git(api, 'cherry-pick', s.a56);
  git(api, 'cherry-pick', s.a8);
  commit(api, 'notes.txt', 'n\n', 'Tidy build notes');
  git(api, 'checkout', '-q', '-b', 'testing/1.1.0');
  commit(api, 'package.json', '{"version":"1.1.0"}\n', 'ABC-99: bump version');
  const web = join(root, 'web');
  execFileSync('mkdir', ['-p', web]);
  git(web, 'init', '-q', '-b', 'main');
  commit(web, 'index.txt', '0\n', 'Initial');
  git(web, 'tag', 'v1.0.0');
  git(web, 'checkout', '-q', '-b', 'develop');
  commit(web, 'ui.txt', '1\n', 'ABC-1: first feature UI');
  git(web, 'checkout', '-q', '-b', 'release/1.1.0', 'v1.0.0');
  return { root, api, web, s };
}

export const PROFILE = {
  id: 'example', name: 'Example', environmentId: 'env-1', workspaceRoot: '/workspace', ticketProjects: ['ABC'],
  tracker: { connection: 'tracker', kind: 'jira-cloud', versionFormat: '{product}: v.{version}', doneStatuses: ['Done'], parentCarriesVersion: true },
  forge: { connection: 'forge', kind: 'gitlab' },
  manifestFiles: ['package.json', '**/pom.xml'], mrPattern: 'See merge request (\\S+![0-9]+)',
  repos: [
    { key: 'api', path: 'api', product: 'svc', forgeProject: 'group/api', source: 'develop', release: 'release/1.1.0', testing: 'testing/1.1.0', baseline: { tag: 'v1.0.0' } },
    { key: 'web', path: 'web', product: 'svc', forgeProject: 'group/web', source: 'develop', release: 'release/1.1.0', baseline: { tag: 'v1.0.0' } },
  ],
};

const issue = (key, versions, { status = 'Done', parent = null, subtask = false } = {}) => ({ key, fields: { summary: `Synthetic ${key}`, status: { name: status }, fixVersions: versions.map((name) => ({ name })), parent: parent ? { key: parent } : undefined, issuetype: { subtask } } });
const V = 'svc: v.1.1.0';
/** Tracker responses as the collector returns them for the three requests, plus open MRs. */
export function trackerHttp({ incomplete = false } = {}) {
  return [
    { id: 'versions', connection: 'tracker', pages: 1, total: null, complete: !incomplete, at: '2026-01-01T00:00:00.000Z', items: [issue('ABC-1', [V]), issue('ABC-3', [V]), issue('ABC-4', [V]), issue('ABC-7', [V]), issue('ABC-10', [V]), issue('ABC-11', [V])], ...(incomplete ? { error: 'Stopped at 50 pages' } : {}) },
    { id: 'committed', connection: 'tracker', pages: 1, total: null, complete: true, at: '2026-01-01T00:00:00.000Z', keys: [], items: [issue('ABC-1', [V]), issue('ABC-2', []), issue('ABC-3', [V]), issue('ABC-4', [V]), issue('ABC-5', [V], { status: 'In Progress' }), issue('ABC-6', [V]), issue('ABC-8', [], { parent: 'ABC-7', subtask: true }), issue('ABC-99', [V])] },
    { id: 'parents', connection: 'tracker', pages: 1, total: null, complete: true, at: '2026-01-01T00:00:00.000Z', keys: ['ABC-7'], items: [issue('ABC-7', [V])] },
    { id: 'mrs-0', connection: 'forge', pages: 1, total: null, complete: true, at: '2026-01-01T00:00:00.000Z', items: [{ iid: 12, title: 'ABC-11: pending work', source_branch: 'feature/ABC-11', target_branch: 'release/1.1.0', references: { full: 'group/api!12' } }] },
    { id: 'mrs-1', connection: 'forge', pages: 1, total: null, complete: true, at: '2026-01-01T00:00:00.000Z', items: [] },
  ];
}
