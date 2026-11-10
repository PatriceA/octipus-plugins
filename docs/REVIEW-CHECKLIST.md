# Review checklist

For the maintainer reviewing a plugin pull request, and for the key holder
before signing. CI's comment on the pull request (`check-summary.md`) is the
starting point: it says what failed, and what the plugin asks for, or what
changed since the published version. The label `needs-security-review` means
something is new or wider; do not merge it until each line below is checked.

For an update that widens nothing, the review is mostly the code diff.

The comment is rendered by the report workflow from validated data; text
from the pull request appears only inside code blocks. If it says the check
result could not be used, review everything by hand.

## Outside plugins/<name>/ (`needs-maintainer-review`)

A pull request that touches anything else changes the machinery, not a
plugin. The code owner reviews it line by line, and:

- [ ] `published.json`: nothing removed or changed (CI refuses it); a record
      added only by the key holder's publish commit, equal to the signed index.
- [ ] `revoked.json`: entries only appended; a reason for each.
- [ ] `keys/`: a key added or removed only as the key holder planned it
      (it takes effect only through a root-signed `keys.json`).
- [ ] `scripts/`, `site/`, `.github/`, `package*.json`, `tests/`: no new
      network call, no new place that reads or writes a file without
      `scripts/lib/safe-fs.mjs`, no lifecycle script, no new action that is
      not pinned to a commit, no write token in a job that runs pull request
      code. `scripts/sign.mjs`: still Node built-ins only, still starting only
      git and the pinned CLI.
- [ ] `OCTIPUS_REF`: a 40-hex commit on PatriceA/octipus `main` (publish
      refuses one that is not), and the Octipus diff since the old one read
      for the plugin CLI.
- [ ] A pull request that edits a workflow: what it ran on itself proves
      nothing; read the workflow.

## The checks passed

- [ ] Both jobs are green: the data checks (validate, `marketplace.json`,
      README and changelog, size, the version) and the sandboxed tests and
      smoke run.
- [ ] Warnings read: a lookalike name, an unknown licence.
- [ ] It is a package (`runtime` is not `in-process`).
- [ ] No prebuilt or minified code you cannot read, unless it is a vendored
      dependency whose origin and version are named (and you checked it
      matches upstream).
- [ ] No `dependencies` in `package.json`; nothing installs at runtime.

## The code

- [ ] It does what the README says, and nothing it does not say.
- [ ] No obfuscated strings, `eval`, dynamic `import()` of fetched code, or
      code downloaded and run at runtime.
- [ ] It keeps its state in `OCTIPUS_PLUGIN_DATA_DIR`, never in its own
      directory.
- [ ] It does not log secrets, tokens or user content it does not need to.
- [ ] Every tool the server offers is declared in the manifest.

## The permissions summary

- [ ] Each **tool effect** is the narrowest true one: `read` only reads;
      `write` changes data in the connected system; `external` reaches outside
      the organisation (a payment, a message to a person, a post). A tool that
      sends anything to a person is `external`.
- [ ] Each **host API scope** is needed, and the README says why. Watch
      `web:read`, `model:complete` and `agent:run` together with any `:read`
      scope: the plugin can send what it reads anywhere (it is then limited
      to protection level 1).
- [ ] **Contributions** (commands, schedules, events, prompt, context) are
      needed. The summary names them but does not show what changed inside
      one (its tool, cron, prompt text): read the manifest diff. A `context` tool sees every turn of every user; a prompt file
      goes into every matching agent's system prompt: read its full text.
- [ ] **Pages:** what the page shows, and that it uses only the page bridge.
- [ ] **`model.trustedInput`:** only if its model prompts never carry outside
      data (web pages, mail, documents, tool results), and its reason is
      honest. When in doubt, ask for it to be removed.
- [ ] **`maxProtection`** is no higher than the data it truly needs.

## The network hosts

- [ ] You know who each host belongs to, and why the plugin needs it.
- [ ] Hosts are as narrow as they can be (`api.example.com`, not
      `*.example.com`), on the default ports unless a port is needed.
- [ ] Nothing reaches a host that is not declared (under the sandbox it
      would fail; without it, it would work, so read the code).

## Where outside data meets a model prompt

- [ ] Find every place text from outside (a fetched page, a mail, an API
      response, a document) goes into a `model:complete` prompt or an
      `agent:run` brief. It must be fenced as data, never as instructions,
      and the model's answer must not be able to trigger a `write` or
      `external` tool on its own.

## What it writes

- [ ] What it writes to the user's notes, tasks and documents: titles,
      content, how much, and that it is marked as coming from the plugin.
- [ ] Nothing is written unattended (from a schedule or an event) that the
      user would not expect.

## The listing

- [ ] `marketplace.json`: an honest title and summary, the right category, a
      licence that matches the code, an author you can reach.
- [ ] Screenshots show the real plugin; the README has setup steps and the
      secrets it needs, with the narrowest access each one can have.

## Before signing (the key holder)

- [ ] `publish build` passed: the commit is CI's (a push run on `main`), the
      records match the live signed index. A CI-compare bypass is in the plan:
      only if you checked the record yourself.
- [ ] Read the diff stat `build` and `sign.mjs` print of everything outside
      the plugin directories since the last publish; when `scripts/sign.mjs`
      changed, read its diff before running it.
- [ ] For each package `sign.mjs` shows: the name, version, content hash and
      permissions are what was reviewed.
- [ ] The new revocations it shows are the ones you meant.
- [ ] Remember what the signature means: this exact content passed CI and
      a review. It does not make the code safe; the host's sandbox, approvals
      and permission rules still apply.
