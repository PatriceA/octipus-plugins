// Deterministic release reconciliation: tracker tickets (with their target
// versions) against repository evidence collected by the Octipus host
// (`repos:collect`). Pure functions, no I/O: same profile + run settings +
// evidence → same report. Absence is never asserted from incomplete evidence:
// such verdicts become `unknown`.

/** Distinct PROJECT-NUMBER keys of `projects` in `text`, in order of appearance. */
export function extractKeys(projects, text) {
  if (!projects.length || !text) return [];
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${projects.join('|')})-[1-9][0-9]{0,8}(?![0-9])`, 'g');
  return [...new Set(String(text).match(re) ?? [])];
}

/** `{product}` and `{version}` in a version label format. */
export function versionLabel(format, product, version) {
  return format.replaceAll('{product}', product).replaceAll('{version}', version);
}

/** A glob (`*` within a segment, `**` across) as a whole-path RegExp. */
export function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// `git revert -m N` adds the mainline it kept: "This reverts commit X, reversing\nchanges made to P."
const REVERT = /This reverts commit ([0-9a-f]{40,64})(?:,\s+reversing\s+changes\s+made\s+to\s+([0-9a-f]{40,64}))?/g;
const revertsOf = (c) => [...c.body.matchAll(REVERT)].map((m) => ({ target: m[1], mainline: m[2] ?? null }));
const isRevert = (c) => revertsOf(c).length > 0;
const MERGE_BRANCH = /^Merge (?:branch|remote-tracking branch) '([^']+)'/;

/** In-range ancestors of `start` (itself included), following parents within `bySha`. */
function reach(start, bySha) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const sha = stack.pop();
    if (seen.has(sha) || !bySha.has(sha)) continue;
    seen.add(sha);
    stack.push(...bySha.get(sha).parents);
  }
  return seen;
}

const RANK = { active: 0, unknown: 1, reverted: 2 };

/**
 * The effective state of each commit of a range: `active`, `reverted` or `unknown`.
 * A revert takes effect only while it is itself active, so reverting a revert
 * restores its target. A reverted merge also reverts what its other parents
 * brought in, relative to the mainline the revert names; a merge revert whose
 * mainline is not stated or is not one of the merge's parents leaves those
 * commits unknown. Targets outside the range are not evaluated.
 */
export function effectiveStates(commits) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const revertersOf = new Map();
  for (const c of commits) for (const r of revertsOf(c)) {
    if (bySha.has(r.target) && r.target !== c.sha) revertersOf.set(r.target, [...(revertersOf.get(r.target) ?? []), { by: c.sha, mainline: r.mainline }]);
  }
  const memo = new Map();
  /** Undone by an active revert of this very commit? Unknown when a revert's own state is unknown. */
  const own = (sha) => {
    if (memo.has(sha)) return memo.get(sha);
    memo.set(sha, 'unknown'); // a cycle (impossible for real SHAs) stays unknown
    let state = 'active';
    for (const r of revertersOf.get(sha) ?? []) {
      const s = own(r.by);
      if (s === 'active') { state = 'reverted'; break; }
      if (s === 'unknown') state = 'unknown';
    }
    memo.set(sha, state);
    return state;
  };
  const states = new Map(commits.map((c) => [c.sha, own(c.sha)]));
  const mark = (sha, s) => { if (RANK[s] > RANK[states.get(sha)]) states.set(sha, s); };
  for (const m of commits) {
    if (m.parents.length < 2) continue;
    for (const r of revertersOf.get(m.sha) ?? []) {
      const s = own(r.by);
      if (s === 'reverted') continue; // the revert was itself reverted: what the merge brought is back
      const effect = s === 'active' ? 'reverted' : 'unknown';
      const sides = m.parents.map((p) => reach(p, bySha));
      const main = m.parents.indexOf(r.mainline);
      if (main >= 0) {
        for (const [i, side] of sides.entries()) if (i !== main) for (const x of side) if (!sides[main].has(x)) mark(x, effect);
      } else {
        // Which side was kept is not established: everything not common to all parents is unknown.
        for (const side of sides) for (const x of side) if (!sides.every((o) => o.has(x))) mark(x, 'unknown');
      }
    }
  }
  return states;
}

/** A ticket as the tracker adapters normalise it. */
function emptyTicket(key) {
  return { key, found: false, summary: null, status: null, versions: [], parentKey: null, subtask: false };
}

function finding(kind, severity, message, extra = {}) {
  return { kind, severity, message, ...extra };
}

/**
 * The report.
 * @param {object} profile   validated profile (./profile.mjs)
 * @param {object} run       validated run settings
 * @param {object} evidence  the collector's evidence
 * @param {{ tickets: object[], ticketsComplete: boolean, openMrs: object[], openMrsComplete: boolean }} tracker  normalised tracker/forge data
 */
export function reconcile(profile, run, evidence, tracker) {
  const projects = profile.ticketProjects;
  const mrRe = profile.mrPattern ? new RegExp(profile.mrPattern) : null;
  const manifest = (profile.manifestFiles ?? []).map(globRegex);
  const findings = [];
  const ticketMap = new Map();
  for (const t of tracker.tickets) ticketMap.set(t.key, { ...t, found: true });
  const ticket = (key) => {
    if (!ticketMap.has(key)) ticketMap.set(key, emptyTicket(key));
    return ticketMap.get(key);
  };
  const labels = Object.fromEntries(Object.entries(run.versions).map(([product, v]) => [product, versionLabel(profile.tracker.versionFormat, product, v)]));
  const productsOfRepos = new Map(profile.repos.map((r) => [r.key, r.product]));

  /** Per ticket and repo: commits by how they reach the release. */
  const work = new Map();
  const workOf = (key, repo) => {
    if (!work.has(key)) work.set(key, new Map());
    const byRepo = work.get(key);
    if (!byRepo.has(repo)) byRepo.set(repo, { delivered: [], equivalent: [], sourceOnly: [], unknown: [], testing: [], reverted: [], reverts: [], merges: [] });
    return byRepo.get(repo);
  };

  const repos = [];
  for (const repo of profile.repos) {
    const e = evidence.repos.find((r) => r.key === repo.key);
    const view = { key: repo.key, product: repo.product, complete: false, refs: {}, checks: [], problems: [] };
    repos.push(view);
    if (!e) { view.problems.push('no evidence collected'); continue; }
    view.complete = e.complete;
    view.problems.push(...e.problems);
    view.shallow = e.shallow;
    for (const r of [e.baseline, ...e.refs].filter(Boolean)) view.refs[r.name] = { input: r.input, sha: r.sha, status: r.status, source: r.source, at: r.at };
    for (const f of e.fetches) if (!f.ok) view.problems.push(`fetch ${f.ref}: ${f.error}`);

    const range = (name) => e.ranges.find((g) => g.ref === name) ?? null;
    const pair = (a, b) => e.pairs.find((p) => (p.a === a && p.b === b)) ?? (() => {
      const p = e.pairs.find((x) => x.a === b && x.b === a);
      return p && { ...p, a, b, aInB: p.bInA, bInA: p.aInB, onlyInA: p.onlyInB, onlyInB: p.onlyInA, cherryAtoB: p.cherryBtoA, cherryBtoA: p.cherryAtoB };
    })();
    const rel = range('release');
    const src = range('source');
    const tst = range('testing');
    const relShas = new Set((rel?.commits ?? []).map((c) => c.sha));
    const relState = effectiveStates(rel?.commits ?? []);
    const srcState = effectiveStates(src?.commits ?? []);
    const keysOf = (c) => extractKeys(projects, `${c.subject}\n${c.body}`);
    // Release commits whose change is not (or not provably) in effect: a source commit
    // `git cherry` finds equivalent may correspond to one of them.
    const relUndone = (rel?.commits ?? []).filter((c) => !isRevert(c) && relState.get(c.sha) !== 'active');
    // Cherry evidence does not identify its matching release commit. Rewritten
    // subjects or ticket labels cannot rule out an undone match, so any undone
    // release change leaves historical patch equivalence unresolved.
    const mayCorrespondToUndone = () => relUndone.length > 0;

    // Branch-level checks: ancestry and effective tree are separate questions.
    for (const [a, b] of [['source', 'release'], ['testing', 'release']]) {
      const p = pair(a, b);
      if (!p) { if (view.refs[a]?.sha && view.refs[b]?.sha) view.checks.push({ kind: 'pair_unknown', a, b }); continue; }
      const manifestOnly = !p.sameTree && !p.changedFilesTruncated && p.changedFiles.length > 0 && p.changedFiles.every((f) => manifest.some((m) => m.test(f)));
      view.checks.push({
        kind: 'branch_pair', a, b, aInB: p.aInB, bInA: p.bInA, onlyInA: p.onlyInA, onlyInB: p.onlyInB, sameTree: p.sameTree,
        changedFiles: p.changedFiles.length, changedFilesTruncated: p.changedFilesTruncated, manifestOnly,
      });
      if (!p.aInB) findings.push(finding('ancestry_gap', 'warn', `${repo.key}: ${b} does not contain ${a} by ancestry (${p.onlyInA} commits only in ${a})`, { repo: repo.key, a, b }));
      if (p.sameTree && !p.aInB) findings.push(finding('same_tree_different_history', 'info', `${repo.key}: ${a} and ${b} have the same tree but different history`, { repo: repo.key, a, b }));
      else if (manifestOnly) findings.push(finding('manifest_only_difference', 'info', `${repo.key}: ${a} and ${b} differ only in version/manifest files`, { repo: repo.key, a, b, files: p.changedFiles }));
      else if (!p.sameTree) findings.push(finding('tree_drift', 'warn', `${repo.key}: ${a} and ${b} trees differ in ${p.changedFiles.length}${p.changedFilesTruncated ? '+' : ''} files`, { repo: repo.key, a, b, files: p.changedFiles.slice(0, 50) }));
    }
    for (const g of e.ranges) if (!g.baselineIsAncestor) findings.push(finding('baseline_not_ancestor', 'warn', `${repo.key}: the baseline is not an ancestor of ${g.ref}; its range includes unrelated history`, { repo: repo.key, ref: g.ref }));

    const commitInfo = (c, branch, how) => {
      const merge = c.subject.match(MERGE_BRANCH);
      const mr = mrRe ? (c.body.match(mrRe)?.[1] ?? c.subject.match(mrRe)?.[1] ?? null) : null;
      return { repo: repo.key, branch, sha: c.sha, subject: c.subject, committedAt: c.committedAt, how, mergedBranch: merge?.[1] ?? null, mr };
    };
    const attribute = (c, branch, how, slot) => {
      const keys = keysOf(c);
      if (keys.length > 1) findings.push(finding('ambiguous_attribution', 'warn', `${repo.key}@${branch} ${c.sha.slice(0, 12)} names ${keys.join(', ')}`, { repo: repo.key, sha: c.sha, keys }));
      for (const k of keys) workOf(k, repo.key)[slot].push({ ...commitInfo(c, branch, how), ambiguous: keys.length > 1 });
      return keys;
    };

    // The release: everything reachable since the baseline and still in effect is delivered.
    for (const c of rel?.commits ?? []) {
      const state = relState.get(c.sha);
      const [how, slot] = isRevert(c) ? [state === 'active' ? 'revert' : state === 'reverted' ? 'revert_undone' : 'revert_unresolved', 'reverts']
        : state === 'active' ? ['ancestry', 'delivered'] : state === 'reverted' ? ['reverted', 'reverted'] : ['revert_unresolved', 'unknown'];
      const keys = attribute(c, 'release', how, slot);
      if (keys.length === 0 && c.parents.length < 2 && !isRevert(c)) {
        findings.push(finding('unticketed_commit', 'warn', `${repo.key}@release ${c.sha.slice(0, 12)} "${c.subject}" names no ticket`, { repo: repo.key, sha: c.sha }));
      }
    }
    // The source: how each commit not in the release relates to it.
    const sr = pair('source', 'release');
    const cherry = new Map((sr?.cherryAtoB ?? []).map((x) => [x.sha, x.equivalent]));
    for (const c of src?.commits ?? []) {
      if (relShas.has(c.sha)) continue;
      const state = srcState.get(c.sha);
      if (isRevert(c)) { attribute(c, 'source', 'revert_on_source', 'reverts'); continue; }
      if (state === 'reverted') { attribute(c, 'source', 'reverted_on_source', 'reverted'); continue; }
      if (state === 'unknown') { attribute(c, 'source', 'revert_unresolved', 'unknown'); continue; }
      // A merge on the source only carries metadata (branch, MR); its commits are classified themselves.
      if (c.parents.length > 1) { attribute(c, 'source', 'merge_on_source', 'merges'); continue; }
      let how = !sr || sr.cherryTruncated ? 'unknown' : cherry.has(c.sha) ? (cherry.get(c.sha) ? 'equivalent' : 'source_only') : 'ancestry';
      // `git cherry` matches any historical patch: one later reverted on the release is not a delivery.
      if (how === 'equivalent' && mayCorrespondToUndone(c)) how = 'equivalent_unresolved';
      attribute(c, 'source', how, how === 'equivalent' ? 'equivalent' : how === 'source_only' ? 'sourceOnly' : how === 'ancestry' ? 'delivered' : 'unknown');
    }
    for (const c of tst?.commits ?? []) if (!relShas.has(c.sha)) attribute(c, 'testing', 'testing_only', 'testing');
  }

  // Tickets: keys from tickets with a target version, and every key in the evidence.
  const targetsOf = (t) => {
    const parent = t.parentKey ? ticketMap.get(t.parentKey) : null;
    const versions = new Set([...(t.versions ?? []), ...(profile.tracker.parentCarriesVersion && parent?.found ? parent.versions ?? [] : [])]);
    return Object.entries(labels).filter(([, l]) => versions.has(l)).map(([p]) => p);
  };
  /** Why a found ticket's target versions are not fully known, or null. */
  const versionGap = (t) => {
    if (!Array.isArray(t.versions)) return 'its version field is missing, malformed or contradictory';
    if (t.conflicts?.includes('parentKey')) return 'its parent link is contradictory';
    if (!profile.tracker.parentCarriesVersion || !t.parentKey) return null;
    const parent = ticketMap.get(t.parentKey);
    if (!parent?.found) return tracker.ticketsComplete ? 'its parent was not returned by the tracker' : 'the parent ticket query is incomplete';
    return Array.isArray(parent.versions) ? null : 'its parent\'s version field is missing, malformed or contradictory';
  };
  for (const key of work.keys()) ticket(key);
  const childrenOf = new Map();
  for (const t of ticketMap.values()) if (t.parentKey) childrenOf.set(t.parentKey, [...(childrenOf.get(t.parentKey) ?? []), t.key]);
  // An open MR counts for a product only in the forge project of one of its repositories and into a configured target branch.
  const mrTargets = profile.forge?.mrTargets ?? ['release'];
  const openMrsOf = (key, product) => tracker.openMrs.filter((mr) => profile.repos.some((r) => r.product === product && r.forgeProject && r.forgeProject === mr.project && mrTargets.some((t) => r[t] === mr.targetBranch))
    && extractKeys(projects, `${mr.title}\n${mr.sourceBranch}`).includes(key));
  const mrEvidenceComplete = (product) => profile.repos.every((r) => r.product !== product || !r.forgeProject || tracker.openMrProjects?.[r.forgeProject] === true);
  const reposOf = (product) => profile.repos.filter((r) => r.product === product).map((r) => r.key);
  const repoComplete = (key) => repos.find((r) => r.key === key)?.complete === true;
  const deliveredIn = (key, repo) => {
    const w = work.get(key)?.get(repo);
    return !!w && (w.delivered.length > 0 || w.equivalent.length > 0);
  };

  const tickets = [];
  for (const t of [...ticketMap.values()].sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }))) {
    const byRepo = work.get(t.key) ?? new Map();
    const evidenceList = [...byRepo.values()].flatMap((w) => [...w.delivered, ...w.equivalent, ...w.sourceOnly, ...w.unknown, ...w.testing, ...w.reverted, ...w.reverts, ...w.merges]);
    const verdicts = [];
    const targets = targetsOf(t);
    const gap = t.found ? versionGap(t) : null;
    const delivered = profile.repos.filter((r) => deliveredIn(t.key, r.key));
    const deliveredViaChild = (product) => (childrenOf.get(t.key) ?? []).some((c) => reposOf(product).some((r) => deliveredIn(c, r)));

    // Version assigned, implementation absent from the release target.
    for (const product of targets) {
      const rs = reposOf(product);
      if (rs.some((r) => deliveredIn(t.key, r)) || (profile.tracker.parentCarriesVersion && deliveredViaChild(product))) continue;
      const sourceOnly = rs.some((r) => (byRepo.get(r)?.sourceOnly.length ?? 0) > 0);
      const mrs = openMrsOf(t.key, product);
      const revertedHere = rs.some((r) => (byRepo.get(r)?.reverted.length ?? 0) > 0);
      if (!rs.every(repoComplete) || rs.some((r) => (byRepo.get(r)?.unknown.length ?? 0) > 0)) verdicts.push({ kind: 'unknown', product, reason: 'repository evidence incomplete' });
      else if (sourceOnly) verdicts.push({ kind: 'version_source_only', product });
      else if (revertedHere) verdicts.push({ kind: 'version_reverted', product });
      else if (rs.some((r) => (byRepo.get(r)?.testing.length ?? 0) > 0)) verdicts.push({ kind: 'version_testing_only', product });
      else if (mrs.length) verdicts.push({ kind: 'version_open_mr', product, mrs: mrs.map((m) => m.ref) });
      else if (profile.forge && !mrEvidenceComplete(product)) verdicts.push({ kind: 'unknown', product, reason: 'open merge requests incomplete' });
      else verdicts.push({ kind: 'version_without_code', product });
    }
    // Merged code without the version.
    for (const product of new Set(delivered.map((r) => r.product))) {
      if (!Object.hasOwn(labels, product) || targets.includes(product)) continue;
      if (!t.found) verdicts.push({ kind: 'unknown', product, reason: tracker.ticketsComplete ? 'ticket not found in the tracker' : 'tracker results incomplete' });
      else if (gap) verdicts.push({ kind: 'unknown', product, reason: gap });
      else verdicts.push({ kind: 'delivered_without_version', product, expected: labels[product] });
    }
    // Partial multi-repo delivery: delivered in one repo, only on source in another.
    const partialRepos = profile.repos.filter((r) => !deliveredIn(t.key, r.key) && (byRepo.get(r.key)?.sourceOnly.length ?? 0) > 0);
    if (delivered.length > 0 && partialRepos.length > 0) verdicts.push({ kind: 'partial_delivery', delivered: delivered.map((r) => r.key), missing: partialRepos.map((r) => r.key) });
    if (delivered.length > 0 && delivered.every((r) => (byRepo.get(r.key)?.delivered.length ?? 0) === 0)) verdicts.push({ kind: 'delivered_by_equivalent_patch', repos: delivered.map((r) => r.key) });
    const reverted = [...byRepo.values()].some((w) => w.reverted.length > 0);
    if (reverted && !verdicts.some((v) => v.kind === 'version_reverted')) verdicts.push({ kind: delivered.length ? 'partially_reverted' : 'reverted' });
    if (delivered.length > 0 && t.found && t.status !== null && profile.tracker.doneStatuses.length && !profile.tracker.doneStatuses.includes(t.status)) {
      verdicts.push({ kind: 'status_not_done', status: t.status });
    }
    if ([...byRepo.values()].some((w) => [...w.delivered, ...w.equivalent, ...w.sourceOnly].some((c) => c.ambiguous))) verdicts.push({ kind: 'ambiguous_attribution' });
    if (gap && verdicts.length === 0) verdicts.push({ kind: 'unknown', reason: gap });
    if (targets.length === 0 && delivered.length === 0 && evidenceList.length === 0 && verdicts.length === 0) continue;
    tickets.push({
      key: t.key, found: t.found, summary: t.summary, status: t.status, versions: t.versions, parentKey: t.parentKey, subtask: t.subtask,
      targets, delivered: delivered.map((r) => r.key), verdicts, evidence: evidenceList,
    });
  }

  for (const t of tickets) for (const v of t.verdicts) {
    const severity = ['version_without_code', 'version_source_only', 'version_open_mr', 'version_reverted', 'version_testing_only', 'delivered_without_version', 'partial_delivery'].includes(v.kind) ? 'error'
      : ['unknown', 'status_not_done', 'ambiguous_attribution', 'partially_reverted', 'reverted'].includes(v.kind) ? 'warn' : 'info';
    findings.push(finding(v.kind, severity, `${t.key}: ${v.kind.replaceAll('_', ' ')}${v.product ? ` (${v.product})` : ''}${v.reason ? `: ${v.reason}` : ''}`, { ticket: t.key, ...v }));
  }
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
  const complete = evidence.complete && tracker.ticketsComplete && (!profile.forge || tracker.openMrsComplete);
  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return {
    complete,
    completeness: { repositories: evidence.complete, tracker: tracker.ticketsComplete, openMergeRequests: profile.forge ? tracker.openMrsComplete : null },
    collectedAt: evidence.finishedAt, environmentId: evidence.environmentId, versions: labels,
    counts, findings, repos, tickets,
  };
}
