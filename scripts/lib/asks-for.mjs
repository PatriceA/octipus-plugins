// "What it asks for": a plugin's permissions in the words Octipus's own admin
// page uses (web/app/admin/plugins/page.tsx in PatriceA/octipus, and
// docs/PLUGIN-PACKAGES.md), so a listing on plugins.octipus.cc reads like the
// confirmation an admin sees when enabling the plugin. Keep these strings in
// step with that page; they are copied, not invented.
//
// The permissions are the CLI's (scripts/lib/permissions.mjs): each item
// says what it is bound to (a schedule's cron, tool and input, the prompt's
// sha256, a page's entry, the page files' hash), in the words of Octipus's
// install consent (src/shared/plugin-declarations.ts).
//
// Shared by the site (the plugin page) and the PR summary.
import { STORE_SCOPES, storeWords } from './permissions.mjs';

export const EFFECT_TEXT = {
  read: 'Reads only. Allowed by default; a user\'s rule can ask or deny.',
  write: 'Changes data in the connected system. Asks by default.',
  external: 'An effect outside the organisation: a payment, a message to a person, a post. Always asks; a rule can deny it but never allow it, and an unattended run is refused.',
};

export const HOST_TOKEN_WHEN = 'A call gets a short-lived token for them (at most 30 seconds, for that call only) only when a user starts it: '
  + 'a tool call of their own agent in their conversation, a slash command they type, or a button on the package\'s page. '
  + 'Schedules, events and context calls never get one. The token acts as that user, within their own data and permission rules. '
  + 'An upgrade asks for this approval again.';

export const EGRESS_SCOPES = ['web:read', 'model:complete', 'agent:run', 'mail:send'];

export function egressReadWarning(scopes) {
  const out = scopes.filter((s) => EGRESS_SCOPES.includes(s));
  // store:read reads back what the package itself stored, not the user's data.
  const reads = scopes.filter((s) => s.endsWith(':read') && s !== 'web:read' && s !== 'store:read');
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

export const MAIL_READ_NOTE = 'mail:read lists and reads the user\'s mail: the Mail module\'s mailboxes (each message at its own protection level) '
  + 'and the connected Gmail or Microsoft 365 inbox (counted as level 4: it carries no level). Messages above what the plugin may see stay hidden.';

export const MAIL_DRAFT_NOTE = 'mail:draft saves drafts as the user, marked with the plugin that wrote them. It never sends: the user reviews '
  + 'and sends a draft from Octipus or their mail app. A plugin that only drafts keeps its full protection level. '
  + 'A draft in the connected Gmail or Microsoft 365 inbox is stored at Google or Microsoft, like everything in that inbox.';

export const MAIL_SEND_NOTE = 'mail:send sends mail as the user to any address, from an external tool only (each call is asked about '
  + 'by the user\'s permission rules; a schedule or event never sends): one message per approved call, at most 20 an hour. '
  + 'What it sends leaves the house, so the plugin is limited to data at protection level 1.';

export const CALENDAR_NOTE = 'The calendars connected in Settings → Integrations (Google, Microsoft 365), in the personal workspace only. '
  + 'Events carry no protection level of their own: they count as the level an admin sets (plugins.calendarProtectionLevel, default 3). '
  + 'calendar:write adds events and changes only the ones this plugin added.';

export const STORE_NOTE = 'Octipus keeps this data for each user apart: the plugin only ever reaches the data of the user it acts for, never another user\'s. '
  + 'Each user can delete theirs in Settings → My plugin usage; uninstalling the plugin deletes everyone\'s.';

export function scopeNotes(scopes) {
  return [
    ...(scopes.includes('agent:run') ? [AGENT_RUN_NOTE] : []),
    ...(scopes.includes('documents:write') ? [DOCUMENTS_WRITE_NOTE] : []),
    ...(scopes.includes('mail:read') ? [MAIL_READ_NOTE] : []),
    ...(scopes.includes('mail:draft') ? [MAIL_DRAFT_NOTE] : []),
    ...(scopes.includes('mail:send') ? [MAIL_SEND_NOTE] : []),
    ...(scopes.includes('calendar:read') || scopes.includes('calendar:write') ? [CALENDAR_NOTE] : []),
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

  // Newer CLIs list the secrets and settings a package declares (names only).
  for (const [id, title, what] of [['secrets', 'Secrets', 'secrets'], ['settings', 'Settings', 'settings']]) {
    const names = arr(p[id]);
    if (names.length) sections.push({ id, title, lead: `${what}: ${names.join(', ')}`, items: names.map((n) => ({ code: n })), notes: [] });
  }

  // Newer CLIs print the per-user store ({ quotaBytes } or null; absent reads as none).
  if (p.store && typeof p.store === 'object' && Number.isSafeInteger(p.store.quotaBytes)) {
    const scopes = host.filter((s) => STORE_SCOPES.includes(s));
    sections.push({
      id: 'store',
      title: 'Store',
      lead: storeWords(p.store.quotaBytes),
      items: [{ text: `store: up to ${p.store.quotaBytes} bytes per user (${scopes.join(', ') || 'no store scope'})` }],
      notes: [STORE_NOTE],
    });
  }

  const c = p.contributions ?? {};
  const items = [];
  for (const x of arr(c.commands)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `command /${x}` }); continue; }
    const input = x.input !== undefined ? ` with ${JSON.stringify(x.input)}` : '';
    items.push({ text: `command /${x.name} → ${x.tool} (${effectOf(p, x.tool, x.effect)})${input}, run as the user who types it${x.description ? `: ${x.description}` : ''}` });
  }
  for (const x of arr(c.schedules)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `schedule ${x}` }); continue; }
    const input = x.input !== undefined ? ` with ${JSON.stringify(x.input)}` : '';
    items.push({ text: `schedule ${x.id} ${x.cron} (UTC) → ${x.tool} (${effectOf(p, x.tool, x.effect)})${input}, run as the installing admin, unattended` });
  }
  for (const x of arr(c.events)) {
    if (typeof x !== 'object' || !x) { items.push({ text: `on ${x}` }); continue; }
    items.push({ text: `on ${x.on} of every user → ${x.tool} (${effectOf(p, x.tool, x.effect)}), run as that user (ids only)` });
  }
  if (c.context && typeof c.context === 'object') {
    items.push({
      text: `context: ${c.context.tool} (${effectOf(p, c.context.tool, c.context.effect)}) receives the message of every turn of every user — root agents and workers, ${roles(c.context.roles)} — and its answer is put in front of the agent`,
      tone: 'warn',
    });
  }
  if (c.prompt && typeof c.prompt === 'object') {
    items.push({
      text: `prompt: ${c.prompt.file} is added to the system prompt of ${roles(c.prompt.roles)}, for every user, fenced as third-party text${c.prompt.sha256 ? ` (sha256 ${c.prompt.sha256})` : ''}`,
    });
  }
  if (items.length) {
    sections.push({ id: 'contributions', title: 'Contributions', lead: 'What it adds besides tools; nothing of it is active until an admin approves it when enabling.', items, notes: [] });
  }

  const pages = arr(p.pages).filter((pg) => pg && typeof pg === 'object');
  if (pages.length > 0) {
    sections.push({
      id: 'pages',
      title: 'Pages',
      lead: `pages: ${pages.map((pg) => `${pg.title} (/plugins/${pluginName}/${pg.path})`).join(', ')}`,
      items: [
        ...pages.map((pg) => ({ text: `Adds the page "${pg.title}": /${pg.path} → ${pg.entry}` })),
        ...(p.ui && typeof p.ui === 'object' ? [{ text: `Serves its page files: ${p.ui.dir}/${p.ui.sha256 ? `, sha256 ${p.ui.sha256}` : ''}` }] : []),
      ],
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
    ...(s.id === 'contributions' || s.id === 'pages' ? s.items.map((i) => `  ${i.text}`) : []),
    ...s.notes.filter((n) => typeof n === 'object' && n.tone === 'warn').map((n) => n.text),
  ]);
}
