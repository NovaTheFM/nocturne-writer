import os
import shutil
import subprocess
import sys

arguments = sys.argv[1:]
if not arguments:
    raise SystemExit('Usage: python scripts/run-silent.py <command> [arguments...]')
executable = shutil.which(arguments[0]) or arguments[0]
arguments[0] = executable
if os.name == 'nt' and executable.lower().endswith(('.cmd', '.bat')):
    arguments = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c', subprocess.list2cmdline(arguments)]
environment = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
process = subprocess.Popen(arguments, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
for output in iter(process.stdout.readline, b''):
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
raise SystemExit(process.wait())
