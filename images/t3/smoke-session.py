#!/usr/bin/env python3
"""Verify the running T3 worker against its real IDE, terminal, and desktop."""
import base64
import json
import os
from pathlib import Path
import re
import shlex
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def verify():
    origin = 'http://127.0.0.1:' + os.environ.get('T3_WORKER_PORT', '8083')
    headers = {'Authorization': 'Bearer ' + os.environ['T3_WORKER_TOKEN']}
    root = Path(os.environ.get('T3_WORKSPACE_ROOT', '/workspace'))

    def request(path, body=None, extra=None):
        h = {**headers, **(extra or {})}
        if body is not None:
            h['Content-Type'] = 'application/json'
        return urllib.request.urlopen(urllib.request.Request(origin + path,
            data=None if body is None else json.dumps(body).encode(), headers=h), timeout=30)

    with request('/v1/identity') as response:
        identity = json.load(response)

    def call(method, value):
        with request('/v1/operations', {'identity': identity,
            'operationId': str(uuid.uuid4()), 'method': method, 'input': value}) as response:
            result = json.load(response)
        assert result['ok'], (method, result)
        return result['value']

    status = call('computer.status', {})
    assert status['available'] and status['resolution'] == {'width': 1440, 'height': 900}, status
    for action in [{'kind': 'wait', 'seconds': 0}, {'kind': 'move', 'x': 450, 'y': 450},
                   {'kind': 'scroll', 'dx': 0, 'dy': 1}]:
        assert call('computer.action', action)['ok']
    shot = call('computer.screenshot', {})['screenshot']
    assert base64.b64decode(shot['data']).startswith(b'\x89PNG\r\n\x1a\n')
    assert shot['width'] == 1440 and shot['height'] == 900

    ide_headers = {'x-t3-ide-identity': json.dumps(identity),
                   'x-forwarded-host': 'session.ide.example.com',
                   'x-forwarded-prefix': '/api/sandbox-ide/session',
                   'x-t3-ide-base': '/api/sandbox-ide/session/'}
    with request('/v1/ide/?folder=' + urllib.parse.quote(str(root)), extra=ide_headers) as response:
        html = response.read().decode()
    assert '<html' in html.lower() and 'vscode' in html.lower()
    assets = re.findall(r'(?:src|href)="([^\"]+\.(?:js|css)(?:\?[^\"]*)?)"', html)
    assert assets, 'IDE HTML has no script or stylesheet references'
    for asset in assets[:2]:
        resolved = urllib.parse.urljoin('http://ide/', asset)
        parsed = urllib.parse.urlsplit(resolved)
        assert parsed.netloc == 'ide', 'IDE depends on an external asset'
        with request('/v1/ide' + parsed.path + ('?' + parsed.query if parsed.query else ''), extra=ide_headers) as response:
            assert response.status == 200 and response.read(32), asset
    stale = {**identity, 'generation': identity['generation'] + 1}
    try:
        request('/v1/ide/', extra={**ide_headers, 'x-t3-ide-identity': json.dumps(stale)})
        raise AssertionError('stale IDE identity accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 409

    endpoint = urllib.parse.urlsplit(origin)
    with socket.create_connection((endpoint.hostname, endpoint.port), timeout=5) as connection:
        ws_headers = {**headers, **ide_headers, 'Host': endpoint.netloc,
            'Origin': 'https://session.ide.example.com', 'Connection': 'Upgrade',
            'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': base64.b64encode(os.urandom(16)).decode()}
        target = '/v1/ide/?reconnectionToken=' + str(uuid.uuid4()) + '&reconnection=false&skipWebSocketFrames=false'
        connection.sendall(('GET ' + target + ' HTTP/1.1\r\n' + ''.join(
            key + ': ' + value + '\r\n' for key, value in ws_headers.items()) + '\r\n').encode())
        response = b''
        while b'\r\n\r\n' not in response and len(response) < 65536:
            part = connection.recv(4096)
            assert part, 'IDE WebSocket closed before upgrade'
            response += part
        assert response.startswith(b'HTTP/1.1 101'), response[:150]

    terminal = {'threadId': 'session-proof', 'terminalId': 'term-proof'}
    marker = root / ('terminal-proof-' + uuid.uuid4().hex)
    try:
        call('terminals.open', {**terminal, 'cwd': '.', 'cols': 80, 'rows': 24,
            'env': {'DISPLAY': ':wrong', 'XAUTHORITY': '/wrong'}})
        command = "printf '%s\\n' \"$DISPLAY\" \"$XAUTHORITY\" \"$HOME\" > " + shlex.quote(str(marker)) + '\n'
        call('terminals.write', {**terminal, 'data': command})
        deadline = time.monotonic() + 10
        lines = []
        while time.monotonic() < deadline:
            if marker.exists():
                lines = marker.read_text().splitlines()
                if len(lines) == 3:
                    break
            time.sleep(.05)
        assert len(lines) == 3, 'T3 terminal did not write its environment proof'
        assert lines[0] == ':99' and lines[1].endswith('/Xauthority'), lines
        assert lines[2] == os.environ['HOME'], lines
    finally:
        call('terminals.close', terminal)
        marker.unlink(missing_ok=True)
    print('T3 session passed: real IDE HTML/assets/WebSocket, stale-identity rejection, desktop tools, and terminal display binding.')


if __name__ == '__main__':
    verify()
