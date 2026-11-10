// The permissions diff between a published version and a submission, and the
// plain-language summary of what a plugin asks for.
//
// The permissions object is the CLI's (`octi plugin permissions <dir> --json`):
//   { name, version, apiVersion, runtime, host[], network[], tools[{name,effect}],
//     effects{read,write,external}, contributions{commands[],schedules[],events[],prompt,context},
//     pages, trustedInput, maxProtection }
// Nothing here computes permissions; it only compares two of them. Fields are
// read defensively (a list of strings or of objects, a count or a list of
// pages) so a small change in the CLI's output shape does not hide a widening.

/** Tool effects from least to most consequential (docs/PLUGIN-PACKAGES.md#tool-effects). */
export const EFFECT_RANK = { read: 0, write: 1, external: 2 };

/** A stable key for a list item that may be a string or an object. */
function itemKey(x) {
  if (x === null || x === undefined) return '';
  if (typeof x !== 'object') return String(x);
  return stableStringify(x);
}

/** JSON with sorted object keys, so equal objects compare equal. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** How a contribution reads in a summary. */
function contributionLabel(kind, x) {
  if (typeof x !== 'object' || x === null) return `${kind} ${x}`;
  switch (kind) {
    case 'command': return `command /${x.name ?? '?'}${x.tool ? ` → ${x.tool}` : ''}`;
    case 'schedule': return `schedule ${x.id ?? '?'}${x.cron ? ` (${x.cron} UTC)` : ''}${x.tool ? ` → ${x.tool}` : ''}`;
    case 'event': return `on ${x.on ?? '?'}${x.tool ? ` → ${x.tool}` : ''}`;
    default: return `${kind} ${stableStringify(x)}`;
  }
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

/** Pages as a list of labels; a bare count becomes that many unnamed pages. */
function pageList(v) {
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'object' && p !== null ? `${p.title ?? p.path ?? '?'}${p.path ? ` (${p.path})` : ''}` : String(p)));
  if (typeof v === 'number' && v > 0) return Array.from({ length: v }, (_, i) => `page ${i + 1}`);
  return [];
}

/** Tools as name → effect, from `tools[{name,effect}]` (or a manifest-style map). */
function toolMap(v) {
  const out = new Map();
  if (Array.isArray(v)) for (const t of v) if (t && typeof t === 'object' && t.name) out.set(String(t.name), String(t.effect ?? 'external'));
  else if (v && typeof v === 'object') for (const [name, d] of Object.entries(v)) out.set(name, String(d?.effect ?? d ?? 'external'));
  return out;
}

/** Whether `prompt`/`context` is present (null, false and {} are absent). */
function present(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
  return true;
}

/** The permissions in a comparable form. */
export function normalizePermissions(p = {}) {
  const c = p.contributions ?? {};
  return {
    runtime: p.runtime ?? 'package',
    apiVersion: p.apiVersion ?? null,
    host: [...new Set(list(p.host).map(String))].sort(),
    network: [...new Set(list(p.network).map(String))].sort(),
    tools: toolMap(p.tools),
    commands: new Map(list(c.commands).map((x) => [itemKey(x), contributionLabel('command', x)])),
    schedules: new Map(list(c.schedules).map((x) => [itemKey(x), contributionLabel('schedule', x)])),
    events: new Map(list(c.events).map((x) => [itemKey(x), contributionLabel('event', x)])),
    prompt: present(c.prompt) ? c.prompt : null,
    context: present(c.context) ? c.context : null,
    pages: pageList(p.pages),
    trustedInput: p.trustedInput === true || (typeof p.trustedInput === 'object' && p.trustedInput !== null && p.trustedInput.trustedInput === true),
    maxProtection: typeof p.maxProtection === 'number' ? p.maxProtection : null,
  };
}

/**
 * What changed between `before` (the published version's permissions, or
 * null for a plugin not published yet) and `after`.
 *
 * Returns `{ widened, changes: [{ kind, change: 'added'|'removed'|'wider'|'narrower'|'changed', text, widens }] }`.
 * A plugin that is not published yet widens by definition: everything it
 * asks for is new, so it always gets a security review.
 */
export function diffPermissions(before, after) {
  const a = normalizePermissions(after);
  if (!before) {
    return { widened: true, firstVersion: true, changes: describeAll(a).map((text) => ({ kind: 'new', change: 'added', text, widens: true })) };
  }
  const b = normalizePermissions(before);
  const changes = [];
  const add = (kind, change, text, widens) => changes.push({ kind, change, text, widens });

  if (b.runtime !== a.runtime) add('runtime', 'changed', `runtime ${b.runtime} → ${a.runtime}`, true);
  if (b.apiVersion !== a.apiVersion) add('apiVersion', 'changed', `apiVersion ${b.apiVersion ?? 'none'} → ${a.apiVersion ?? 'none'}`, false);

  for (const s of a.host) if (!b.host.includes(s)) add('host', 'added', `host API scope ${s}`, true);
  for (const s of b.host) if (!a.host.includes(s)) add('host', 'removed', `host API scope ${s}`, false);
  for (const h of a.network) if (!b.network.includes(h)) add('network', 'added', `network host ${h}`, true);
  for (const h of b.network) if (!a.network.includes(h)) add('network', 'removed', `network host ${h}`, false);

  for (const [name, effect] of a.tools) {
    if (!b.tools.has(name)) { add('tool', 'added', `tool ${name} (${effect})`, true); continue; }
    const was = b.tools.get(name);
    if (was === effect) continue;
    const wider = (EFFECT_RANK[effect] ?? 3) > (EFFECT_RANK[was] ?? 3);
    add('tool', wider ? 'wider' : 'narrower', `tool ${name}: ${was} → ${effect}`, wider);
  }
  for (const [name, effect] of b.tools) if (!a.tools.has(name)) add('tool', 'removed', `tool ${name} (${effect})`, false);

  for (const kind of ['commands', 'schedules', 'events']) {
    for (const [k, label] of a[kind]) if (!b[kind].has(k)) add('contribution', 'added', label, true);
    for (const [k, label] of b[kind]) if (!a[kind].has(k)) add('contribution', 'removed', label, false);
  }
  for (const kind of ['prompt', 'context']) {
    const was = b[kind];
    const now = a[kind];
    if (!was && now) add('contribution', 'added', `${kind}: ${describeContribution(kind, now)}`, true);
    else if (was && !now) add('contribution', 'removed', `${kind}`, false);
    else if (was && now && stableStringify(was) !== stableStringify(now)) add('contribution', 'changed', `${kind}: ${describeContribution(kind, now)}`, true);
  }

  for (const p of a.pages) if (!b.pages.includes(p)) add('pages', 'added', `page ${p}`, true);
  for (const p of b.pages) if (!a.pages.includes(p)) add('pages', 'removed', `page ${p}`, false);

  if (!b.trustedInput && a.trustedInput) add('trustedInput', 'added', 'model.trustedInput (its model calls may be approved to run on CLI lanes)', true);
  if (b.trustedInput && !a.trustedInput) add('trustedInput', 'removed', 'model.trustedInput', false);

  if (b.maxProtection !== a.maxProtection) {
    const wider = (a.maxProtection ?? 0) > (b.maxProtection ?? 0);
    add('maxProtection', wider ? 'wider' : 'narrower', `maxProtection ${b.maxProtection ?? 'default'} → ${a.maxProtection ?? 'default'}`, wider);
  }

  return { widened: changes.some((c) => c.widens), firstVersion: false, changes };
}

function describeContribution(kind, v) {
  if (typeof v !== 'object' || v === null) return String(v);
  if (kind === 'prompt') return `${v.file ?? 'a prompt file'}${v.roles ? ` (roles ${[].concat(v.roles).join(', ')})` : ' (every agent)'}`;
  if (kind === 'context') return `${v.tool ?? '?'}${v.roles ? ` (roles ${[].concat(v.roles).join(', ')})` : ' (every agent)'}`;
  return stableStringify(v);
}

/** Every permission of a first version, as lines. */
function describeAll(a) {
  const lines = [`runtime ${a.runtime}`];
  for (const s of a.host) lines.push(`host API scope ${s}`);
  for (const h of a.network) lines.push(`network host ${h}`);
  for (const [name, effect] of a.tools) lines.push(`tool ${name} (${effect})`);
  for (const kind of ['commands', 'schedules', 'events']) for (const label of a[kind].values()) lines.push(label);
  if (a.prompt) lines.push(`prompt: ${describeContribution('prompt', a.prompt)}`);
  if (a.context) lines.push(`context: ${describeContribution('context', a.context)}`);
  for (const p of a.pages) lines.push(`page ${p}`);
  if (a.trustedInput) lines.push('model.trustedInput');
  if (a.maxProtection !== null) lines.push(`maxProtection ${a.maxProtection}`);
  return lines;
}
