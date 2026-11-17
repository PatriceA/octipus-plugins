#!/bin/sh
# Run explicitly as root on the monitored Linux host, after reviewing the bundle.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this installer as root on the monitored host.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v systemctl >/dev/null
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -c 'import sys; assert sys.version_info >= (3, 9), "Python 3.9 or newer required"'
install -d -m 755 /opt/llama-monitor
install -d -m 700 /etc/llama-monitor
install -m 644 "$bundle_dir/collector.py" /opt/llama-monitor/collector.py
install -m 644 "$bundle_dir/llama-monitor.service" /etc/systemd/system/llama-monitor.service
if [ ! -e /etc/llama-monitor/collector.conf ]; then
  printf '%s\n' 'COLLECTOR_LISTEN=127.0.0.1' 'COLLECTOR_PORT=9187' > /etc/llama-monitor/collector.conf
  chmod 600 /etc/llama-monitor/collector.conf
fi
systemctl daemon-reload
printf '%s\n' 'Files installed. Service has NOT been enabled or started.' 'Follow README.md to provision credentials, choose a listener and start the service.' 'For upgrades, restart the service explicitly after reviewing changes.'
