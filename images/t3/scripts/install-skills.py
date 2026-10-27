#!/usr/bin/env python3
"""Build an immutable skill catalog from checksum-pinned source archives."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.request


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or not path.parts:
        raise ValueError(f"unsafe archive path: {value}")
    return path


def extract(data, source, destination):
    if hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError(f"archive checksum mismatch: {source['name']}")
    included = [relative_path(item) for item in source["include"]]
    roots = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = relative_path(member.name)
            roots.add(path.parts[0])
            if len(roots) != 1:
                raise ValueError("archive must have a single repository root")
            if len(path.parts) == 1:
                continue
            path = PurePosixPath(*path.parts[1:])
            if not any(path == root or root in path.parents for root in included):
                continue
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as reader, target.open("xb") as writer:
                    writer.write(reader.read())
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise ValueError(f"unsupported archive entry: {member.name}")


def install(lock, bundles, catalog, cache=None):
    if lock["version"] != 1:
        raise ValueError("unsupported skills lock version")
    # Fresh destinations prevent an old or partial catalog entering an image.
    bundles.mkdir(parents=True, exist_ok=False)
    catalog.mkdir(parents=True, exist_ok=False)
    inventory = []
    for source in lock["sources"]:
        if not re.fullmatch(r"[a-z0-9-]+", source["name"]):
            raise ValueError("invalid source name")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source["repository"]):
            raise ValueError("invalid repository")
        if not re.fullmatch(r"[a-f0-9]{40}", source["revision"]):
            raise ValueError("source revision must be a full commit SHA")
        url = f"https://codeload.github.com/{source['repository']}/tar.gz/{source['revision']}"
        cached = cache / f"{source['name']}.tar.gz" if cache else None
        if cached and cached.exists():
            data = cached.read_bytes()
        else:
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            raise ValueError("skill archive exceeds 32 MiB")
        bundle = bundles / source["name"]
        extract(data, source, bundle)
        for replacement in source["replacements"]:
            path = bundle.joinpath(*relative_path(replacement["path"]).parts)
            content = path.read_text()
            if replacement["old"] not in content:
                raise ValueError(f"upstream skill reference changed: {path}")
            path.write_text(content.replace(replacement["old"], replacement["new"]))
        skill_root = bundle.joinpath(*relative_path(source["skill_root"]).parts)
        skills = sorted(skill_root.rglob("SKILL.md"))
        if not skills:
            raise ValueError(f"empty skill collection: {source['name']}")
        for skill in skills:
            original = skill.parent.name
            name = source["aliases"].get(original, original)
            if not re.fullmatch(r"[a-z0-9-]+", name):
                raise ValueError(f"invalid skill directory: {name}")
            content = skill.read_text()
            if name != original:
                content, count = re.subn(
                    rf"(?m)^name: {re.escape(original)}$", f"name: {name}", content
                )
                if count != 1:
                    raise ValueError(f"upstream skill metadata changed: {skill}")
                skill.write_text(content)
            link = catalog / name
            if link.exists() or link.is_symlink():
                raise ValueError(f"duplicate skill name: {name}")
            # Preserve complete source layout for references to sibling skills.
            link.symlink_to(skill.parent.resolve(), target_is_directory=True)
            inventory.append({"name": name, "source": source["name"],
                              "revision": source["revision"],
                              "path": str(skill.relative_to(bundles)),
                              "sha256": hashlib.sha256(skill.read_bytes()).hexdigest()})
    files = [{"path": str(path.relative_to(bundles)),
              "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
             for path in sorted(bundles.rglob("*")) if path.is_file()]
    (bundles / "files.json").write_text(json.dumps(files, indent=2) + "\n")
    (bundles / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    (bundles / "sources.json").write_text(json.dumps(lock, indent=2) + "\n")
    for path in sorted(bundles.rglob("*"), reverse=True):
        path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    bundles.chmod(0o555)
    catalog.chmod(0o555)
    print(f"Installed {len(inventory)} pinned skills into {catalog}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path("skills.lock.json"))
    parser.add_argument("--bundles", type=Path, default=Path("/opt/agent-skill-bundles"))
    parser.add_argument("--catalog", type=Path, default=Path("/opt/agent-skills"))
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    install(json.loads(args.lock.read_text()), args.bundles, args.catalog, args.cache)
