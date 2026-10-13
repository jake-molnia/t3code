#!/usr/bin/env python3
"""Boot the packaged worker in an isolated home and verify authenticated readiness."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('package', type=Path)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='t3-worker-smoke-') as temporary:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = {
        'PATH': os.environ['PATH'], 'HOME': temporary,
        'T3_WORKSPACE_ID': 'package-test', 'T3_ALLOCATION_ID': '1',
        'T3_ALLOCATION_GENERATION': '1', 'T3_POD_UID': 'test-pod',
        'T3_WORKER_TOKEN': token, 'T3_WORKER_PORT': str(port),
        'T3_WORKSPACE_ROOT': temporary, 'T3_WORKER_STATE_DIR': temporary + '/.worker',
    }
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen(['node', str(args.package.resolve() / 'dist/execution-worker.mjs')], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError('Packaged worker exited: ' + log.read()[-4000:])
                try:
                    request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/identity', headers={'Authorization': 'Bearer ' + token})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        identity = json.load(response)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(.1)
            assert identity['workspaceId'] == 'package-test'
            assert identity['protocolVersion'] == 1
            assert not list(Path(temporary).rglob('*.sqlite')), 'Worker created a conversation database'
            print('Packaged worker readiness verified; no T3 SQLite created.')
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
