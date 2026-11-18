#!/usr/bin/env python3
"""Read-only, on-demand Linux telemetry companion. No shell or engine credential access."""
import argparse
import glob
import hmac
import json
import os
from pathlib import Path
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def read_number(path):
    try:
        n = int(Path(path).read_text().strip())
        return n if n >= 0 else None
    except (OSError, ValueError):
        return None

def meminfo():
    out = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        out[key] = int(value.split()[0]) * 1024
    return out

def cpu_ticks():
    values = [int(n) for n in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    return sum(values), values[3] + values[4]

def gpu_stats(warnings):
    # Card names and per-card readings stay explicit. Do not combine unknown VRAM as zero.
    cards = []
    for path in sorted(glob.glob("/sys/class/drm/card[0-9]*/device")):
        total, used = read_number(path+"/mem_info_vram_total"), read_number(path+"/mem_info_vram_used")
        if total is None:
            continue
        card = {"name": Path(path).parent.name, "totalBytes": total, "usedBytes": used}
        card["gpuPercent"] = read_number(path+"/gpu_busy_percent")
        cards.append(card)
    if not cards:
        warnings.append("AMD DRM counters unavailable; GPU fields unknown. NVIDIA requires a compatible exporter.")
        return {}, []
    fields = {"vramTotalBytes": sum(c["totalBytes"] for c in cards)}
    if all(c["usedBytes"] is not None for c in cards):
        fields["vramUsedBytes"] = sum(c["usedBytes"] for c in cards)
        fields["vramAvailableBytes"] = max(0, fields["vramTotalBytes"]-fields["vramUsedBytes"])
    if len(cards) == 1 and cards[0]["gpuPercent"] is not None:
        fields["gpuPercent"] = cards[0]["gpuPercent"]
    warnings.append("VRAM source: AMD kernel DRM counters. Some kernel/RADV versions misreport residency; values are not model allocation guarantees.")
    for pattern, key, divisor in [("/sys/class/drm/card[0-9]*/device/hwmon/hwmon*/temp1_input","gpuTemperatureC",1000), ("/sys/class/drm/card[0-9]*/device/hwmon/hwmon*/power1_average","gpuPowerWatts",1000000)]:
        readings = [read_number(p) for p in glob.glob(pattern)]
        readings = [n/divisor for n in readings if n is not None]
        if len(readings) == 1:
            fields[key] = readings[0]
    return fields, cards

def snapshot(pid=None, cgroup="/sys/fs/cgroup"):
    warnings = []
    before, idle_before = cpu_ticks()
    time.sleep(0.1)
    after, idle_after = cpu_ticks()
    mem = meminfo()
    host = {"ramTotalBytes": mem["MemTotal"], "ramAvailableBytes": mem.get("MemAvailable"),
            "swapUsedBytes": max(0, mem.get("SwapTotal",0)-mem.get("SwapFree",0))}
    if host["ramAvailableBytes"] is not None:
        host["ramUsedBytes"] = max(0, host["ramTotalBytes"]-host["ramAvailableBytes"])
    if after > before:
        host["cpuPercent"] = max(0, min(100, 100*(1-(idle_after-idle_before)/(after-before))))
    limit = read_number(str(Path(cgroup)/"memory.max"))
    current = read_number(str(Path(cgroup)/"memory.current"))
    if limit is not None: host["containerLimitBytes"] = limit
    if current is not None: host["containerUsedBytes"] = current
    if pid:
        try:
            status = Path("/proc/"+str(pid)+"/status").read_text()
            for line in status.splitlines():
                if line.startswith("VmRSS:"): host["processRssBytes"] = int(line.split()[1])*1024
        except OSError:
            warnings.append("Configured engine PID unavailable; process RSS unknown.")
    gpu, devices = gpu_stats(warnings)
    host.update(gpu)
    return {"at":datetime.now(timezone.utc).isoformat(),"scope":"collector namespace (/proc); run on physical host for physical RAM","host":host,"gpus":devices,"warnings":warnings}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen",default="127.0.0.1")
    parser.add_argument("--port",type=int,default=9187)
    parser.add_argument("--credential-file",help="Bearer credential file, e.g. systemd LoadCredential token")
    parser.add_argument("--pid",type=int,help="Engine PID as visible from collector namespace")
    parser.add_argument("--cgroup",default="/sys/fs/cgroup",help="Monitored cgroup v2 path")
    parser.add_argument("--once",action="store_true",help="Print one non-secret JSON reading; no HTTP listener")
    args=parser.parse_args()
    if args.once:
        print(json.dumps(snapshot(args.pid,args.cgroup)));return
    if not args.credential_file:
        parser.error("--credential-file required for HTTP mode; no unauthenticated listener")
    token=Path(args.credential_file).read_text().strip()
    if len(token)<16:
        parser.error("Credential file must contain at least 16 characters")
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log request headers, credentials or paths.
        def do_GET(self):
            if self.path != "/telemetry":
                self.send_error(404);return
            supplied=self.headers.get("Authorization","")
            if not hmac.compare_digest(supplied,"Bearer "+token):
                self.send_response(401);self.send_header("Content-Length","0");self.end_headers();return
            try:
                payload=json.dumps(snapshot(args.pid,args.cgroup)).encode()
                self.send_response(200)
                self.send_header("Content-Type","application/json")
                self.send_header("Cache-Control","no-store")
                self.send_header("Content-Length",str(len(payload)))
                self.end_headers();self.wfile.write(payload)
            except (OSError, ValueError, BrokenPipeError):
                self.send_error(503)
    server=ThreadingHTTPServer((args.listen,args.port),Handler)
    server.serve_forever()

if __name__=="__main__":
    main()
