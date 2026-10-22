#!/usr/bin/env python3
"""Apply a published Nix extension set to a persistent native IDE directory."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def provision(source, directory, replace=False):
    declaration = (source / "extensions.json").read_bytes()
    desired = json.loads(declaration)
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / "managed-extensions.json"
    previous = json.loads(marker.read_text()) if marker.exists() else {"revision": None, "extensions": []}
    revision = hashlib.sha256(declaration).hexdigest()
    if previous["revision"] == revision and not replace:
        return
    command = [
        "code-server", "--config", str(directory / "config.yaml"),
        "--user-data-dir", str(directory / "user-data"),
        "--extensions-dir", str(directory / "extensions"),
    ]
    installed = {}
    if desired or previous["extensions"] or replace:
        output = subprocess.check_output(command + ["--list-extensions", "--show-versions"], text=True)
        for line in output.splitlines():
            if re.fullmatch(r"[\w-]+\.[\w-]+@[^\s]+", line):
                name, version = line.rsplit("@", 1)
                installed[name.lower()] = version
    names = {item["id"] for item in desired}
    removals = [{"id": name, "version": version} for name, version in installed.items()] if replace else previous["extensions"]
    for item in removals:
        if item["id"] not in names and installed.get(item["id"]) == item["version"]:
            subprocess.run(command + ["--uninstall-extension", item["id"]], check=True, stdout=sys.stderr)
    install = []
    for item in desired:
        if installed.get(item["id"]) != item["version"]:
            archive = source / f'{item["id"]}-{item["version"]}.vsix'
            install.extend(["--install-extension", str(archive)])
    if install:
        subprocess.run(command + install + ["--force"], check=True, stdout=sys.stderr)
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as target:
        temporary = target.name
        json.dump({"revision": revision, "extensions": desired}, target)
    os.replace(temporary, marker)


if __name__ == "__main__":
    provision(Path("/opt/t3/ide-extensions"), Path(os.environ["T3_WORKER_STATE_DIR"]) / "ide")
