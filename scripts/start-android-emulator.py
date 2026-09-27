import os
from pathlib import Path
import subprocess

sdk = Path(os.environ.get('ANDROID_HOME', 'D:/Android/Sdk'))
avd_home = Path('D:/Android/avd')
avd_home.mkdir(parents=True, exist_ok=True)
environment = {**os.environ, 'JAVA_HOME': 'C:/Program Files/Java/jdk-21', 'ANDROID_HOME': str(sdk), 'ANDROID_AVD_HOME': str(avd_home)}
flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
avd = avd_home / 'NocturneQA.avd'
if not avd.exists():
    result = subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', str(sdk / 'cmdline-tools/latest/bin/avdmanager.bat'), 'create', 'avd', '-n', 'NocturneQA', '-k', 'system-images;android-35;default;x86_64', '--device', 'pixel_5'], input=b'no\n', env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags)
    print(result.stdout.decode('utf-8', errors='replace')[-1800:])
    result.check_returncode()
configuration = avd / 'config.ini'
lines = configuration.read_text().splitlines()
lines = [line for line in lines if not line.startswith('disk.dataPartition.size')]
configuration.write_text('\n'.join(lines) + '\ndisk.dataPartition.size=1536M\n')
log = Path('.android-sdk-download/emulator.log').open('wb')
process = subprocess.Popen([str(sdk / 'emulator/emulator.exe'), '-avd', 'NocturneQA', '-no-accel', '-gpu', 'off', '-feature', '-Vulkan', '-no-window', '-no-audio', '-no-snapshot', '-memory', '2048', '-no-boot-anim'], env=environment, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
print(f'Hidden Android emulator PID {process.pid}; log .android-sdk-download/emulator.log')
raise SystemExit(process.wait())
