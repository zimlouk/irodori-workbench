"""Isolate Server protocol tests; never patch the live source or load real weights."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-dir', type=Path)
    parser.add_argument('--runtime-dir', type=Path)
    parser.add_argument('--dependency-site-packages', type=Path)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--test-deps', type=Path, help='Optional isolated test-only dependency directory')
    parser.add_argument('--from-pinned-head', action='store_true')
    parser.add_argument('--child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.child:
        sys.path.insert(0, str(ROOT.parents[1]/'backend/src'))
        from irodori_workbench.settings import load_settings
        settings = load_settings()
        python = args.python or settings.runtime_python
        server = args.server_dir or settings.server_dir
        runtime = args.runtime_dir or settings.runtime_dir
        fallback = args.dependency_site_packages or settings.dependency_site_packages
        if not python or not server:
            parser.error('Configure inference.python/server_dir or pass --python and --server-dir')
        command = [str(python), str(Path(__file__).resolve()), '--child', '--server-dir', str(server)]
        for flag, value in [('--runtime-dir', runtime), ('--dependency-site-packages', fallback)]:
            if value: command.extend([flag, str(value)])
        if args.from_pinned_head: command.append('--from-pinned-head')
        if args.test_deps: command.extend(['--test-deps', str(args.test_deps.resolve())])
        return subprocess.call(command)
    if not args.server_dir or not (args.server_dir/'tests').is_dir():
        parser.error('Server checkout with tests required')
    output = ROOT/'test-output'; output.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='protocol-', dir=output) as temporary:
        work = Path(temporary).resolve()
        package = work/'src/irodori_openai_tts'
        shutil.copytree(args.server_dir/'src/irodori_openai_tts', package, ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(args.server_dir/'tests', work/'tests', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(ROOT/'test_managed.py', work/'tests/test_workbench_managed.py')
        if args.from_pinned_head:
            import json
            commit = json.loads((ROOT/'manifest.json').read_text())['upstream_commit']
            for name in ('app.py','voices.py'):
                content = subprocess.run(['git','-C',str(args.server_dir),'show',commit+':src/irodori_openai_tts/'+name],capture_output=True,check=True).stdout
                (package/name).write_bytes(content)
        spec = importlib.util.spec_from_file_location('protocol_patch', ROOT/'apply_patch.py')
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        installer.install(work, apply=True, backups=work/'backups')
        sys.path.insert(0, str(work/'src'))
        if args.runtime_dir: sys.path.insert(0, str(args.runtime_dir))
        if args.dependency_site_packages: sys.path.append(str(args.dependency_site_packages))
        if args.test_deps: sys.path.append(str(args.test_deps))
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', IRODORI_PRELOAD='false')
        original_cwd = Path.cwd()
        try:
            os.chdir(work)
            import pytest
            return pytest.main([str(work/'tests'), '-q', '--tb=short'])
        finally:
            os.chdir(original_cwd)


if __name__ == '__main__':
    raise SystemExit(main())
