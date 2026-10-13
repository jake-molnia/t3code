#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class GitHubWrapperTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.profile = self.root / 'credentials.json'
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), 'T3_GIT_CREDENTIALS_FILE': str(self.profile)}
        self.secret = 'projected-secret-not-for-argv-or-logs'
        self.write_token('github.com', self.secret)
        self.fake = self.root / 'gh-real'
        self.fake.write_text('#!/usr/bin/env python3\nimport hashlib,json,os,sys\nprint(json.dumps({"args":sys.argv[1:],"tokens":{key:hashlib.sha256(os.environ[key].encode()).hexdigest() for key in ("GH_TOKEN","GH_ENTERPRISE_TOKEN") if key in os.environ}}))\nsys.exit(17)\n')
        self.fake.chmod(0o755)

    def write_token(self, host, token):
        self.profile.write_text(json.dumps({'credentials': [{'protocol': 'https', 'host': host, 'username': 'x-access-token', 'token': token}]}))

    def invoke(self, arguments, **environment):
        code = 'import importlib.util,sys; spec=importlib.util.spec_from_file_location("wrapper",sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); sys.exit(module.execute(sys.argv[4:],real_binary=sys.argv[2],credential_helper=sys.argv[3]))'
        return subprocess.run([sys.executable, '-c', code, str(HERE / 'gh-wrapper.py'), str(self.fake), str(HERE / 'git-credential.py'), *arguments], env={**self.env, **environment}, cwd=self.root, capture_output=True, text=True, check=False)

    def assert_token(self, result, name, token):
        self.assertEqual(result.returncode, 17)
        self.assertEqual(result.stderr, '')
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['tokens'], {name: hashlib.sha256(token.encode()).hexdigest()})

    def test_real_subprocess_receives_token_only_in_environment_and_observes_rotation(self):
        self.assert_token(self.invoke(['api', 'user']), 'GH_TOKEN', self.secret)
        rotated = 'rotated-token-with-new-expiry'
        self.write_token('github.com', rotated)
        result = self.invoke(['api', 'user'])
        self.assert_token(result, 'GH_TOKEN', rotated)
        self.assertEqual(json.loads(result.stdout)['args'], ['api', 'user'])

    def test_exact_enterprise_host_and_hostname_override(self):
        self.write_token('git.example.test:8443', self.secret)
        for arguments, env in [(['api', 'user'], {'GH_HOST': 'git.example.test:8443'}), (['api', '--hostname', 'git.example.test:8443', 'user'], {'GH_HOST': 'other.test'}), (['api', '--hostname=git.example.test:8443', 'user'], {})]:
            self.assert_token(self.invoke(arguments, **env), 'GH_ENTERPRISE_TOKEN', self.secret)
        for host in ['git.example.test', 'other.test']:
            result = self.invoke(['api', '--hostname', host, 'user'])
            self.assertEqual(json.loads(result.stdout)['tokens'], {})

    def test_explicit_credentials_override_projected_credentials(self):
        self.profile.write_text('invalid profile must not be consulted')
        self.assert_token(self.invoke(['api', 'user'], GH_TOKEN='explicit'), 'GH_TOKEN', 'explicit')
        self.assert_token(self.invoke(['api', 'user'], GH_HOST='enterprise.test', GH_ENTERPRISE_TOKEN='explicit-enterprise'), 'GH_ENTERPRISE_TOKEN', 'explicit-enterprise')

    def test_enterprise_credentials_do_not_follow_other_repo_or_api_hosts(self):
        self.write_token('enterprise.test', self.secret)
        for arguments, env in [(['pr', 'list', '-R', 'other.test/owner/repo'], {}), (['pr', 'list', '--repo=other.test/owner/repo'], {}), (['pr', 'list'], {'GH_REPO': 'other.test/owner/repo'}), (['api', 'https://other.test/api/v3/user'], {}), (['pr', 'view', 'https://other.test/owner/repo/pull/1'], {}), (['repo', 'clone', 'other.test/owner/repo'], {})]:
            result = self.invoke(arguments, GH_HOST='enterprise.test', **env)
            self.assertEqual(result.returncode, 17)
            self.assertEqual(json.loads(result.stdout)['tokens'], {})
            self.assertNotIn(self.secret, result.stdout + result.stderr)
        self.assert_token(self.invoke(['pr', 'list', '-R', 'enterprise.test/owner/repo'], GH_HOST='enterprise.test'), 'GH_ENTERPRISE_TOKEN', self.secret)

    def test_git_remote_inference_cannot_send_enterprise_token_to_another_host(self):
        self.write_token('enterprise.test', self.secret)
        subprocess.run(['git', 'init', '-q', str(self.root)], env=self.env, check=True)
        subprocess.run(['git', '-C', str(self.root), 'remote', 'add', 'origin', 'git@other.test:owner/repo.git'], env=self.env, check=True)
        result = self.invoke(['pr', 'list'], GH_HOST='enterprise.test')
        self.assertEqual(json.loads(result.stdout)['tokens'], {})
        self.write_token('github.com', self.secret)
        subprocess.run(['git', '-C', str(self.root), 'remote', 'set-url', 'origin', 'https://other.ghe.com/owner/repo.git'], env=self.env, check=True)
        result = self.invoke(['pr', 'list'])
        self.assertEqual(json.loads(result.stdout)['tokens'], {})

    def test_invalid_profile_and_protocol_injection_fail_without_secret_output(self):
        self.profile.write_text(self.secret)
        for arguments in [['api', 'user'], ['api', '--hostname', 'github.com\nusername=evil', 'user']]:
            result = self.invoke(arguments)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertNotIn(self.secret, result.stderr)
            self.assertEqual(result.stderr, 'GitHub CLI credential setup or executable is unavailable.\n')


if __name__ == '__main__':
    unittest.main()
