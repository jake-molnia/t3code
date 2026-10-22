#!/usr/bin/env python3
"""Native extension operations used only inside execution workers."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

from registry import ID, VERSION, resolve
from provision import provision

ROOT = Path(__file__).parent


def run(command, nix=False):
    environment = dict(os.environ)
    if nix:
        environment["LD_PRELOAD"] = str(ROOT / "nix-pty.so")
    result = subprocess.run(command, env=environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1200)
    return result.stdout


def identity(archive):
    with zipfile.ZipFile(archive) as vsix:
        info = vsix.getinfo("extension/package.json")
        if info.file_size > 1024 * 1024:
            raise ValueError("Extension manifest is too large")
        package = json.loads(vsix.read(info))
    name = f'{package["publisher"]}.{package["name"]}'.lower()
    version = package["version"]
    if not ID.fullmatch(name) or not VERSION.fullmatch(version):
        raise ValueError("Invalid VSIX identity")
    return name, version


def unpack_bundle(archive, destination, digest):
    with open(archive, "rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != digest:
            raise ValueError("Extension bundle digest mismatch")
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) > 260 or sum(member.size for member in members) > 1024**3:
            raise ValueError("Extension bundle exceeds limits")
        for member in members:
            if not member.isfile() or Path(member.name).name != member.name:
                raise ValueError("Unsafe extension bundle entry")
        tar.extractall(destination, members=members, filter="data")
    manifest = json.loads((destination / "extensions.json").read_text())
    for item in manifest:
        if not ID.fullmatch(item["id"]) or not VERSION.fullmatch(item["version"]):
            raise ValueError("Invalid extension manifest")
        vsix = destination / f'{item["id"]}-{item["version"]}.vsix'
        with vsix.open("rb") as file:
            actual = "sha256-" + base64.b64encode(hashlib.file_digest(file, "sha256").digest()).decode()
        if actual != item["hash"] or identity(vsix) != (item["id"], item["version"]):
            raise ValueError("Extension package failed validation")
    return manifest


def reproducible_member(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ""
    info.mode = 0o600
    return info


def build(request, directory):
    work = Path(tempfile.mkdtemp(prefix="ide-build-", dir=directory))
    try:
        source = work / "source"
        source.mkdir()
        for name in ("flake.nix", "flake.lock"):
            shutil.copyfile(ROOT / name, source / name)
        retained = work / "retained"
        retained.mkdir()
        previous = request.get("previous")
        cached = {} if previous is None else {
            (item["id"], item["version"]): item for item in unpack_bundle(Path(previous["path"]), retained, previous["digest"])
        }
        if previous is not None:
            shutil.copyfile(retained / "flake.lock", source / "flake.lock")
        manifest = []
        resolved = set()
        queue = list(request["sources"])
        requested = {item["id"] for item in queue}
        staged = {item["digest"]: Path(item["path"]) for item in request["archives"]}
        while queue:
            item = queue.pop(0)
            if item["id"] in resolved:
                continue
            resolved.add(item["id"])
            if len(resolved) > 256:
                raise ValueError("Too many extensions")
            dependencies = []
            if item["archive"] is None and (item["id"], item["version"]) in cached:
                entry = dict(cached[(item["id"], item["version"])])
                archive = retained / f'{item["id"]}-{item["version"]}.vsix'
                with archive.open("rb") as file:
                    entry["archive"] = hashlib.file_digest(file, "sha256").hexdigest()
                shutil.copyfile(archive, source / archive.name)
                with zipfile.ZipFile(archive) as vsix:
                    package = json.loads(vsix.read("extension/package.json"))
                dependencies = package.get("extensionDependencies", [])
            elif item["archive"] is None:
                entry, dependencies = resolve(f'{item["id"]}@{item["version"]}')
            else:
                digest = item["archive"]
                archive = staged[digest]
                data = archive.read_bytes()
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("Private VSIX digest mismatch")
                if identity(archive) != (item["id"], item["version"]):
                    raise ValueError("Private VSIX identity mismatch")
                shutil.copyfile(archive, source / f'{item["id"]}-{item["version"]}.vsix')
                entry = dict(item, hash="sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode())
                with zipfile.ZipFile(archive) as vsix:
                    package = json.loads(vsix.read("extension/package.json"))
                dependencies = package.get("extensionDependencies", [])
            manifest.append(entry)
            for dependency in dependencies:
                name = dependency.lower()
                if not ID.fullmatch(name):
                    raise ValueError("Invalid extension dependency")
                if name not in requested:
                    requested.add(name)
                    queue.append({"id": name, "version": "", "archive": None})
        manifest.sort(key=lambda item: item["id"])
        (source / "extensions.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        output = work / "result"
        run(["nix", "--extra-experimental-features", "nix-command flakes", "--option", "sandbox", "false",
             "--option", "build-users-group", "", "build", "--no-update-lock-file", "--out-link", str(output), f"path:{source}#default"], nix=True)
        bundle = work / "bundle"
        shutil.copytree(output, bundle, symlinks=False)
        for name in ("flake.nix", "flake.lock"):
            shutil.copyfile(source / name, bundle / name)
        # Native installation validates engine/platform support using the pinned editor.
        # Validation runs in a fresh directory and cannot change the builder's own IDE.
        provision(bundle, work / "validation")
        destination = directory / f'{request["revision"]}.tar'
        temporary = work / "bundle.tar"
        with tarfile.open(temporary, "w") as tar:
            for file in sorted(bundle.iterdir()):
                tar.add(file, arcname=file.name, recursive=False, filter=reproducible_member)
        os.replace(temporary, destination)
        private = {item["id"]: item["archive"] for item in request["sources"]}
        sources = [{"id": item["id"], "version": item["version"], "archive": private.get(item["id"])} for item in manifest]
        return {"path": str(destination), "sources": sources,
                "flake": (source / "flake.nix").read_text(), "lock": (source / "flake.lock").read_text()}
    finally:
        shutil.rmtree(work)


def install(request, directory):
    archive = Path(request["path"])
    with tempfile.TemporaryDirectory(prefix="ide-provision-", dir=directory) as temporary:
        source = Path(temporary)
        unpack_bundle(archive, source, request["digest"])
        provision(source, directory, replace=request.get("replace", False))
    return {"revision": request["revision"]}


def export_setup(request, directory):
    export_directory = directory / "exports"
    export_directory.mkdir(exist_ok=True)
    for archive in export_directory.glob("vscode-setup-*.tar"):
        if archive.stat().st_mtime < time.time() - 3600:
            archive.unlink()
    if len(list(export_directory.glob("vscode-setup-*.tar"))) >= 4:
        raise ValueError("Too many pending IDE exports; retry after transfers complete")
    with tempfile.TemporaryDirectory(prefix="ide-export-", dir=directory) as temporary:
        work = Path(temporary)
        for name, contents in request["files"].items():
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("Invalid native settings path")
            destination = work / "User" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents)
        if request["bundle"] is not None:
            extensions = work / "extensions"
            extensions.mkdir()
            unpack_bundle(Path(request["bundle"]["path"]), extensions, request["bundle"]["digest"])
        handle, name = tempfile.mkstemp(prefix="vscode-setup-", suffix=".tar", dir=export_directory)
        os.close(handle)
        try:
            with tarfile.open(name, "w") as tar:
                for file in sorted(work.rglob("*")):
                    if file.is_file():
                        tar.add(file, arcname=str(file.relative_to(work)), recursive=False)
                        if tar.offset > 1024**3 + 4 * 1024**2:
                            raise ValueError("IDE export exceeds the size limit")
            return {"path": name}
        except BaseException:
            Path(name).unlink(missing_ok=True)
            raise


def main():
    request = json.load(sys.stdin)
    directory = Path(request["directory"])
    directory.mkdir(parents=True, exist_ok=True)
    operation = request["operation"]
    if operation == "build":
        result = build(request, directory)
    elif operation == "install":
        result = install(request, directory)
    elif operation == "export":
        result = export_setup(request, directory)
    elif operation == "inspect":
        name, version = identity(Path(request["path"]))
        result = {"id": name, "version": version}
    else:
        raise ValueError("Unknown extension operation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
