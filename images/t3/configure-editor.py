#!/usr/bin/env python3
"""Seed a new code-server profile before its first browser connection."""
import argparse
import json
from pathlib import Path


def configure_editor(state: Path, manifest: Path) -> None:
    settings = state / "ide" / "user-data" / "User" / "settings.json"
    defaults = json.loads(manifest.read_text())["contributes"]["configurationDefaults"]
    # VS Code rejects extension defaults for this application-scoped preference.
    defaults["chat.tips.enabled"] = False
    settings.parent.mkdir(parents=True, exist_ok=True)
    try:
        # User settings can contain JSONC and must remain byte-for-byte unchanged.
        with settings.open("x") as target:
            target.write(json.dumps(defaults, indent=2) + "\n")
    except FileExistsError:
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    configure_editor(args.state, args.manifest)
