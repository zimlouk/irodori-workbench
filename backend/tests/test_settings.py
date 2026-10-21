import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.catalog import lora_catalog, find_lora
from irodori_workbench.external_api import encode
from irodori_workbench.inference import FakeInferenceAdapter
from irodori_workbench.settings import load_settings


def test_precedence_and_paths_are_relative_to_configuration(tmp_path, monkeypatch):
    config = tmp_path/'config.toml'
    config.write_text('[workbench]\nmode="fake"\nport=9001\ndata_dir="local data"\n[lora]\nroot="loras"\n')
    elsewhere = tmp_path/'elsewhere'; elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    s = load_settings(config, environ={'IRODORI_WORKBENCH_PORT':'9002'}, overrides={'port':9003})
    assert s.port == 9003 and s.mode == 'fake'
    assert s.data_dir == tmp_path/'local data' and s.lora_dir == tmp_path/'loras'
    assert '9003' in s.url
    assert 'http://127.0.0.1:9003' in s.allowed_origins
    assert 'http://127.0.0.1:8999' not in s.allowed_origins
    assert load_settings(root=tmp_path, environ={}).launch_mode == 'external'
    assert load_settings(root=tmp_path, environ={}).runtime_python is None


@pytest.mark.parametrize('text', ['[workbench]\nport=0', '[workbench]\nport=true',
    '[workbench]\nmode="unknown"', '[inference]\nurl="http://192.0.2.1:8998"',
    '[inference]\nurl="http://user:password@127.0.0.1"', '[workbench]\nunknown=1'])
def test_invalid_config_fails_before_starting(tmp_path, text):
    p=tmp_path/'bad.toml'; p.write_text(text)
    with pytest.raises(ValueError): load_settings(p, environ={})


def test_nondefault_port_browser_writes_and_cross_site_protection(tmp_path, monkeypatch):
    monkeypatch.setenv('IRODORI_WORKBENCH_PORT','9001')
    monkeypatch.setenv('IRODORI_WORKBENCH_DEV_PORT','5174')
    with TestClient(create_app(tmp_path,FakeInferenceAdapter(),tmp_path/'missing')) as client:
        assert client.post('/api/v1/batches', json={'source':'port check'},headers={'Origin':'http://127.0.0.1:9001'}).status_code==201
        assert client.post('/api/v1/batches', json={'source':'dev check'},headers={'Origin':'http://localhost:5174'}).status_code==201
        for headers in [{'Origin':'http://127.0.0.1:8999'}, {'Origin':'http://example.com'},
                        {'Origin':'http://127.0.0.1:9001','sec-fetch-site':'cross-site'}]:
            assert client.post('/api/v1/batches',json={'source':'blocked'},headers=headers).status_code==403


def test_lora_move_keeps_ids_and_existing_preset_without_database_migration(tmp_path,monkeypatch):
    root=tmp_path/'old models'; cp=root/'demo_v4/checkpoint_final';cp.mkdir(parents=True)
    (cp/'adapter_config.json').write_text('{}');(cp/'adapter_model.safetensors').write_bytes(b'')
    config=tmp_path/'settings.toml';catalog=tmp_path/'loras.json'
    catalog.write_text(json.dumps({'loras':[{'id':'existing-model-id','name':'Demo','path':'demo_v4/checkpoint_final'}]}))
    config.write_text('[lora]\nroot="old models"\ncatalog="loras.json"\n')
    monkeypatch.setenv('IRODORI_WORKBENCH_CONFIG',str(config))
    with TestClient(create_app(tmp_path/'data',FakeInferenceAdapter())) as client:
        preset=client.post('/api/v1/presets',json={'voice_name':'Demo','name':'Default','config':{'lora_id':'existing-model-id'}}).json()
        before=lora_catalog(catalog)[0]
        destination=tmp_path/'new models';shutil.move(str(root),str(destination))
        config.write_text('[lora]\nroot="new models"\ncatalog="loras.json"\n')
        after=lora_catalog(catalog)[0]
        assert before['id']==after['id']=='existing-model-id'
        assert client.get('/api/v1/presets').json()['items'][0]['config']==preset['config']
        job=client.post('/api/v1/jobs',json={'text':'move check','lora_id':'existing-model-id'})
        assert job.status_code==202
        assert job.json()['request_config']['lora_path']==str(destination/'demo_v4/checkpoint_final')
        assert find_lora(catalog,after['aliases'][0])['id']=='existing-model-id'
    catalog.write_text('{"loras": []}')
    first=lora_catalog(catalog)[0]['id']
    root2=tmp_path/'third models';shutil.move(str(destination),str(root2))
    config.write_text('[lora]\nroot="third models"\ncatalog="loras.json"\n')
    assert lora_catalog(catalog)[0]['id']==first


def test_encoding_optional_and_missing_executable_is_clear_error(monkeypatch,tmp_path):
    monkeypatch.setenv('IRODORI_ENCODER_PYTHON',str(tmp_path/'missing-python.exe'))
    assert encode(b'wav-placeholder','wav')==b'wav-placeholder'
    with pytest.raises(HTTPException) as error:encode(b'wav-placeholder','mp3')
    assert error.value.status_code==502 and 'wav' in error.value.detail


def test_key_never_serialized_to_dev_configuration(tmp_path,monkeypatch):
    monkeypatch.setenv('IRODORI_SERVER_API_KEY','test-private-key')
    monkeypatch.setenv('IRODORI_WORKBENCH_PORT','9012')
    script=Path(__file__).parents[2]/'scripts/config_cli.py'
    result=subprocess.run([sys.executable,str(script)],capture_output=True,text=True,check=True)
    assert json.loads(result.stdout)=={'port':9012,'dev_port':5173}
    assert 'test-private-key' not in result.stdout+result.stderr


def patch_tool():
    file=Path(__file__).parents[2]/'integration/server/apply_patch.py'
    spec=importlib.util.spec_from_file_location('protocol_installer',file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def test_patch_checks_all_files_before_writing_and_is_repeatable(tmp_path):
    tool=patch_tool();source=tmp_path/'server/src/irodori_openai_tts';source.mkdir(parents=True)
    patches=tmp_path/'patches';patches.mkdir()
    manifest={'files':{}}
    for name in ('app.py','voices.py'):
        (source/name).write_bytes(b'old\r\n')
        (patches/(name+'.patch')).write_text('--- a/'+name+'\n+++ b/'+name+'\n@@ -1 +1 @@\n-old\n+new\n')
        manifest['files'][name]={'before':tool.digest(b'old\n'),'after':tool.digest(b'new\n')}
    (patches/'manifest.json').write_text(json.dumps(manifest))
    (source/'voices.py').write_text('changed\n')
    with pytest.raises(ValueError,match='refusing'):tool.install(tmp_path/'server',apply=True,patch_dir=patches,backups=tmp_path/'backups')
    assert (source/'app.py').read_bytes()==b'old\r\n' and not (tmp_path/'backups').exists()
    (source/'voices.py').write_bytes(b'old\r\n')
    assert tool.install(tmp_path/'server',patch_dir=patches)=='ready'
    assert (source/'app.py').read_bytes()==b'old\r\n'
    assert tool.install(tmp_path/'server',apply=True,patch_dir=patches,backups=tmp_path/'backups').startswith('applied')
    assert tool.install(tmp_path/'server',apply=True,patch_dir=patches)=='already-applied'
    assert len(list((tmp_path/'backups').glob('*/app.py')))==1
