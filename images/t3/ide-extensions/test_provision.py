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
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.ide = self.root / "ide"
        self.extension = {"id": "example.extension", "version": "1.0.0", "hash": "first-package"}
        self.installed = {}
        self.operations = []
        self.declare([self.extension])
        self.addCleanup(patch.stopall)
        patch.object(provision.subprocess, "check_output", side_effect=self.list_extensions).start()
        patch.object(provision.subprocess, "run", side_effect=self.run_native).start()

    def declare(self, extensions):
        self.desired = extensions
        (self.bundle / "extensions.json").write_text(json.dumps(extensions))

    def install(self, item, dependencies=(), pack=()):
        self.installed[item["id"]] = dict(item, dependencies=list(dependencies), pack=list(pack))
        directory = self.ide / "extensions" / f'{item["id"]}-{item["version"]}'
        directory.mkdir(parents=True, exist_ok=True)
        publisher, name = item["id"].split(".")
        (directory / "package.json").write_text(json.dumps({
            "publisher": publisher, "name": name, "version": item["version"],
            "extensionDependencies": list(dependencies), "extensionPack": list(pack),
        }))

    def list_extensions(self, command, **kwargs):
        return "\n".join(f'{name}@{item["version"]}' for name, item in sorted(self.installed.items()))

    def run_native(self, command, **kwargs):
        if "--uninstall-extension" in command:
            name = command[command.index("--uninstall-extension") + 1]
            if name not in self.installed or any(name in item["dependencies"] for item in self.installed.values()):
                raise subprocess.CalledProcessError(1, command)
            item = self.installed.pop(name)
            for member in item["pack"]:
                self.installed.pop(member, None)
            self.operations.append(("remove", name))
        else:
            self.assertEqual(command[-2:], ["--vscode-option", "do-not-include-pack-dependencies"])
            for index, argument in enumerate(command):
                if argument != "--install-extension":
                    continue
                archive = Path(command[index + 1]).name
                item = next(item for item in self.desired if archive == f'{item["id"]}-{item["version"]}.vsix')
                self.install(item)
                self.operations.append(("install", item["id"]))
        return subprocess.CompletedProcess(command, 0)

    def test_applies_once_and_removes_a_managed_version(self):
        provision.provision(self.bundle, self.ide)
        provision.provision(self.bundle, self.ide)
        self.assertEqual(self.operations, [("install", "example.extension")])
        self.declare([])
        provision.provision(self.bundle, self.ide)
        self.assertEqual(self.installed, {})

    def test_keeps_a_locally_changed_version_on_removal(self):
        provision.provision(self.bundle, self.ide)
        self.install(dict(self.extension, version="2.0.0"))
        self.declare([])
        provision.provision(self.bundle, self.ide)
        self.assertEqual(self.installed["example.extension"]["version"], "2.0.0")

    def test_explicit_apply_reinstalls_same_version_and_removes_local_extras(self):
        provision.provision(self.bundle, self.ide)
        self.install(dict(self.extension, hash="local-rebuild"))
        self.install({"id": "local.extra", "version": "1.0.0", "hash": "extra"})
        provision.provision(self.bundle, self.ide, replace=True)
        self.assertNotIn("local.extra", self.installed)
        self.assertEqual(self.installed["example.extension"]["hash"], "first-package")

    def test_reinstalls_a_new_archive_with_the_same_id_and_version(self):
        provision.provision(self.bundle, self.ide)
        self.declare([dict(self.extension, hash="rebuilt-package")])
        provision.provision(self.bundle, self.ide)
        self.assertEqual(self.installed["example.extension"]["hash"], "rebuilt-package")

    def test_removes_dependents_before_dependencies(self):
        dependency = dict(self.extension, id="example.a-dependency")
        dependent = dict(self.extension, id="example.z-dependent")
        self.declare([dependency, dependent])
        provision.provision(self.bundle, self.ide)
        self.install(dependent, dependencies=[dependency["id"]])
        self.declare([])
        provision.provision(self.bundle, self.ide)
        self.assertEqual(self.installed, {})
        self.assertEqual(self.operations[-2:], [("remove", dependent["id"]), ("remove", dependency["id"])])

    def test_upgrades_dependents_before_removing_dropped_dependencies(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                dependency = dict(self.extension, id="example.dependency")
                self.declare([self.extension, dependency])
                provision.provision(self.bundle, self.ide, replace=True)
                self.install(self.extension, dependencies=[dependency["id"]])
                self.declare([dict(self.extension, version="2.0.0", hash="upgrade")])
                provision.provision(self.bundle, self.ide, replace=replace)
                self.assertEqual(set(self.installed), {self.extension["id"]})
                self.assertEqual(self.installed[self.extension["id"]]["version"], "2.0.0")

    def test_refreshes_inventory_after_extension_pack_cascading(self):
        pack = dict(self.extension, id="example.a-pack")
        member = dict(self.extension, id="example.z-member")
        self.declare([pack, member])
        provision.provision(self.bundle, self.ide)
        self.install(pack, pack=[member["id"]])
        self.declare([member])
        provision.provision(self.bundle, self.ide)
        self.assertEqual(set(self.installed), {member["id"]})

    def test_cannot_remove_dependency_of_a_retained_local_extension(self):
        provision.provision(self.bundle, self.ide)
        self.install(dict(self.extension, id="local.dependent"), dependencies=["example.extension"])
        before = (self.ide / "managed-extensions.json").read_bytes()
        self.declare([])
        with self.assertRaises(Exception):
            provision.provision(self.bundle, self.ide)
        self.assertEqual((self.ide / "managed-extensions.json").read_bytes(), before)
        self.assertEqual(len(self.installed), 2)

    def test_failed_install_can_retry_without_advancing_marker(self):
        with patch.object(provision.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "code-server")):
            with self.assertRaises(subprocess.CalledProcessError):
                provision.provision(self.bundle, self.ide)
        self.assertFalse((self.ide / "managed-extensions.json").exists())
        provision.provision(self.bundle, self.ide)
        self.assertTrue((self.ide / "managed-extensions.json").exists())


if __name__ == "__main__":
    unittest.main()
