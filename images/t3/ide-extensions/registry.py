#!/usr/bin/env python3
"""Resolve native code-server extension inventories into Nix fixed-output downloads."""
import base64
import hashlib
import io
import json
import re
import urllib.request
from urllib.error import HTTPError
import zipfile

ID = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$", re.I)
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.+-]*$")


def download(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read(256 * 1024 * 1024 + 1)
        if len(data) > 256 * 1024 * 1024:
            raise ValueError("Extension registry response exceeds the size limit")
        return data


def resolve(spec):
    name, _, version = spec.partition("@")
    name = name.lower()
    if not ID.fullmatch(name) or (version and not VERSION.fullmatch(version)):
        raise ValueError(f"Invalid extension: {spec}")
    publisher, extension = name.split(".")
    base = f"https://open-vsx.org/api/{publisher}/{extension}"
    try:
        metadata = json.loads(download(f"{base}/linux-x64/{version or 'latest'}"))
    except HTTPError as error:
        if error.code != 404:
            raise
        metadata = json.loads(download(f"{base}/universal/{version or 'latest'}"))
    actual = metadata["version"]
    if not VERSION.fullmatch(actual) or (version and actual != version):
        raise ValueError(f"Unexpected version for {spec}")
    if metadata.get("targetPlatform", "universal") not in ("universal", "linux-x64"):
        raise ValueError(f"Unsupported platform for {spec}")
    url = metadata["files"]["download"]
    if not url.startswith("https://open-vsx.org/"):
        raise ValueError(f"Unexpected download origin for {spec}")
    archive = download(url)
    with zipfile.ZipFile(io.BytesIO(archive)) as vsix:
        package = json.loads(vsix.read("extension/package.json"))
    if f'{package["publisher"]}.{package["name"]}'.lower() != name or package["version"] != actual:
        raise ValueError(f"VSIX identity does not match {spec}")
    dependencies = package.get("extensionDependencies", []) + package.get("extensionPack", [])
    if not all(isinstance(dep, str) and ID.fullmatch(dep) for dep in dependencies):
        raise ValueError(f"Invalid dependencies in {spec}")
    return {
        "id": name, "version": actual, "url": url,
        "hash": "sha256-" + base64.b64encode(hashlib.sha256(archive).digest()).decode(),
    }, dependencies
