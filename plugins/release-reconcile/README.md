# Release reconciliation

Compare target versions in your issue tracker with commits, release branches and open merge requests. The report shows exact evidence for missing merges, version mismatches, source-only changes, partial deliveries, reverts and unknown or incomplete evidence.

The plugin never merges, tags, deploys or changes tracker tickets. Octipus collects bounded Git evidence and authenticated GET responses through your existing approved connections. Credentials stay in the host vault.

## Set up

Requires Octipus plugin API 1.2 with `repos:collect` support. Open **Set up / check**:
select approved repository folders and existing tracker/Git/forge connections, explicitly
choose the evidence classification, review access, then enable. Unsupported classifications
are rejected before installation; never lower classification merely to fit the page.

On the Release audit page choose **New profile**, then select your workstation environment,
folder, connections and discovered repositories. Branch/tag selectors use saved local refs;
no fetch is performed during setup. Add product names, target versions and tracker rules,
then save. Profiles and audit records are private to the calling user and workspace.
Repository folders and connections remain subject to current environment and plugin grants.
The optional Advanced profile JSON editor remains available for complex mappings.

A generic repository entry looks like:

```json
{
  "key": "billing-api",
  "path": "billing-api",
  "product": "billing",
  "source": "develop",
  "release": "release/2.4.0",
  "baseline": { "tag": "v2.3.0" }
}
```

Optional `targetVersions`, such as `{ "billing": "2.4.0" }`, are saved defaults. The page pre-fills them; each audit stores an independent snapshot of the versions selected for that run. Changing a profile never rewrites an earlier audit.

Use `collector_options` to discover allowed environments and connections. `profile_save`, `profile_get` and `profile_list` manage reusable profiles. `audit_start` starts collection, `audit_status` reads progress and results, and `audit_cancel` cancels a running audit. Missing or stale refs, shallow history, fetch failures, truncated output and incomplete tracker responses remain explicit limitations.

No tokens, passwords, private keys or company-specific configuration belong in this package or its settings. Use existing named vault connections.

## Verify

`npm test` runs synthetic fixtures and local temporary Git repositories; it needs no account or external network. Marketplace checks also run package tests in the Octipus sandbox. No dependencies are installed when the package runs.
