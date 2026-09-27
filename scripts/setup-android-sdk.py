import hashlib
import os
from pathlib import Path
import subprocess
import urllib.request
import zipfile

sdk = Path(os.environ.get('ANDROID_HOME') or Path.home() / 'AppData/Local/Android/Sdk')
tools = sdk / 'cmdline-tools/latest/bin/sdkmanager.bat'
if not tools.exists():
    archive = Path(__file__).resolve().parents[1] / '.android-sdk-download/commandlinetools.zip'
    archive.parent.mkdir(parents=True, exist_ok=True)
    url = 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'
    print('Downloading official Android command-line tools...', flush=True)
    urllib.request.urlretrieve(url, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a':
        raise RuntimeError('Android tools SHA-256 verification failed')
    target = sdk / 'cmdline-tools/latest'
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            if member.filename.startswith('cmdline-tools/'):
                member.filename = member.filename[len('cmdline-tools/'):]
                if member.filename:
                    source.extract(member, target)
env = dict(os.environ)
env['JAVA_HOME'] = env.get('JAVA_HOME') or 'C:/Program Files/Java/jdk-21'
print(f'Installing Android build packages into {sdk}', flush=True)
subprocess.run([str(tools), f'--sdk_root={sdk}', '--licenses'], input='y\n' * 40, text=True, env=env, check=True)
subprocess.run([str(tools), f'--sdk_root={sdk}', 'platform-tools', 'platforms;android-36', 'build-tools;36.0.0'], input='y\n' * 40, text=True, env=env, check=True)
android = Path(__file__).resolve().parents[1] / 'android'
android.mkdir(exist_ok=True)
(android / 'local.properties').write_text(f'sdk.dir={sdk.as_posix()}\n', encoding='utf-8')
print('Android SDK ready.', flush=True)
