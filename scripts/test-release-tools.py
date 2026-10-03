import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('version_tool', ROOT / 'bump_version.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ReleaseToolTests(unittest.TestCase):
    def test_version_change_updates_every_platform_and_preserves_historical_release_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'src').mkdir()
            (root / 'android/app').mkdir(parents=True)
            (root / 'package.json').write_text(json.dumps({'version': '1.2.0'}), encoding='utf-8')
            (root / 'package-lock.json').write_text(json.dumps({'version': '1.2.0', 'packages': {'': {'version': '1.2.0'}}}), encoding='utf-8')
            (root / 'src/main.js').write_text("const currentVersion = '1.2.0'; const settings = { appVersion: '1.2.0' }; function openWhatsNewModal() { return `<p>Версия 1.2.0</p><p>Версия 1.1.0</p>`; }", encoding='utf-8')
            (root / 'index.html').write_text('<script src="src/main.js?v=1.2.0"></script>', encoding='utf-8')
            (root / 'android/app/build.gradle').write_text('versionCode 7\nversionName "1.2.0"', encoding='utf-8')
            old_root, argv = tool.ROOT, sys.argv
            try:
                tool.ROOT = root
                sys.argv = ['bump_version.py', '1.2.1']
                tool.main()
            finally:
                tool.ROOT, sys.argv = old_root, argv
            lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
            self.assertEqual(lock['version'], '1.2.1')
            self.assertEqual(lock['packages']['']['version'], '1.2.1')
            self.assertIn('versionCode 8', (root / 'android/app/build.gradle').read_text(encoding='utf-8'))
            self.assertIn('versionName "1.2.1"', (root / 'android/app/build.gradle').read_text(encoding='utf-8'))
            source = (root / 'src/main.js').read_text(encoding='utf-8')
            self.assertIn('Версия 1.2.1', source)
            self.assertIn('Версия 1.1.0', source)

    def test_invalid_version_cannot_modify_the_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / 'package.json'
            package.write_text('{"version":"1.2.0"}', encoding='utf-8')
            old_root, argv = tool.ROOT, sys.argv
            try:
                tool.ROOT = root
                sys.argv = ['bump_version.py', 'invalid-version']
                with self.assertRaises((ValueError, SystemExit)):
                    tool.main()
            finally:
                tool.ROOT, sys.argv = old_root, argv
            self.assertEqual(json.loads(package.read_text(encoding='utf-8'))['version'], '1.2.0')


if __name__ == '__main__':
    unittest.main()
