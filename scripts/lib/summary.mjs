// The PR comment and step summary, rendered from check-result.json.
//
// Every string in a result can carry text from the pull request (a name, a
// path, a manifest value, the CLI's output about it), so none is written as
// Markdown (M2): a line goes in an inline code span, and several lines in a
// fenced code block, each delimited by more backticks than the longest run
// inside it, with control and bidi characters replaced. Nothing a pull
// request writes can close the fence, add a link, an image, a heading, a
// mention or HTML to the comment.
import { asksForLines } from './asks-for.mjs';

/** The marker that tells the report which comment to refresh. */
export const SUMMARY_MARKER = '<!-- octipus-plugins:check-summary -->';

const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Control, format (bidi, zero-width), private-use characters replaced by U+FFFD; tabs kept as spaces. */
function clean(s, { keepNewlines = false } = {}) {
  let t = String(s).replaceAll('\t', '  ').replaceAll('\r\n', '\n');
  if (keepNewlines) return t.split('\n').map((l) => l.replace(UNSAFE, '\uFFFD')).join('\n');
  t = t.replaceAll('\n', ' ');
  return t.replace(UNSAFE, '\uFFFD');
}

const longestRun = (s, ch) => Math.max(0, ...[...s.matchAll(new RegExp(`${ch === '`' ? '`' : '~'}+`, 'g'))].map((m) => m[0].length));

/** One line as an inline code span, whatever it contains. */
export function codeSpan(s, max = 300) {
  let t = clean(s);
  if (t.length > max) t = `${t.slice(0, max)}…`;
  if (t === '') return '` `';
  const ticks = '`'.repeat(longestRun(t, '`') + 1);
  const pad = t.startsWith('`') || t.endsWith('`') || t.startsWith(' ') || t.endsWith(' ') ? ' ' : '';
  return `${ticks}${pad}${t}${pad}${ticks}`;
}

/** Lines as a fenced code block, whatever they contain. */
export function fence(text, max = 6000) {
  let t = clean(text, { keepNewlines: true });
  if (t.length > max) t = `${t.slice(0, max)}\n… (cut: see the workflow log)`;
  const ticks = '`'.repeat(Math.max(3, longestRun(t, '`') + 1));
  return `${ticks}text\n${t}\n${ticks}`;
}

const list = (items) => items.map((i) => `- ${String(i).replaceAll('\n', '\n  ')}`).join('\n');

/**
 * @param {object} result check-result.json (scripts/lib/check-result.mjs)
 * @param {object} [run] what the report knows from GitHub, not from the artifact: { checkJob, testJob }
 */
export function renderSummary(result, run = {}) {
  const lines = [SUMMARY_MARKER, '## Plugin checks', ''];
  const plugins = result.plugins ?? [];
  if (run.checkJob || run.testJob) {
    lines.push(`Data checks: **${run.checkJob ?? 'unknown'}** · plugin tests and smoke run (sandboxed, no network): **${run.testJob ?? 'unknown'}**`, '');
  }
  if (result.problems?.length) {
    lines.push('**This pull request cannot be merged as it is:**', '', fence(list(result.problems)), '');
  }
  if (result.outside?.length) {
    lines.push(`**Needs maintainer review:** it changes ${result.outsideTotal ?? result.outside.length} path(s) outside \`plugins/<name>/\` (records, keys, scripts, site, workflows, OCTIPUS_REF, package files, tests or the template):`, '', fence(result.outside.join('\n')), '');
  }
  if (plugins.length === 0) {
    lines.push(result.outside?.length ? 'No plugin directory changed.' : 'Nothing changed.', '');
  } else {
    const failed = plugins.filter((r) => !r.ok);
    const widened = plugins.filter((r) => r.widened);
    lines.push(
      failed.length ? `**${failed.length} of ${plugins.length} plugin(s) failed.**` : `**All ${plugins.length} plugin(s) passed the data checks.**`,
      '',
      widened.length
        ? `**Needs security review:** ${widened.map((r) => codeSpan(r.name ?? r.dir)).join(', ')} ${widened.length === 1 ? 'asks' : 'ask'} for something new or wider (a changed command, schedule, prompt, context or page counts when it asks for more).`
        : 'Nothing asks for more than the published version.',
      '',
    );
  }
  for (const r of plugins) {
    const title = r.name ? `${r.name} ${r.version ?? ''}`.trim() : r.dir;
    lines.push(`### ${codeSpan(title)}: ${r.ok ? 'passed' : 'failed'}${r.template ? ' (template)' : ''}`, '');
    if (r.publishedVersion) lines.push(`Published: ${codeSpan(r.publishedVersion)}.`, '');
    else if (!r.template) lines.push('Not published yet.', '');
    if (r.errors.length) lines.push('**Problems**', '', fence(list(r.errors)), '');
    if (r.warnings.length) lines.push('**Warnings**', '', fence(list(r.warnings)), '');
    if (r.steps.length) lines.push('**Checks**', '', fence(r.steps.map((s) => `${s.name}: ${s.status}`).join('\n')), '');
    if (!r.template && r.permissions) {
      if (r.firstVersion) {
        lines.push('**What it asks for** (a new plugin: all of it needs review)', '', fence(asksForLines(r.permissions, { name: r.name }).join('\n')), '');
      } else if (r.changes.length) {
        lines.push(`**Permissions since ${codeSpan(r.publishedVersion ?? '?')}**`, '', fence(r.changes.map((c) => `${c.widens ? 'WIDER' : c.change}: ${c.text}`).join('\n')), '');
      } else {
        lines.push(`**Permissions:** unchanged since ${codeSpan(r.publishedVersion ?? '?')}.`, '');
      }
    }
  }
  const foot = [];
  if (result.octipusRef) foot.push(`Octipus CLI at ${codeSpan(result.octipusRef.slice(0, 12))}`);
  if (result.head) foot.push(`checked ${codeSpan(result.head.slice(0, 12))}`);
  if (foot.length) lines.push(`<sub>${foot.join(' · ')}</sub>`, '');
  let out = `${lines.join('\n')}\n`;
  if (out.length > 60_000) out = `${SUMMARY_MARKER}\n## Plugin checks\n\nThe summary is too long for a comment; read it in the workflow run's summary.\n`;
  return out;
}
