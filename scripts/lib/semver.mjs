// Semantic version order (semver.org §11), for "the new version is greater
// than the published one". Build metadata (+…) is ignored, a pre-release
// sorts before its release.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemver(v) {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export function isSemver(v) {
  return parseSemver(v) !== null;
}

/** -1, 0 or 1; throws on a version that is not semver. */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x) throw new Error(`not a semantic version: ${a}`);
  if (!y) throw new Error(`not a semantic version: ${b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/** The greatest of `versions`, or null for none. */
export function maxSemver(versions) {
  let best = null;
  for (const v of versions) if (best === null || compareSemver(v, best) > 0) best = v;
  return best;
}

/** Versions sorted newest first. */
export function sortSemverDesc(versions) {
  return [...versions].sort((a, b) => compareSemver(b, a));
}
