#!/usr/bin/env python3
"""Install checksum-pinned native artifacts from the worker manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('manifest', type=Path)
parser.add_argument('prefix', type=Path)
parser.add_argument('--section', choices=['harnesses', 'sourceControl'])
args = parser.parse_args()
manifest = json.loads(args.manifest.read_text())
bin_dir = args.prefix / 'bin'
bin_dir.mkdir(parents=True, exist_ok=True)
sections = [args.section] if args.section else ['harnesses', 'sourceControl']
for section in sections:
    for name, artifact in manifest[section].items():
        kind = artifact['kind']
        if kind not in ('binary', 'tar.gz', 'deb', 'wheel'):
            continue
        expected = artifact['sha256']
        if len(expected) != 64 or not artifact['url'].startswith('https://'):
            raise ValueError(f'Invalid pinned artifact: {name}')
        with tempfile.TemporaryDirectory(prefix='t3-artifact-') as temporary:
            download = Path(temporary) / 'artifact'
            digest = hashlib.sha256()
            with urllib.request.urlopen(artifact['url'], timeout=120) as response, download.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f'Checksum mismatch: {name}')
            if kind == 'deb':
                subprocess.run(['dpkg-deb', '--extract', str(download), str(args.prefix / name)], check=True)
            elif kind == 'wheel':
                directory = args.prefix / 'extensions' / artifact['directory']
                directory.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(download) as archive:
                    for entry in archive.infolist():
                        if not (directory / entry.filename).resolve().is_relative_to(directory.resolve()):
                            raise ValueError(f'Archive path escapes destination: {name}')
                    archive.extractall(directory)
            else:
                installed = bin_dir / artifact['binary']
                if kind == 'binary':
                    shutil.copyfile(download, installed)
                else:
                    with tarfile.open(download, 'r:gz') as archive:
                        entry = archive.getmember(artifact['member'])
                        if not entry.isfile():
                            raise ValueError(f'Expected regular executable: {name}')
                        with archive.extractfile(entry) as source, installed.open('wb') as output:
                            shutil.copyfileobj(source, output)
                installed.chmod(0o755)
            print(f'Installed {name} {artifact["version"]}')
