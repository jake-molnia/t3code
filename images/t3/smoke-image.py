#!/usr/bin/env python3
"""Boot an exported image through its real entrypoint with deployment restrictions."""
import argparse
import os
import secrets
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('target', choices=['t3-worker', 't3-web'])
parser.add_argument('image')
args = parser.parse_args()
worker = args.target == 't3-worker'
name = 't3-image-smoke-' + secrets.token_hex(8)
env = dict(os.environ)
env.update({
    'T3_WORKSPACE_ID': 'image-smoke', 'T3_ALLOCATION_ID': '1',
    'T3_ALLOCATION_GENERATION': '1', 'T3_POD_UID': 'smoke-pod',
    'T3_WORKER_TOKEN': secrets.token_urlsafe(32),
    'SANDBOX_CHROMIUM_SANDBOX': 'disabled',
    'AGENT_RUNTIME_URL': 'http://127.0.0.1:9',
    'AGENT_RUNTIME_TOKEN': secrets.token_urlsafe(32),
    'T3_MCP_ADVERTISED_URL': 'http://127.0.0.1:3773/mcp',
})
variables = (
    ['T3_WORKSPACE_ID', 'T3_ALLOCATION_ID', 'T3_ALLOCATION_GENERATION', 'T3_POD_UID', 'T3_WORKER_TOKEN', 'SANDBOX_CHROMIUM_SANDBOX']
    if worker else ['AGENT_RUNTIME_URL', 'AGENT_RUNTIME_TOKEN', 'T3_MCP_ADVERTISED_URL']
)
command = [
    'docker', 'run', '--detach', '--name', name, '--network', 'none',
    '--user', '0:0' if worker else '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--tmpfs', ('/workspace:rw,uid=0,gid=0,mode=0700' if worker else '/data:rw,uid=1000,gid=1000,mode=0700'),
]
if not worker:
    command.append('--read-only')
else:
    for capability in ('CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID'):
        command.extend(['--cap-add', capability])
for variable in variables:
    command.extend(['--env', variable])
command.append(args.image)
probe = r'''
import json, os, urllib.request, urllib.error
from pathlib import Path
request = urllib.request.Request('http://127.0.0.1:8083/v1/identity', headers={'Authorization': 'Bearer ' + os.environ['T3_WORKER_TOKEN']})
with urllib.request.urlopen(request, timeout=2) as response:
    identity = json.load(response)
assert identity['workspaceId'] == 'image-smoke'
assert identity['podUid'] == 'smoke-pod'
assert identity['protocolVersion'] == 1
with urllib.request.urlopen('http://127.0.0.1:8085/healthz', timeout=2) as response:
    assert json.load(response)['status'] in ('alive', 'expired')
with urllib.request.urlopen('http://127.0.0.1:8085/?folder=/workspace', timeout=3) as response:
    assert '<html' in response.read().decode().lower()
with urllib.request.urlopen('http://127.0.0.1:18091/v2/computer/info', timeout=2) as response:
    assert json.load(response)['data']['available'] is True
with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=2) as response:
    assert json.load(response)['webSocketDebuggerUrl'].startswith('ws://127.0.0.1:9222/')
try:
    urllib.request.urlopen('http://127.0.0.1:8083/v1/identity', timeout=2)
    raise AssertionError('Unauthenticated worker identity was accepted')
except urllib.error.HTTPError as error:
    assert error.code == 401
assert not [p for p in Path('/workspace').rglob('*') if p.name in ('state.sqlite', 'statev2.sqlite')], 'Worker created T3 conversation state'
''' if worker else r'''
import urllib.request
with urllib.request.urlopen('http://127.0.0.1:3773/', timeout=2) as response:
    assert '<html' in response.read().decode().lower()
'''
try:
    subprocess.run(command, env=env, check=True, capture_output=True, text=True)
    deadline = time.monotonic() + 180
    while True:
        status = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', name], check=True, capture_output=True, text=True)
        if status.stdout.strip() != 'true':
            raise RuntimeError('Container exited before becoming ready')
        result = subprocess.run(['docker', 'exec', name, 'python3', '-c', probe], capture_output=True, text=True)
        if result.returncode == 0:
            if worker:
                subprocess.run(['docker', 'exec', name, 'python3', '/opt/t3/smoke-session.py'], check=True)
            print(f'{args.target} real entrypoint passed with deployment user/filesystem/capability settings and no external network.')
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('Image did not become ready: ' + result.stderr[-2000:])
        time.sleep(.5)
    if worker:
        verification = r"""
import base64, json, os, tempfile, urllib.request
assert os.getuid() == 0
with tempfile.NamedTemporaryFile() as f:
    os.chown(f.name, 1000, 1000)
    assert os.stat(f.name).st_uid == 1000
child = os.fork()
if child == 0:
    os.setgid(1000)
    os.setuid(1000)
    os._exit(0)
assert os.waitpid(child, 0)[1] == 0
headers = {'Authorization': 'Bearer ' + os.environ['T3_WORKER_TOKEN'], 'Content-Type': 'application/json'}
with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8083/v1/identity', headers=headers)) as response:
    identity = json.load(response)
request = urllib.request.Request('http://127.0.0.1:8083/v1/operations', headers=headers, data=json.dumps({'identity': identity, 'operationId': 'image-browser-smoke', 'method': 'html.preview', 'input': {'html': '<h1>T3 sandbox preview</h1>', 'width': 640}}).encode())
with urllib.request.urlopen(request, timeout=45) as response:
    result = json.load(response)
assert result['ok'], result
assert base64.b64decode(result['value']['png']).startswith(b'\x89PNG\r\n\x1a\n')
assert result['value']['width'] == 640
print('Worker root operations and native Chromium preview passed.')
"""
        subprocess.run(['docker', 'exec', name, 'python3', '-c', verification], check=True, timeout=60)
except Exception:
    logs = subprocess.run(['docker', 'logs', '--tail', '100', name], capture_output=True, text=True)
    output = logs.stdout + logs.stderr
    for variable in ('T3_WORKER_TOKEN', 'AGENT_RUNTIME_TOKEN'):
        output = output.replace(env[variable], '[redacted]')
    print(output[-8000:])
    raise
finally:
    subprocess.run(['docker', 'rm', '--force', name], capture_output=True)
