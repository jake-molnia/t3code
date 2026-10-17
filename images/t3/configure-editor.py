#!/usr/bin/env python3
"""Seed a new code-server profile before its first browser connection."""
import argparse
import json
import os
from pathlib import Path
import tempfile


def configure_editor(state: Path, manifest: Path) -> None:
    settings = state / "ide" / "user-data" / "User" / "settings.json"
    if settings.exists():
        return
    defaults = json.loads(manifest.read_text())["contributes"]["configurationDefaults"]
    # These choices are consumed before extension defaults load. Keep theme,
    # completion and other live defaults in the extension so image updates apply.
    initial = {key: defaults[key] for key in (
        "workbench.startupEditor", "workbench.secondarySideBar.defaultVisibility"
    )}
    # VS Code rejects extension defaults for this application-scoped preference.
    initial["chat.tips.enabled"] = False
    contents = json.dumps(initial, indent=2) + "\n"
    settings.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=settings.parent, prefix=".t3-settings-", delete=False) as target:
        temporary = Path(target.name)
        try:
            target.write(contents)
            target.flush()
            os.fsync(target.fileno())
            try:
                # Atomic publication without replacing a user file created concurrently.
                os.link(temporary, settings)
            except FileExistsError:
                pass
        finally:
            temporary.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    configure_editor(args.state, args.manifest)
