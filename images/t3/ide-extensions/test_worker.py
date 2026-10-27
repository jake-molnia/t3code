import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

import worker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_build_keeps_removed_optional_members_out_of_saved_sources(self):
        archive = self.root / "pack.vsix"
        with zipfile.ZipFile(archive, "w") as vsix:
            vsix.writestr("extension/package.json", json.dumps({
                "publisher": "example", "name": "pack", "version": "1.0.0",
                "extensionPack": ["example.removed"],
                "extensionDependencies": ["example.required"],
            }))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()

        def nix(command, **kwargs):
            source = Path(command[-1][5:].split("#")[0])
            output = Path(command[command.index("--out-link") + 1])
            shutil.copytree(source, output)

        def resolve(spec):
            self.assertEqual(spec, "example.required@")
            return {"id": "example.required", "version": "1.0.0", "hash": "required"}, []

        with patch.object(worker, "run", side_effect=nix), patch.object(worker, "resolve", side_effect=resolve), patch.object(worker, "provision"):
            result = worker.build({
                "revision": "revision", "sources": [{"id": "example.pack", "version": "1.0.0", "archive": digest}],
                "archives": [{"digest": digest, "path": str(archive)}],
            }, self.root)
        self.assertEqual([item["id"] for item in result["sources"]], ["example.pack", "example.required"])

    def test_exports_have_a_capacity_and_expired_archives_are_collected(self):
        request = {"files": {"settings.json": "{}"}, "bundle": None}
        paths = [Path(worker.export_setup(request, self.root)["path"]) for _ in range(4)]
        with self.assertRaisesRegex(ValueError, "exports"):
            worker.export_setup(request, self.root)
        for path in paths:
            os.utime(path, (time.time() - 7200, time.time() - 7200))
        newest = Path(worker.export_setup(request, self.root)["path"])
        self.assertEqual(list((self.root / "exports").iterdir()), [newest])

    def test_failed_export_removes_partial_archive(self):
        with patch.object(worker.tarfile, "open", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                worker.export_setup({"files": {}, "bundle": None}, self.root)
        self.assertEqual(list((self.root / "exports").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
