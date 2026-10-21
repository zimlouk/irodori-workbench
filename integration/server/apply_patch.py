"""Install the versioned managed protocol. Default is a read-only preflight."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent


def digest(content):
    return hashlib.sha256(content.replace(b'\r\n', b'\n')).hexdigest()


def apply_diff(source, diff):
    original = source.splitlines(keepends=True)
    lines = diff.splitlines(keepends=True)
    output, cursor, index = [], 0, 0
    while index < len(lines):
        header = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', lines[index])
        if not header:
            index += 1
            continue
        start = int(header[1])-1 if int(header[1]) else 0
        if start < cursor or start > len(original):
            raise ValueError('Patch has overlapping or invalid ranges')
        output.extend(original[cursor:start]); cursor = start
        old_count = new_count = 0
        index += 1
        while index < len(lines) and lines[index][:1] in {' ', '-', '+'}:
            mark, text = lines[index][0], lines[index][1:]
            if mark in {' ', '-'}:
                if cursor >= len(original) or original[cursor] != text:
                    raise ValueError('Patch context mismatch; source kept unchanged')
                cursor += 1; old_count += 1
            if mark in {' ', '+'}:
                output.append(text); new_count += 1
            index += 1
        if old_count != int(header[2] if header[2] is not None else 1) or new_count != int(header[4] if header[4] is not None else 1):
            raise ValueError('Patch hunk line count mismatch')
    output.extend(original[cursor:])
    return ''.join(output)


def preflight(server_dir, patch_dir=ROOT):
    manifest = json.loads((patch_dir/'manifest.json').read_text(encoding='utf-8'))
    target = server_dir/'src/irodori_openai_tts'
    changes = {}
    for name, expected in manifest['files'].items():
        if name not in {'app.py', 'voices.py'}:
            raise ValueError('Unsupported patch target')
        path = target/name
        before = path.read_bytes()
        current = digest(before)
        if current in {expected['after'], expected.get('legacy_after')}:
            continue
        if current != expected['before']:
            raise ValueError(f'{name}: source differs from pinned baseline; refusing overwrite')
        after = apply_diff(before.decode('utf-8').replace('\r\n', '\n'),
                           (patch_dir/(name+'.patch')).read_text(encoding='utf-8')).encode('utf-8')
        if digest(after) != expected['after']:
            raise ValueError(f'{name}: generated file hash mismatch')
        changes[path] = (before, after)
    return changes


def install(server_dir, *, apply=False, patch_dir=ROOT, backups=None):
    changes = preflight(server_dir, patch_dir)
    if not changes:
        return 'already-applied'
    if not apply:
        return 'ready'
    backup = (backups or ROOT/'backups')/datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True)
    for path, (before, _) in changes.items():
        (backup/path.name).write_bytes(before)
    (backup/'hashes.json').write_text(json.dumps({p.name:{'before':digest(b),'after':digest(a)}
        for p,(b,a) in changes.items()}, indent=2), encoding='utf-8')
    written = []
    try:
        for path, (before, after) in changes.items():
            if path.read_bytes() != before:
                raise ValueError(f'{path.name} changed after preflight; aborting')
            temporary = path.with_name(path.name+'.workbench-patch.tmp')
            temporary.write_bytes(after)
            os.replace(temporary, path)
            written.append(path)
    except Exception:
        for path in reversed(written):
            path.write_bytes(changes[path][0])
        raise
    return f'applied; originals at {backup}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-dir', type=Path)
    flags = parser.add_mutually_exclusive_group()
    flags.add_argument('--check', action='store_true')
    flags.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    server = args.server_dir
    if server is None:
        sys.path.insert(0, str(ROOT.parents[1]/'backend/src'))
        from irodori_workbench.settings import load_settings
        server = load_settings().server_dir
    if server is None:
        parser.error('Pass --server-dir or configure inference.server_dir')
    print(install(server.resolve(), apply=args.apply))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        print(f'Patch check failed: {exc}', file=sys.stderr)
        sys.exit(1)
