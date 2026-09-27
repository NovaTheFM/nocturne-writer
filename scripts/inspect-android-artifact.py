import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
apk = root / 'Nocturne-Writer-debug.apk'
verified = []
filenames = ['index.html'] + [path.relative_to(root).as_posix() for directory in ['src', 'reaper_photo'] for path in sorted((root / directory).rglob('*')) if path.is_file()]
with ZipFile(apk) as archive:
    for filename in filenames:
        assert archive.read('assets/public/' + filename) == (root / filename).read_bytes(), f'Outdated packaged file: {filename}'
        verified.append(filename)
    assert archive.read('classes.dex')
result = {'artifact': str(apk), 'bytes': apk.stat().st_size, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'verifiedPackagedFiles': verified}
report = root / 'release/qa/android-artifact.json'
report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"Android APK verified: {len(verified)} packaged files, {result['bytes']} bytes, SHA256 {result['sha256']}")
