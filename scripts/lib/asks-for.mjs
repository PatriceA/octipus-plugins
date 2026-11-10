// "What it asks for": a plugin's permissions in the words Octipus's own admin
// page uses (web/app/admin/plugins/page.tsx in PatriceA/octipus, and
// docs/PLUGIN-PACKAGES.md), so a listing on plugins.octipus.cc reads like the
// confirmation an admin sees when enabling the plugin. Keep these strings in
// step with that page; they are copied, not invented.
//
// Shared by the site (the plugin page) and the PR summary.

export const EFFECT_TEXT = {
  read: 'Reads only. Allowed by default; a user\'s rule can ask or deny.',
  write: 'Changes data in the connected system. Asks by default.',
  external: 'An effect outside the organisation: a payment, a message to a person, a post. Always asks; a rule can deny it but never allow it, and an unattended run is refused.',
};

export const HOST_TOKEN_WHEN = 'A call gets a short-lived token for them (at most 30 seconds, for that call only) only when a user starts it: '
  + 'a tool call of their own agent in their conversation, a slash command they type, or a button on the package\'s page. '
  + 'Schedules, events and context calls never get one. The token acts as that user, within their own data and permission rules. '
  + 'An upgrade asks for this approval again.';

export const EGRESS_SCOPES = ['web:read', 'model:complete', 'agent:run'];

export function egressReadWarning(scopes) {
  const out = scopes.filter((s) => EGRESS_SCOPES.includes(s));
  const reads = scopes.filter((s) => s.endsWith(':read') && s !== 'web:read');
  if (out.length === 0 || reads.length === 0) return '';
  return `Warning: with ${out.join(' and ')} and ${reads.join(', ')} together, this package can send what it reads anywhere. `
    + 'It is limited to data at protection level 1.';
}

export const AGENT_RUN_NOTE = 'agent:run starts background agent runs as the user who asks (from a write tool only): the host\'s own agent of a role, '
  + 'with web search, the user\'s knowledge and documents (no shell, messages or mail), unattended (nothing is asked; an ASK is refused), '
  + 'for up to 20 minutes and plugins.hostAgentRunTokens tokens a run, counted in the user\'s daily plugin allowance and spend budgets. '
  + 'The package gets only the run\'s id and its final text.';

export const DOCUMENTS_WRITE_NOTE = 'documents:write creates text documents in the user\'s Documents and updates the ones this package created, '
  + 'as that user, marked with the package and tool that made them.';

export function scopeNotes(scopes) {
  return [
    ...(scopes.includes('agent:run') ? [AGENT_RUN_NOTE] : []),
    ...(scopes.includes('documents:write') ? [DOCUMENTS_WRITE_NOTE] : []),
  ];
}

export const MODEL_CLI_TOOLS_APPROVAL = 'model:cli-tools';
export const MODEL_CLI_TOOLS_WARNING = 'Its model calls may run on CLI agents with their own tools (shell, files) as the Octipus server user; '
  + 'only approve if its prompts never carry outside data.';

const arr = (v) => (Array.isArray(v) ? v : []);

/** The effect of `tool` in `perm.tools`, or '?'. */
function effectOf(perm, tool, given) {
  if (given) return given;
  const t = arr(perm.tools).find((x) => x && x.name === tool);
  return t?.effect ?? '?';
}

function roles(r) {
  const list = Array.isArray(r) ? r : r ? [r] : null;
  return list && list.length ? `agents of the roles ${list.join(', ')}` : 'every agent';
}

/**
 * The sections of "What it asks for", each `{ id, title, items: [{ text, code?, tone? }] , notes: [] }`.
 * `tone` is 'warn' for what the admin page shows as a warning.
 */
export function asksFor(perm, { name } = {}) {
  const p = perm ?? {};
  const pluginName = name ?? p.name ?? '';
  const sections = [];

  const tools = arr(p.tools);
  sections.push({
    id: 'tools',
    title: 'Tools',
    lead: 'tools: ' + (tools.length ? tools.map((t) => `${t.name} (${t.effect})`).join(', ') : 'none'),
    items: tools.map((t) => ({ code: t.name, text: `${t.effect}: ${EFFECT_TEXT[t.effect] ?? 'an effect Octipus does not know; it is refused.'}`, tone: t.effect === 'external' ? 'warn' : undefined })),
    notes: [],
  });

  const network = arr(p.network);
  sections.push({
    id: 'network',
    title: 'Network',
    lead: `hosts: ${network.length ? network.join(', ') : 'none'}`,
    items: network.map((h) => ({ code: h })),
    notes: network.length
      ? ['The package reaches only these hosts, on 443 and 80 unless a port is given, through its own egress proxy; that is enforced under the sandbox.']
      : ['No network hosts: under the sandbox it has no network at all.'],
  });

  const host = arr(p.host);
  if (host.length) {
    const warning = egressReadWarning(host);
    sections.push({
      id: 'host',
      title: 'Host API',
      lead: `host API: ${host.join(', ')}`,
      items: host.map((s) => ({ code: s })),
      notes: [...(warning ? [{ text: warning, tone: 'warn' }] : []), ...scopeNotes(host), HOST_TOKEN_WHEN],
    });
  }

  const c = p.contributions ?? {};
  const items = [];
  for (const x of arr(c.commands)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `command /${x}` }); continue; }
    items.push({ text: `command /${x.name} → ${x.tool} (${effectOf(p, x.tool, x.effect)}), run as the user who types it${x.description ? `: ${x.description}` : ''}` });
  }
  for (const x of arr(c.schedules)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `schedule ${x}` }); continue; }
    items.push({ text: `schedule ${x.id} ${x.cron} (UTC) → ${x.tool} (${effectOf(p, x.tool, x.effect)}), run as the installing admin, unattended` });
  }
  for (const x of arr(c.events)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `on ${x}` }); continue; }
    items.push({ text: `on ${x.on} of every user → ${x.tool} (${effectOf(p, x.tool, x.effect)}), run as that user (ids only)` });
  }
  if (c.context) {
    const tool = typeof c.context === 'object' ? c.context.tool : c.context;
    items.push({
      text: `context: ${tool} (${effectOf(p, tool, c.context.effect)}) receives the message of every turn of every user — root agents and workers, ${roles(c.context.roles)} — and its answer is put in front of the agent`,
      tone: 'warn',
    });
  }
  if (c.prompt) {
    const file = typeof c.prompt === 'object' ? c.prompt.file : c.prompt;
    items.push({ text: `prompt: ${file} is added to the system prompt of ${roles(c.prompt.roles)}, for every user, fenced as third-party text` });
  }
  if (items.length) {
    sections.push({ id: 'contributions', title: 'Contributions', lead: 'What it adds besides tools; nothing of it is active until an admin approves it when enabling.', items, notes: [] });
  }

  const pages = Array.isArray(p.pages) ? p.pages : [];
  const pageCount = Array.isArray(p.pages) ? p.pages.length : typeof p.pages === 'number' ? p.pages : 0;
  if (pageCount > 0) {
    const labels = pages.length
      ? pages.map((pg) => (typeof pg === 'object' && pg ? `${pg.title ?? pg.path} (/plugins/${pluginName}/${pg.path ?? ''})` : String(pg)))
      : [`${pageCount} page${pageCount === 1 ? '' : 's'}`];
    sections.push({
      id: 'pages',
      title: 'Pages',
      lead: `pages: ${labels.join(', ')}`,
      items: [],
      notes: ['Its pages are added to the sidebar while it is enabled, and run in a sandboxed frame that reaches the package only through the page bridge.'],
    });
  }

  if (p.trustedInput) {
    const reason = typeof p.trustedInput === 'object' ? p.trustedInput.reason : p.trustedInputReason;
    sections.push({
      id: 'trustedInput',
      title: 'Model calls on CLI lanes',
      lead: `It declares model.trustedInput${reason ? ` ("${reason}")` : ''}, not approved: enabling leaves its model calls off CLI lanes.`,
      items: [],
      notes: [{ text: `If an admin approves ${MODEL_CLI_TOOLS_APPROVAL}: ${MODEL_CLI_TOOLS_WARNING}`, tone: 'warn' }],
    });
  }

  if (typeof p.maxProtection === 'number') {
    sections.push({
      id: 'maxProtection',
      title: 'Protection level',
      lead: `maxProtection ${p.maxProtection}: the highest protection level (1-4) of data it may see. A call from a conversation holding content above it is refused.`,
      items: [],
      notes: [],
    });
  }
  return sections;
}

/** The summary as plain lines (for the PR comment). */
export function asksForLines(perm, opts) {
  return asksFor(perm, opts).flatMap((s) => [
    s.lead,
    ...(s.id === 'contributions' ? s.items.map((i) => `  ${i.text}`) : []),
    ...s.notes.filter((n) => typeof n === 'object' && n.tone === 'warn').map((n) => n.text),
  ]);
}
