// check-result.json: what the `check` job hands to the `report` workflow.
// The report holds a write token, so it trusts nothing in the artifact: it
// validates it with `validateCheckResult` (exact keys, types and sizes) and
// renders the comment itself (summary.mjs), with escaping. The PR number,
// the head commit and the job outcomes come from GitHub, never from here.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_STR = 4000;
const STATUSES = ['added', 'removed', 'wider', 'narrower', 'changed'];

export class ResultError extends Error {}

function exact(o, keys, at) {
  if (!isObj(o)) throw new ResultError(`${at}: not an object`);
  const have = Object.keys(o).sort().join(',');
  const want = [...keys].sort().join(',');
  if (have !== want) throw new ResultError(`${at}: keys ${have}, expected ${want}`);
}
const str = (v, at, { nullable = false, max = MAX_STR } = {}) => {
  if (nullable && v === null) return;
  if (typeof v !== 'string' || v.length > max) throw new ResultError(`${at}: not a string of at most ${max}`);
};
const bool = (v, at) => { if (typeof v !== 'boolean') throw new ResultError(`${at}: not a boolean`); };
const arr = (v, at, max, each) => {
  if (!Array.isArray(v) || v.length > max) throw new ResultError(`${at}: not a list of at most ${max}`);
  v.forEach((x, i) => each(x, `${at}[${i}]`));
};

const PLUGIN_KEYS = ['dir', 'name', 'version', 'publishedVersion', 'template', 'ok', 'widened', 'firstVersion', 'errors', 'warnings', 'steps', 'permissions', 'changes'];

/** Throws ResultError unless `r` is exactly a check-result.json v1; returns it. */
export function validateCheckResult(r) {
  exact(r, ['schema', 'kind', 'base', 'head', 'octipusRef', 'ok', 'widened', 'needsMaintainer', 'problems', 'outside', 'outsideTotal', 'plugins'], 'result');
  if (r.schema !== 1 || r.kind !== 'octipus-plugins-check') throw new ResultError('result: not a check result v1');
  for (const k of ['base', 'head', 'octipusRef']) if (typeof r[k] !== 'string' || !HEX40.test(r[k])) throw new ResultError(`result.${k}: not a 40-hex commit`);
  for (const k of ['ok', 'widened', 'needsMaintainer']) bool(r[k], `result.${k}`);
  arr(r.problems, 'result.problems', 200, (x, at) => str(x, at));
  arr(r.outside, 'result.outside', 500, (x, at) => str(x, at, { max: 1024 }));
  if (!Number.isSafeInteger(r.outsideTotal) || r.outsideTotal < r.outside.length) throw new ResultError('result.outsideTotal');
  arr(r.plugins, 'result.plugins', 100, (p, at) => {
    exact(p, PLUGIN_KEYS, at);
    str(p.dir, `${at}.dir`, { max: 200 });
    for (const k of ['name', 'version', 'publishedVersion']) str(p[k], `${at}.${k}`, { nullable: true, max: 200 });
    for (const k of ['template', 'ok', 'widened', 'firstVersion']) bool(p[k], `${at}.${k}`);
    arr(p.errors, `${at}.errors`, 200, (x, a) => str(x, a));
    arr(p.warnings, `${at}.warnings`, 200, (x, a) => str(x, a));
    arr(p.steps, `${at}.steps`, 50, (s, a) => { exact(s, ['name', 'status'], a); str(s.name, `${a}.name`, { max: 200 }); str(s.status, `${a}.status`, { max: 1000 }); });
    if (p.permissions !== null && !isObj(p.permissions)) throw new ResultError(`${at}.permissions`);
    if (p.permissions !== null && JSON.stringify(p.permissions).length > 100_000) throw new ResultError(`${at}.permissions: too large`);
    arr(p.changes, `${at}.changes`, 500, (c, a) => {
      exact(c, ['change', 'text', 'widens'], a);
      if (!STATUSES.includes(c.change)) throw new ResultError(`${a}.change`);
      str(c.text, `${a}.text`, { max: 1000 });
      bool(c.widens, `${a}.widens`);
    });
  });
  // The verdicts must follow from the details: a result cannot say ok over its own errors.
  const anyErrors = r.problems.length > 0 || r.plugins.some((p) => !p.ok || p.errors.length > 0);
  if (r.ok === anyErrors) throw new ResultError('result.ok contradicts its problems');
  if (r.plugins.some((p) => p.ok !== (p.errors.length === 0))) throw new ResultError('a plugin\'s ok contradicts its errors');
  if (r.widened !== r.plugins.some((p) => p.widened)) throw new ResultError('result.widened contradicts its plugins');
  if (r.needsMaintainer !== (r.outsideTotal > 0)) throw new ResultError('result.needsMaintainer contradicts outside');
  return r;
}
