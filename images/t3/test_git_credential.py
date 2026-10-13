#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent

class CredentialTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.file = self.root / 'credentials.json'
        self.token = 'test-secret-must-not-be-logged'
        self.document = {'credentials': [{'protocol': 'https', 'host': 'git.example.test:8443', 'username': 'example', 'token': self.token}]}
        self.file.write_text(json.dumps(self.document))
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), 'T3_GIT_CREDENTIALS_FILE': str(self.file), 'GIT_TERMINAL_PROMPT': '0'}

    def helper(self, action='get', query='protocol=https\nhost=git.example.test:8443\n\n'):
        return subprocess.run(['python3', str(HERE / 'git-credential.py'), action], input=query, capture_output=True, text=True, env=self.env, check=False)

    def test_get_only_discloses_exact_host_protocol_and_user(self):
        result = self.helper()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, f'username=example\npassword={self.token}\n\n')
        self.assertEqual(result.stderr, '')
        for query in ['protocol=http\nhost=git.example.test:8443\n', 'protocol=https\nhost=git.example.test\n', 'protocol=https\nhost=other.test\n', 'protocol=https\nhost=git.example.test:8443\nusername=another\n']:
            result = self.helper(query=query)
            self.assertEqual(result.stdout, '')
            self.assertNotIn(self.token, result.stderr)

    def test_store_and_erase_never_write_the_projected_secret(self):
        original = self.file.read_bytes()
        for action in ['store', 'erase']:
            result = self.helper(action)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
            self.assertEqual(self.file.read_bytes(), original)

    def test_repeated_git_capabilities_do_not_hide_credentials(self):
        result = self.helper(query='capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=git.example.test:8443\n\n')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, f'username=example\npassword={self.token}\n\n')
        self.assertEqual(result.stderr, '')

    def test_repeated_scalar_fields_still_fail_closed(self):
        result = self.helper(query='protocol=https\nhost=other.test\nhost=git.example.test:8443\n\n')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn(self.token, result.stderr)

    def test_invalid_profile_cannot_inject_credential_fields_or_leak_data(self):
        self.document['credentials'][0]['token'] = self.token + '\npassword=injected'
        self.file.write_text(json.dumps(self.document))
        result = self.helper()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn(self.token, result.stderr)
        self.assertEqual(result.stderr, 'Git credential profile is invalid or unreadable.\n')

    def test_entrypoint_configuration_is_idempotent_and_contains_no_token(self):
        for _ in range(2):
            subprocess.run(['sh', str(HERE / 'configure-git.sh')], env=self.env, check=True)
        result = subprocess.run(['git', 'config', '--global', '--get-all', 'credential.helper'], env=self.env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '\n/usr/local/bin/t3-git-credential\n')
        self.assertNotIn(self.token, (self.root / '.gitconfig').read_text())

    def test_migrated_identity_authors_commits_without_overriding_user_or_repository_identity(self):
        identity = self.root / 'identity.gitconfig'
        identity.write_text('[user]\n\tname = Migrated User\n\temail = migrated@example.test\n')
        env = {**self.env, 'T3_GIT_IDENTITY_FILE': str(identity), 'GIT_CONFIG_NOSYSTEM': '1'}
        configure = lambda: subprocess.run(['sh', str(HERE / 'configure-git.sh')], env=env, check=True)
        configure()
        repo = self.root / 'repo'
        repo.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(repo), *args], env=env, capture_output=True, text=True, check=True).stdout.strip()
        git('init')
        git('commit', '--allow-empty', '-m', 'Migrated identity')
        self.assertEqual(git('log', '-1', '--format=%an <%ae>'), 'Migrated User <migrated@example.test>')
        git('config', '--global', 'user.name', 'Edited User')
        git('config', '--global', 'user.email', 'edited@example.test')
        configure()
        git('commit', '--allow-empty', '-m', 'Retained global identity')
        self.assertEqual(git('log', '-1', '--format=%an <%ae>'), 'Edited User <edited@example.test>')
        git('config', 'user.name', 'Repository User')
        git('config', 'user.email', 'repository@example.test')
        configure()
        git('commit', '--allow-empty', '-m', 'Repository override')
        self.assertEqual(git('log', '-1', '--format=%an <%ae>'), 'Repository User <repository@example.test>')

    def test_github_helpers_are_scoped_and_do_not_persist_tokens(self):
        env = {key: value for key, value in self.env.items() if key != 'T3_GIT_CREDENTIALS_FILE'}
        env.update(GH_TOKEN=self.token, GH_ENTERPRISE_TOKEN=self.token, GH_HOST='github.example.test:8443')
        for _ in range(2):
            subprocess.run(['sh', str(HERE / 'configure-git.sh')], env=env, check=True)
        for host in ['github.com', 'github.example.test:8443']:
            result = subprocess.run(['git', 'config', '--global', '--get-all', f'credential.https://{host}.helper'], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, '\n!gh auth git-credential\n')
        self.assertNotIn(self.token, (self.root / '.gitconfig').read_text())
        result = subprocess.run(['git', 'config', '--global', '--get-all', 'credential.helper'], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)

    def test_enterprise_configuration_requires_a_host_authority(self):
        env = {key: value for key, value in self.env.items() if key != 'T3_GIT_CREDENTIALS_FILE'}
        env['GH_ENTERPRISE_TOKEN'] = self.token
        for host in ['', 'https://example.test', 'example.test/path', 'example.test\nother']:
            result = subprocess.run(['sh', str(HERE / 'configure-git.sh')], env={**env, 'GH_HOST': host}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(self.token, result.stdout + result.stderr)

    def test_native_git_uses_helper_without_storing_credentials(self):
        subprocess.run(['git', 'config', '--global', 'credential.helper', f'!python3 {HERE / "git-credential.py"}'], env=self.env, check=True)
        result = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=git.example.test:8443\n\n', env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn(f'password={self.token}', result.stdout)
        self.assertEqual(result.stderr, '')
        self.assertNotIn(self.token, (self.root / '.gitconfig').read_text())
        rejected = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=other.test\n\n', env=self.env, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertNotIn(self.token, rejected.stdout + rejected.stderr)

if __name__ == '__main__':
    unittest.main()
