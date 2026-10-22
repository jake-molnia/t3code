#!/usr/bin/env python3
"""Exercise smoke commands with transport fixtures that enforce gateway configuration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DIRECTORY = Path(__file__).resolve().parent
DOCKER = '''import os, sys
args = sys.argv[1:]
if args[0] == 'run':
    assert args[args.index('--network') + 1] == 'none'
    forwarded = [args[index + 1] for index, argument in enumerate(args) if argument == '--env']
    assert 'T3_GATEWAY_API_KEY' in forwarded and os.environ.get('T3_GATEWAY_API_KEY'), 'Missing shared gateway key'
    if args[-1] == 'worker-fixture':
        assert 'T3_GATEWAY_URL' in forwarded and os.environ.get('T3_GATEWAY_URL') == 'http://127.0.0.1:9', 'Missing isolated gateway URL'
elif args[0] == 'inspect':
    print('true')
'''
NODE = '''import http.server, json, os
from pathlib import Path
assert os.environ.get('T3_GATEWAY_URL') == 'http://127.0.0.1:9', 'Missing isolated gateway URL'
assert os.environ.get('T3_GATEWAY_API_KEY'), 'Missing shared gateway key'
manifest = Path(os.environ['T3_GATEWAY_HARNESS_CONFIG_FILE'])
assert json.loads(manifest.read_text())['codex']['config']['setupMode'] == 'existing'
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.headers['Authorization'] == 'Bearer ' + os.environ['T3_WORKER_TOKEN']
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'workspaceId': 'package-test', 'protocolVersion': 1}).encode())
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', int(os.environ['T3_WORKER_PORT'])), Handler).serve_forever()
'''

PROXY = """import http.server, json, sys
from pathlib import Path
config = json.loads(Path(sys.argv[2]).read_text())
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.headers['Authorization'] == 'Bearer ' + config['management']['secret-key']
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"files":[]}')
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', config['server']['port']), Handler).serve_forever()
"""
HEAD_NODE = """import http.server, os, sys, urllib.request
assert os.environ['T3_GATEWAY_API_KEY']
assert 'AGENT_RUNTIME_URL' not in os.environ
assert 'AGENT_RUNTIME_TOKEN' not in os.environ
assert 'T3_EXECUTION_POOLS_FILE' not in os.environ
request = urllib.request.Request(os.environ['T3_GATEWAY_MANAGEMENT_URL'] + '/v8/management/credentials',
                                headers={'Authorization': 'Bearer ' + os.environ['T3_GATEWAY_MANAGEMENT_KEY']})
with urllib.request.urlopen(request) as response: assert response.status == 200
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'<html>fixture</html>')
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[sys.argv.index('--port') + 1])), Handler).serve_forever()
"""


class SmokeConfigurationTests(unittest.TestCase):
    def executable(self, directory, name, code):
        path = directory / name
        path.write_text('#!' + sys.executable + '\n' + code)
        path.chmod(0o700)

    def test_exported_images_supply_gateway_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.executable(directory, 'docker', DOCKER)
            environment = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH'])
            for target, image in [('t3-worker', 'worker-fixture'), ('t3-web', 'head-fixture')]:
                with self.subTest(target=target):
                    result = subprocess.run([sys.executable, str(DIRECTORY / 'smoke-image.py'), target, image],
                                            env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_packaged_worker_uses_shipped_gateway_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.executable(directory, 'node', NODE)
            manifest = (DIRECTORY / 'harness-configs/gateway.json').read_text()
            (directory / 'gateway-harnesses.json').write_text(manifest)
            environment = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH'])
            result = subprocess.run([sys.executable, str(DIRECTORY / 'smoke-worker.py'), str(directory)],
                                    env=environment, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_packaged_head_starts_gateway_before_web(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.executable(directory, 'node', HEAD_NODE)
            self.executable(directory, 'proxy', PROXY)
            (directory / 'head-entrypoint.py').write_text((DIRECTORY / 'head-entrypoint.py').read_text())
            client = directory / 'dist/client'
            client.mkdir(parents=True)
            (client / 'index.html').write_text('<html>fixture</html>')
            environment = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH'],
                               T3_CLIPROXY_BINARY=str(directory / 'proxy'))
            result = subprocess.run([sys.executable, str(DIRECTORY / 'smoke-web.py'), str(directory)],
                                    env=environment, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
