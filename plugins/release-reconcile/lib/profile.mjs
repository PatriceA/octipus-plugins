// Saved profiles (reusable per user and workspace), per-release run settings,
// the collector request they produce, and the tracker/forge adapters that
// turn collected responses into tickets and open merge requests. No I/O.

export class InputError extends Error {}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const REF = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}(?<![./])$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONNECTION = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const REMOTE_PATH = /^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.git$/;
const FORGE_PROJECT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,9}$/;
export const TRACKER_KINDS = ['jira-cloud', 'jira-dc'];
export const FORGE_KINDS = ['gitlab'];
export const MAX_REPOS = 20;
/** Which branch of a repository an open merge request must target to count for a version. */
export const MR_TARGETS = ['release', 'source'];

const fail = (msg) => { throw new InputError(msg); };
const str = (v, re, what) => (typeof v === 'string' && re.test(v) ? v : fail(`${what} is invalid`));
const list = (v, what, max) => (Array.isArray(v) && v.length <= max ? v : fail(`${what} must be a list of at most ${max}`));
const only = (obj, keys, what) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${what} must be an object`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`${what}.${k} is not a known field`);
  return obj;
};

function baseline(b, what) {
  only(b, ['tag', 'sha'], what);
  if (('tag' in b) === ('sha' in b)) fail(`${what} needs exactly one of tag or sha`);
  return 'tag' in b ? { tag: str(b.tag, REF, `${what}.tag`) } : { sha: str(b.sha, SHA, `${what}.sha`) };
}

function relPath(p, what) {
  if (typeof p !== 'string' || !p || p.length > 500 || p.startsWith('/') || p.includes('\0') || p.split('/').some((s) => s === '..' || s === '')) fail(`${what} must be a relative folder without ..`);
  return p;
}

/** A profile as saved: validated, unknown fields refused, no defaults invented beyond the documented ones. */
export function validateProfile(input) {
  const p = only(input, ['id', 'name', 'environmentId', 'workspaceRoot', 'ticketProjects', 'tracker', 'forge', 'manifestFiles', 'mrPattern', 'repos', 'targetVersions'], 'profile');
  const tracker = only(p.tracker, ['connection', 'kind', 'versionFormat', 'versionField', 'doneStatuses', 'parentCarriesVersion', 'pageSize'], 'tracker');
  if (!TRACKER_KINDS.includes(tracker.kind)) fail(`tracker.kind is one of ${TRACKER_KINDS.join(', ')}`);
  const versionFormat = typeof tracker.versionFormat === 'string' && tracker.versionFormat.includes('{version}') && tracker.versionFormat.length <= 100 && !/["\\]/.test(tracker.versionFormat)
    ? tracker.versionFormat : fail('tracker.versionFormat must contain {version} (and may contain {product})');
  const forge = p.forge === undefined ? undefined : only(p.forge, ['connection', 'kind', 'mrTargets'], 'forge');
  if (forge && !FORGE_KINDS.includes(forge.kind)) fail(`forge.kind is one of ${FORGE_KINDS.join(', ')}`);
  const mrTargets = forge?.mrTargets === undefined ? ['release'] : list(forge.mrTargets, 'forge.mrTargets', MR_TARGETS.length);
  if (!mrTargets.length || new Set(mrTargets).size !== mrTargets.length || !mrTargets.every((x) => MR_TARGETS.includes(x))) fail(`forge.mrTargets lists distinct branches of ${MR_TARGETS.join(', ')}`);
  const workspaceRoot = typeof p.workspaceRoot === 'string' && p.workspaceRoot.startsWith('/') && !p.workspaceRoot.split('/').includes('..') && p.workspaceRoot.length <= 500
    ? p.workspaceRoot.replace(/\/+$/, '') || '/' : fail('workspaceRoot must be an absolute folder');
  if (p.mrPattern !== undefined) {
    if (typeof p.mrPattern !== 'string' || p.mrPattern.length > 200) fail('mrPattern is invalid');
    try { new RegExp(p.mrPattern); } catch { fail('mrPattern is not a valid regular expression'); }
  }
  const repos = list(p.repos, 'repos', MAX_REPOS).map((r, i) => {
    const w = `repos[${i}]`;
    only(r, ['key', 'path', 'product', 'fetch', 'forgeProject', 'source', 'release', 'testing', 'baseline'], w);
    if (r.fetch !== undefined) only(r.fetch, ['connection', 'remotePath'], `${w}.fetch`);
    return {
      key: str(r.key, KEY, `${w}.key`), path: relPath(r.path, `${w}.path`), product: str(r.product, KEY, `${w}.product`),
      ...(r.fetch ? { fetch: { connection: str(r.fetch.connection, CONNECTION, `${w}.fetch.connection`), remotePath: str(r.fetch.remotePath, REMOTE_PATH, `${w}.fetch.remotePath`) } } : {}),
      ...(r.forgeProject !== undefined ? { forgeProject: str(r.forgeProject, FORGE_PROJECT, `${w}.forgeProject`) } : {}),
      source: str(r.source, REF, `${w}.source`), release: str(r.release, REF, `${w}.release`),
      ...(r.testing !== undefined ? { testing: str(r.testing, REF, `${w}.testing`) } : {}),
      baseline: baseline(r.baseline, `${w}.baseline`),
    };
  });
  if (repos.length === 0) fail('repos needs at least one repository');
  if (new Set(repos.map((r) => r.key)).size !== repos.length) fail('repo keys repeat');
  return {
    id: str(p.id, KEY, 'id'), name: typeof p.name === 'string' && p.name.trim() && p.name.length <= 100 ? p.name.trim() : fail('name is required (at most 100 characters)'),
    environmentId: typeof p.environmentId === 'string' && p.environmentId && p.environmentId.length <= 100 ? p.environmentId : fail('environmentId is required'),
    workspaceRoot,
    ticketProjects: list(p.ticketProjects, 'ticketProjects', 20).map((x, i) => str(x, PROJECT, `ticketProjects[${i}]`)).length ? p.ticketProjects : fail('ticketProjects needs at least one project key'),
    tracker: {
      connection: str(tracker.connection, CONNECTION, 'tracker.connection'), kind: tracker.kind, versionFormat,
      versionField: tracker.versionField === undefined ? 'fixVersions' : str(tracker.versionField, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'tracker.versionField'),
      doneStatuses: list(tracker.doneStatuses ?? [], 'tracker.doneStatuses', 20).map((s) => (typeof s === 'string' && s.length <= 60 ? s : fail('tracker.doneStatuses holds names'))),
      parentCarriesVersion: tracker.parentCarriesVersion === undefined ? true : typeof tracker.parentCarriesVersion === 'boolean' ? tracker.parentCarriesVersion : fail('tracker.parentCarriesVersion is true or false'),
      pageSize: tracker.pageSize === undefined ? 100 : Number.isInteger(tracker.pageSize) && tracker.pageSize >= 1 && tracker.pageSize <= 100 ? tracker.pageSize : fail('tracker.pageSize is 1-100'),
    },
    ...(forge ? { forge: { connection: str(forge.connection, CONNECTION, 'forge.connection'), kind: forge.kind, mrTargets } } : {}),
    manifestFiles: list(p.manifestFiles ?? [], 'manifestFiles', 30).map((g) => (typeof g === 'string' && g && g.length <= 200 ? g : fail('manifestFiles holds globs'))),
    ...(p.mrPattern !== undefined ? { mrPattern: p.mrPattern } : {}),
    repos,
    ...(p.targetVersions !== undefined ? { targetVersions: validateVersions(p.targetVersions, new Set(repos.map(r => r.product))) } : {}),
  };
}

/** Validate reusable target defaults and immutable per-run choices alike. */
function validateVersions(input, products) {
  only(input, Object.keys(input ?? {}), 'versions');
  const versions = {};
  for (const [product, v] of Object.entries(input)) {
    if (!products.has(product)) fail(`versions.${product}: no repository of the profile has this product`);
    versions[product] = str(v, VERSION, `versions.${product}`);
  }
  if (Object.keys(versions).length === 0) fail('versions needs a target version for at least one product');
  return versions;
}

/** Each run freezes its choices; a saved profile may supply reusable defaults. */
export function validateRunSettings(input, profile) {
  const r = only(input, ['profileId', 'versions', 'includeTesting', 'fetch', 'maxCommits'], 'run');
  const versions = validateVersions(r.versions ?? profile.targetVersions, new Set(profile.repos.map(x => x.product)));
  return {
    profileId: profile.id, versions,
    includeTesting: r.includeTesting === undefined ? true : !!r.includeTesting,
    fetch: r.fetch === undefined ? true : !!r.fetch,
    maxCommits: r.maxCommits === undefined ? 2000 : Number.isInteger(r.maxCommits) && r.maxCommits >= 1 && r.maxCommits <= 5000 ? r.maxCommits : fail('maxCommits is 1-5000'),
  };
}

const jqlString = (s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
/** An encoded query whose `{keys}` survives encoding as the host's placeholder. */
const withKeys = (encoded) => encoded.replaceAll(encodeURIComponent('{keys}'), '{keys}');

function trackerRequest(profile, id, jql, expand) {
  const t = profile.tracker;
  const fields = ['summary', 'status', 'parent', 'issuetype', t.versionField].join(',');
  const q = withKeys(encodeURIComponent(jql));
  const base = t.kind === 'jira-cloud'
    ? { path: `/rest/api/3/search/jql?jql=${q}&fields=${fields}&maxResults=${t.pageSize}`, pagination: { type: 'token', itemsPointer: '/issues', tokenParam: 'nextPageToken', nextTokenPointer: '/nextPageToken', lastPointer: '/isLast' } }
    : { path: `/rest/api/2/search?jql=${q}&fields=${fields}`, pagination: { type: 'offset', itemsPointer: '/issues', startParam: 'startAt', limitParam: 'maxResults', limit: t.pageSize, totalPointer: '/total' } };
  return { id, connection: t.connection, maxPages: 50, ...base, ...(expand ? { expand: { projects: profile.ticketProjects, batch: 50, from: expand } } : {}) };
}

/** The distinct forge projects of a profile; the open-MR request of project `i` has id `mrs-<i>`. */
export function forgeProjects(profile) {
  return profile.forge ? [...new Set(profile.repos.map((r) => r.forgeProject).filter(Boolean))] : [];
}

/** The collector request (POST /api/plugin-host/collector/runs) for a profile and run. */
export function buildCollectorRequest(profile, run, title) {
  const projects = profile.ticketProjects.join(', ');
  const labels = Object.entries(run.versions).map(([product, v]) => profile.tracker.versionFormat.replaceAll('{product}', product).replaceAll('{version}', v));
  const http = [
    trackerRequest(profile, 'versions', `project in (${projects}) AND ${profile.tracker.versionField === 'fixVersions' ? 'fixVersion' : profile.tracker.versionField} in (${labels.map(jqlString).join(', ')}) ORDER BY key`),
    trackerRequest(profile, 'committed', 'key in ({keys}) ORDER BY key', { source: 'commits' }),
    trackerRequest(profile, 'parents', 'key in ({keys}) ORDER BY key', { source: 'http', id: 'committed', pointer: '/fields/parent/key' }),
  ];
  forgeProjects(profile).forEach((project, i) => {
    http.push({
      id: `mrs-${i}`, connection: profile.forge.connection, maxPages: 20,
      path: `/api/v4/projects/${encodeURIComponent(project)}/merge_requests?state=opened&scope=all`,
      pagination: { type: 'page', itemsPointer: '', pageParam: 'page', perPageParam: 'per_page', perPage: 100 },
    });
  });
  return {
    environmentId: profile.environmentId, title: (title ?? `${profile.name}: ${labels.join(', ')}`).slice(0, 200), maxCommits: run.maxCommits,
    repos: profile.repos.map((r) => ({
      key: r.key, path: `${profile.workspaceRoot === '/' ? '' : profile.workspaceRoot}/${r.path}`,
      ...(run.fetch && r.fetch ? { fetch: r.fetch } : {}),
      baseline: { name: 'baseline', ...(r.baseline.tag ? (run.fetch && r.fetch ? { tag: r.baseline.tag } : { localRef: `refs/tags/${r.baseline.tag}` }) : { sha: r.baseline.sha }) },
      refs: [
        { name: 'source', ...(run.fetch && r.fetch ? { branch: r.source } : { localRef: `refs/heads/${r.source}` }) },
        { name: 'release', ...(run.fetch && r.fetch ? { branch: r.release } : { localRef: `refs/heads/${r.release}` }) },
        ...(run.includeTesting && r.testing ? [{ name: 'testing', ...(run.fetch && r.fetch ? { branch: r.testing } : { localRef: `refs/heads/${r.testing}` }) }] : []),
      ],
    })),
    http,
  };
}

const TICKET_FIELDS = ['summary', 'status', 'versions', 'parentKey', 'subtask'];

/** One tracker snapshot of an issue; `undefined` = absent or malformed, i.e. unknown (never an empty value). */
function readIssue(profile, issue) {
  const f = issue.fields && typeof issue.fields === 'object' ? issue.fields : {};
  const vf = f[profile.tracker.versionField];
  const parent = f.parent;
  return {
    summary: typeof f.summary === 'string' ? f.summary : undefined,
    status: typeof f.status?.name === 'string' ? f.status.name : undefined,
    versions: Array.isArray(vf) && vf.every((v) => typeof v?.name === 'string') ? vf.map((v) => v.name) : undefined,
    // No parent field (or null) is "no parent"; a parent without a key is malformed.
    parentKey: parent === undefined || parent === null ? null : typeof parent.key === 'string' ? parent.key : undefined,
    subtask: typeof f.issuetype?.subtask === 'boolean' ? f.issuetype.subtask : undefined,
  };
}

const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()) : a === b);

/**
 * Tracker items (any of the three requests) → tickets, by key. Snapshots of one
 * ticket are merged field by field: an unknown field never replaces a known one,
 * and two different known values make the field unknown and listed in `conflicts`.
 * Unknown fields are null; `versions: null` is not "no versions".
 */
export function normaliseTickets(profile, evidence) {
  const tickets = new Map();
  for (const id of ['versions', 'committed', 'parents']) {
    for (const issue of evidence.http.find((h) => h.id === id)?.items ?? []) {
      if (!issue || typeof issue.key !== 'string') continue;
      const snap = readIssue(profile, issue);
      const t = tickets.get(issue.key) ?? { key: issue.key, conflicts: [] };
      for (const field of TICKET_FIELDS) {
        if (t.conflicts.includes(field) || snap[field] === undefined) continue;
        if (t[field] === undefined) t[field] = snap[field];
        else if (!same(t[field], snap[field])) { t[field] = undefined; t.conflicts.push(field); }
      }
      tickets.set(issue.key, t);
    }
  }
  const out = [...tickets.values()].map((t) => ({ ...Object.fromEntries(TICKET_FIELDS.map((f) => [f, t[f] ?? null])), key: t.key, subtask: t.subtask === true, conflicts: t.conflicts }));
  const complete = ['versions', 'committed', 'parents'].every((id) => evidence.http.find((h) => h.id === id)?.complete === true);
  // Each open-MR request belongs to one forge project (`mrs-<i>`): its MRs keep that project.
  const openMrs = [];
  const openMrProjects = {};
  forgeProjects(profile).forEach((project, i) => {
    const h = evidence.http.find((x) => x.id === `mrs-${i}`);
    openMrProjects[project] = h?.complete === true;
    for (const m of h?.items ?? []) {
      if (!m || typeof m.iid !== 'number') continue;
      openMrs.push({
        project, ref: typeof m.references?.full === 'string' ? m.references.full : `${project}!${m.iid}`, title: String(m.title ?? ''), sourceBranch: String(m.source_branch ?? ''),
        targetBranch: String(m.target_branch ?? ''), url: typeof m.web_url === 'string' ? m.web_url : null,
      });
    }
  });
  return { tickets: out, ticketsComplete: complete, openMrs, openMrProjects, openMrsComplete: Object.values(openMrProjects).every(Boolean) };
}
