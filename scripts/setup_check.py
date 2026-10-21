"""Check only workbench prerequisites, preserving existing local configuration."""
from pathlib import Path
import re
import shutil
import subprocess
import sys

if sys.version_info < (3, 11):
    raise SystemExit('Workbench requires Python 3.11+; tested release baseline is Python 3.14.')
node = shutil.which('node')
npm = shutil.which('npm.cmd')
if not node or not npm:
    raise SystemExit('Install Node.js (20.19+ in v20, or 22.12+) with npm before setup.')
version = subprocess.check_output([node, '--version'], text=True).strip()
numbers = tuple(map(int, re.findall(r'\d+', version)[:3]))
if not ((numbers[0] == 20 and numbers >= (20, 19, 0)) or numbers >= (22, 12, 0)):
    raise SystemExit(f'Unsupported Node.js {version}; requires ^20.19.0 or >=22.12.0.')
root = Path(__file__).resolve().parents[1]
config = root/'config.local.toml'
if not config.exists():
    with config.open('xb') as output:
        output.write((root/'config.example.toml').read_bytes())
    print('Created config.local.toml; edit it to configure your local inference service.')
else:
    print('Keeping existing config.local.toml and data directory.')
print('Workbench prerequisites ready. GPU environments are not modified.')
