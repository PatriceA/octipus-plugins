# Host collector companion

Version 0.2.0. Linux, Python 3.9+, systemd with LoadCredential support (247+).
No Python dependencies. AMD DRM sysfs supported; NVIDIA telemetry is not implemented.
This companion is optional: engine metrics work without it.

## Where it runs

Install on the machine whose CPU, RAM and GPU you want to measure. For physical
RAM, install on the physical host; a container reports its visible /proc namespace.
Do not run it in the Octipus plugin sandbox. It reads Linux /proc and AMD /sys;
it never reads prompts, environment variables, model files or engine credentials.
AMD counters may misreport VRAM residency.

## Get and inspect

Download the bundle in Admin → Plugins → Companion services. It is included in
the signed plugin package and covered by its content hash. The host verifies
package content before downloading; no separate unsigned service download is used.

Extract the gzip tarball, open its directory, and review collector.py,
llama-monitor.service and install.sh. Copy this directory to the monitored host.
Do not run an installer directly from a remote URL.

## Install

As root on the monitored host:

```sh
sh ./install.sh
```

This copies files and reloads systemd. It does not start or enable anything,
generate credentials, contact another machine, change a firewall or modify llama.cpp.
The service runs as a temporary unprivileged user, using read-only system access.

## Credential and network setup

1. Generate a dedicated random bearer token in your password manager (32 or more
   characters). Provision the same value into the host's
   /etc/llama-monitor/token and an Octipus vault entry. Use your credential
   manager's secure file provisioning or a local editor; never paste it in chat
   or put it in command arguments, source code or a downloadable bundle.
2. Set token file owner root:root and mode 600. Keep its parent directory mode 700.
3. Edit /etc/llama-monitor/collector.conf. Default binding is loopback.
   Set COLLECTOR_LISTEN to the monitored host's actual private interface address.
   Keep COLLECTOR_PORT=9187 unless another service uses that port.
4. Permit that port only from the Octipus host, using the monitored host's firewall.
   The collector provides HTTP with bearer authentication, not TLS. Use an approved
   encrypted transport on untrusted networks. Do not expose it publicly.

Then:

```sh
systemctl enable --now llama-monitor
systemctl status llama-monitor --no-pager
```

Missing or short credential files cause startup to fail; they never open an
unauthenticated listener. /telemetry requires the matching bearer credential.

## Connect in Octipus

In Secrets → Connect API, create a connection such as host_metrics.
Use the collector's actual origin and port, prefix /telemetry, method GET and
bearer authentication selecting the vault entry. Internal destinations need admin
approval. Do not reuse the engine's credential.

Merge this entry into the plugin's Approved connection paths JSON:

```json
{
  "host_metrics": ["/telemetry"]
}
```

Keep your existing engine grants. In the dashboard, select the saved engine,
enter the connection name under Host collector connection, and use
Save collector connection. Read once should populate the Host metrics section.
Two successful samples with model activity between them are needed for throughput.

## Check and troubleshoot

A credential-free local hardware check (no HTTP listener):

```sh
python3 /opt/llama-monitor/collector.py --once
```

This prints non-secret telemetry. If that works but the dashboard cannot connect,
check service status, binding, firewall, connection permission and exact path grant.
Test authenticated HTTP with Octipus's configured connection; never print its token.

An unavailable GPU field means the kernel did not expose a readable counter.
Process RSS requires --pid with a PID visible on this host; without it RSS is
unavailable. Container memory fields require a suitable --cgroup path; the service's
default cgroup is not the engine container. Configure overrides through systemctl edit
llama-monitor if these optional readings are needed. Do not claim physical values
from a container or treat kernel VRAM counters as exact model allocations.

## Update and remove

To update, download the bundle from the new reviewed plugin version, inspect it,
run install.sh again, then run systemctl restart llama-monitor. Credentials and
collector.conf are preserved. Plugin upgrades do not update the external service.

To stop and prevent autostart:

```sh
systemctl disable --now llama-monitor
```

For complete removal, an administrator can remove the service unit and
/opt/llama-monitor, then reload systemd. Remove /etc/llama-monitor and revoke its
vault connection only when its credentials are no longer needed. Uninstalling
the Octipus plugin leaves this service and its credentials untouched.
