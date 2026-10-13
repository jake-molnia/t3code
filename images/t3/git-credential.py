#!/usr/bin/env python3
"""Read exact HTTPS host credentials from an explicitly projected profile Secret."""
import json
import os
from pathlib import Path
import sys


def get_credential():
    if len(sys.argv) != 2 or sys.argv[1] not in ('get', 'store', 'erase'):
        return 1
    if sys.argv[1] != 'get':
        return 0
    filename = os.environ.get('T3_GIT_CREDENTIALS_FILE')
    if not filename:
        return 0
    query = {}
    for line in sys.stdin:
        line = line.rstrip('\n')
        if not line:
            break
        key, separator, value = line.partition('=')
        if separator and key == 'capability[]':
            continue
        if not separator or key in query:
            return 1
        query[key] = value
    if query.get('protocol') != 'https' or not query.get('host'):
        return 0
    try:
        document = json.loads(Path(filename).read_text())
        entries = document['credentials']
        if not isinstance(entries, list):
            raise ValueError()
        seen = set()
        match = None
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'protocol', 'host', 'username', 'token'}:
                raise ValueError()
            if any(not isinstance(value, str) or not value or any(c in value for c in '\r\n\x00') for value in entry.values()):
                raise ValueError()
            if entry['protocol'] != 'https' or any(c in entry['host'] for c in '/@?# '):
                raise ValueError()
            identity = (entry['protocol'], entry['host'])
            if identity in seen:
                raise ValueError()
            seen.add(identity)
            if identity == (query['protocol'], query['host']):
                if query.get('username', entry['username']) == entry['username']:
                    match = entry
        if match:
            sys.stdout.write(f"username={match['username']}\npassword={match['token']}\n\n")
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        sys.stderr.write('Git credential profile is invalid or unreadable.\n')
        return 1


if __name__ == '__main__':
    sys.exit(get_credential())
