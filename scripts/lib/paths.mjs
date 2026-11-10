// Which changed paths are a plugin's and which need a maintainer (H5).
// No dependencies: the report workflow imports it without npm ci.

export const PLUGINS_DIR = 'plugins';

/** A plugin directory that is never published: `_template`, `.anything`. */
export function isSkipped(dirName) {
  return dirName.startsWith('_') || dirName.startsWith('.');
}

/** The plugin directory names touched by a list of changed paths (repo-relative, `/`-separated). */
export function changedPluginDirs(paths) {
  const out = new Set();
  for (const p of paths) {
    const m = /^plugins\/([^/]+)\//.exec(p);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * The changed paths that are not inside one publishable plugin directory
 * (`plugins/<name>/…`, `<name>` not starting with `_` or `.`): what needs a
 * maintainer's review (published.json, revoked.json, keys/, scripts/, site/,
 * the workflows, OCTIPUS_REF, package*.json, tests/, the template, …).
 */
export function outsidePluginPaths(paths) {
  return paths.filter((p) => {
    const m = /^plugins\/([^/]+)\/./.exec(p);
    return !m || isSkipped(m[1]);
  });
}
