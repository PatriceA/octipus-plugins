// Reconciliation over real temporary Git repositories (collector-shaped evidence) and synthetic tracker data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildCollectorRequest, InputError, normaliseTickets, validateProfile, validateRunSettings } from '../lib/profile.mjs';
import { effectiveStates, extractKeys, globRegex, reconcile } from '../lib/reconcile.mjs';
import { buildFixture, commit, git, PROFILE, repoEvidence, trackerHttp } from './fixture.mjs';

let fx;
before(() => { fx = buildFixture(); });
after(() => rmSync(fx.root, { recursive: true, force: true }));

const profile = () => validateProfile(structuredClone(PROFILE));
const run = (p) => validateRunSettings({ profileId: p.id, versions: { svc: '1.1.0' } }, p);
function evidence({ webMissing = false, trackerIncomplete = false } = {}) {
  const repos = [
    repoEvidence(fx.api, 'api', 'v1.0.0', { source: 'develop', release: 'release/1.1.0', testing: 'testing/1.1.0' }),
    repoEvidence(fx.web, 'web', 'v1.0.0', { source: 'develop', release: 'release/1.1.0' }, { missing: webMissing ? ['release'] : [] }),
  ];
  return { environmentId: 'env-1', startedAt: 't0', finishedAt: 't1', complete: repos.every((r) => r.complete) && !trackerIncomplete, repos, http: trackerHttp({ incomplete: trackerIncomplete }) };
}
const report = (opts) => { const p = profile(); const ev = evidence(opts); return reconcile(p, run(p), ev, normaliseTickets(p, ev)); };
const verdicts = (rep, key) => (rep.tickets.find((t) => t.key === key)?.verdicts ?? []).map((v) => v.kind).sort();

describe('reconciliation', () => {
  test('bidirectional ticket/version checks with exact evidence', () => {
    const rep = report();
    assert.equal(rep.complete, true);
    assert.deepEqual(verdicts(rep, 'ABC-1'), ['partial_delivery']);
    const abc1 = rep.tickets.find((t) => t.key === 'ABC-1');
    assert.ok(abc1.evidence.some((e) => e.repo === 'api' && e.branch === 'release' && e.mr === 'group/api!7' && /^[0-9a-f]{40}$/.test(e.sha)));
    assert.ok(abc1.evidence.some((e) => e.repo === 'web' && e.how === 'source_only'));
    assert.deepEqual(verdicts(rep, 'ABC-2'), ['delivered_without_version']);
    assert.ok(rep.tickets.find((t) => t.key === 'ABC-2').evidence.some((e) => e.how === 'equivalent_unresolved'), 'unmapped equivalence is uncertain when release contains reverted changes');
    assert.ok(rep.tickets.find((t) => t.key === 'ABC-2').evidence.some((e) => e.branch === 'release' && e.how === 'ancestry'), 'the release commit independently proves delivery');
    assert.deepEqual(verdicts(rep, 'ABC-3'), ['version_source_only']);
    assert.deepEqual(verdicts(rep, 'ABC-4'), ['version_reverted']);
    assert.deepEqual(verdicts(rep, 'ABC-5'), ['ambiguous_attribution', 'status_not_done']);
    assert.deepEqual(verdicts(rep, 'ABC-6'), ['ambiguous_attribution']);
    assert.deepEqual(verdicts(rep, 'ABC-7'), [], 'a parent carrying the version is delivered through its subtask');
    assert.deepEqual(verdicts(rep, 'ABC-8'), [], 'a subtask inherits the parent version');
    assert.deepEqual(verdicts(rep, 'ABC-10'), ['version_without_code']);
    assert.deepEqual(verdicts(rep, 'ABC-11'), ['version_open_mr']);
    assert.deepEqual(verdicts(rep, 'ABC-99'), ['version_testing_only']);
    assert.ok(rep.findings.some((f) => f.kind === 'unticketed_commit' && f.message.includes('Tidy build notes')));
  });

  test('branch ancestry and effective tree are reported separately', () => {
    const rep = report();
    const api = rep.repos.find((r) => r.key === 'api');
    const testing = api.checks.find((c) => c.a === 'testing');
    assert.equal(testing.manifestOnly, true);
    assert.equal(testing.bInA, true, 'testing contains release');
    assert.ok(rep.findings.some((f) => f.kind === 'manifest_only_difference' && f.repo === 'api'));
    assert.ok(rep.findings.some((f) => f.kind === 'ancestry_gap' && f.repo === 'api' && f.a === 'source'));
    assert.ok(rep.findings.some((f) => f.kind === 'tree_drift' && f.repo === 'api' && f.a === 'source'));
  });

  test('a failed fetch or incomplete tracker turns absence verdicts into unknown', () => {
    const rep = report({ webMissing: true });
    assert.equal(rep.complete, false);
    // ABC-3 is only on api's source, but the product's web release is unknown: no confident verdict.
    assert.deepEqual(verdicts(rep, 'ABC-3'), ['unknown']);
    assert.deepEqual(verdicts(rep, 'ABC-10'), ['unknown']);
    const inc = report({ trackerIncomplete: true });
    assert.equal(inc.complete, false);
    assert.equal(inc.completeness.tracker, false);
  });

  test('a ticket the tracker did not return is unknown, not missing a version', () => {
    const p = profile(); const ev = evidence();
    ev.http[1].items = ev.http[1].items.filter((i) => i.key !== 'ABC-2');
    ev.http[1].complete = false;
    const rep = reconcile(p, run(p), ev, normaliseTickets(p, ev));
    assert.deepEqual(verdicts(rep, 'ABC-2'), ['unknown']);
  });

  test('deterministic: same input, same report', () => {
    assert.deepEqual(report(), report());
  });
});

describe('profile and request', () => {
  test('profiles refuse unknown fields, traversal and bad refs', () => {
    assert.throws(() => validateProfile({ ...PROFILE, shell: 'ls' }), InputError);
    assert.throws(() => validateProfile({ ...PROFILE, repos: [{ ...PROFILE.repos[0], path: '../x' }] }), /relative folder/);
    assert.throws(() => validateProfile({ ...PROFILE, repos: [{ ...PROFILE.repos[0], release: '--upload-pack=x' }] }), /release is invalid/);
    assert.throws(() => validateProfile({ ...PROFILE, tracker: { ...PROFILE.tracker, versionFormat: 'no placeholder' } }), /versionFormat/);
    assert.throws(() => validateRunSettings({ versions: { other: '1.0' } }, profile()), /no repository/);
    assert.throws(() => validateRunSettings({ versions: { svc: '1 0' } }, profile()), /invalid/);
  });

  test('the collector request: audit refs, key expansion, pagination per tracker kind', () => {
    const p = profile();
    const req = buildCollectorRequest(p, run(p));
    assert.equal(req.repos[0].path, '/workspace/api');
    assert.deepEqual(req.repos[0].refs.map((r) => r.localRef), ['refs/heads/develop', 'refs/heads/release/1.1.0', 'refs/heads/testing/1.1.0']);
    const withFetch = validateProfile({ ...PROFILE, repos: [{ ...PROFILE.repos[0], fetch: { connection: 'forge', remotePath: '/group/api.git' } }] });
    const fr = buildCollectorRequest(withFetch, run(withFetch));
    assert.deepEqual(fr.repos[0].baseline, { name: 'baseline', tag: 'v1.0.0' });
    assert.deepEqual(fr.repos[0].refs[1], { name: 'release', branch: 'release/1.1.0' });
    const [versions, committed, parents] = req.http;
    assert.match(decodeURIComponent(versions.path), /fixVersion in \("svc: v\.1\.1\.0"\)/);
    assert.equal(versions.pagination.type, 'token');
    assert.ok(committed.path.includes('key%20in%20({keys})'));
    assert.deepEqual(committed.expand.from, { source: 'commits' });
    assert.deepEqual(parents.expand.from, { source: 'http', id: 'committed', pointer: '/fields/parent/key' });
    assert.equal(req.http.filter((h) => h.id.startsWith('mrs-')).length, 2);
    const dc = validateProfile({ ...PROFILE, tracker: { ...PROFILE.tracker, kind: 'jira-dc' } });
    assert.equal(buildCollectorRequest(dc, run(dc)).http[0].pagination.type, 'offset');
    const quoted = validateRunSettings({ versions: { svc: '1.1.0' } }, validateProfile({ ...PROFILE, tracker: { ...PROFILE.tracker, versionFormat: "{product}'s {version}" } }));
    assert.ok(quoted);
  });

  test('keys, globs', () => {
    assert.deepEqual(extractKeys(['ABC'], "Merge branch 'feature/ABC-12_x' ABC-12 xABC-3 ABC-0"), ['ABC-12']);
    assert.ok(globRegex('**/pom.xml').test('a/b/pom.xml'));
    assert.ok(globRegex('**/pom.xml').test('pom.xml'));
    assert.ok(!globRegex('package.json').test('sub/package.json'));
  });
});

describe('review regressions', () => {
  const V = 'svc: v.1.1.0';
  const issue = (key, versions, extra = {}) => ({ key, fields: { summary: key, status: { name: 'Done' }, fixVersions: versions.map((name) => ({ name })), issuetype: { subtask: false }, ...extra } });
  const http = (items, over = {}) => [
    { id: 'versions', complete: true, items, ...over.versions },
    { id: 'committed', complete: true, items: over.committed ?? [] },
    { id: 'parents', complete: true, items: over.parents ?? [] },
    { id: 'mrs-0', complete: true, items: over.mrs ?? [] },
  ];
  const single = () => validateProfile({ ...structuredClone(PROFILE), repos: [structuredClone(PROFILE.repos[0])] });
  /** One repository: base, then `build(repo)` creates develop and release/1.1.0. */
  function oneRepo(build) {
    const dir = mkdtempSync(join(tmpdir(), 'reconcile-regress-'));
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'base.txt', '0\n', 'Initial');
    git(dir, 'tag', 'v1.0.0');
    const s = build(dir);
    const repo = repoEvidence(dir, 'api', 'v1.0.0', { source: 'develop', release: 'release/1.1.0' });
    rmSync(dir, { recursive: true, force: true });
    return { repo, s };
  }
  const rep = (p, repo, httpItems) => {
    const ev = { environmentId: 'env-1', startedAt: 't0', finishedAt: 't1', complete: true, repos: [repo], http: httpItems };
    return reconcile(p, run(p), ev, normaliseTickets(p, ev));
  };

  test('3: a source patch cherry-picked to the release and reverted there is not delivered', () => {
    const { repo } = oneRepo((d) => {
      git(d, 'checkout', '-q', '-b', 'develop');
      const b = commit(d, 'b.txt', 'b\n', 'ABC-20: feature');
      git(d, 'checkout', '-q', '-b', 'release/1.1.0', 'v1.0.0');
      commit(d, 'other.txt', 'o\n', 'ABC-30: other work'); // another parent: the cherry-pick gets its own SHA
      git(d, 'cherry-pick', b);
      git(d, 'revert', '--no-edit', 'HEAD');
      return { b };
    });
    assert.ok(repo.pairs[0].cherryAtoB.some((c) => c.equivalent), 'git cherry still reports the historical patch as equivalent');
    const r = rep(single(), repo, http([issue('ABC-20', [V])]));
    const t = r.tickets.find((x) => x.key === 'ABC-20');
    assert.deepEqual(t.delivered, []);
    assert.deepEqual(verdicts(r, 'ABC-20'), ['reverted', 'unknown'], 'the release revert is reported; delivery is not asserted');
    assert.ok(t.evidence.some((e) => e.branch === 'source' && e.how === 'equivalent_unresolved'));
  });

  test('3: patch equivalence stays usable when release has no undone changes', () => {
    const { repo } = oneRepo((d) => {
      git(d, 'checkout', '-q', '-b', 'develop');
      const source = commit(d, 'f.txt', 'f\n', 'ABC-25: feature');
      git(d, 'checkout', '-q', '-b', 'release/1.1.0', 'v1.0.0');
      commit(d, 'other.txt', 'o\n', 'ABC-30: other work');
      git(d, 'cherry-pick', source);
      return {};
    });
    const r = rep(single(), repo, http([issue('ABC-25', [V])]));
    const t = r.tickets.find((x) => x.key === 'ABC-25');
    assert.deepEqual(t.delivered, ['api']);
    assert.ok(t.evidence.some((e) => e.branch === 'source' && e.how === 'equivalent'));
    assert.ok(!t.verdicts.some((v) => v.kind === 'unknown'));
  });

  test('3: rewritten cherry-pick ticket labels cannot hide a reverted equivalent patch', () => {
    const { repo } = oneRepo((d) => {
      git(d, 'checkout', '-q', '-b', 'develop');
      const source = commit(d, 'f.txt', 'f\n', 'ABC-23: original feature');
      git(d, 'checkout', '-q', '-b', 'release/1.1.0', 'v1.0.0');
      commit(d, 'other.txt', 'o\n', 'ABC-30: other work');
      git(d, 'cherry-pick', source);
      git(d, 'commit', '--amend', '-m', 'ABC-24: renamed backport');
      git(d, 'revert', '--no-edit', 'HEAD');
      return {};
    });
    assert.ok(repo.pairs[0].cherryAtoB.some((c) => c.equivalent));
    const r = rep(single(), repo, http([issue('ABC-23', [V])]));
    const t = r.tickets.find((x) => x.key === 'ABC-23');
    assert.deepEqual(t.delivered, []);
    assert.ok(t.verdicts.some((v) => v.kind === 'unknown'));
    assert.ok(t.evidence.some((e) => e.how === 'equivalent_unresolved'));
  });

  test('4: a revert of a revert restores delivery; a third revert undoes it again', () => {
    const { repo } = oneRepo((d) => {
      git(d, 'checkout', '-q', '-b', 'develop');
      git(d, 'checkout', '-q', '-b', 'release/1.1.0');
      commit(d, 'f.txt', 'f\n', 'ABC-21: feature');
      git(d, 'revert', '--no-edit', 'HEAD');
      git(d, 'revert', '--no-edit', 'HEAD');
      return {};
    });
    const r = rep(single(), repo, http([issue('ABC-21', [V])]));
    assert.deepEqual(r.tickets.find((x) => x.key === 'ABC-21').delivered, ['api']);
    assert.deepEqual(verdicts(r, 'ABC-21'), []);
    const sha = (n) => n.repeat(40);
    const chain = [
      { sha: sha('d'), parents: [sha('c')], body: `This reverts commit ${sha('c')}.` },
      { sha: sha('c'), parents: [sha('b')], body: `This reverts commit ${sha('b')}.` },
      { sha: sha('b'), parents: [sha('a')], body: `This reverts commit ${sha('a')}.` },
      { sha: sha('a'), parents: [], body: '' },
    ];
    assert.equal(effectiveStates(chain).get(sha('a')), 'reverted');
    assert.equal(effectiveStates(chain.slice(1)).get(sha('a')), 'active');
  });

  test('4: a merge revert without an established mainline leaves the merged commits unknown', () => {
    const sha = (n) => n.repeat(40);
    const commits = [
      { sha: sha('e'), parents: [sha('d')], body: `This reverts commit ${sha('d')}.` },
      { sha: sha('d'), parents: [sha('a'), sha('b')], body: '' },
      { sha: sha('b'), parents: [], body: '' },
      { sha: sha('a'), parents: [], body: '' },
    ];
    const st = effectiveStates(commits);
    assert.equal(st.get(sha('d')), 'reverted');
    assert.equal(st.get(sha('b')), 'unknown');
    assert.equal(st.get(sha('a')), 'unknown');
    commits[0].body = `This reverts commit ${sha('d')}, reversing\nchanges made to ${sha('a')}.`;
    const known = effectiveStates(commits);
    assert.equal(known.get(sha('b')), 'reverted');
    assert.equal(known.get(sha('a')), 'active');
  });

  test('5: a parent that carries the version but was not returned makes the child unknown', () => {
    const p = profile(); const ev = evidence();
    ev.http[0].items = ev.http[0].items.filter((i) => i.key !== 'ABC-7');
    ev.http[2].items = [];
    ev.http[2].complete = false;
    const r = reconcile(p, run(p), ev, normaliseTickets(p, ev));
    const v = r.tickets.find((t) => t.key === 'ABC-8').verdicts;
    assert.deepEqual(v.map((x) => x.kind), ['unknown']);
    assert.match(v[0].reason, /parent/);
  });

  test('6: an absent or malformed version field is unknown, never "no versions"', () => {
    const p = profile();
    for (const fields of [{}, { fixVersions: 'x' }, { fixVersions: [{ id: 1 }] }]) {
      const ev = { http: [{ id: 'committed', complete: true, items: [{ key: 'ABC-2', fields }] }] };
      assert.equal(normaliseTickets(p, ev).tickets[0].versions, null);
    }
    const prior = normaliseTickets(p, { http: http([issue('ABC-2', [V])], { committed: [{ key: 'ABC-2', fields: { summary: 'x' } }] }) }).tickets[0];
    assert.deepEqual(prior.versions, [V], 'a later snapshot without the field keeps the known value');
    const torn = normaliseTickets(p, { http: http([issue('ABC-2', [V])], { committed: [issue('ABC-2', [])] }) }).tickets[0];
    assert.equal(torn.versions, null);
    assert.deepEqual(torn.conflicts, ['versions']);
    // ABC-2 is delivered: with a malformed or contradictory field it is unknown, not delivered without version.
    for (const committed of [{ key: 'ABC-2', fields: { fixVersions: 'x' } }, issue('ABC-2', [])]) {
      const ev = evidence();
      ev.http[1].items = ev.http[1].items.filter((i) => i.key !== 'ABC-2').concat(committed);
      if (committed.fields.fixVersions !== 'x') ev.http[0].items.push(issue('ABC-2', ['svc: v.1.0.9']));
      const r = reconcile(p, run(p), ev, normaliseTickets(p, ev));
      assert.deepEqual(verdicts(r, 'ABC-2'), ['unknown']);
    }
  });

  test('7: an open MR of another project or target branch does not affect the verdict', () => {
    const mr = (target) => ({ iid: 5, title: 'ABC-10: pending', source_branch: 'feature/ABC-10', target_branch: target });
    const withMrs = (over, prof = profile()) => {
      const ev = evidence();
      ev.http = ev.http.filter((h) => !h.id.startsWith('mrs-')).concat(over);
      return reconcile(prof, run(prof), ev, normaliseTickets(prof, ev));
    };
    const ok = (items0, items1 = []) => [{ id: 'mrs-0', complete: true, items: items0 }, { id: 'mrs-1', complete: true, items: items1 }];
    assert.deepEqual(verdicts(withMrs(ok([mr('release/1.1.0')])), 'ABC-10'), ['version_open_mr']);
    assert.deepEqual(verdicts(withMrs(ok([mr('main')])), 'ABC-10'), ['version_without_code'], 'another target branch');
    assert.deepEqual(verdicts(withMrs(ok([mr('develop')])), 'ABC-10'), ['version_without_code'], 'the source is not a target unless configured');
    const both = validateProfile({ ...structuredClone(PROFILE), forge: { ...PROFILE.forge, mrTargets: ['release', 'source'] } });
    assert.deepEqual(verdicts(withMrs(ok([mr('develop')]), both), 'ABC-10'), ['version_open_mr']);
    assert.deepEqual(verdicts(withMrs([...ok([]), { id: 'mrs-7', complete: true, items: [mr('release/1.1.0')] }]), 'ABC-10'), ['version_without_code'], 'a request of no profile project');
    const other = validateProfile({ ...structuredClone(PROFILE), repos: [...PROFILE.repos, { key: 'lib', path: 'lib', product: 'lib', forgeProject: 'group/lib', source: 'develop', release: 'release/1.1.0', baseline: { tag: 'v1.0.0' } }] });
    const r = withMrs([...ok([]), { id: 'mrs-2', complete: true, items: [mr('release/1.1.0')] }], other);
    assert.deepEqual(verdicts(r, 'ABC-10'), ['version_without_code'], 'an MR in a repository of another product');
    assert.equal(r.tickets.find((t) => t.key === 'ABC-10').verdicts.some((v) => v.kind === 'version_open_mr'), false);
    assert.throws(() => validateProfile({ ...PROFILE, forge: { ...PROFILE.forge, mrTargets: ['main'] } }), /mrTargets/);
  });
});
