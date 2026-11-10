// The permissions diff between a published version and a submission, and the
// strict check of the permissions object itself.
//
// The permissions object is the CLI's (`octi plugin permissions <dir> --json`,
// Octipus src/plugins/packages/permissions.ts, `computePermissions`), in
// exactly this key order:
//
//   { name, version, apiVersion, runtime, host[] (sorted), network[] (sorted),
//     tools[{name,effect}] (by name), effects{read,write,external},
//     contributions{
//       commands[{name,tool}] (by name),
//       schedules[{id,cron,tool,input?}] (by id; input only when the manifest has one),
//       events[{on,tool}] (by on, then tool),
//       prompt{file,sha256,roles?}|null (sha256: lower-case hex of the file's bytes),
//       context{tool,roles?}|null },            (roles sorted; omitted when none)
//     pages[{path,title,entry}] (by path), ui{dir,sha256}|null (null without pages),
//     trustedInput, maxProtection }
//
// An index lists it as it is: the host recomputes it from the downloaded
// package and compares the whole object (deep equality), and refuses the old
// shape (`pages` a count, `prompt` a boolean). Nothing here computes
// permissions; it checks their shape and compares two of them, with the
// rules and words of Octipus's own diff (src/shared/plugin-permissions.ts,
// `diffPermissions`).

/** Tool effects from least to most consequential (docs/PLUGIN-PACKAGES.md#tool-effects). */
export const EFFECT_RANK = { read: 0, write: 1, external: 2 };

/** The keys of a permissions object, in the CLI's order. */
export const PERMISSION_KEYS = ['name', 'version', 'apiVersion', 'runtime', 'host', 'network', 'tools', 'effects', 'contributions', 'pages', 'ui', 'trustedInput', 'maxProtection'];

/** JSON with sorted object keys, so equal objects compare equal. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Any control character, or a bidirectional or invisible formatting one (Octipus's `line()`). */
const BAD_TEXT = /[\u0000-\u001F\u007F-\u009F؜​-‏‪-‮⁦-⁩﻿]/;

/**
 * Why `p` is not a permissions object as the CLI prints it and an index must
 * carry it, as a list of problems (empty when it is). Checks the types and
 * bounds of Octipus's index schema (`indexPermissionsSchema`), and then that
 * `p` is byte for byte its canonical form: the key order, every list sorted,
 * `input` and `roles` only when present, the effects counted from the tools,
 * `ui` exactly when there are pages, and both sha256 filled in (the host
 * always computes them, so a listing without them never matches).
 */
export function permissionsProblems(p) {
  const out = [];
  const bad = (m) => { out.push(m); return out; };
  if (!isObj(p)) return bad('permissions must be an object');
  if (typeof p.pages === 'number' || typeof p.contributions?.prompt === 'boolean' || typeof p.contributions?.context === 'boolean') {
    return bad('permissions are in the old shape (pages a count, prompt or context a boolean), which hosts refuse: they come from an Octipus CLI older than bf9551be');
  }
  const keys = Object.keys(p);
  if (keys.join(',') !== PERMISSION_KEYS.join(',')) return bad(`permissions must have exactly ${PERMISSION_KEYS.join(', ')}, in that order (has ${keys.join(', ')})`);
  const text = (v, max) => typeof v === 'string' && v.length <= max && !BAD_TEXT.test(v);
  const list = (v, max) => Array.isArray(v) && v.length <= max;
  const roles = (r) => r === undefined || (list(r, 30) && r.every((x) => text(x, 64)));
  if (typeof p.name !== 'string' || p.name.length > 50) out.push('permissions.name');
  if (typeof p.version !== 'string' || p.version.length > 100 || !SEMVER.test(p.version)) out.push('permissions.version');
  if (typeof p.apiVersion !== 'string' || p.apiVersion.length > 100 || !SEMVER.test(p.apiVersion)) out.push('permissions.apiVersion');
  if (!['package', 'in-process'].includes(p.runtime)) out.push('permissions.runtime');
  if (!list(p.host, 30) || !p.host.every((x) => text(x, 40))) out.push('permissions.host');
  if (!list(p.network, 50) || !p.network.every((x) => text(x, 300))) out.push('permissions.network');
  if (!list(p.tools, 200) || !p.tools.every((t) => isObj(t) && text(t.name, 64) && t.effect in EFFECT_RANK)) out.push('permissions.tools');
  if (!isObj(p.effects) || !['read', 'write', 'external'].every((k) => Number.isSafeInteger(p.effects[k]) && p.effects[k] >= 0 && p.effects[k] <= 200)) out.push('permissions.effects');
  const c = p.contributions;
  if (!isObj(c)) out.push('permissions.contributions');
  else {
    if (!list(c.commands, 100) || !c.commands.every((x) => isObj(x) && text(x.name, 64) && text(x.tool, 64))) out.push('permissions.contributions.commands');
    if (!list(c.schedules, 100) || !c.schedules.every((x) => isObj(x) && text(x.id, 64) && text(x.cron, 100) && text(x.tool, 64)
      && (x.input === undefined || (isObj(x.input) && Object.keys(x.input).every((k) => k.length <= 100) && JSON.stringify(x.input).length <= 4000)))) out.push('permissions.contributions.schedules');
    if (!list(c.events, 100) || !c.events.every((x) => isObj(x) && text(x.on, 64) && text(x.tool, 64))) out.push('permissions.contributions.events');
    if (c.prompt !== null && !(isObj(c.prompt) && text(c.prompt.file, 300) && typeof c.prompt.sha256 === 'string' && HEX64.test(c.prompt.sha256) && roles(c.prompt.roles))) {
      out.push('permissions.contributions.prompt (null, or { file, sha256 (64 lower-case hex), roles? })');
    }
    if (c.context !== null && !(isObj(c.context) && text(c.context.tool, 64) && roles(c.context.roles))) out.push('permissions.contributions.context (null, or { tool, roles? })');
  }
  if (!list(p.pages, 100) || !p.pages.every((x) => isObj(x) && text(x.path, 200) && text(x.title, 100) && text(x.entry, 300))) out.push('permissions.pages');
  if (p.ui !== null && !(isObj(p.ui) && text(p.ui.dir, 300) && typeof p.ui.sha256 === 'string' && HEX64.test(p.ui.sha256))) out.push('permissions.ui (null, or { dir, sha256 (64 lower-case hex) })');
  if (typeof p.trustedInput !== 'boolean') out.push('permissions.trustedInput');
  if (![1, 2, 3, 4].includes(p.maxProtection)) out.push('permissions.maxProtection');
  if (out.length) return out;

  const canonical = canonicalPermissions(p);
  if (JSON.stringify(canonical) !== JSON.stringify(p)) {
    const which = PERMISSION_KEYS.filter((k) => JSON.stringify(canonical[k]) !== JSON.stringify(p[k]));
    out.push(`permissions are not in the CLI's exact form (${which.join(', ')}: key order, sorting, duplicates, the effect counts or ui)`);
  }
  for (const [k, l] of [['host', p.host], ['network', p.network], ['tools', p.tools.map((t) => t.name)], ['commands', c.commands.map((x) => x.name)], ['schedules', c.schedules.map((x) => x.id)], ['pages', p.pages.map((x) => x.path)]]) {
    if (new Set(l).size !== l.length) out.push(`permissions: ${k} lists one twice`);
  }
  return out;
}

/** `p` rebuilt in the CLI's form (computePermissions): key order, sorted lists, effects from the tools. */
function canonicalPermissions(p) {
  const sorted = (l) => [...l].sort(byCodeUnit);
  const rolesOf = (r) => (r === undefined ? {} : { roles: sorted(r) });
  const c = p.contributions;
  const effects = { read: 0, write: 0, external: 0 };
  for (const t of p.tools) effects[t.effect] += 1;
  const pages = p.pages.map((x) => ({ path: x.path, title: x.title, entry: x.entry })).sort((a, b) => byCodeUnit(a.path, b.path));
  return {
    name: p.name,
    version: p.version,
    apiVersion: p.apiVersion,
    runtime: p.runtime,
    host: sorted(p.host),
    network: sorted(p.network),
    tools: p.tools.map((t) => ({ name: t.name, effect: t.effect })).sort((a, b) => byCodeUnit(a.name, b.name)),
    effects,
    contributions: {
      commands: c.commands.map((x) => ({ name: x.name, tool: x.tool })).sort((a, b) => byCodeUnit(a.name, b.name)),
      schedules: c.schedules.map((x) => ({ id: x.id, cron: x.cron, tool: x.tool, ...(x.input !== undefined ? { input: x.input } : {}) })).sort((a, b) => byCodeUnit(a.id, b.id)),
      events: c.events.map((x) => ({ on: x.on, tool: x.tool })).sort((a, b) => byCodeUnit(a.on, b.on) || byCodeUnit(a.tool, b.tool)),
      prompt: c.prompt ? { file: c.prompt.file, sha256: c.prompt.sha256, ...rolesOf(c.prompt.roles) } : null,
      context: c.context ? { tool: c.context.tool, ...rolesOf(c.context.roles) } : null,
    },
    pages,
    ui: pages.length > 0 ? { dir: p.ui?.dir, sha256: p.ui?.sha256 } : null,
    trustedInput: p.trustedInput,
    maxProtection: p.maxProtection,
  };
}

/** Throw with every problem unless `p` is a permissions object in the CLI's exact form. */
export function assertPermissions(p, what = 'permissions') {
  const problems = permissionsProblems(p);
  if (problems.length) throw new Error(`${what}: ${problems.join('; ')}`);
  return p;
}

const json = (v) => JSON.stringify(v ?? null);
const rolesText = (roles) => (roles ? `roles ${roles.join(', ')}` : 'every role');
/** Whether `after` reaches a role `before` did not (no roles: every role). */
const reachesMore = (before, after) => before !== undefined && (after === undefined || after.some((r) => !before.includes(r)));

/**
 * What changed between `before` (the published version's permissions, or
 * null for a plugin not published yet) and `after`; both in the CLI's shape
 * (permissionsProblems).
 *
 * Returns `{ widened, firstVersion, changes: [{ kind, change: 'added'|'removed'|'wider'|'narrower'|'changed', text, widens }] }`.
 * A plugin that is not published yet widens by definition: everything it
 * asks for is new, so it always gets a security review. Otherwise the rules
 * are Octipus's: a change widens when it adds something, points a command,
 * schedule or the context at another tool, moves a cron, changes the prompt
 * file or text, adds or changes a page, changes the page files, or reaches
 * roles it did not. A schedule's `input` alone is a change, not a widening.
 */
export function diffPermissions(before, after) {
  if (!before) {
    return { widened: true, firstVersion: true, changes: describeAll(after).map((text) => ({ kind: 'new', change: 'added', text, widens: true })) };
  }
  const changes = [];
  const add = (kind, change, text, widens) => changes.push({ kind, change, text, widens });

  // The marketplace carries sandboxed packages only: any other runtime widens.
  if (before.runtime !== after.runtime) add('runtime', 'changed', `runtime ${before.runtime} → ${after.runtime}`, after.runtime !== 'package');
  if (before.apiVersion !== after.apiVersion) add('apiVersion', 'changed', `apiVersion ${before.apiVersion} → ${after.apiVersion}`, false);
  for (const [kind, label] of [['host', 'host API scope'], ['network', 'network host']]) {
    for (const v of after[kind]) if (!before[kind].includes(v)) add(kind, 'added', `${label} ${v}`, true);
    for (const v of before[kind]) if (!after[kind].includes(v)) add(kind, 'removed', `${label} ${v}`, false);
  }
  const was = new Map(before.tools.map((t) => [t.name, t.effect]));
  const now = new Map(after.tools.map((t) => [t.name, t.effect]));
  for (const [name, effect] of now) {
    const old = was.get(name);
    if (old === undefined) add('tool', 'added', `tool ${name} (${effect})`, true);
    else if (old !== effect) {
      const wider = (EFFECT_RANK[effect] ?? 3) > (EFFECT_RANK[old] ?? 3);
      add('tool', wider ? 'wider' : 'narrower', `tool ${name}: ${old} → ${effect}`, wider);
    }
  }
  for (const [name, effect] of was) if (!now.has(name)) add('tool', 'removed', `tool ${name} (${effect})`, false);
  diffContributions(before, after, add);
  if (!before.trustedInput && after.trustedInput) add('trustedInput', 'added', 'model.trustedInput (its model calls may be approved to run on CLI lanes)', true);
  if (before.trustedInput && !after.trustedInput) add('trustedInput', 'removed', 'model.trustedInput', false);
  if (before.maxProtection !== after.maxProtection) {
    const wider = after.maxProtection > before.maxProtection;
    add('maxProtection', wider ? 'wider' : 'narrower', `maxProtection ${before.maxProtection} → ${after.maxProtection}`, wider);
  }
  return { widened: changes.some((c) => c.widens), firstVersion: false, changes };
}

/** Commands, schedules, events, prompt, context, pages and page files (Octipus's `diffContributions`). */
function diffContributions(before, after, add) {
  const b = before.contributions;
  const a = after.contributions;
  const was = new Map(b.commands.map((c) => [c.name, c]));
  const now = new Map(a.commands.map((c) => [c.name, c]));
  for (const [name, c] of now) {
    const old = was.get(name);
    if (!old) add('contribution', 'added', `command /${name} → ${c.tool}`, true);
    else if (old.tool !== c.tool) add('contribution', 'changed', `command /${name}: ${old.tool} → ${c.tool}`, true);
  }
  for (const [name, c] of was) if (!now.has(name)) add('contribution', 'removed', `command /${name} → ${c.tool}`, false);

  const wasS = new Map(b.schedules.map((x) => [x.id, x]));
  const nowS = new Map(a.schedules.map((x) => [x.id, x]));
  for (const [id, x] of nowS) {
    const old = wasS.get(id);
    if (!old) { add('contribution', 'added', `schedule ${id} (${x.cron} UTC) → ${x.tool}`, true); continue; }
    if (old.tool !== x.tool) add('contribution', 'changed', `schedule ${id}: tool ${old.tool} → ${x.tool}`, true);
    if (old.cron !== x.cron) add('contribution', 'changed', `schedule ${id}: cron ${old.cron} → ${x.cron} (UTC)`, true);
    if (stableStringify(old.input) !== stableStringify(x.input)) add('contribution', 'changed', `schedule ${id}: input ${json(old.input)} → ${json(x.input)}`, false);
  }
  for (const [id, x] of wasS) if (!nowS.has(id)) add('contribution', 'removed', `schedule ${id} (${x.cron} UTC) → ${x.tool}`, false);

  const key = (e) => `${e.on} → ${e.tool}`;
  const wasE = new Set(b.events.map(key));
  const nowE = new Set(a.events.map(key));
  for (const e of nowE) if (!wasE.has(e)) add('contribution', 'added', `event ${e}`, true);
  for (const e of wasE) if (!nowE.has(e)) add('contribution', 'removed', `event ${e}`, false);

  if (!b.prompt && a.prompt) add('contribution', 'added', `prompt ${a.prompt.file} (${rolesText(a.prompt.roles)})`, true);
  else if (b.prompt && !a.prompt) add('contribution', 'removed', `prompt ${b.prompt.file}`, false);
  else if (b.prompt && a.prompt) {
    if (b.prompt.file !== a.prompt.file || b.prompt.sha256 !== a.prompt.sha256) add('contribution', 'changed', `prompt text (${a.prompt.file})`, true);
    if (json(b.prompt.roles) !== json(a.prompt.roles)) {
      add('contribution', 'changed', `prompt ${rolesText(b.prompt.roles)} → ${rolesText(a.prompt.roles)}`, reachesMore(b.prompt.roles, a.prompt.roles));
    }
  }
  if (!b.context && a.context) add('contribution', 'added', `context → ${a.context.tool} (${rolesText(a.context.roles)})`, true);
  else if (b.context && !a.context) add('contribution', 'removed', `context → ${b.context.tool}`, false);
  else if (b.context && a.context) {
    if (b.context.tool !== a.context.tool) add('contribution', 'changed', `context tool ${b.context.tool} → ${a.context.tool}`, true);
    if (json(b.context.roles) !== json(a.context.roles)) {
      add('contribution', 'changed', `context ${rolesText(b.context.roles)} → ${rolesText(a.context.roles)}`, reachesMore(b.context.roles, a.context.roles));
    }
  }

  const wasP = new Map(before.pages.map((p) => [p.path, p]));
  const nowP = new Map(after.pages.map((p) => [p.path, p]));
  for (const [path, p] of nowP) {
    const old = wasP.get(path);
    if (!old) add('pages', 'added', `page ${path} ("${p.title}")`, true);
    else if (old.title !== p.title || old.entry !== p.entry) add('pages', 'changed', `page ${path}: "${old.title}" ${old.entry} → "${p.title}" ${p.entry}`, true);
  }
  for (const [path, p] of wasP) if (!nowP.has(path)) add('pages', 'removed', `page ${path} ("${p.title}")`, false);
  if (before.ui && after.ui && (before.ui.dir !== after.ui.dir || before.ui.sha256 !== after.ui.sha256)) {
    add('pages', 'changed', `page files (${after.ui.dir}/)`, true);
  }
}

/** Every permission of a first version, as lines. */
function describeAll(a) {
  const c = a.contributions;
  const lines = [`runtime ${a.runtime}`];
  for (const s of a.host) lines.push(`host API scope ${s}`);
  for (const h of a.network) lines.push(`network host ${h}`);
  for (const t of a.tools) lines.push(`tool ${t.name} (${t.effect})`);
  for (const x of c.commands) lines.push(`command /${x.name} → ${x.tool}`);
  for (const x of c.schedules) lines.push(`schedule ${x.id} (${x.cron} UTC) → ${x.tool}${x.input !== undefined ? ` with ${JSON.stringify(x.input)}` : ''}`);
  for (const x of c.events) lines.push(`event ${x.on} → ${x.tool}`);
  if (c.prompt) lines.push(`prompt ${c.prompt.file} (${rolesText(c.prompt.roles)}), sha256 ${c.prompt.sha256}`);
  if (c.context) lines.push(`context → ${c.context.tool} (${rolesText(c.context.roles)})`);
  for (const p of a.pages) lines.push(`page ${p.path} ("${p.title}") → ${p.entry}`);
  if (a.ui) lines.push(`page files (${a.ui.dir}/), sha256 ${a.ui.sha256}`);
  if (a.trustedInput) lines.push('model.trustedInput');
  lines.push(`maxProtection ${a.maxProtection}`);
  return lines;
}
