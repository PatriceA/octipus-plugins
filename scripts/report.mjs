// The report: what the `Plugin checks report` workflow (workflow_run, with
// the write token) posts on a pull request, for forks too. It imports no
// package (no npm ci in that job) and trusts nothing the checked pull
// request could have written (H5):
//   - the PR number, its changed files and the job outcomes come from
//     GitHub's event and API (the workflow passes them in);
//   - check-result.json, the `check` job's artifact, is read as data
//     (regular file, at most 1 MB), validated strictly, and the comment is
//     rendered here from it, every string escaped (M2);
//   - the paths outside plugins/<name>/ are computed here from the API's
//     file list, not from the artifact;
//   - labels are only ever added, never removed: a maintainer removes them.
import { ResultError, validateCheckResult } from './lib/check-result.mjs';
import { outsidePluginPaths } from './lib/paths.mjs';
import { readFileUnder } from './lib/safe-fs.mjs';
import { fence, renderSummary, SUMMARY_MARKER } from './lib/summary.mjs';

export const LABELS = {
  security: { name: 'needs-security-review', color: 'efa99b', description: 'A plugin asks for something new, wider or changed: a maintainer reviews it before merging' },
  maintainer: { name: 'needs-maintainer-review', color: 'd93f0b', description: 'Changes outside plugins/<name>/, or a check that could not be read: a maintainer reviews it before merging' },
};

/** The artifact's check-result.json under `dir`, as text, or null. */
export function readResult(dir) {
  try { return readFileUnder(dir, 'check-result.json', { encoding: 'utf8', maxBytes: 1024 * 1024 }); } catch { return null; }
}

/**
 * @param {object} a
 * @param {string|null} a.resultText the artifact's check-result.json, or null
 * @param {string[]} a.paths the pull request's changed paths (API: filename and previous_filename)
 * @param {boolean} a.filesTruncated the API listed its maximum (3000) files
 * @param {string} a.checkJob the `check` job's conclusion (API)
 * @param {string} a.testJob the `test` job's conclusion (API)
 * @returns {{ body: string, labels: string[] }}
 */
export function buildReport({ resultText, paths, filesTruncated = false, checkJob, testJob }) {
  const labels = new Set();
  const outside = outsidePluginPaths(paths);
  if (outside.length || filesTruncated) labels.add(LABELS.maintainer.name);
  let result = null;
  let invalid = null;
  if (resultText === null || resultText === undefined) invalid = 'the check job left no check-result.json';
  else {
    try { result = validateCheckResult(JSON.parse(resultText)); } catch (err) { invalid = err instanceof ResultError ? err.message : `not JSON (${err.message})`; }
  }
  // The job outcome and the result must agree; anything else is a maintainer's to look at.
  if (result && !((checkJob === 'success' && result.ok) || (checkJob === 'failure' && !result.ok))) invalid = `the check job concluded ${checkJob}, but its result says ${result.ok ? 'ok' : 'failed'}`;
  const run = { checkJob, testJob };
  if (invalid) {
    labels.add(LABELS.maintainer.name);
    const lines = [
      SUMMARY_MARKER, '## Plugin checks', '',
      `Data checks: **${checkJob}** · plugin tests and smoke run (sandboxed, no network): **${testJob}**`, '',
      '**The check result could not be used, so nothing here is checked:** a maintainer reviews this pull request by hand.', '',
      fence(invalid), '',
    ];
    if (outside.length) lines.push(`Changed outside \`plugins/<name>/\` (${outside.length}):`, '', fence(outside.slice(0, 500).join('\n')), '');
    return { body: `${lines.join('\n')}\n`, labels: [...labels] };
  }
  if (result.widened) labels.add(LABELS.security.name);
  const shown = { ...result, outside: outside.slice(0, 500), outsideTotal: outside.length + (filesTruncated ? 1 : 0), needsMaintainer: outside.length > 0 || filesTruncated };
  if (filesTruncated) shown.outside = [...shown.outside, '(the pull request has more files than the API lists: review all of it)'];
  return { body: renderSummary(shown, run), labels: [...labels] };
}
