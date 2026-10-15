#!/usr/bin/env python3
"""Run the bundled account gateway and central T3 server as one supervised unit."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.request


def resolve_base_dir(environment, arguments):
    # Match serve's --base-dir > T3CODE_HOME > ~/.t3 precedence and path expansion.
    # --home-dir belongs to the dev runner, not the server CLI.
    selected = environment.get('T3CODE_HOME')
    arguments = iter(arguments)
    for argument in arguments:
        if argument == '--':
            break
        if argument == '--base-dir':
            selected = next(arguments, None)
            if selected is None or selected.startswith('--'):
                raise ValueError('--base-dir requires a path')
        elif argument.startswith('--base-dir='):
            selected = argument.split('=', 1)[1]
    home_directory = environment.get('HOME') or str(Path.home())
    selected = selected.strip() if selected else ''
    if not selected:
        selected = os.path.join(home_directory, '.t3')
    elif selected == '~':
        selected = home_directory
    elif selected.startswith(('~/', '~\\')):
        selected = os.path.join(home_directory, selected[2:])
    return Path(os.path.abspath(selected))


def configure(environment, arguments=()):
    directory = resolve_base_dir(environment, arguments) / 'model-gateway'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (directory / 'supervisor.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credentials_path = directory / 'keys.json'
        if credentials_path.exists():
            credentials = json.loads(credentials_path.read_text())
        else:
            credentials = {'management': secrets.token_urlsafe(48), 'inference': secrets.token_urlsafe(48),
                           'port': int(environment.get('T3_CLIPROXY_PORT', '8317'))}
            for key, variable in [('management', 'T3_GATEWAY_MANAGEMENT_KEY'), ('inference', 'T3_GATEWAY_API_KEY')]:
                credentials[key] = environment.get(variable) or credentials[key]
            temporary = directory / 'keys.json.tmp'
            temporary.write_text(json.dumps(credentials))
            temporary.chmod(0o600)
            temporary.replace(credentials_path)
        for key, variable in [('management', 'T3_GATEWAY_MANAGEMENT_KEY'), ('inference', 'T3_GATEWAY_API_KEY')]:
            supplied = environment.get(variable)
            if supplied and supplied != credentials[key]:
                raise ValueError(f'{variable} differs from the persisted gateway key')
            environment[variable] = credentials[key]
        port = credentials['port']
        if 'T3_CLIPROXY_PORT' in environment and int(environment['T3_CLIPROXY_PORT']) != port:
            raise ValueError('T3_CLIPROXY_PORT differs from the persisted gateway port')
        environment['T3_GATEWAY_MANAGEMENT_URL'] = f'http://127.0.0.1:{port}'
        config = {
            'server': {'host': '127.0.0.1', 'port': port},
            'management': {'allow-remote': False, 'secret-key': credentials['management'],
                           'disable-control-panel': True, 'disable-auto-update-panel': True},
            'access': {'api-keys': [credentials['inference']]},
            'oauth': {'auth-dir': str(directory / 'accounts')},
        }
        # CLIProxyAPI owns subsequent edits, including endpoint groups and hashed keys.
        # JSON is valid YAML for the initial configuration.
        config_path = directory / 'config.yaml'
        if not config_path.exists():
            temporary = directory / 'config.yaml.tmp'
            temporary.write_text(json.dumps(config))
            temporary.chmod(0o600)
            temporary.replace(config_path)
        return config_path, lock
    except BaseException:
        lock.close()
        raise


def signal_child_group(child, signum):
    # Popen starts each service in its own session; this never targets our group.
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass


def stop_children(children):
    pending = list(children)
    for child in pending:
        signal_child_group(child, signal.SIGTERM)
    deadline = time.monotonic() + 10
    while pending:
        for child in list(pending):
            if child.poll() is not None:
                # The subreaper adopts orphaned descendants, even if their service exited first.
                try:
                    while os.waitpid(-child.pid, os.WNOHANG)[0] > 0:
                        pass
                except ChildProcessError:
                    pass
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                pending.remove(child)
        if not pending:
            return
        if deadline is not None and time.monotonic() >= deadline:
            for child in pending:
                signal_child_group(child, signal.SIGKILL)
            deadline = None
        time.sleep(0.05)


def run(arguments):
    os.umask(0o077)
    environment = dict(os.environ)
    config, lock = configure(environment, arguments)
    children = []
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        # Linux PR_SET_CHILD_SUBREAPER keeps orphaned service children here until reaped.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Could not enable child process reaping')
        proxy = subprocess.Popen([environment.get('T3_CLIPROXY_BINARY', '/usr/local/bin/cliproxyapi'),
                                  '-config', str(config)], env=environment, start_new_session=True)
        children.append(proxy)
        deadline = time.monotonic() + 30
        while not stopping:
            if proxy.poll() is not None:
                raise RuntimeError('Account gateway exited before becoming ready')
            try:
                request = urllib.request.Request(environment['T3_GATEWAY_MANAGEMENT_URL'] + '/v8/management/credentials',
                                                 headers={'Authorization': 'Bearer ' + environment['T3_GATEWAY_MANAGEMENT_KEY']})
                with urllib.request.urlopen(request, timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('Account gateway did not become ready')
            time.sleep(0.05)
        if stopping:
            return 0
        server = subprocess.Popen(arguments, env=environment, start_new_session=True)
        children.append(server)
        while not stopping:
            proxy_code = proxy.poll()
            if proxy_code is not None:
                # A clean gateway exit still means the head cannot serve requests.
                return proxy_code if proxy_code > 0 else 1
            server_code = server.poll()
            if server_code is not None:
                return server_code if server_code >= 0 else 128 - server_code
            time.sleep(0.05)
        return 0
    finally:
        try:
            stop_children(children)
        finally:
            lock.close()


if __name__ == '__main__':
    try:
        sys.exit(run(sys.argv[1:] or ['node', '/opt/t3/dist/bin.mjs']))
    except (OSError, ValueError, RuntimeError) as error:
        print(f't3 head: {error}', file=sys.stderr)
        sys.exit(1)
