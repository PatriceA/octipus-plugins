// Index v2 (docs/plans/marketplace.md, "Index v2"): the v1 fields every host
// reads (name, version, description, url, sha256) plus the listing metadata,
// the CLI's permissions (exactly as `octi plugin permissions --json` prints
// them: scripts/lib/permissions.mjs), apiVersion, minOctipus, the publisher, publishedAt,
// every published version, and the revocations of revoked.json.
//
// Pure: everything comes in as arguments, so the same inputs give the same
// bytes (the index is signed over its exact bytes).
import { assertPermissions } from './permissions.mjs';
import { sortSemverDesc } from './semver.mjs';
import { INDEX_MAX_DAYS } from '../sign.mjs';

export const BASE_URL = 'https://plugins.octipus.cc';
export const PUBLISHER = 'Octipus';

/** The tarball's file name. */
export function tarballName(name, version) {
  return `${name}-${version}.tar.gz`;
}

/** Where a listing image is served: `/<name>/<path in the plugin directory>`. */
export function assetPath(name, file) {
  return `/${name}/${file}`;
}

/**
 * @param {object} args
 * @param {Record<string, Record<string, object>>} args.published name → version → record
 * @param {Record<string, { listing: object, readme: string, changelog: string }>} args.sources
 *   the current listing, README and CHANGELOG of each plugin (a plugin whose
 *   source is gone falls back to the listing recorded when it was published)
 * @param {{ packages: object[], keys: object[] }} args.revoked
 * @param {string} args.generatedAt ISO time
 * @param {string} args.expires ISO time after which hosts refuse the index
 *   (publish sets generatedAt + 30 days): required, at most 45 days after
 *   generatedAt (Octipus refuses an index without it, or with a longer life)
 * @param {string} [args.baseUrl]
 */
export function buildIndex({ published, sources, revoked, generatedAt, expires, baseUrl = BASE_URL }) {
  const life = typeof expires === 'string' ? Date.parse(expires) - Date.parse(generatedAt) : Number.NaN;
  if (!(life > 0)) throw new Error(`the index's expires (${expires}) must be a time after generatedAt (${generatedAt})`);
  if (life > INDEX_MAX_DAYS * 86_400_000) throw new Error(`the index's expires (${expires}) is more than ${INDEX_MAX_DAYS} days after generatedAt: hosts refuse it`);
  const base = baseUrl.replace(/\/+$/, '');
  const packages = [];
  for (const name of Object.keys(published).sort()) {
    const versions = sortSemverDesc(Object.keys(published[name]));
    versions.forEach((version, i) => {
      const rec = published[name][version];
      const src = sources[name];
      const listing = src?.listing ?? rec.listing ?? {};
      const latest = i === 0;
      // The CLI's object, exactly: a host refuses any other shape, and an
      // entry whose permissions are not its own name, version and apiVersion.
      const permissions = assertPermissions(rec.permissions, `${name} ${version}: permissions`);
      const apiVersion = rec.apiVersion ?? permissions.apiVersion;
      if (permissions.name !== name || permissions.version !== version || permissions.apiVersion !== apiVersion) {
        throw new Error(`${name} ${version}: permissions are for ${permissions.name} ${permissions.version} (apiVersion ${permissions.apiVersion}), not the entry's (apiVersion ${apiVersion})`);
      }
      packages.push({
        name,
        version,
        description: rec.description ?? listing.summary ?? '',
        url: `${base}/dl/${tarballName(name, version)}`,
        sha256: rec.sha256,
        contentHash: rec.contentHash,
        apiVersion,
        minOctipus: rec.minOctipus ?? null,
        title: listing.title ?? name,
        summary: listing.summary ?? '',
        category: listing.category ?? null,
        tags: listing.tags ?? [],
        icon: listing.icon ? `${base}${assetPath(name, listing.icon)}` : null,
        screenshots: (listing.screenshots ?? []).map((s) => `${base}${assetPath(name, s)}`),
        homepage: listing.homepage ?? null,
        author: listing.author ?? null,
        // The README and the changelog (which covers every version) ride on
        // the newest entry only, so the index stays far below a host's 1 MB cap.
        readme: latest ? (src?.readme ?? null) : null,
        changelog: latest ? (src?.changelog ?? null) : null,
        publisher: PUBLISHER,
        license: listing.license ?? null,
        publishedAt: rec.publishedAt,
        keyId: rec.keyId ?? null,
        permissions,
        deprecated: listing.deprecated ?? null,
      });
    });
  }
  return {
    schema: 2,
    generatedAt,
    expires,
    publisher: PUBLISHER,
    url: `${base}/index.json`,
    packages,
    revoked: [
      ...revoked.packages.map((p) => ({ name: p.name, version: p.version, reason: p.reason })),
      ...revoked.keys.map((k) => ({ keyId: k.keyId, reason: k.reason })),
    ],
  };
}

/** The index as the exact bytes that are signed and served. */
export function serializeIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Whether `name@version` is revoked in an index's `revoked` list. */
export function isRevoked(index, name, version, keyId) {
  return (index.revoked ?? []).find((r) => (r.name === name && r.version === version) || (keyId && r.keyId === keyId)) ?? null;
}
