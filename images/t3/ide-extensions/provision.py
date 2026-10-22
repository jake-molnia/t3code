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
    def inventory():
        installed = {}
        output = subprocess.check_output(command + ["--list-extensions", "--show-versions"], text=True)
        for line in output.splitlines():
            if re.fullmatch(r"[\w-]+\.[\w-]+@[^\s]+", line):
                name, version = line.rsplit("@", 1)
                installed[name.lower()] = version
        return installed

    installed = inventory() if desired or previous["extensions"] or replace else {}
    dependencies = {}
    for manifest in (directory / "extensions").glob("*/package.json"):
        package = json.loads(manifest.read_text())
        name = f'{package["publisher"]}.{package["name"]}'.lower()
        if installed.get(name) == package["version"]:
            dependencies[name] = {dependency.lower() for dependency in package.get("extensionDependencies", [])}
    names = {item["id"] for item in desired}
    removals = installed if replace else {item["id"]: item["version"] for item in previous["extensions"]}
    pending = {name for name, version in removals.items() if name not in names and installed.get(name) == version}
    while pending:
        # Native uninstall rejects dependencies with installed dependents.
        removable = next((name for name in sorted(pending) if not any(
            name in dependencies.get(dependent, set()) for dependent in installed
        )), None)
        if removable is None:
            raise RuntimeError("Cannot remove extensions with retained dependents: " + ", ".join(sorted(pending)))
        subprocess.run(command + ["--uninstall-extension", removable], check=True, stdout=sys.stderr)
        installed = inventory()
        if removable in installed:
            raise RuntimeError(f"Extension was not removed: {removable}")
        # Removing a pack can also remove members, including desired extensions.
        pending.intersection_update(installed)
    previous_packages = {item["id"]: item for item in previous["extensions"]}
    install = []
    for item in desired:
        if (replace or installed.get(item["id"]) != item["version"]
                or previous_packages.get(item["id"], {}).get("hash") != item["hash"]):
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
