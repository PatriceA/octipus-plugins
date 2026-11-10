// Index v2 (docs/plans/marketplace.md, "Index v2"): the v1 fields every host
// reads (name, version, description, url, sha256) plus the listing metadata,
// the CLI's permissions, apiVersion, minOctipus, the publisher, publishedAt,
// every published version, and the revocations of revoked.json.
//
// Pure: everything comes in as arguments, so the same inputs give the same
// bytes (the index is signed over its exact bytes).
import { sortSemverDesc } from './semver.mjs';

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
 * @param {string} [args.baseUrl]
 */
export function buildIndex({ published, sources, revoked, generatedAt, baseUrl = BASE_URL }) {
  const base = baseUrl.replace(/\/+$/, '');
  const packages = [];
  for (const name of Object.keys(published).sort()) {
    const versions = sortSemverDesc(Object.keys(published[name]));
    versions.forEach((version, i) => {
      const rec = published[name][version];
      const src = sources[name];
      const listing = src?.listing ?? rec.listing ?? {};
      const latest = i === 0;
      packages.push({
        name,
        version,
        description: rec.description ?? listing.summary ?? '',
        url: `${base}/dl/${tarballName(name, version)}`,
        sha256: rec.sha256,
        contentHash: rec.contentHash,
        apiVersion: rec.apiVersion ?? rec.permissions?.apiVersion ?? null,
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
        permissions: rec.permissions,
        deprecated: listing.deprecated ?? null,
      });
    });
  }
  return {
    schema: 2,
    generatedAt,
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
