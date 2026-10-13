#!/usr/bin/env python3
"""Boot the bundled central web app with disposable state, without opening a browser."""
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
package = args.package.resolve()
assert (package / 'dist/client/index.html').is_file(), 'Bundled web client is missing'
with tempfile.TemporaryDirectory(prefix='t3-web-smoke-') as temporary:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {'PATH': os.environ['PATH'], 'HOME': temporary,
           'AGENT_RUNTIME_URL': 'http://127.0.0.1:9', 'AGENT_RUNTIME_TOKEN': secrets.token_urlsafe(32),
           'T3_MCP_ADVERTISED_URL': 'http://example.invalid'}
    # A killed container can leave a runtime PID that belongs to an unrelated
    # process after restart. Interactive `start` refuses it; supervised `serve`
    # must still acquire the real server lock and boot this retained state.
    state = Path(temporary) / 'userdata'
    state.mkdir()
    (state / 'server-runtime.json').write_text(json.dumps({
        'version': 1, 'pid': os.getpid(), 'port': port,
        'origin': f'http://127.0.0.1:{port}', 'startedAt': '2026-10-01T00:00:00Z',
    }))
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen(['node', str(package / 'dist/bin.mjs'), 'serve', '--host', '127.0.0.1', '--port', str(port), '--no-browser', '--base-dir', temporary], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError('Central web exited: ' + log.read()[-4000:])
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=1) as response:
                        html = response.read().decode()
                    assert '<html' in html.lower()
                    print('Bundled central web served HTML despite an unrelated live PID in retained runtime state.')
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        log.seek(0)
                        raise RuntimeError('Central web did not become ready: ' + log.read()[-4000:])
                    time.sleep(.1)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
