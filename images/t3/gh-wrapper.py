#!/usr/bin/env python3
"""Supply rotated, host-scoped projected credentials to the pinned GitHub CLI."""
import os
import subprocess
import sys
from urllib.parse import urlsplit

REAL_GH = '/opt/native/bin/gh'
CREDENTIAL_HELPER = '/usr/local/bin/t3-git-credential'


def option_values(arguments, long_name, short_name=None):
    values = []
    for index, argument in enumerate(arguments):
        if argument == '--':
            break
        if argument == long_name or (short_name and argument == short_name):
            if index + 1 >= len(arguments):
                raise ValueError()
            values.append(arguments[index + 1])
        elif argument.startswith(long_name + '='):
            values.append(argument[len(long_name) + 1:])
        elif short_name and argument.startswith(short_name) and len(argument) > len(short_name):
            values.append(argument[len(short_name):].removeprefix('='))
    return values


def valid_host(host):
    return bool(host) and not any(character.isspace() or character in '/@?#\\\x00' for character in host)


def repository_host(value):
    if '://' in value:
        return urlsplit(value).netloc.rsplit('@', 1)[-1]
    if value.startswith('git@') and ':' in value:
        return value[4:].split(':', 1)[0]
    parts = value.split('/')
    return parts[0] if len(parts) >= 3 else None


def build_env(arguments, environment, credential_helper=CREDENTIAL_HELPER):
    result = dict(environment)
    hosts = option_values(arguments, '--hostname')
    if len(set(hosts)) > 1:
        return result
    host = hosts[-1] if hosts else (environment.get('GH_HOST') or 'github.com')
    if not valid_host(host):
        raise ValueError()
    public = host == 'github.com' or host.endswith('.ghe.com')
    token_name = 'GH_TOKEN' if public else 'GH_ENTERPRISE_TOKEN'
    fallback_name = 'GITHUB_TOKEN' if public else 'GITHUB_ENTERPRISE_TOKEN'
    if environment.get(token_name) or environment.get(fallback_name):
        return result
    if not environment.get('T3_GIT_CREDENTIALS_FILE'):
        return result

    repositories = option_values(arguments, '--repo', '-R')
    if not repositories and environment.get('GH_REPO'):
        repositories = [environment['GH_REPO']]
    targets = [repository_host(value) for value in repositories]
    # PR/issue URLs and positional repo clone/view targets also override gh's host.
    targets.extend(urlsplit(value).netloc for value in arguments if value.startswith(('https://', 'http://')))
    if arguments and arguments[0] == 'repo':
        targets.extend(repository_host(value) for value in arguments[2:] if not value.startswith('-'))
    if any(target and target != host for target in targets):
        return result

    # gh shares token variables across hosts and can infer a repository from Git
    # even when GH_HOST is supplied. Only inject for unambiguous matching remotes.
    if not repositories and arguments and arguments[0] not in ('api', 'auth'):
        remotes = subprocess.run(['git', 'remote', '-v'], env=environment, capture_output=True, text=True, check=False)
        if remotes.returncode == 0:
            remote_hosts = [repository_host(line.split()[1]) for line in remotes.stdout.splitlines() if len(line.split()) >= 2]
            if any(target != host for target in remote_hosts):
                return result

    credential = subprocess.run(
        [sys.executable, credential_helper, 'get'],
        input=f'protocol=https\nhost={host}\n\n',
        env=environment, capture_output=True, text=True, check=False,
    )
    if credential.returncode != 0:
        raise ValueError()
    fields = dict(line.split('=', 1) for line in credential.stdout.splitlines() if '=' in line)
    token = fields.get('password')
    if token:
        result[token_name] = token
    return result


def execute(arguments, environment=None, real_binary=REAL_GH, credential_helper=CREDENTIAL_HELPER):
    try:
        variables = build_env(arguments, os.environ if environment is None else environment, credential_helper)
        os.execve(real_binary, [real_binary, *arguments], variables)
    except (OSError, ValueError):
        sys.stderr.write('GitHub CLI credential setup or executable is unavailable.\n')
        return 1


if __name__ == '__main__':
    sys.exit(execute(sys.argv[1:]))
