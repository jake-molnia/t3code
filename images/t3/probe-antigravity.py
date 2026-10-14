#!/usr/bin/env python3
"""Check Google's native ACP executable without signing in or sending a prompt."""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time


def probe(executable, version):
    with tempfile.TemporaryDirectory(prefix='t3-antigravity-probe-') as root:
        profile = Path(root) / 'profile'
        profile.mkdir()
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('GOOGLE_', 'GEMINI_', 'AGY_ACP_'))}
        environment.update(GEMINI_HOME=str(profile), TMPDIR=root,
                           ANTIGRAVITY_HARNESS_PATH=str(executable.parent / 'localharness_external'),
                           AGY_ACP_FORCE_FILE_STORAGE='1', BROWSER='/bin/false')
        with tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen([str(executable), '--uid='], cwd=root, env=environment,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=stderr, start_new_session=True)
            try:
                request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                    'protocolVersion': 1, 'clientCapabilities': {},
                    'clientInfo': {'name': 't3-image-check', 'version': '1.0.0'}}}
                process.stdin.write((json.dumps(request) + '\n').encode())
                process.stdin.flush()
                deadline = time.monotonic() + 90
                pending = b''
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while time.monotonic() < deadline:
                        if not selector.select(timeout=max(0, deadline - time.monotonic())):
                            break
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            raise RuntimeError('Antigravity exited before initialize completed')
                        pending += chunk
                        if len(pending) > 1024 * 1024:
                            raise RuntimeError('Unexpected Antigravity initialize output size')
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            response = json.loads(line)
                            if response.get('id') != 1:
                                continue
                            result = response.get('result', {})
                            info = result.get('agentInfo', {})
                            if info.get('name') != 'antigravity-acp' or version not in info.get('version', ''):
                                raise RuntimeError('Antigravity identity/version differs from the image manifest')
                            methods = [method['id'] for method in result.get('authMethods', [])]
                            if 'oauth-personal' not in methods:
                                raise RuntimeError('Antigravity does not offer Google authentication')
                            return {'agent': info, 'protocolVersion': result['protocolVersion'],
                                    'authMethods': methods, 'authenticated': False}
                raise TimeoutError('Antigravity initialize timed out')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('version')
    args = parser.parse_args()
    print(json.dumps(probe(args.executable.resolve(), args.version)))
