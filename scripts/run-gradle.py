import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
environment = {**os.environ, 'JAVA_HOME': os.environ.get('JAVA_HOME') or 'C:/Program Files/Java/jdk-21', 'ANDROID_HOME': 'D:/Android/Sdk'}
command = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c', 'gradlew.bat ' + subprocess.list2cmdline(sys.argv[1:])]
result = subprocess.run(command, cwd=root / 'android', env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
print(result.stdout.decode('utf-8', errors='replace'))
raise SystemExit(result.returncode)
