# llama.cpp Monitor

A dependency-free Octipus plugin: saved engines, a live dashboard and on-demand monitoring sessions. Source is unsigned; maintainer reviews and signs it for the marketplace.

**Requires Octipus plugin manifest API 1.1**, including companion-service downloads, plus the approved-connection bridge and shared theme support. Release the matching Octipus host before publishing; pin its released version/commit in marketplace tooling. Older hosts reject this manifest instead of silently hiding companion setup.

## Dashboard

Version 0.2.0 also needs the companion host fixes for local-origin asset CSP, full-height plugin pages, and shared theme messages. The isolated iframe consumes Octipus global color/font/radius tokens; it follows the active palette and light/dark setting. After upgrading the package, an admin must review and enable it again.

- Save named engine base URLs and switch between them. Use Edit selected to update names, URLs and connection names in place; Save changes preserves the engine ID and recorded history. A path means the HTTP engine endpoint, not a GGUF filesystem path.
- Inspect model identifiers and explicit state. A model merely listed by the OpenAI API is labelled **advertised**, not assumed resident.
- Prefill/output tokens per second, active/queued requests and context high-water mark.
- With a host collector: RAM total/available/used, container RAM limit/usage, swap, process RSS, GPU VRAM available/used, GPU utilization, temperature and power where supported.
- Start/stop sessions; view charts, low/peak/average, valid sample counts and saved history.
- No polling before Start or after Stop. Read once is an explicit single probe. Keep the page open for recording; browser throttling and closing the tab interrupt collection. Saved readings survive a reload; a session interrupted by closing has a null stop time.
- At most 600 samples per session. Failed/unknown measurements stay unavailable, never zero. Manual snapshot input remains available for offline diagnostics.

Throughput is calculated from successive `/metrics` token and processing-time counter deltas. First sample, idle intervals and counter resets have no speed reading. Averages are arithmetic means of valid samples, excluding missing values and inactive throughput intervals; they are not time-weighted wall-clock rates.

## 1. Engine and connection

Enable `llama-server --metrics`. Do not restart a production engine until its users are ready.

In **Secrets → Connect API**, configure a named connection such as `engine_api`, using your engine's authentication. Approve GET and your engine origin (example: `https://engine.example.com`), prefix `/`. Internal destinations require admin approval. TLS settings stay controlled by that connection.

In plugin admin settings, set **Approved connection paths (JSON)**:

```json
{
  "engine_api": ["/health", "/v1/models", "/props", "/metrics"],
  "host_metrics": ["/telemetry"]
}
```

Only exact pairs work. Remove the collector entry if unused. For an engine behind a path prefix, include that prefix on all four paths. The saved engine URL's origin must match the connection origin. Router-mode metrics requiring `?model=` are not supported in this initial release; save individual llama-server worker endpoints instead.

Approve `connections:read`, `store:read` and `store:write`, review the package and enable it manually. Open **Plugins → llama.cpp Monitor**. Add name, base URL, connection name, and optionally a collector connection. No API keys belong in this page, profile, URL, or plugin files.

The bridge performs GET only, bounded to 1 MiB/10 seconds per request, with no redirects, custom headers or body. It rechecks user connection permissions and exact admin path grants, uses the trusted credential client, masks credentials from responses and returns no response headers. Personal workspace and protection level 1 only. A package never receives the underlying vault secret.

## 2. Host collector (optional)

The plugin ships `collector/llama-monitor-collector.tar.gz`: Python collector, systemd unit, explicit installer and setup/removal guide. In **Admin → Plugins → Companion services**, download the bundle and guide even while the plugin is disabled. Review them, copy to the monitored host, and follow [collector setup](collector/README.md). Octipus does not install, start, update or remove remote services. Existing saved engines can use **Save collector connection** in the Host metrics panel; engine metrics need no collector.

llama.cpp does not expose all physical-machine telemetry. `collector/collector.py` is a separate Linux companion, not a process the plugin starts. Install it on the monitored physical host for physical RAM; running it in an LXC reports that namespace instead. No root is required for normal /proc and readable AMD sysfs values. Do not grant sudo.

The collector supports AMD DRM sysfs. NVIDIA metrics require a compatible exporter/adapter and display unavailable here. AMD driver counters can misreport VRAM residency; they are not a guarantee of model placement. No prompts, command lines, environment dumps or engine keys are read.

For an initial non-secret local reading:

```sh
python3 collector/collector.py --once
```

For HTTP, provision a dedicated bearer token using your credential manager into an owner-readable credential file, and store the same credential in a vault entry. Do not pass its plaintext on a command line. A systemd credential file (LoadCredential) is suitable. Then:

```sh
python3 /opt/llama-monitor/collector.py --listen 127.0.0.1 --port 9187 --credential-file /run/credentials/llama-monitor.service/token
```

Default listener is loopback. HTTP mode refuses to start without a credential file. Restrict access to Octipus's host with the host firewall; use TLS or an approved encrypted transport beyond a trusted LAN. In Secrets → Connect API create `host_metrics` with this origin, prefix `/telemetry`, GET and bearer authentication. A missing collector connection does not block engine metrics; host fields show unavailable.

Optional `--pid <pid>` reports engine RSS visible from that namespace. `--cgroup <path>` reads a particular cgroup v2 limit and current usage. No configured PID means no process RSS. Unbounded/missing limits stay unavailable.

## Data, permissions and retention

Profiles, history and samples are per user and per workspace in Octipus's 5 MiB store. Nothing is kept in the shared plugin data directory or browser localStorage. Delete old sessions to reclaim quota; uninstall deletes the plugin store. No automatic retention deletion.

Read tools: `read_engine` (approved read-only telemetry probes), `parse_snapshot` (pure parser), `summarize_session` (pure statistics). No inference, model loads/unloads, shell/SSH access, schedules, prompt contributions, network-host declarations or secret declarations. Connection credentials resolve inside Octipus's trusted client.

## Development and marketplace

`npm test` runs parser and mocked transport tests. Build the reproducible companion archive with `python3 collector/build_bundle.py` inside the repository sandbox; the bundle tests compare it with reviewed source files. Run package code in the marketplace's bwrap harness; see repository CONTRIBUTING.md. Validate with the patched host contract. Marketplace CI also checks listing, changelog, dependencies, manifest, package tree and smoke startup. No signature, install, enable, push or publication is performed by this source package.

UI live integration and a real host collector must be verified after the host patch is running and connections are configured. Fixture tests do not prove live connectivity.

## Publication examples

Use reserved example domains and neutral names in UI placeholders, documentation and test fixtures. Never copy an operator's local addresses, hostnames, engine names, connection names or vault entry names into published examples. Example URLs are placeholders; configure your own endpoint.

License: MIT.
