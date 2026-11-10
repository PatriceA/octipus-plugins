// Where the navigation points: back to octipus.cc, its docs and GitHub, with
// Plugins (this site) as the current entry.
export const OCTIPUS = 'https://octipus.cc/';
export const DOCS = 'https://octipus.cc/docs/';
export const GITHUB = 'https://github.com/PatriceA/octipus';
export const LICENSE = 'https://github.com/PatriceA/octipus/blob/main/LICENSE';
export const MARKET_REPO = 'https://github.com/PatriceA/octipus-plugins';
export const CONTRIBUTING = 'https://github.com/PatriceA/octipus-plugins/blob/main/CONTRIBUTING.md';

/** The main navigation, as on octipus.cc (`ocean-navigation`), with Plugins current. */
export const NAV = [
  { href: OCTIPUS, label: 'Octipus', mobile: 'Octipus home' },
  { href: DOCS, label: 'Docs ↗', mobile: 'Documentation ↗' },
  { href: GITHUB, label: 'GitHub ↗', mobile: 'GitHub ↗' },
  { href: '/', label: 'Plugins', mobile: 'Plugins', current: true },
];
