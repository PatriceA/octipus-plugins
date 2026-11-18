#!/usr/bin/env python3
"""Reproducible companion archive; no credentials and no installation actions."""
import gzip
import io
from pathlib import Path
import tarfile

FILES = ("README.md", "collector.py", "install.sh", "llama-monitor.service")
ROOT = "llama-monitor-collector"

def build():
    here = Path(__file__).resolve().parent
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(FILES):
            payload = (here / name).read_bytes()
            entry = tarfile.TarInfo(ROOT + "/" + name)
            entry.size = len(payload)
            entry.mode = 0o755 if name == "install.sh" else 0o644
            entry.mtime = 0
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            archive.addfile(entry, io.BytesIO(payload))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", compresslevel=9, mtime=0) as output:
        output.write(data.getvalue())
    return compressed.getvalue()

if __name__ == "__main__":
    target = Path(__file__).resolve().parent / "llama-monitor-collector.tar.gz"
    target.write_bytes(build())
    print(target.name + " built")
