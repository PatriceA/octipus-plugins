# keys/

The **public** halves of the marketplace's keys. Nothing secret is ever in
this directory, or anywhere in this repository (`*.key` is ignored).

| Path | What it is |
|---|---|
| `root/*.pub` | The **root** keys (a root and a backup root). Kept offline; they sign one file, `keys.json`, and nothing else. Octipus ships these public keys built in. |
| `signing/*.pub` | The **signing** keys. A signing key endorsed by `keys.json` signs every package and every `index.json`. It lives encrypted on the publishing machine. A root key is never a signing key. |
| `endorsements.json` | Which signing keys `keys.json` endorses (`{ "signingKeys": [{ "file": "signing/<name>.pub", "notAfter"? }], "revokedKeys": [{ "keyId", "reason" }] }`). |

## keys.json

Served at `https://plugins.octipus.cc/keys.json` with `keys.json.sig`:

```json
{ "schema": 1, "version": 3, "generatedAt": "2026-11-10T12:00:00Z", "expires": "2027-01-09T12:00:00Z",
  "signingKeys": [{ "keyId": "ed25519:<64 hex>", "publicKey": "-----BEGIN PUBLIC KEY-----…", "notAfter": "2027-12-31T00:00:00Z" }],
  "revokedKeys": [{ "keyId": "ed25519:<64 hex>", "reason": "…" }] }
```

`keys.json.sig` is the canonical signature file
(`{ "alg": "ed25519", "keyId", "signature" }`) over
`octipus-marketplace-keys/v1\n` + `sha256:<hex of the exact bytes>`, made by
a root key. `version` only goes up; `revokedKeys` only grows (a host keeps a
revocation even if a later file drops it, and `scripts/keys.mjs` refuses to
drop one).

Build and sign it in the root key session, with `node` (it refuses `npm`),
from a clean `main` equal to `origin/main`. The root public keys always come
from `--root-pub`: your own copy, outside the repository, never `keys/root/`.

```sh
node scripts/keys.mjs build  --root-pub ~/offline/root.pub        # keys.json from this directory, after the live one (no key)
node scripts/keys.mjs sign   --root-pub ~/offline/root.pub --key ~/offline/root.key   # → release-keys/keys.json(.sig)
node scripts/keys.mjs verify --root-pub ~/offline/root.pub release-keys/keys.json
```

`sign` checks the pinned Octipus CLI as `sign.mjs` does and that the root
key is encrypted, verifies the published keys.json with your root keys,
shows the signing keys added and removed, `notAfter` changes and the
revocations added against it, has you **type each added key id** (check it
against your own record of the key, not against this repository) and
confirm, and signs only through the pinned CLI (`octi plugin sign-keys`).
The passphrase is asked on the terminal, or read from `--passphrase-file
<path>` (not `-`: the confirmations need the terminal). `--first` makes
version 1 when there is no live keys.json yet; `--previous <file|url>`
replaces the live one.

`expires` is required (Octipus refuses a `keys.json` without it, or more
than 90 days after `generatedAt`): `generatedAt` + 60 days by default
(`--expires-days <n>`, at most 90; more is refused here). A host refuses an
expired `keys.json`, and with it every index and package of the
marketplace, so the root key holder **renews it before it is 60 days old**:
signs and deploys a new one (version + 1, nothing else need change).
Nothing reminds you: put it in your calendar when you sign. `publish build`
warns when `keys.json` expires before the index it is building. The index
itself is republished at least weekly (hosts warn after 7 days; see the
[README](../README.md)).

## What changing this directory changes

Nothing that publish trusts, by itself. `npm run publish -- build` and
`scripts/sign.mjs` take the endorsed signing keys from the live,
root-signed `keys.json`, and `sign.mjs` takes the root key from the key
holder's own copy (`--root-pub`, outside the repository). A pull request
that edits `keys/` gets `needs-maintainer-review` and needs the code owner's
review; it takes effect only when the root key holder signs a new
`keys.json` from it.

Key rotation and revocation: see "Rotating a signing key" in the
[README](../README.md).
