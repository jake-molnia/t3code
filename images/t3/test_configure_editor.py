import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "configure_editor", Path(__file__).with_name("configure-editor.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EditorDefaultsTest(unittest.TestCase):
    def test_new_profile_starts_dark_without_disabling_completions(self):
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
            self.assertEqual(settings["workbench.colorTheme"], "Dark Modern")
            self.assertEqual(settings["workbench.startupEditor"], "none")
            self.assertEqual(settings["workbench.secondarySideBar.defaultVisibility"], "hidden")
            self.assertTrue(settings["editor.inlineSuggest.enabled"])
            self.assertFalse(settings["chat.tips.enabled"])
            self.assertNotIn("chat.disableAIFeatures", settings)

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
