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
keys/                      root/*.pub, signing/*.pub and endorsements.json (public halves only; keys/README.md)
revoked.json               revoked package versions and keys (append-only), published in the index
published.json             what is published (append-only, anchored to the signed index)
OCTIPUS_REF                the 40-hex Octipus commit whose CLI the scripts and CI use
scripts/                   check.mjs and test-plugins.mjs (PR gate), report.mjs (PR comment), build.mjs (CI build),
                           publish.mjs (build, finish), sign.mjs (the key session), keys.mjs (keys.json), stats.mjs
scripts/lib/               the pure parts, safe-fs.mjs (no links), git.mjs (trees from git objects), octi.mjs (the CLI)
site/                      the Astro site, in the octipus.cc design (site/src/design/)
.github/                   CODEOWNERS; workflows pr.yml, pr-report.yml, build.yml, site.yml, test.yml
```

## Trust, in one paragraph

Four boundaries are hard: the sandbox a host runs a plugin in, the
signatures, the listing matching the plugin that is downloaded, and the
runtime enforcement of what the plugin declared. Everything this repository
does to protect the **signatures** is hard too, and fails closed: no symbolic
link or submodule is ever accepted anywhere; `published.json` and
`revoked.json` only grow and must match the last signed index; the pull
request gate runs only the base branch's code; the key session runs only the
pinned Octipus CLI and a small dependency-free script; the signing keys are
the ones an offline root key endorses. The rest (a widened permission, a
lookalike name, an unknown licence) is guidance for the reviewer: a label, a
warning, a line in the checklist.

## The Octipus CLI is the single source of truth

Nothing here hashes, packs, signs or computes permissions itself. Every such
step calls `octi plugin <cmd>` from an Octipus checkout, through
[`scripts/lib/octi.mjs`](scripts/lib/octi.mjs) (and, in the key session,
[`scripts/sign.mjs`](scripts/sign.mjs)), one way only:

```sh
"$OCTIPUS/node_modules/.bin/tsx" --tsconfig "$OCTIPUS/tsconfig.json" "$OCTIPUS/scripts/plugin.ts" <cmd> …
```

- `$OCTIPUS` defaults to `../octipus`. Its HEAD must be exactly the 40-hex
  commit in [`OCTIPUS_REF`](OCTIPUS_REF) and `git status` must be empty;
  otherwise every script stops. Run `npm ci --ignore-scripts` in it.
- There is no override: `$OCTI_CLI` is refused, and `npx` is never used (it
  would fetch a missing `tsx` from the registry without asking).
- `OCTIPUS_REF` is a commit id, never a branch, tag or `refs/pull/…`. Moving
  it is a reviewed change (CODEOWNERS).
- `node_modules` of the Octipus checkout is not covered by the clean check
  (it is ignored by git): install it with `npm ci --ignore-scripts` from the
  pinned lockfile, on a machine you trust.

The commands used: `validate`, `hash`, `pack`, `permissions`, `verify`,
`verify-index`, `sign`, `sign-index`, `keygen`, and `sign-keys` for
keys.json (all offline, with `--json`).

`OCTIPUS_REF` pins the Octipus commit on `main` whose CLI every script
runs (49e577f3, the merge of the marketplace host side). `scripts/sign.mjs`
and `scripts/keys.mjs` refuse a CLI checkout that is not exactly that commit,
clean, and an ancestor of Octipus `origin/main`.

## How the CI works

### Pull requests: `pr.yml` and `pr-report.yml`

`pr.yml` has two jobs, both with a read-only token, for forks too:

- **`check`** (Check changed plugins (data only)) checks out the **base**
  commit's scripts into `base/`, the pull request's tree into `pr/` as data,
  and the Octipus CLI at the base's `OCTIPUS_REF`; it runs
  `base/scripts/check.mjs`. Nothing of the pull request runs: not its tests,
  its server, its scripts, schema or `OCTIPUS_REF`. It checks:
  1. no symbolic link or submodule anywhere in the pull request's tree;
  2. `published.json` and `revoked.json` against the base: no entry removed
     or changed; a record added to `published.json` must be exactly one the
     live signed index already has;
  3. for each changed plugin directory, exported from git (regular files
     only): `octipus-plugin.json` present (a legacy `plugin.json` is refused
     before `validate`, which would import its code), name and version rules
     (no reserved name, no build metadata), `octi plugin validate`, the
     listing schema and text rules, README and CHANGELOG present and within
     64 KB and 32 KB, no committed signature, no `dependencies`, no
     `in-process` runtime, the install limits, a version greater than the
     published one, and the permissions diff.
  It uploads only `check-result.json`.
- **`test`** (Plugin tests (sandboxed)) runs `base/scripts/test-plugins.mjs`:
  each changed plugin's `npm test --ignore-scripts` and a smoke run of its
  server (`initialize`, `tools/list`), both in bwrap with no network, a
  read-only system, and nothing of the runner's workspace. It passes or
  fails; it uploads nothing and nothing it prints reaches the report.

`pr-report.yml` runs on `workflow_run` from the default branch, with the
write token, and runs nothing of the pull request. It finds the pull request
from the event (head repository, branch and commit), lists its files and the
two jobs' outcomes through the API, downloads `check-result.json` as data,
validates it strictly ([`scripts/lib/check-result.mjs`](scripts/lib/check-result.mjs)),
and renders the comment itself ([`scripts/report.mjs`](scripts/report.mjs)):
every string from the pull request sits in a code span or a fenced block
longer than any backtick run in it. It adds labels and never removes them:

- `needs-security-review`: a plugin asks for something new or wider, by
  Octipus's own rules (`diffPermissions` in `src/shared/plugin-permissions.ts`,
  mirrored in [`scripts/lib/permissions.mjs`](scripts/lib/permissions.mjs)):
  a host scope, a network host, a tool or a secret; a wider tool effect, or
  one moved to `read` (no per-call approval any more: it can run
  unattended); a new or retargeted command; a schedule's tool or cron; an added event handler; a
  changed prompt file or text (its sha256); prompt or context roles that
  reach more agents; another context tool; an added or changed page; other
  page files (the `ui` hash); `trustedInput`; a higher `maxProtection`. A
  schedule's or a command's `input` alone, a setting, a removal or a
  narrowing is listed but does not add the label. (`secrets` and `settings`
  are read when the pinned CLI lists them, and as none when it does not.)
  A wildcard network host with fewer than three labels after the `*`
  (`*.github.io`, `*.co.uk`) is a warning;
- `needs-maintainer-review`: the pull request touches anything outside
  `plugins/<name>/` (`published.json`, `revoked.json`, `keys/`, `scripts/`,
  `site/`, the workflows, `OCTIPUS_REF`, `package*.json`, `tests/`, the
  template), or the check result is missing, invalid or contradicts its job.

A pull request can edit `pr.yml` itself: on `pull_request` the checks run the
pull request's own workflow and scripts, so their artifact and outcomes say
whatever it likes. So when the API's file list has any path outside
`plugins/<name>/`, the report shows no verdict at all: "Not checked: this
pull request changes repository files outside plugins/ … A maintainer must
review it by hand.", with both labels, decided before the artifact is read.
Code owners' review is what keeps such a change out of `main`.

Locally: `npm run check -- --plugin <name>` checks your commits against
`origin/main` (commit first: it reads git, not the working tree), and
`node scripts/test-plugins.mjs --plugin <name>` runs the sandboxed tests
(bwrap required).

### `main`: `build.yml`, and the rest

On every push to `main`, `build.yml` runs `scripts/build.mjs`: it exports
the commit's tree from git and packs every version `published.json` does not
have, recording `build-record.json` (`{ schema, commit, packages: [{ name,
version, sha256, contentHash }] }`) as the artifact `build-record`. CI holds
no key and never signs. `site.yml` builds the site on pull requests that
touch it, and `test.yml` runs `npm test`. Every `npm ci` runs with
`--ignore-scripts`; every action is pinned to a commit (checked against its
tag).

### Branch protection (turn it on)

In the repository settings, for `main`:

1. **Require a pull request before merging**, with at least one approval,
   **Require review from Code Owners**, and dismiss stale approvals on new
   commits. [`.github/CODEOWNERS`](.github/CODEOWNERS) assigns everything
   outside `plugins/<name>/` (and the template) to the maintainer.
2. **Require status checks to pass**: `Check changed plugins (data only)`
   and `Plugin tests (sandboxed)` (and `npm test` from `test.yml`), with the
   branch up to date.
3. Do not allow force pushes or deletions. If you keep pushing the publish
   commit (`published.json`) directly, allow only the maintainer to bypass;
   otherwise send it as a pull request: CI accepts its new records only when
   they match the live signed index.

## Publishing

Publishing is three steps; only the middle one holds a key.

```
npm run publish -- build          no key: plan, pack, compare with CI, index template   → release/
node scripts/sign.mjs …           the key session: pinned CLI only; asks, signs         → release/signed/
npm run publish -- finish …       no key: verify, published.json, the site              → dist/
```

### The keys

The marketplace has an offline **root** key (and a backup root) and
**signing** keys. Octipus ships only the root public keys; the root signs
`keys.json`, which endorses the signing keys; a signing key signs packages
and the index. See [keys/README.md](keys/README.md) for the layout and the
`keys.json` format.

Once:

1. Make the root key, a backup root and a signing key, each with its own
   passphrase, **outside this repository** (`octi plugin keygen <prefix>
   --passphrase-file -`). Keep both roots offline.
2. Put the public halves in `keys/root/` and `keys/signing/`, name the
   signing key in `keys/endorsements.json`, and merge that (code owners).
3. Keep a copy of the root public key(s) on the root key and publishing
   machines, outside the repository: `keys.mjs` and `sign.mjs` take the
   root from there (`--root-pub`, required), never from `keys/`, so a pull
   request cannot choose it.
4. In the root key session, from a clean `main` equal to `origin/main`:
   `node scripts/keys.mjs sign --first --root-pub <root.pub> --key
   <root.key>` (with `node`: it refuses npm). It shows what keys.json
   endorses and revokes against the published one, has you type each added
   key id, then signs through the pinned CLI. Deploy
   `release-keys/keys.json` and `keys.json.sig` to the site.

### Every release

1. Merge the reviewed pull requests and wait for **Build** on the merge
   commit.
2. **Build** (no key; Node from `.node-version`, `gh` logged in, Octipus at
   `OCTIPUS_REF` in `../octipus`):

   ```sh
   git switch main && git pull --ff-only
   npm ci --ignore-scripts
   npm run publish -- build
   ```

   It checks the worktree (clean, `main`, equal to `origin/main`) and the
   commit's tree (no link or submodule), and reads everything from a copy
   exported from git. It verifies the live `keys.json` with the root keys
   and the live `index.json` with an endorsed signing key, and refuses when
   `published.json` or `revoked.json` drops, changes or adds anything the
   signed index does not have, or when a record is malformed (name, `dir`,
   version, `commit` an ancestor of HEAD, canonical `signatureFile`). It
   packs each new version, compares it with CI's build record (a successful
   **push** run of `build.yml` on `main` for exactly this commit), rebuilds
   every published version byte for byte, and writes
   `release/release-plan.json`, the unsigned tarballs and the index
   template. It prints the git diff stat of everything outside the plugin
   directories since the last publish.

   `--index-from <file|url>` and `--keys-from <file|url>` replace the live
   files (tests); the first publish of all uses `--no-previous-index`.
   `--build-record <file>` and `--skip-ci-compare` bypass the CI compare only
   after you type `bypass the CI compare for <commit>`; the plan records it
   and `sign.mjs` shows it.
3. **Sign** (the key session): with `node`, never `npm` (npm would run a
   `presign` script and read the repository's `.npmrc`):

   ```sh
   node scripts/sign.mjs --plan release/release-plan.json \
     --key ~/octipus-keys/signing.key --root-pub ~/octipus-keys/root.pub
   ```

   `sign.mjs` imports only Node's built-ins and starts only git, `gh` (when
   installed) and the pinned CLI (HEAD exactly `OCTIPUS_REF`, clean, an
   ancestor of its `origin/main`). It verifies `keys.json` with your root key
   and the live index with an endorsed key, shows the diff stat outside the
   plugins, then for each package extracts the tarball (files and
   directories only) and checks name, version and content hash with the
   CLI. It trusts nothing in `release/` by itself (`build` ran npm packages
   on this machine): it exports `plugins/<name>` at the plan's commit from
   git's objects (as CI's build does: no checkout, no link) and hashes it
   with the pinned CLI, and takes CI's content hash from the build record of
   `build.yml`'s push run (through `gh`; without `gh`, it asks you to paste
   it from that run's log, or take it as `--ci-content-hash
   <name>@<version>=sha256:<hex>`; for a re-sign, from the last signed
   index). It signs only when git, the tarball, CI and the plan agree, shows
   them with the permissions, and asks you to type `sign <name> <version>`. It signs the
   extracted copy (the signature covers the content hash), verifies it, packs
   it again with its signature, fills the tarballs' sha256 and key id into
   the index, checks the index against the live one (nothing dropped or
   changed, no revocation undone), and asks before signing it. `--yes` skips
   the questions, with a loud banner. Read `git diff <last publish>..HEAD --
   scripts/sign.mjs` before a release when it changed.

   Why packing after signing is safe: the signature is over the content hash,
   and the signature file is the one file the content hash leaves out, so the
   signed tarball has the same content hash as the unsigned one that was
   compared with CI; `sign.mjs` checks that, and its sha256 goes into the
   index it then signs.
4. **Finish** (no key):

   ```sh
   npm run publish -- finish --plan release/release-plan.json [--stats stats.json]
   ```

   It verifies what sign wrote, adds the records to `published.json`, and
   assembles `dist/`: the tarballs, `index.json(.sig)`, `keys.json(.sig)`,
   the site, the listing images. It prints when the index and `keys.json`
   expire.
5. **Deploy** `dist/` as it is (`rsync -a --delete --filter 'P stats.json'
   dist/ <server>:/var/www/plugins.octipus.cc/`), and **commit and push
   `published.json`**.
6. **Republish at least weekly.** Octipus requires `expires` on the index
   and on `keys.json`. The index expires 30 days after `build`
   (`--index-expires-days`, at most 45: hosts refuse a longer life), and
   hosts warn their admins once the index they hold is more than 7 days
   old, so run the release again **at least weekly**, even with nothing
   new. `keys.json` expires 60 days after the root key signs it
   (`--expires-days`, at most 90): **renew it before it is 60 days old**
   (`build` warns when it expires before the index would). An expired one
   makes the whole marketplace unavailable to hosts. Scheduling both is the
   key holder's job: set reminders.

### Rotating a signing key

1. Make the new signing key, add it to `keys/signing/` and
   `keys/endorsements.json` beside the old one, and merge.
2. Root session: `node scripts/keys.mjs sign --root-pub <root.pub> --key
   <root.key>` (version + 1, both keys endorsed; type the new key id when
   asked, after checking it against your own record of the new key); deploy
   keys.json.
3. `npm run publish -- build --resign-to <new key id>`; `sign.mjs` with the
   new key re-signs every live version (same content hash, rebuilt
   reproducibly; revoked versions keep their old signature); finish; deploy.
4. Remove the old key from `signingKeys` and add it to `revokedKeys` in
   `keys/endorsements.json`, merge, root-sign keys.json again, deploy.

If the old key leaked, do steps 1-2 with the old key already revoked; the
last index then verifies only with the old key: pass
`--previous-keys-from <the older keys.json>` to build and sign (both say so
loudly).

### Revoking

Append the version (`{ "name", "version", "reason" }`) or key (`{ "keyId",
"reason" }`) to [`revoked.json`](revoked.json), merge, and publish: the index
carries it in `revoked`. A revocation is never removed: CI refuses it, and
publish refuses an index that would drop it.

### Download counts

`npm run stats -- [--out stats.json] /var/log/nginx/access.log*` counts the
`GET /dl/<name>-<version>.tar.gz` answered 200 per plugin into
`stats.json` (`{ generatedAt, downloads: { "<name>": n } }`), and keeps
nothing else (no address, user agent or time). Run it on the web server or
the deploy machine, never in the key session; serve it as
`/stats.json` (unsigned, display only), and pass it to `finish --stats` to
show the counts on the site.

### Serving the site

`dist/` is static: HTML, `/_astro/`, `/dl/*.tar.gz`, `/index.json(.sig)`,
`/keys.json(.sig)`, `/stats.json`, and listing images under `/<name>/`. No
cookies, no analytics, no external scripts; the only remote resource is the
Manrope font.

The CSP allows exactly the two inline scripts of `site/src/scripts/`, by
the hash of their source, and the build fails on any other script, `on*`
attribute or `javascript:` URL in a page. The build writes the headers to
`dist/_headers` and the CSP to `dist/csp.txt`. With nginx, `add_header` in a
`location` replaces every `add_header` of the server, so repeat the security
headers in each location that adds its own:

```nginx
# /etc/nginx/snippets/octipus-plugins-security.conf
add_header Content-Security-Policy "<contents of dist/csp.txt>" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header X-Frame-Options "DENY" always;
```

```nginx
server {
  listen 443 ssl;
  server_name plugins.octipus.cc;
  root /var/www/plugins.octipus.cc;
  include snippets/octipus-plugins-security.conf;

  location /dl/ {
    include snippets/octipus-plugins-security.conf;
    types { application/gzip gz; }
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }
  location ~ ^/(index|keys)\.json(\.sig)?$ {
    include snippets/octipus-plugins-security.conf;
    default_type application/json;
    types { application/json json sig; }
    add_header Cache-Control "public, max-age=300" always;
  }
  location = /stats.json {
    include snippets/octipus-plugins-security.conf;
    add_header Cache-Control "public, max-age=300" always;
  }
}
```

Take the CSP from `dist/csp.txt` after each publish (it changes only when
the scripts do).

## Index v2

`https://plugins.octipus.cc/index.json`, signed by `index.json.sig` over its
exact bytes. It is backward compatible: a v1 host reads `name`, `version`,
`description`, `url` and `sha256` and ignores the rest.

```json
{
  "schema": 2,
  "generatedAt": "2026-11-10T12:00:00Z",
  "expires": "2026-12-10T12:00:00Z",
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
      "contributions": {
        "commands": [{ "name": "review", "tool": "review" }],
        "schedules": [{ "id": "friday", "cron": "0 16 * * 5", "tool": "review", "input": { "days": 7 } }],
        "events": [],
        "prompt": { "file": "prompt.md", "sha256": "<hex of its bytes>", "roles": ["assistant"] },
        "context": null
      },
      "pages": [{ "path": "review", "title": "Weekly review", "entry": "index.html" }],
      "ui": { "dir": "ui", "sha256": "<hex>" },
      "trustedInput": false, "maxProtection": 1
    },
    "deprecated": null
  }],
  "revoked": [{ "name": "x", "version": "1.0.0", "reason": "…" }, { "keyId": "ed25519:…", "reason": "…" }]
}
```

- `permissions` is exactly what `octi plugin permissions --json` prints for
  the package, key for key and in its order: what each command, schedule
  and event is bound to (its tool; a schedule's cron and `input` when it has
  one), the prompt file's sha256 and roles, the context tool and roles,
  every page's path, title and entry, and the page files' hash (`ui`, null
  without pages); lists sorted, `roles` left out when there are none. A host
  recomputes it from the downloaded package and refuses an install when the
  two differ in anything; it refuses the old shape (`pages` a count,
  `prompt` a boolean) outright. `scripts/lib/permissions.mjs` checks the
  exact form wherever an index entry or a `published.json` record is made
  or read.
- `expires` is required: `generatedAt` + 30 days (`publish build
  --index-expires-days <n>`, at most 45; Octipus refuses an index without
  `expires` or with a longer life). A host refuses an expired index and
  warns its admins once the last index it accepted is more than 7 days old:
  the key holder publishes again (build, sign, finish; a release with
  nothing new only re-signs the index) at least weekly and always before
  `expires`. Nothing here schedules that: set yourself a reminder.
- Every published version is listed, newest first per plugin; `readme` and
  `changelog` ride on the newest entry of each plugin only (older entries
  have `null`), to keep the index far below a host's 1 MB cap.
- Listing metadata comes from the current `marketplace.json`, which can
  change without a new version. Icons and screenshots are always under
  `https://plugins.octipus.cc/<name>/`, tarballs under `/dl/` on the same
  origin, and `homepage` and `author.url` are https (the host drops
  anything else). README and CHANGELOG stay within 64 KB and 32 KB here (the
  host reads at most 200k and 100k characters).
- `keyId` is informational: a host takes the key from the signature.

## Developing

```sh
npm ci --ignore-scripts
npm test               # unit tests, the site, the security regressions, the PR gate, build/sign/finish end to end
npm run build:site     # the empty marketplace, into dist/
npm run dev:site
```

The integration tests need an Octipus checkout (`$OCTIPUS` or `../octipus`)
with `node_modules`. They never use it directly: `tests/octipus.mjs` clones
it at `OCTIPUS_REF` into a clean temporary checkout (while `OCTIPUS_REF` is
not on Octipus `main`, that clone's `origin/main` is set to it, so the
end-to-end test can sign). bwrap is needed for the
sandboxed-test test. The end-to-end test makes a temporary marketplace with
throwaway encrypted root and signing keys, publishes the reader fixture
twice, rotates the signing key, and replays the review's attacks.

The site's design (`site/src/design/`) is a stand-in for the octipus.cc
design source: see [its README](site/src/design/README.md).
