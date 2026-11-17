# Changelog

## 0.2.3

- Draw individual throughput samples so isolated prefill readings remain visible in session trends.
- Preserve missing-data gaps and show an explanation when no active throughput was recorded.

## 0.2.2

- Edit saved engine names, URLs and connection names without deleting profiles or changing their IDs.
- Keep saved session history unchanged; cancel edits without writing and retain the form on save failures.

## 0.2.1

- Recover from initial session-write failures and commit samples before counting them.
- Treat session metadata count as the committed history boundary after partial storage failures.
- Clear previous engine telemetry and summaries when selection or collector changes.
- Disable action controls while operations are pending.
- Prevent generated Python bytecode from entering release artifacts.
- Companion bundle validation requires plain POSIX ustar with no extension headers.

## 0.2.0

- Ship a reproducible collector companion bundle, installer, systemd unit and full setup/removal guide.
- Declare companion purpose, target host, platforms, data access and privileges in manifest API 1.1.
- Separate engine and optional host metrics; show a single host setup notice until connected.
- Configure the collector connection on an existing saved engine.

## 0.1.2

- Handle missing profile store entries by error code so first-use Save enables.
- Add retry for failed profile loading; history failures do not block engine saving.
- Replace operator-specific examples in UI, docs and tests with neutral examples.

## 0.1.1

- Match Octipus shared theme tokens and use available dashboard width.
- Show engine-save success, guard initialization and support LAN UUID generation.
- Require companion host fix for local asset CSP and full-height plugin pages.

## 0.1.0

- Saved per-user engine profiles and an on-demand monitoring dashboard.
- Live reads through admin-approved named connection paths, with credentials kept inside Octipus.
- Session history, throughput charts and low/peak/average statistics.
- Optional authenticated Linux/AMD host collector with explicit namespace scope.
