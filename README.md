# octipus-plugins

The Octipus plugin marketplace: reviewed plugin packages, the checks they go
through, the command that signs and publishes them, and the static site
[plugins.octipus.cc](https://plugins.octipus.cc), which serves the signed
index and the tarballs that Octipus hosts install from.

The marketplace launches **empty**. Octipus's example plugins (`reader`,
`research`) stay in Octipus only; a copy of `reader` lives under
`tests/fixtures/` for the tests and is never published.

The design is in [docs/plans/marketplace.md](https://github.com/PatriceA/octipus/blob/main/docs/plans/marketplace.md)
in the Octipus repository; the package format, signatures and registries in
[docs/PLUGIN-PACKAGES.md](https://github.com/PatriceA/octipus/blob/main/docs/PLUGIN-PACKAGES.md).

```
plugins/<name>/            one plugin each: manifest, server, ui/, tests, README.md, CHANGELOG.md, marketplace.json
plugins/_template/         the starting point (anything starting with _ is never published)
schema/                    marketplace.schema.json, the listing schema
keys/                      octipus.pub and octipus-backup.pub (public halves only)
revoked.json               revoked package versions and keys, published in the index
published.json             what is published: name → version → { sha256, contentHash, permissions, publishedAt, … }
OCTIPUS_REF                the Octipus commit whose CLI the scripts and CI use
scripts/                   check.mjs (PR checks), build.mjs (CI build), publish.mjs (signing and output)
scripts/lib/               the pure parts (permissions diff, semver, schema, index v2) and octi.mjs, the CLI wrapper
site/                      the Astro site, in the octipus.cc design (site/src/design/)
.github/workflows/         pr.yml, build.yml, site.yml, test.yml
```

## The Octipus CLI is the single source of truth

Nothing here hashes, packs, signs or computes permissions itself. Every such
step calls `octi plugin <cmd>` from an Octipus checkout, through one wrapper,
[`scripts/lib/octi.mjs`](scripts/lib/octi.mjs):

```sh
npx --prefix "$OCTIPUS" tsx --tsconfig "$OCTIPUS/tsconfig.json" "$OCTIPUS/scripts/plugin.ts" <cmd> …
```

- **Locally** `$OCTIPUS` defaults to `../octipus` (a checkout next to this
  one, with `npm ci` run in it). `$OCTI_CLI` replaces the whole command, e.g.
  `OCTI_CLI="octi plugin"` for an installed Octipus.
- **In CI** the workflows check out PatriceA/octipus at the ref in
  [`OCTIPUS_REF`](OCTIPUS_REF), run `npm ci` in it and point `$OCTIPUS` at it.
  Pin `OCTIPUS_REF` to a commit; moving it is a reviewed change.

The commands used: `validate`, `hash`, `pack`, `permissions`, `verify`,
`verify-index`, `sign`, `sign-index`, `keygen` (all offline, all with
`--json`).

## How the CI works

**On a pull request** (`pr.yml`), `scripts/check.mjs` checks each plugin the
pull request changes:

1. `octi plugin validate`, the `marketplace.json` schema, `README.md` and a
   `CHANGELOG.md` heading for the version, no committed signature, no
   `dependencies`;
2. the plugin's own tests (`npm test` in its directory, when it has a test
   script);
3. a smoke run: its server is started under bwrap (no network, a read-only
   view, its data directory the only writable place), and must answer
   `initialize` and `tools/list` with its declared tools. Without bwrap it
   runs plain, with a warning;
4. the host's install limits: 20,000 files, 200 MB unpacked, a 50 MB tarball;
5. `runtime: in-process` is refused;
6. the version must be greater than the published one (`published.json`),
   and a published version can never change content;
7. the **permissions diff** against the published version's permissions:
   new or wider host scopes, network hosts, tool effects, contributions,
   pages, `trustedInput`, `maxProtection` and the runtime. A new plugin is all
   new.

The summary (`check-summary.md`) is posted as one comment on the pull request
and refreshed on every push. When anything widens, the label
`needs-security-review` is added (and removed again when nothing does). The
job that runs the pull request's code has a read-only token; a second job,
which runs none of it, comments and labels. A pull request from a fork cannot
comment, so its summary is in the job log and the job summary.

Run it locally: `npm run check -- --plugin <name> --smoke` (or `--all`, or
`--base origin/main` for what changed).

**On a push to `main`** (`build.yml`), `scripts/build.mjs` packs every plugin
version that `published.json` does not have yet and uploads the artifact
`build-record` (`build-record.json`: `{ commit, packages: [{ name, version,
sha256, contentHash }] }`). CI holds no key and never signs or publishes.

**`site.yml`** builds the site on pull requests that touch it, and
**`test.yml`** runs `npm test`.

## Publishing (the key holder)

Publishing happens only on the publishing machine. The private key never
goes to GitHub or to the web server.

### Once: the keys

1. Generate the active key and the backup key, each with its own
   passphrase, **outside this repository**:

   ```sh
   cd ~/octipus-keys            # not inside any checkout
   octi plugin keygen octipus --passphrase-file -          # type the passphrase, then Ctrl-D
   octi plugin keygen octipus-backup --passphrase-file -
   ```

   (Or with the checkout: `npx --prefix ../octipus tsx --tsconfig ../octipus/tsconfig.json ../octipus/scripts/plugin.ts keygen …`.)
   Each writes `<name>.key` (passphrase-encrypted PKCS#8, mode 0600) and
   `<name>.pub`, and prints the key id.
2. Copy the two **public** files into `keys/` here, as `keys/octipus.pub` and
   `keys/octipus-backup.pub`, and commit them.
3. Move `octipus-backup.key` **offline** (a password manager, a USB stick in
   a drawer) with its passphrase, and delete it from the machine. It is only
   for replacing a lost or leaked active key.
4. Give both `.pub` files to Octipus's built-in `trustedPublishers` entry for
   the marketplace.

### Every release

1. Merge the reviewed pull requests to `main`, and wait for the **Build**
   workflow on the merge commit to finish.
2. On the publishing machine, with **Node 24 (the version in
   `.node-version`, as CI)**, `gh` logged in, and Octipus checked out at
   `OCTIPUS_REF` next to this repository:

   ```sh
   git switch main && git pull --ff-only
   npm ci
   npm run publish -- --key ~/octipus-keys/octipus.key
   ```

   It asks for the passphrase once (or pass `--passphrase-file <path|->`).
   Publish:
   1. checks the worktree is clean, on `main`, and equal to `origin/main`;
   2. finds the new versions (not in `published.json`);
   3. packs each from the committed tree and **compares** it with CI's
      `build-record.json` for that commit (fetched with `gh run download`;
      without `gh`, pass `--build-record <file>`; `--skip-ci-compare` skips it
      with a loud warning). Any difference stops it;
   4. signs the package copy (so the tarball carries `octipus-plugin.sig`)
      and verifies it against `keys/octipus.pub`;
   5. writes `dist/dl/<name>-<version>.tar.gz`, and rebuilds every older
      version's tarball from its recorded commit and signature, checking it
      is byte for byte the published one;
   6. builds `index.json` (index v2, below);
   7. signs it (`index.json.sig`) and verifies it against `keys/`;
   8. updates `published.json`;
   9. builds the site into `dist/`;
   10. prints what to deploy and commit.

   `--dry-run` does all of it except signing and writing `published.json`
   (do not deploy its output). `--out <dir>` changes the output directory.
   It refuses a key file inside the repository and an unencrypted key, and it
   never pushes or uploads anything.
3. **Deploy `dist/`** to the web server for plugins.octipus.cc, as it is
   (e.g. `rsync -a --delete dist/ <server>:/var/www/plugins.octipus.cc/`).
4. **Commit and push `published.json`**:
   `git add published.json && git commit -m "Publish <name> <version>" && git push`.

That signature is the sign-off: a merged version is not installable from the
marketplace until it is published.

### Revoking

Add the version (`{ "name", "version", "reason" }`) or key
(`{ "keyId", "reason" }`) to [`revoked.json`](revoked.json), commit, and
publish: the index carries it in `revoked`, and hosts refuse the version or
key at install and at start. If the active key leaked, publish with the
backup key and a new active key (and update `keys/`).

### Serving the site

`dist/` is static: HTML, `/_astro/` assets, `/dl/*.tar.gz`, `/index.json`,
`/index.json.sig`, `/keys/*.pub`, and the listing images under `/<name>/`.

- **No cookies, no analytics, no external scripts.** The only remote
  resource is the Manrope font from Google Fonts.
- **The CSP**: the build writes it to `dist/_headers` (the `_headers` format)
  and `dist/csp.txt`. It allows the site's own files, its two inline
  scripts by hash, and Google Fonts only:

  ```
  default-src 'none'; script-src 'self' 'sha256-…'; style-src 'self' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; manifest-src 'self';
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  ```

  Take the exact value from `dist/csp.txt` after each publish (the script
  hashes change only when the scripts do). With nginx:

  ```nginx
  add_header Content-Security-Policy "<contents of csp.txt>" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  location /dl/ { types { application/gzip gz; } add_header Cache-Control "public, max-age=31536000, immutable"; }
  location = /index.json { add_header Cache-Control "public, max-age=300"; }
  location = /index.json.sig { default_type application/json; add_header Cache-Control "public, max-age=300"; }
  ```

## Index v2

`https://plugins.octipus.cc/index.json`, signed by `index.json.sig` over its
exact bytes. It is backward compatible: a v1 host reads `name`, `version`,
`description`, `url` and `sha256` and ignores the rest.

```json
{
  "schema": 2,
  "generatedAt": "2026-11-10T12:00:00Z",
  "publisher": "Octipus",
  "url": "https://plugins.octipus.cc/index.json",
  "packages": [{
    "name": "weekly-review", "version": "1.2.0", "description": "…",
    "url": "https://plugins.octipus.cc/dl/weekly-review-1.2.0.tar.gz",
    "sha256": "<hex>", "contentHash": "sha256:<hex>", "apiVersion": "1.0.0", "minOctipus": "0.7.0",
    "title": "Weekly review", "summary": "…", "category": "productivity", "tags": ["tasks", "notes"],
    "icon": "https://plugins.octipus.cc/weekly-review/icon.png", "screenshots": ["…"],
    "homepage": "https://…", "author": { "name": "…", "url": "https://…" },
    "readme": "…", "changelog": "…",
    "publisher": "Octipus", "license": "MIT", "publishedAt": "…", "keyId": "ed25519:<hex>",
    "permissions": {
      "name": "weekly-review", "version": "1.2.0", "apiVersion": "1.0.0", "runtime": "package",
      "host": ["notes:write", "tasks:read"], "network": [],
      "tools": [{ "name": "review", "effect": "read" }, { "name": "save", "effect": "write" }],
      "effects": { "read": 1, "write": 1, "external": 0 },
      "contributions": { "commands": [], "schedules": [{ "id": "friday", "cron": "0 16 * * 5", "tool": "review" }], "events": [], "prompt": false, "context": false },
      "pages": 1, "trustedInput": false, "maxProtection": 1
    },
    "deprecated": null
  }],
  "revoked": [{ "name": "x", "version": "1.0.0", "reason": "…" }, { "keyId": "ed25519:…", "reason": "…" }]
}
```

- `permissions` is exactly what `octi plugin permissions --json` prints for
  the package (contributions is an object, `effects` has all three counts),
  so a host can recompute it from the downloaded manifest and refuse an
  install when the two differ.
- Every published version is listed, newest first per plugin; `readme` and
  `changelog` ride on the newest entry of each plugin only (older entries
  have `null`), to keep the index far below a host's 1 MB cap.
- Listing metadata comes from the current `marketplace.json`, which can
  change without a new version.

## Developing

```sh
npm ci
npm test               # unit tests, the site build with fixtures, the end-to-end publish test
npm run build:site     # the empty marketplace, into dist/
npm run dev:site
```

The end-to-end test needs the Octipus checkout (`$OCTIPUS` or `../octipus`)
with the CLI commands above; it makes a temporary marketplace repository, a
throwaway encrypted key and publishes the reader fixture twice.

The site's design (`site/src/design/`) is a stand-in for the octipus.cc
design source: see [its README](site/src/design/README.md).
