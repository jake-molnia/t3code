import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "configure_editor", Path(__file__).with_name("configure-editor.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EditorDefaultsTest(unittest.TestCase):
    def test_new_profile_seeds_only_settings_needed_before_extensions_load(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "package.json"
            manifest.write_text(json.dumps({"contributes": {"configurationDefaults": {
                "workbench.colorTheme": "Dark Modern",
                "workbench.startupEditor": "none",
                "workbench.secondarySideBar.defaultVisibility": "hidden",
                "editor.inlineSuggest.enabled": True,
            }}}))
            state = root / "custom-worker-state"
            module.configure_editor(state, manifest)
            settings = json.loads((state / "ide/user-data/User/settings.json").read_text())
            self.assertNotIn("workbench.colorTheme", settings)
            self.assertEqual(settings["workbench.startupEditor"], "none")
            self.assertEqual(settings["workbench.secondarySideBar.defaultVisibility"], "hidden")
            self.assertNotIn("editor.inlineSuggest.enabled", settings)
            self.assertFalse(settings["chat.tips.enabled"])
            self.assertNotIn("chat.disableAIFeatures", settings)

    def test_failed_initialization_does_not_publish_an_empty_settings_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "package.json"
            manifest.write_text('{"contributes":{"configurationDefaults":{"workbench.startupEditor":"none","workbench.secondarySideBar.defaultVisibility":"hidden"}}}')
            settings = root / "ide/user-data/User/settings.json"
            with patch.object(module.json, "dumps", side_effect=MemoryError("interrupted serialization")):
                with self.assertRaises(MemoryError):
                    module.configure_editor(root, manifest)
            self.assertFalse(settings.exists())
            module.configure_editor(root, manifest)
            self.assertEqual(json.loads(settings.read_text())["workbench.startupEditor"], "none")

    def test_failed_write_leaves_no_published_settings_and_can_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "package.json"
            manifest.write_text('{"contributes":{"configurationDefaults":{"workbench.startupEditor":"none","workbench.secondarySideBar.defaultVisibility":"hidden"}}}')
            settings = root / "ide/user-data/User/settings.json"
            with patch.object(module.os, "fsync", side_effect=OSError("storage interrupted")):
                with self.assertRaises(OSError):
                    module.configure_editor(root, manifest)
            self.assertFalse(settings.exists())
            self.assertEqual(list(settings.parent.iterdir()), [])
            module.configure_editor(root, manifest)
            self.assertFalse(json.loads(settings.read_text())["chat.tips.enabled"])

    def test_concurrent_user_file_wins_without_being_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "package.json"
            manifest.write_text('{"contributes":{"configurationDefaults":{"workbench.startupEditor":"none","workbench.secondarySideBar.defaultVisibility":"hidden"}}}')
            settings = root / "ide/user-data/User/settings.json"
            saved = '// chosen while the worker starts\n{"workbench.colorTheme":"Light Modern"}\n'
            link = module.os.link

            def concurrent_write(source, destination):
                self.assertEqual(json.loads(Path(source).read_text())["workbench.startupEditor"], "none")
                self.assertFalse(settings.exists())
                settings.write_text(saved)
                return link(source, destination)

            with patch.object(module.os, "link", side_effect=concurrent_write):
                module.configure_editor(root, manifest)
            self.assertEqual(settings.read_text(), saved)
            self.assertEqual(list(settings.parent.iterdir()), [settings])

    def test_restart_preserves_existing_preferences_including_jsonc(self):
        for saved in ["", '// My theme\n{ "workbench.colorTheme": "Light Modern", }\n']:
            with self.subTest(saved=saved), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = root / "package.json"
                manifest.write_text('{"contributes":{"configurationDefaults":{"workbench.colorTheme":"Dark Modern"}}}')
                settings = root / "ide/user-data/User/settings.json"
                settings.parent.mkdir(parents=True)
                settings.write_text(saved)
                module.configure_editor(root, manifest)
                module.configure_editor(root, manifest)
                self.assertEqual(settings.read_text(), saved)


if __name__ == "__main__":
    unittest.main()
