import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
apk = root / 'Nocturne-Writer-debug.apk'
verified = []
with ZipFile(apk) as archive:
    for filename in ['index.html', 'src/main.js', 'src/core/db.js', 'src/features/database-sync.js', 'src/features/local-sync.js', 'src/css/polish.css', 'src/css/fonts.css', 'src/vendor/pdfjs/pdf.min.mjs', 'src/vendor/pdfjs/pdf.worker.min.mjs', 'src/vendor/capacitor/native.bundle.js']:
        assert archive.read('assets/public/' + filename) == (root / filename).read_bytes(), f'Outdated packaged file: {filename}'
        verified.append(filename)
    assert archive.read('classes.dex')
result = {'artifact': str(apk), 'bytes': apk.stat().st_size, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'verifiedPackagedFiles': verified}
report = root / 'release/qa/android-artifact.json'
report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
