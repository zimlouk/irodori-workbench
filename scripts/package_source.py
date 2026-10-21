"""Build a source-only archive using .gitignore, without creating a repository in the checkout."""
import argparse
from datetime import datetime
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def public_files(root=ROOT):
    staging = root/'data'
    staging.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='package-index-', dir=staging) as temporary:
        metadata = Path(temporary).resolve()
        if not metadata.is_relative_to(staging.resolve()):
            raise ValueError('Invalid temporary metadata path')
        subprocess.run(['git', 'init', '--quiet', str(metadata)], check=True)
        result = subprocess.run(['git', '--git-dir='+str(metadata/'.git'), '--work-tree='+str(root),
                                 'ls-files', '--others', '--exclude-standard', '-z'],
                                capture_output=True, check=True)
        files = [Path(name.decode('utf-8')) for name in result.stdout.split(b'\0') if name]
    for relative in files:
        path = (root/relative).resolve()
        if not path.is_relative_to(root.resolve()) or relative.is_absolute():
            raise ValueError('File outside checkout cannot be packaged')
        if (relative.parts[0] in {'data', '.venv', 'models', 'model', 'weights', 'checkpoints'}
                or 'node_modules' in relative.parts or relative.name == 'config.local.toml'
                or relative.name.endswith('.local.json')
                or (relative.name.startswith('.env') and relative.name != '.env.example')
                or relative.suffix in {'.safetensors', '.pth', '.ckpt', '.sqlite3', '.log'}):
            raise ValueError(f'Private/runtime file would be packaged: {relative}')
    return sorted(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    files = public_files()
    required = {'README.md', 'LICENSE', 'config.example.toml', 'Start-Workbench.cmd',
                'backend/src/irodori_workbench/settings.py', 'frontend/package-lock.json'}
    if not required.issubset({p.as_posix() for p in files}):
        raise ValueError('Required source files missing from package')
    if args.check:
        print(f'Public source check passed: {len(files)} files; local data/config are excluded by .gitignore.')
        return
    output = args.output or ROOT/'data/releases'/('irodori-workbench-source-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.zip')
    output = output.resolve()
    if output.exists():
        raise ValueError('Output already exists; choose another path')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        for relative in files:
            archive.write(ROOT/relative, relative.as_posix())
    print(f'Packaged {len(files)} source files: {output}')


if __name__ == '__main__':
    main()
