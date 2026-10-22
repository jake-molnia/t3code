import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("provision", Path(__file__).with_name("provision.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.ide = self.root / "ide"
        self.extension = {"id": "example.extension", "version": "1.0.0", "url": "https://example.invalid/extension.vsix", "hash": "unused-by-provisioner"}
        self.declare([self.extension])

    def declare(self, extensions):
        (self.bundle / "extensions.json").write_text(json.dumps(extensions))

    def test_applies_once_and_removes_a_managed_version(self):
        with patch.object(provision.subprocess, "check_output", return_value="") as listing, patch.object(provision.subprocess, "run") as run:
            provision.provision(self.bundle, self.ide)
            self.assertIn("--install-extension", run.call_args.args[0])
            self.assertIn(str(self.ide / "user-data"), run.call_args.args[0])
            provision.provision(self.bundle, self.ide)
            listing.assert_called_once()
            run.assert_called_once()
            self.declare([])
            listing.return_value = "example.extension@1.0.0\nother.local@2.0.0\n"
            provision.provision(self.bundle, self.ide)
            self.assertEqual(run.call_args.args[0][-2:], ["--uninstall-extension", "example.extension"])

    def test_keeps_a_locally_changed_version_on_removal(self):
        with patch.object(provision.subprocess, "check_output", return_value="example.extension@1.0.0\n"), patch.object(provision.subprocess, "run") as run:
            provision.provision(self.bundle, self.ide)
            run.assert_not_called()
        self.declare([])
        with patch.object(provision.subprocess, "check_output", return_value="example.extension@2.0.0\n"), patch.object(provision.subprocess, "run") as run:
            provision.provision(self.bundle, self.ide)
            run.assert_not_called()

    def test_explicit_apply_replaces_local_changes_even_at_same_revision(self):
        with patch.object(provision.subprocess, "check_output", return_value="example.extension@1.0.0\n"), patch.object(provision.subprocess, "run"):
            provision.provision(self.bundle, self.ide)
        with patch.object(provision.subprocess, "check_output", return_value="example.extension@2.0.0\nlocal.extra@1.0.0\n"), patch.object(provision.subprocess, "run") as run:
            provision.provision(self.bundle, self.ide, replace=True)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any(command[-2:] == ["--uninstall-extension", "local.extra"] for command in commands))
            self.assertTrue(any("--install-extension" in command for command in commands))

    def test_failed_install_can_retry_without_advancing_marker(self):
        with patch.object(provision.subprocess, "check_output", return_value=""), patch.object(provision.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "code-server")):
            with self.assertRaises(subprocess.CalledProcessError):
                provision.provision(self.bundle, self.ide)
        self.assertFalse((self.ide / "managed-extensions.json").exists())
        with patch.object(provision.subprocess, "check_output", return_value=""), patch.object(provision.subprocess, "run"):
            provision.provision(self.bundle, self.ide)
        self.assertTrue((self.ide / "managed-extensions.json").exists())


if __name__ == "__main__":
    unittest.main()
