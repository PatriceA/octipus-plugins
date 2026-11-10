// The site's data: the signed index (index.json, index v2) that publish
// writes, read at build time from $MARKETPLACE_INDEX. Without it the site
// builds as an empty marketplace.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (set by astro.config.mjs; this file's location when run unbundled). */
export function repoRoot() {
  return process.env.OCTIPUS_PLUGINS_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
}

const schema = JSON.parse(readFileSync(join(repoRoot(), 'schema', 'marketplace.schema.json'), 'utf8'));

export const CATEGORY_LABELS = {
  productivity: 'Productivity',
  knowledge: 'Knowledge',
  writing: 'Writing',
  research: 'Research',
  communication: 'Communication',
  developer: 'Developer tools',
  data: 'Data',
  finance: 'Finance',
  business: 'Business',
  media: 'Media',
  integrations: 'Integrations',
  utilities: 'Utilities',
};

export const CATEGORIES = schema.properties.category.enum.map((id) => ({ id, label: CATEGORY_LABELS[id] ?? id }));

/** Semver order, newest first (numbers only; a pre-release sorts before its release). */
function cmp(a, b) {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return (a.includes('-') ? 1 : 0) - (b.includes('-') ? 1 : 0);
}

export function loadIndex(env = process.env) {
  const file = env.MARKETPLACE_INDEX;
  if (!file) return { schema: 2, packages: [], revoked: [] };
  if (!existsSync(file)) throw new Error(`MARKETPLACE_INDEX=${file}: no such file`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A URL on this site as a path ("https://plugins.octipus.cc/x/icon.png" → "/x/icon.png"). */
export function sitePath(url) {
  if (!url) return null;
  try { return new URL(url).pathname; } catch { return url.startsWith('/') ? url : null; }
}

/** The index's packages grouped per plugin: [{ name, latest, versions[], revokedKey }], by title. */
export function pluginsFrom(index) {
  const byName = new Map();
  for (const e of index.packages ?? []) {
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const revoked = index.revoked ?? [];
  const out = [];
  for (const [name, entries] of byName) {
    const versions = entries.sort((a, b) => cmp(a.version, b.version)).map((e) => ({
      ...e,
      revoked: revoked.find((r) => (r.name === name && r.version === e.version) || (r.keyId && r.keyId === e.keyId)) ?? null,
    }));
    const latest = versions.find((v) => !v.revoked) ?? versions[0];
    const withText = versions.find((v) => v.readme || v.changelog) ?? latest;
    out.push({
      name,
      latest,
      versions,
      readme: withText.readme ?? '',
      changelog: withText.changelog ?? '',
      icon: sitePath(latest.icon),
      screenshots: (latest.screenshots ?? []).map(sitePath).filter(Boolean),
      allRevoked: versions.every((v) => v.revoked),
    });
  }
  return out.sort((a, b) => (a.latest.title ?? a.name).localeCompare(b.latest.title ?? b.name));
}

/** The listing images a README may show: plugin-relative path → site path. */
export function readmeImages(plugin) {
  const map = {};
  for (const p of [plugin.icon, ...plugin.screenshots]) {
    if (!p) continue;
    const prefix = `/${plugin.name}/`;
    if (p.startsWith(prefix)) map[p.slice(prefix.length)] = p;
  }
  return map;
}
