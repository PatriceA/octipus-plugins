// Text a listing shows: no bidi controls and nothing invisible (L5); a
// lookalike mix of scripts is a warning for the reviewer.

/** Bidi controls (Trojan Source), zero-width and other format characters, controls, private use, surrogates, line separators. */
const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u034F\u180E\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
/** Any space but the ASCII one. */
const ODD_SPACE = /[^\S ]|\p{Zs}/u;

/** Why `s` cannot be shown as a title, summary or name, or null. */
export function displayTextProblem(s) {
  if (typeof s !== 'string') return 'not a string';
  for (const ch of s) {
    if (ch === ' ') continue;
    if (HIDDEN.test(ch)) return `contains an invisible or bidi control character U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    if (ODD_SPACE.test(ch)) return `contains a space other than U+0020 (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`;
  }
  return null;
}

/**
 * A word mixing Latin with Cyrillic, Greek or another lookalike script, as a
 * lookalike name (Paypal with a Cyrillic "a", U+0430) is made: guidance for the
 * reviewer (a warning on the PR), not a refusal; names in other scripts are
 * legitimate.
 */
export function displayTextWarning(s) {
  if (typeof s !== 'string') return null;
  for (const word of s.split(/[\s\p{P}\p{S}]+/u)) {
    const latin = /\p{Script=Latin}/u.test(word);
    const other = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(word);
    if (latin && other) return `the word "${word}" mixes Latin with Cyrillic, Greek or another lookalike script: check it is not imitating another name`;
  }
  return null;
}

/** The README and CHANGELOG caps (bytes), in check and in publish (L5). */
export const TEXT_LIMITS = {
  readmeBytes: 64 * 1024,
  changelogBytes: 32 * 1024,
  listingBytes: 16 * 1024,
  manifestBytes: 256 * 1024,
};
