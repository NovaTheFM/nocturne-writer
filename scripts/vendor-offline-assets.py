import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

root = Path(__file__).resolve().parents[1]
fonts = root / 'src/assets/fonts'
fonts.mkdir(parents=True, exist_ok=True)
request = urllib.request.Request('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap', headers={'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36'})
css = urllib.request.urlopen(request).read().decode()
urls = dict.fromkeys(re.findall(r'url\((https://[^)]+)\)', css))
for url in urls:
    name = hashlib.sha256(url.encode()).hexdigest()[:20] + ('.woff2' if '.woff2' in url else '.ttf')
    target = fonts / name
    if not target.exists(): target.write_bytes(urllib.request.urlopen(url).read())
    css = css.replace(url, '../assets/fonts/' + name)
(root / 'src/css/fonts.css').write_text(css, encoding='utf-8')
for family in ['manrope', 'lora', 'inter', 'playfairdisplay', 'merriweather']:
    license_url = f'https://raw.githubusercontent.com/google/fonts/main/ofl/{family}/OFL.txt'
    (fonts / f'{family}-OFL.txt').write_bytes(urllib.request.urlopen(license_url).read())
print(f'Offline fonts: {len(urls)} files')

version = '6.3.289'
metadata = json.load(urllib.request.urlopen(f'https://registry.npmjs.org/pdfjs-dist/{version}'))
archive = urllib.request.urlopen(metadata['dist']['tarball']).read()
if hashlib.sha1(archive).hexdigest() != metadata['dist']['shasum']: raise RuntimeError('PDF.js archive checksum mismatch')
vendor = root / 'src/vendor/pdfjs'
vendor.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
    for member in source.getmembers():
        name = member.name.removeprefix('package/')
        if name in ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'] or name.startswith(('cmaps/', 'standard_fonts/', 'wasm/')):
            if member.isfile():
                target = vendor / name.removeprefix('build/')
                if not target.resolve().is_relative_to(vendor.resolve()): raise RuntimeError('Unsafe archive path')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.extractfile(member).read())
(vendor / 'VERSION').write_text(version)
print(f'Offline PDF.js {version} installed')
