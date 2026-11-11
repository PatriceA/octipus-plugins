# Contributing a plugin

Anyone can propose a plugin for the Octipus marketplace. You send its
**source** as a pull request; CI checks it and posts what it asks for; a
maintainer reviews it; and the key holder signs each version on publishing.
**That signature is the sign-off:** until it exists, no Octipus host installs
the version from the marketplace, merged or not. You need no key.

## 1. Start from the template

Copy [`plugins/_template/`](plugins/_template/) to `plugins/<name>/`, where
`<name>` is your plugin's name (lower case, `a-z0-9-`, 2-50 characters). The
directory and the manifest's `name` must match. Directories starting with
`_` are never published.

A submission is one directory with:

| File | What it is |
|---|---|
| `octipus-plugin.json` | The manifest: name, version, `apiVersion`, server, tools and their effects, network hosts, host scopes ([the package format](https://github.com/PatriceA/octipus/blob/main/docs/PLUGIN-PACKAGES.md)). |
| the server, `ui/`, tests | Its code. A `package.json` with a `test` script, when it has tests (CI runs `npm test`). |
| `README.md` | What it does, how to set it up, the secrets it needs. |
| `CHANGELOG.md` | A heading for every version (`## 1.2.0`). |
| `marketplace.json` | The listing: title, summary, category, tags, icon, screenshots, homepage, licence, author, `minOctipus` ([schema](schema/marketplace.schema.json)). It is not part of the package, so it can change without a new version. |

Everything in the directory except `marketplace.json` is the package: it is
what gets packed, hashed and signed, and what a host installs. The icon and
screenshots you name in `marketplace.json` live in the directory too.

## 2. The rules

- **Source, never a prebuilt tarball.** Publishing rebuilds the package from
  the reviewed source and checks the hash, so what is signed is what was
  reviewed.
- **Dependency-free or vendored code.** A package installs as it is: no
  `npm install` runs on the host. Vendor what you need, or bundle the server
  into one file. A `package.json` may hold scripts, not `dependencies`.
- **No `in-process` runtime.** The marketplace carries sandboxed packages
  only; in-process plugins stay a deliberate local install.
- **The narrowest true tool effects.** `read` for what only reads, `write` for
  what changes data in the connected system, `external` for what reaches
  outside the organisation (a payment, a message to a person, a post).
  Never declare a tool lower than what it does.
- **Every network host declared.** Name each host your server talks to, as
  narrowly as you can (`api.example.com` rather than `*.example.com`). Under
  the sandbox it reaches nothing else.
- **An honest `model.trustedInput` reason, or none at all.** Declare it only
  when your `model:complete` prompts never carry outside data, and say why.
- **Runtime state in `OCTIPUS_PLUGIN_DATA_DIR`**, never in the package
  directory (it is read-only under the sandbox and pinned by hash).
- **Per-user data in the store, never in the data directory.** The data
  directory is shared by every user of an install. What belongs to one user
  goes in the per-user store: declare `store` (`{}` for the default 5 MB per
  user, or `{ "quotaBytes": … }`, 1 KB to 20 MB) with the host scopes
  `store:read` and/or `store:write` (a write scope: only `write` and
  `external` tools get it), and ask for no more quota than you need. The
  store needs an `OCTIPUS_REF` with it (Octipus's per-user store); until
  then `octi plugin validate` refuses `store`.
- **No `octipus-plugin.sig`** in the submission: the key holder signs.
- **Regular files only.** A symbolic link or a submodule anywhere in the
  pull request fails it, as does a legacy plugin (`plugin.json` without
  `octipus-plugin.json`: convert it with `octi plugin convert`).
- **A plain version** (`1.2.0`, `1.2.0-rc.1`), never with build metadata
  (`1.2.0+x` would compare equal to `1.2.0`), and a name that is not reserved
  (`keys`, `dl`, `publish`, `index`, … are paths of the site).
- **A plain title, summary and author name:** no bidi controls or invisible
  characters (refused); a word mixing Latin with a lookalike script is
  flagged for the reviewer.
- **README.md at most 64 KB, CHANGELOG.md at most 32 KB:** they ride in the
  signed index, which a host reads up to 1 MB.
- **A new version for every change** to the package. A version is never
  republished with other content, and a new version is greater than the
  published one. `marketplace.json` alone can change without a version bump.
- **Size:** at most 20,000 files and 200 MB unpacked, and a tarball under
  50 MB; an icon under 256 KB, at most 6 screenshots of under 1 MB each.
- **An open source licence**, as an SPDX id in `marketplace.json`.

## 3. Check it locally

You need Node 24 and a checkout of
[Octipus](https://github.com/PatriceA/octipus) next to this repository
(`../octipus`, at the commit in `OCTIPUS_REF`, clean, with
`npm ci --ignore-scripts` run in it), or `OCTIPUS` pointing at one:

```sh
npm ci --ignore-scripts
git commit …                                         # the check reads your commits, not the working tree
npm run check -- --plugin <name>                     # the data checks, as CI's `check` job
node scripts/test-plugins.mjs --plugin <name>        # your tests and a smoke run, in bwrap, as CI's `test` job
```

The first runs `octi plugin validate`, the `marketplace.json` schema and text
rules, the README and changelog, the size limits, the version against
`published.json`, and the permissions summary, and writes
`check-summary.md`. The second runs `npm test --ignore-scripts` and starts
your server (`initialize`, `tools/list`) in a bwrap sandbox with no network
and a read-only system: your tests must not need the network or write
outside their own directory and `/tmp`.

## 4. Open the pull request

CI checks your pull request with the base branch's scripts, never the ones
in your pull request, and posts the summary as a comment, for a fork too.
For a new plugin it lists everything the plugin asks for; for an update, only
what changed since the published version. Anything new or wider (a host
scope, a network host, a tool or a wider tool effect, a new or retargeted
command, a schedule's tool or cron, a new event handler, other prompt text,
prompt or context roles that reach more agents, another context tool, a new
or changed page or other page files, a new store or a larger store quota,
`trustedInput`, a higher `maxProtection`) adds the label `needs-security-review`. A change to anything outside your
`plugins/<name>/` directory adds `needs-maintainer-review` and needs the code
owner's review: keep a plugin pull request to its directory.

The review follows [the review checklist](docs/REVIEW-CHECKLIST.md): the
code, the permissions, the network hosts, where outside data meets a model
prompt, and what is written to the user's notes, tasks and documents. For an
update that widens nothing, the review is mostly the code diff.

## 5. After the merge

CI builds the tarball reproducibly and records its hashes; it never signs.
The key holder then publishes: rebuilds from the merged source and compares
with CI's record (no key), signs in a separate key session that runs only the
pinned Octipus CLI, and deploys
[plugins.octipus.cc](https://plugins.octipus.cc). Your plugin page shows you
as the author and "Reviewed and signed by Octipus".

An update is a new submission: merging it changes nothing for hosts until it
is signed.

## What a marketplace signature means

It says that this exact content passed CI and a maintainer's review. It does
not say that the code is safe. What a plugin can do is still decided on each
host: the sandbox, its declared network hosts, its host scopes with the
admin's approval, its tool effects with the user's permission rules,
protection levels and budgets.

## Other routes

You do not need the marketplace to share a plugin:

- **Your own registry:** sign an index with your own key
  (`octi plugin keygen`, `octi plugin sign-index`); an admin who trusts you
  adds the registry and your key to their config.
- **A direct install:** an admin installs from a directory or a signed
  tarball URL on their own host.
