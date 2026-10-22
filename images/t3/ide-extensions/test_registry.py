import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zipfile

spec = importlib.util.spec_from_file_location("registry", Path(__file__).with_name("registry.py"))
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.base = "https://open-vsx.org/api/example/extension"
        self.url = "https://open-vsx.org/api/example/extension/file.vsix"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("extension/package.json", json.dumps({
                "publisher": "example", "name": "extension", "version": "1.0.0",
            }))
        self.archive = buffer.getvalue()

    def download(self, url, universal=False):
        if url == self.url:
            return self.archive
        if url == self.base + "/linux-x64/1.0.0":
            if universal:
                raise HTTPError(url, 404, "Not Found", {}, None)
            platform = "linux-x64"
        elif url == self.base + "/universal/1.0.0" and universal:
            platform = "universal"
        else:
            raise AssertionError(f"Unexpected registry route: {url}")
        return json.dumps({"version": "1.0.0", "targetPlatform": platform, "files": {"download": self.url}}).encode()

    def test_resolves_the_platform_qualified_linux_package(self):
        with patch.object(registry, "download", side_effect=self.download):
            entry, dependencies = registry.resolve("example.extension@1.0.0")
        self.assertEqual(entry["id"], "example.extension")
        self.assertEqual(dependencies, [])

    def test_falls_back_to_universal_only_when_linux_is_missing(self):
        with patch.object(registry, "download", side_effect=lambda url: self.download(url, True)):
            entry, _ = registry.resolve("example.extension@1.0.0")
        self.assertEqual(entry["version"], "1.0.0")

    def test_does_not_mask_registry_outages_with_a_fallback(self):
        with patch.object(registry, "download", side_effect=HTTPError(self.base, 503, "Unavailable", {}, None)) as download:
            with self.assertRaises(HTTPError):
                registry.resolve("example.extension@1.0.0")
            self.assertEqual(download.call_count, 1)


if __name__ == "__main__":
    unittest.main()
