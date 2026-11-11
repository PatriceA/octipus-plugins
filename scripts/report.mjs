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
//   - a pull request that changes anything outside plugins/<name>/ (its
//     workflows above all: on `pull_request` the checks run the workflow and
//     scripts of the pull request itself, so it writes its own artifact and
//     job outcomes) gets no verdict at all: "Not checked", both labels. That
//     decision is made from the API's file list before the artifact is read;
//   - labels are only ever added, never removed: a maintainer removes them.
import { ResultError, validateCheckResult } from './lib/check-result.mjs';
import { outsidePluginPaths } from './lib/paths.mjs';
import { readFileUnder } from './lib/safe-fs.mjs';
import { fence, renderSummary, SUMMARY_MARKER } from './lib/summary.mjs';

export const LABELS = {
  security: { name: 'needs-security-review', color: 'efa99b', description: 'A plugin asks for something new or wider, or files outside plugins/ change: a maintainer reviews it before merging' },
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
  // Decided from the API's list alone, before the artifact is read (review
  // finding 8): with any path outside plugins/<name>/, the checks ran code
  // the pull request may have changed, so nothing they say is shown.
  if (outside.length || filesTruncated) return notChecked(outside, filesTruncated);
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
    return { body: `${lines.join('\n')}\n`, labels: [...labels] };
  }
  if (result.widened) labels.add(LABELS.security.name);
  // Nothing is outside plugins/<name>/ (the API says so): the artifact's own outside list is not used.
  return { body: renderSummary({ ...result, outside: [], outsideTotal: 0, needsMaintainer: false }, run), labels: [...labels] };
}

/** The report for a pull request that changes files outside plugins/<name>/: no verdict, both labels. */
export function notChecked(outside, filesTruncated = false) {
  const shown = outside.slice(0, 500);
  if (outside.length > shown.length) shown.push(`… and ${outside.length - shown.length} more`);
  if (filesTruncated) shown.push('(the pull request has more files than the API lists: review all of it)');
  const lines = [
    SUMMARY_MARKER, '## Plugin checks', '',
    `**Not checked: this pull request changes repository files outside plugins/ (the ${outside.length}${filesTruncated ? '+' : ''} path(s) below). A maintainer must review it by hand.**`, '',
    'Its checks ran with the workflows and scripts of this pull request itself, so their results are not shown here.', '',
    fence(shown.join('\n')), '',
  ];
  return { body: `${lines.join('\n')}\n`, labels: [LABELS.maintainer.name, LABELS.security.name] };
}
