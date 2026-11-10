// check-summary.md: what scripts/check.mjs found, as the PR comment.
import { asksForLines } from './asks-for.mjs';

/** The marker that tells the workflow which comment to refresh. */
export const SUMMARY_MARKER = '<!-- octipus-plugins:check-summary -->';

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const code = (s) => `\`${String(s).replaceAll('`', 'ˋ')}\``;

/**
 * @param {object[]} results one per plugin: { dir, name, version, publishedVersion, template, errors[], warnings[], steps[{ name, status, detail? }], permissions, diff }
 * @param {object} [opts] { octipusRef, sandbox }
 */
export function renderSummary(results, opts = {}) {
  const lines = [SUMMARY_MARKER, '## Plugin checks', ''];
  if (results.length === 0) {
    lines.push('No plugin changed in this pull request.', '');
    return `${lines.join('\n')}\n`;
  }
  const failed = results.filter((r) => r.errors.length > 0);
  const widened = results.filter((r) => r.diff?.widened);
  lines.push(
    failed.length ? `**${failed.length} of ${results.length} failed.**` : `**All ${results.length} passed.**`,
    '',
    widened.length
      ? `**Needs security review:** ${widened.map((r) => code(r.name ?? r.dir)).join(', ')} ${widened.length === 1 ? 'asks' : 'ask'} for something new or wider.`
      : 'Nothing asks for more than the published version.',
    '',
  );
  for (const r of results) {
    const title = r.name ? `${r.name} ${r.version ?? ''}`.trim() : r.dir;
    const state = r.errors.length ? 'failed' : 'passed';
    lines.push(`### ${code(title)}: ${state}${r.template ? ' (template)' : ''}`, '');
    if (r.publishedVersion) lines.push(`Published: ${code(r.publishedVersion)}.`, '');
    else if (!r.template) lines.push('Not published yet.', '');
    if (r.errors.length) {
      lines.push('**Problems**', '');
      for (const e of r.errors) lines.push(`- ${esc(e)}`);
      lines.push('');
    }
    if (r.warnings.length) {
      lines.push('**Warnings**', '');
      for (const w of r.warnings) lines.push(`- ${esc(w)}`);
      lines.push('');
    }
    if (r.steps?.length) {
      lines.push('| Check | Result |', '|---|---|');
      for (const s of r.steps) lines.push(`| ${esc(s.name)} | ${esc(s.status)}${s.detail ? `: ${esc(s.detail).replaceAll('|', '\\|').replaceAll('\n', ' ')}` : ''} |`);
      lines.push('');
    }
    if (r.diff && !r.template) {
      if (r.diff.firstVersion) {
        lines.push('**What it asks for** (a new plugin: all of it needs review)', '');
        for (const l of asksForLines(r.permissions, { name: r.name })) lines.push(`- ${esc(l)}`);
        lines.push('');
      } else if (r.diff.changes.length) {
        lines.push(`**Permissions since ${code(r.publishedVersion)}**`, '');
        for (const c of r.diff.changes) lines.push(`- ${c.widens ? '**wider**' : c.change}: ${esc(c.text)}`);
        lines.push('');
      } else {
        lines.push(`**Permissions:** unchanged since ${code(r.publishedVersion)}.`, '');
      }
    }
  }
  const foot = [];
  if (opts.octipusRef) foot.push(`Octipus CLI at ${code(opts.octipusRef)}`);
  if (opts.sandbox) foot.push(`smoke run: ${opts.sandbox}`);
  if (foot.length) lines.push(`<sub>${foot.join(' · ')}</sub>`, '');
  return `${lines.join('\n')}\n`;
}
