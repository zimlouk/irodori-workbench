import json
from pathlib import Path

from irodori_workbench.catalog import lora_catalog


def test_discovery_uses_model_root_and_keeps_chosen_checkpoints(tmp_path, monkeypatch):
    monkeypatch.setenv('IRODORI_VOICE_PROFILE', str(Path(__file__).parents[2]/'config/voice-profile.example.json'))
    root = tmp_path/'lora_output'
    def checkpoint(name):
        path = root/name/'checkpoint_final'
        path.mkdir(parents=True)
        (path/'adapter_config.json').write_text('{}')
        (path/'adapter_model.safetensors').write_bytes(b'')
        return path
    chosen = checkpoint('speaker_a_v4')
    checkpoint('speaker_a_v4_2')
    checkpoint('speaker_b_v3')
    checkpoint('speaker_b_v4')
    newest = checkpoint('speaker_b_v4_2')
    (root/'broken_v4').mkdir()
    settings = tmp_path/'settings.json'
    settings.write_text(json.dumps({'loras':[
        {'name':'Example speaker A', 'path':str(chosen)},
        {'name':'outside', 'path':str(tmp_path/'elsewhere')},
    ]}), encoding='utf-8')
    monkeypatch.setenv('IRODORI_LORA_DIR',str(root))
    items = lora_catalog(settings)
    assert len(items) == 4
    assert items[0]['path'] == str(chosen.resolve())
    speaker_b = [item for item in items if item['family']=='speaker_b']
    assert len(speaker_b)==2
    assert speaker_b[0]['name'] == 'Example speaker B'
    assert speaker_b[0]['path'] == str(newest.resolve())
    assert {item['model_version'] for item in speaker_b} == {'v4','v4_2'}
    assert all(item['checkpoint']=='checkpoint_final' for item in items)
    assert len({item['id'] for item in items})==4
    assert all(item['available'] for item in items)


def test_api_exposes_version_and_freezes_exact_chosen_checkpoint(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from irodori_workbench.app import create_app
    from irodori_workbench.inference import FakeInferenceAdapter
    root=tmp_path/'lora_output'
    for folder in ['speaker_c_v4','speaker_c_v4_4']:
        p=root/folder/'checkpoint_final'
        p.mkdir(parents=True)
        (p/'adapter_config.json').write_text('{}')
        (p/'adapter_model.safetensors').write_bytes(b'')
    settings=tmp_path/'settings.json'
    settings.write_text(json.dumps({'loras':[{'name':'Example speaker C',
        'path':str(root/'speaker_c_v4/checkpoint_final')}]}),encoding='utf-8')
    monkeypatch.setenv('IRODORI_LORA_DIR',str(root))
    with TestClient(create_app(tmp_path/'data',FakeInferenceAdapter(),settings)) as c:
        items=c.get('/api/v1/loras').json()['items']
        assert {i['model_version'] for i in items}=={'v4','v4_4'}
        assert all('path' not in i for i in items)
        assert all(not __import__('pathlib').Path(i['relative_path']).is_absolute() for i in items)
        for lora in items:
            r=c.post('/api/v1/jobs',json={'text':'確認です。','lora_id':lora['id']})
            assert r.status_code==202,r.text
            job=r.json()
            assert job['request_config']['lora_path']==str(root/lora['relative_path'])
        assert c.get('/api/v1/loras').json()['items']==items
