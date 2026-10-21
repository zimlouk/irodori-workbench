"""Create missing default character presets without changing existing templates."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'backend/src'))
from irodori_workbench.catalog import lora_catalog
from irodori_workbench.configuration import VoiceConfig, config_dict
from irodori_workbench.settings import load_settings, voice_profile


def targets(settings):
    profile = voice_profile()
    grouped = {}
    for item in lora_catalog(settings):
        if not item['available']:
            continue
        path = Path(item['path'])
        folder = next((p.name for p in [path, *path.parents] if re.search(r'_v\d', p.name)), '')
        family = folder.split('_v')[0]
        if not family or family in profile.get('exclude', []):
            continue
        match = re.search(r'_v(\d+(?:_\d+)*)', folder)
        version = tuple(map(int, match[1].split('_')))
        if family not in grouped or version > grouped[family][0]:
            grouped[family] = (version, item)
    result = []
    for family, (_, item) in sorted(grouped.items()):
        name = re.sub(r'(?:_\d+|（\d+）)$', '', item['name'])
        parameters = {**profile.get('defaults', {}), **profile.get('families', {}).get(family, {})}
        config = config_dict(VoiceConfig(lora_id=item['id'], caption='', parameters=parameters))
        result.append({'voice_name':name, 'name':'默认', 'config':config})
    return result


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--url', default=load_settings().url)
    args = parser.parse_args()
    settings = load_settings().lora_settings
    items = targets(settings)
    print(json.dumps(items, ensure_ascii=False, indent=2))
    if not args.apply:
        return
    def api(path, body=None):
        req = Request(args.url+'/api/v1/'+path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type':'application/json'})
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    before = api('presets')['items']
    report = ROOT/'data/character-presets-20261019'
    report.mkdir(parents=True, exist_ok=True)
    backup = report/'before.json'
    if not backup.exists():
        backup.write_text(json.dumps(before, ensure_ascii=False, indent=2), encoding='utf-8')
    existing = {(p['voice_name'],p['name']) for p in before}
    created = []
    for item in items:
        if (item['voice_name'],item['name']) not in existing:
            created.append(api('presets',item))
    after = api('presets')['items']
    by_id = {p['id']:p for p in after}
    assert all(by_id.get(p['id']) == p for p in before), 'An existing preset changed'
    created_file = report/'created.json'
    previous = json.loads(created_file.read_text(encoding='utf-8')) if created_file.exists() else []
    recorded = {p['id']:p for p in [*previous,*created]}
    created_file.write_text(json.dumps(list(recorded.values()), ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Created {len(created)} presets; all {len(before)} existing presets unchanged.')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
