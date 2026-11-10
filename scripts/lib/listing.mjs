// marketplace.json: the schema check and the licence check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { REPO_ROOT } from './octi.mjs';

export const LISTING_FILE = 'marketplace.json';

export const listingSchema = JSON.parse(readFileSync(join(REPO_ROOT, 'schema', 'marketplace.schema.json'), 'utf8'));

export const CATEGORIES = listingSchema.properties.category.enum;

/** Open source licences a listing may name without a reviewer's note (SPDX ids). */
export const KNOWN_LICENSES = new Set([
  '0BSD', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0',
  'CC0-1.0', 'EPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'ISC',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MIT', 'MIT-0', 'MPL-2.0',
  'Unlicense', 'Zlib',
]);
const LICENSE_EXCEPTIONS = new Set(['Classpath-exception-2.0', 'LLVM-exception']);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(listingSchema);

function describeError(e) {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : 'marketplace.json';
  switch (e.keyword) {
    case 'additionalProperties': return `${where}: unknown field "${e.params.additionalProperty}"`;
    case 'required': return `${where}: missing "${e.params.missingProperty}"`;
    case 'enum': return `${where}: must be one of ${e.params.allowedValues.join(', ')}`;
    case 'maxLength': return `${where}: at most ${e.params.limit} characters`;
    case 'minLength': return `${where}: at least ${e.params.limit} characters`;
    case 'maxItems': return `${where}: at most ${e.params.limit} items`;
    default: return `${where}: ${e.message}`;
  }
}

/** Problems with a parsed marketplace.json (an empty list when it fits). */
export function checkListing(listing) {
  if (!validate(listing)) return validate.errors.map(describeError);
  return [];
}

/** Licence ids in an SPDX expression that are not on the known list (warnings, not errors). */
export function unknownLicenses(expr) {
  if (typeof expr !== 'string') return [];
  return expr.replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !['AND', 'OR', 'WITH'].includes(t))
    .filter((id) => !KNOWN_LICENSES.has(id) && !LICENSE_EXCEPTIONS.has(id));
}

/** The image files a listing names (icon first). */
export function listingImages(listing) {
  return [...(listing?.icon ? [listing.icon] : []), ...(listing?.screenshots ?? [])];
}
