#!/usr/bin/env python3
"""Exercise persistent gateway configuration and the head process lifecycle."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import unittest

ENTRYPOINT = Path(__file__).with_name('head-entrypoint.py')
spec = importlib.util.spec_from_file_location('head_entrypoint', ENTRYPOINT)
head = importlib.util.module_from_spec(spec)
spec.loader.exec_module(head)

FAKE_PROXY = '''#!/usr/bin/env python3
import http.server, json, os, signal, sys
from pathlib import Path
config = json.loads(Path(sys.argv[2]).read_text())
Path(os.environ['PROXY_PID_FILE']).write_text(str(os.getpid()))
if os.environ.get('PROXY_FAIL'):
    sys.exit(23)
signal.signal(signal.SIGUSR1, lambda *_: sys.exit(0))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        expected = 'Bearer ' + config['management']['secret-key']
        self.send_response(200 if self.headers.get('Authorization') == expected else 401)
        self.end_headers()
        self.wfile.write(b'{"files":[]}')
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', config['server']['port']), Handler)
server.serve_forever()
'''

APP = '''import json, os, pathlib, sys, time
pathlib.Path(os.environ['APP_PID_FILE']).write_text(str(os.getpid()))
pathlib.Path(os.environ['APP_PID_FILE'] + '.arguments').write_text(json.dumps(sys.argv[1:]))
assert os.environ['T3_GATEWAY_MANAGEMENT_URL'].startswith('http://127.0.0.1:')
assert os.environ['T3_GATEWAY_MANAGEMENT_KEY'] and os.environ['T3_GATEWAY_API_KEY']
print('server-ready', flush=True)
if os.environ.get('APP_FAIL'): sys.exit(24)
if os.environ.get('APP_SUCCESS'): sys.exit(0)
while True: time.sleep(10)
'''


DESCENDANT = """import os, signal, time
if os.environ.get('IGNORE_TERM'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(os.getpid(), flush=True)
while True: time.sleep(10)
"""
SPAWN_DESCENDANT = """import subprocess
if os.environ.get('SPAWN_DESCENDANTS'):
    descendant = subprocess.Popen([sys.executable, '-c', %r], stdout=subprocess.PIPE, text=True)
    descendant_pid = descendant.stdout.readline().strip()
    descendant.stdout.close()
    from pathlib import Path
    Path(os.environ[PID_VARIABLE] + '.descendant').write_text(descendant_pid)
""" % DESCENDANT
FAKE_PROXY = FAKE_PROXY.replace("class Handler", SPAWN_DESCENDANT.replace('PID_VARIABLE', "'PROXY_PID_FILE'") + "\nclass Handler")
APP = APP.replace("print('server-ready'", SPAWN_DESCENDANT.replace('PID_VARIABLE', "'APP_PID_FILE'") + "\nprint('server-ready'")


class HeadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Adopt test descendants on a regression so fixture cleanup can reap them.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Could not enable test subreaper')

    def reap_fixture_descendants(self, pids):
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass

    def descendant_pids(self, directory):
        pids = [int((directory / name).read_text()) for name in ['proxy.pid.descendant', 'app.pid.descendant']]
        self.addCleanup(self.reap_fixture_descendants, pids)
        return pids

    def test_configuration_is_private_and_stable(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = {'T3CODE_HOME': temporary, 'T3_GATEWAY_API_KEY': 'shared-worker-key'}
            config, lock = head.configure(env)
            first = json.loads(config.read_text())
            self.assertEqual(first['server']['host'], '127.0.0.1')
            self.assertFalse(first['management']['allow-remote'])
            self.assertTrue(first['management']['disable-control-panel'])
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(BlockingIOError):
                head.configure({'T3CODE_HOME': temporary})
            lock.close()
            env2 = {'T3CODE_HOME': temporary}
            config2, lock2 = head.configure(env2)
            self.assertEqual(json.loads(config2.read_text()), first)
            self.assertEqual(env2['T3_GATEWAY_API_KEY'], 'shared-worker-key')
            lock2.close()
            # Management writes YAML and adds user endpoint groups. Restart must preserve it.
            managed_yaml = 'openai-compatibility:\n  - name: local-models\n    base-url: https://models.example/v1\n'
            config2.write_text(managed_yaml)
            config3, lock3 = head.configure({'T3CODE_HOME': temporary})
            self.assertEqual(config3.read_text(), managed_yaml)
            lock3.close()
            with self.assertRaisesRegex(ValueError, 'persisted gateway port'):
                head.configure({'T3CODE_HOME': temporary, 'T3_CLIPROXY_PORT': '18317'})
            with self.assertRaisesRegex(ValueError, 'differs from the persisted'):
                head.configure({'T3CODE_HOME': temporary, 'T3_GATEWAY_API_KEY': 'wrong'})

    def test_configuration_matches_server_path_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            environment = {'HOME': temporary, 'T3CODE_HOME': str(directory / 'ambient')}
            cases = [
                (environment, [], directory / 'ambient'),
                ({'HOME': temporary}, [], directory / '.t3'),
                ({'HOME': temporary, 'T3CODE_HOME': '~/from-env'}, [], directory / 'from-env'),
                (environment, ['--base-dir', '~/from-flag'], directory / 'from-flag'),
                (environment, ['--base-dir=~'], directory),
                (environment, ['--base-dir', f'  {directory}/trimmed  '], directory / 'trimmed'),
                (environment, ['--base-dir', os.path.relpath(directory / 'relative')], directory / 'relative'),
                (environment, ['--base-dir='], directory / '.t3'),
            ]
            for env, arguments, expected in cases:
                with self.subTest(arguments=arguments):
                    config, lock = head.configure(dict(env), arguments)
                    try:
                        self.assertEqual(config.parent, expected / 'model-gateway')
                        self.assertEqual(json.loads(config.read_text())['oauth']['auth-dir'],
                                         str(expected / 'model-gateway/accounts'))
                    finally:
                        lock.close()
            for arguments in [['--base-dir'], ['--base-dir', '--port', '3773']]:
                with self.subTest(arguments=arguments), self.assertRaisesRegex(ValueError, 'requires a path'):
                    head.configure(dict(environment), arguments)

    def start(self, directory, arguments=(), **extra):
        proxy = directory / 'proxy.py'
        proxy.write_text(FAKE_PROXY)
        proxy.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, T3CODE_HOME=str(directory / 'state'), T3_CLIPROXY_BINARY=str(proxy),
                   T3_CLIPROXY_PORT=str(port), PROXY_PID_FILE=str(directory / 'proxy.pid'),
                   APP_PID_FILE=str(directory / 'app.pid'), **extra)
        env.pop('T3_GATEWAY_API_KEY', None)
        env.pop('T3_GATEWAY_MANAGEMENT_KEY', None)
        process = subprocess.Popen([sys.executable, str(ENTRYPOINT), sys.executable, '-c', APP, *arguments],
                                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop, process)
        return process

    def stop(self, process):
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=15)

    def ready(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 5)[0], 'server never started')
        self.assertEqual(process.stdout.readline().strip(), 'server-ready')

    def assert_stopped(self, path):
        pid = int(path.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_explicit_base_dir_keeps_gateway_with_server_state(self):
        for equals in [False, True]:
            with self.subTest(equals=equals), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                base = directory / 'mounted state'
                arguments = [f'--base-dir={base}'] if equals else ['--base-dir', str(base)]
                process = self.start(directory, arguments=arguments)
                self.ready(process)
                try:
                    self.assertTrue((base / 'model-gateway/keys.json').is_file())
                    self.assertFalse((directory / 'state/model-gateway').exists())
                    self.assertEqual(json.loads((directory / 'app.pid.arguments').read_text()), arguments)
                finally:
                    self.stop(process)

    def test_signal_stops_both_children(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory)
            self.ready(process)
            process.terminate()
            self.assertEqual(process.wait(timeout=15), 0)
            self.assert_stopped(directory / 'app.pid')
            self.assert_stopped(directory / 'proxy.pid')

    def test_app_exit_stops_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory, APP_FAIL='1')
            self.assertEqual(process.wait(timeout=5), 24)
            self.assert_stopped(directory / 'proxy.pid')

    def test_successful_app_exit_preserves_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory, APP_SUCCESS='1')
            self.assertEqual(process.wait(timeout=5), 0)
            self.assert_stopped(directory / 'proxy.pid')

    def test_signal_stops_and_reaps_service_descendants(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory, SPAWN_DESCENDANTS='1')
            self.ready(process)
            pids = self.descendant_pids(directory)
            for name, descendant in zip(['proxy.pid', 'app.pid'], pids):
                service = int((directory / name).read_text())
                self.assertEqual(os.getpgid(service), service)
                self.assertEqual(os.getpgid(descendant), service)
                self.assertNotEqual(service, os.getpgrp())
            process.terminate()
            self.assertEqual(process.wait(timeout=15), 0)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_app_exit_kills_descendants_that_ignore_term(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory, APP_SUCCESS='1', SPAWN_DESCENDANTS='1', IGNORE_TERM='1')
            self.ready(process)
            pids = self.descendant_pids(directory)
            with self.assertRaises(BlockingIOError):
                head.configure({'T3CODE_HOME': str(directory / 'state')})
            result = process.wait(timeout=15)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            self.assertEqual(result, 0)

    def test_app_signal_exit_preserves_shell_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory)
            self.ready(process)
            os.kill(int((directory / 'app.pid').read_text()), signal.SIGTERM)
            self.assertEqual(process.wait(timeout=5), 128 + signal.SIGTERM)
            self.assert_stopped(directory / 'proxy.pid')

    def test_proxy_clean_exit_is_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory)
            self.ready(process)
            os.kill(int((directory / 'proxy.pid').read_text()), signal.SIGUSR1)
            self.assertEqual(process.wait(timeout=5), 1)
            self.assert_stopped(directory / 'app.pid')

    def test_proxy_failure_prevents_server_start(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory, PROXY_FAIL='1')
            self.assertEqual(process.wait(timeout=5), 1)
            self.assertFalse((directory / 'app.pid').exists())

    def test_proxy_exit_stops_running_server(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            process = self.start(directory)
            self.ready(process)
            # This PID is returned by the test's own child, never found by pattern.
            os.kill(int((directory / 'proxy.pid').read_text()), signal.SIGTERM)
            self.assertEqual(process.wait(timeout=5), 1)
            self.assert_stopped(directory / 'app.pid')

    @unittest.skipUnless(Path(os.environ.get('T3_CLIPROXY_BINARY', '/usr/local/bin/cliproxyapi')).is_file(),
                         'bundled proxy is not installed')
    def test_real_proxy_preserves_endpoint_after_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = Path(temporary) / 'mounted-state'
            env = dict(os.environ, T3_CLIPROXY_PORT=str(port))
            persisted_keys = None
            for mode in ['create', 'read']:
                env['T3CODE_HOME'] = str(Path(temporary) / ('ambient-' + mode))
                arguments = ['--base-dir', str(base)] if mode == 'create' else [f'--base-dir={base}']
                script = """import json, os, sys, urllib.request
origin = os.environ['T3_GATEWAY_MANAGEMENT_URL']
headers = {'Authorization': 'Bearer ' + os.environ['T3_GATEWAY_MANAGEMENT_KEY'], 'Content-Type': 'application/json'}
if sys.argv[1] == 'create':
    groups = [{'name': 'restart-check', 'base-url': 'https://example.invalid/v1',
               'keys': [{'api-key': 'test-only'}], 'models': [{'name': 'model', 'alias': 'model'}]}]
    request = urllib.request.Request(origin + '/v8/management/config/api-keys/openai-compatibility',
                                    data=json.dumps(groups).encode(), headers=headers, method='PUT')
    with urllib.request.urlopen(request) as response: assert response.status == 200
else:
    request = urllib.request.Request(origin + '/v8/management/config', headers=headers)
    with urllib.request.urlopen(request) as response: config = json.load(response)
    assert config['api-keys']['openai-compatibility'][0]['name'] == 'restart-check'
print('gateway-check-passed', flush=True)
"""
                process = subprocess.Popen([sys.executable, str(ENTRYPOINT), sys.executable, '-c', script, mode, *arguments],
                                           env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                try:
                    output, _ = process.communicate(timeout=40)
                    self.assertIn('gateway-check-passed', output, output[-4000:])
                    self.assertEqual(process.returncode, 0, output[-4000:])
                    current_keys = (base / 'model-gateway/keys.json').read_text()
                    if persisted_keys is not None:
                        self.assertEqual(current_keys, persisted_keys)
                    persisted_keys = current_keys
                    self.assertFalse(Path(env['T3CODE_HOME']).exists())
                finally:
                    self.stop(process)


if __name__ == '__main__':
    unittest.main()
