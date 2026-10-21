from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime
import io
import threading
import wave

import pytest
from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter
from test_inference import wav_bytes


class RecordingAdapter(FakeInferenceAdapter):
    def __init__(self):
        self.configs=[]

    def synthesize(self, output, config=None):
        self.configs.append(deepcopy(config))
        return super().synthesize(output,config)


@pytest.fixture
def client(tmp_path):
    adapter=RecordingAdapter()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        yield c


def preset(c, caption='warm', **config):
    r=c.post('/api/v1/presets',json={'voice_name':'八宮めぐる','name':caption,
        'config':{'caption':caption,**config}})
    assert r.status_code==201,r.text
    return r.json()


def speech(c,p,**body):
    return c.post('/v1/audio/speech',headers={'X-Application-Id':'eidolon'},
        json={'model':'irodori-tts','preset_id':p['id'],'input':'😊こんにちは、プロデューサー！',**body})


def decoded(r):
    assert r.status_code==200,r.text
    assert r.headers['content-type']=='audio/wav'
    with wave.open(io.BytesIO(r.content)) as wav:
        assert wav.getnframes()>0
        assert wav.readframes(wav.getnframes())
    return r.headers['x-job-id']


def test_health_and_preset_list_never_generate(client):
    assert client.get('/api/v1/health').json()=={'service':'irodori-workbench','ready':True}
    assert client.get('/api/v1/presets').json()['items']==[]
    a=preset(client,'warm'); b=preset(client,'soft')
    items=client.get('/api/v1/presets').json()['items']
    assert {p['id'] for p in items}=={a['id'],b['id']}
    for item in items:
        assert isinstance(item['version'],int) and item['version']>=1
        assert datetime.fromisoformat(item['updated_at']).tzinfo is not None
        assert all(isinstance(item[k],str) for k in ('id','voice_name','name'))
    assert client.get('/api/v1/jobs').json()['items']==[]
    assert not client.app.state.adapter.configs


def test_exact_preset_config_emoji_references_and_headers(client,tmp_path,monkeypatch):
    lora=tmp_path/'loras/test_v4/checkpoint_final'
    lora.mkdir(parents=True)
    (lora/'adapter_config.json').write_text('{}')
    (lora/'adapter_model.safetensors').write_bytes(b'')
    monkeypatch.setenv('IRODORI_LORA_DIR',str(tmp_path/'loras'))
    lora_id=client.get('/api/v1/loras').json()['items'][0]['id']
    assets=[client.post('/api/v1/assets',files={'file':(str(i)+'.wav',wav_bytes())}).json()['id'] for i in range(2)]
    a=preset(client,'warm',lora_id=lora_id,reference_asset_ids=assets[::-1],parameters={
        'seed':'1234567890123456789','cfg_scale_text':3,'cfg_scale_caption':4,'cfg_scale_speaker':2})
    b=preset(client,'soft',parameters={'cfg_scale_text':1.5,'duration_scale':.9})
    for p,purpose in [(a,'call'),(b,'preview')]:
        r=client.post('/v1/audio/speech',headers={
            'X-Application-Id':'eidolon','X-Generation-Purpose':purpose},
            json={'preset_id':p['id'],'input':'😊こんにちは、プロデューサー！','response_format':'wav'})
        jid=decoded(r)
        assert r.headers['x-preset-version']==str(p['version'])
        job=client.get('/api/v1/jobs/'+jid).json()
        frozen=job['request_config']
        assert job['origin']=='eidolon' and job['generation_purpose']==purpose
        assert job['preset_id']==p['id'] and job['preset_version']==p['version']
        assert frozen['preset_snapshot']['config']==p['config']
        assert frozen['caption']==p['config']['caption']
        assert frozen['parameters']==p['config']['parameters']
        assert frozen['reference_asset_ids']==p['config']['reference_asset_ids']
        assert frozen['lora_id']==p['config']['lora_id']
        assert frozen['lora_path']==(str(lora) if p['id']==a['id'] else None)
        assert job['text']=='😊こんにちは、プロデューサー！'
        batch=client.get('/api/v1/batches/'+r.headers['x-workbench-batch']).json()
        assert batch['generation_purpose']==purpose
        assert batch['preset_snapshot']['version']==p['version']
    assert len(client.app.state.adapter.configs)==2
    assert client.app.state.adapter.configs[0]['reference_asset_ids']==assets[::-1]
    assert client.app.state.adapter.configs[0]['caption']!=client.app.state.adapter.configs[1]['caption']
    assert {p['generation_purpose'] for p in client.get('/api/v1/batches').json()['items']}=={'call','preview'}


def test_snapshot_is_immutable_and_wait_does_not_block_management(tmp_path):
    class Gate(RecordingAdapter):
        def __init__(self):
            super().__init__()
            self.started=threading.Event(); self.release=threading.Event()

        def synthesize(self,output,config=None):
            self.started.set()
            assert self.release.wait(8),'test did not release adapter'
            return super().synthesize(output,config)

    adapter=Gate()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        p=preset(c,'old')
        with ThreadPoolExecutor() as pool:
            pending=pool.submit(speech,c,p)
            try:
                assert adapter.started.wait(3)
                assert pool.submit(c.get,'/api/v1/health').result(2).status_code==200
                assert pool.submit(c.get,'/api/v1/presets').result(2).status_code==200
                updated=c.put('/api/v1/presets/'+p['id'],json={
                    'version':p['version'],'voice_name':p['voice_name'],'name':'renamed',
                    'config':{**p['config'],'caption':'new'}}).json()
                assert updated['id']==p['id'] and updated['version']==2
                assert c.delete('/api/v1/presets/'+p['id']+'?version=2').status_code==200
            finally:
                adapter.release.set()
            r=pending.result(5)
        jid=decoded(r)
        assert r.headers['x-preset-version']=='1'
        snapshot=c.get('/api/v1/jobs/'+jid).json()['request_config']['preset_snapshot']
        assert snapshot['config']==p['config'] and snapshot['name']=='old'
        assert speech(c,p).status_code==404


def test_renamed_binding_uses_new_version_and_default_purpose(client):
    p=preset(client)
    updated=client.put('/api/v1/presets/'+p['id'],json={
        **{k:p[k] for k in ('version','voice_name','config')},'name':'renamed'}).json()
    r=speech(client,p)
    jid=decoded(r)
    assert r.headers['x-preset-version']==str(updated['version'])=='2'
    assert client.get('/api/v1/jobs/'+jid).json()['generation_purpose']=='call'


def test_processed_lines_return_one_complete_decodable_wav(client):
    p=preset(client)
    r=speech(client,p,input='最初です。\n次です。',processing={'mode':'lines','merge_short':False})
    decoded(r)
    with wave.open(io.BytesIO(r.content)) as wav:
        assert wav.getnframes()==24000
    batch=client.get('/api/v1/batches/'+r.headers['x-workbench-batch']).json()
    assert len(batch['segments'])==2
    assert all(s['attempts'][0]['preset_version']==1 for s in batch['segments'])


@pytest.mark.parametrize('extra',[
    {'voice':'none'}, {'voice':None}, {'voice':{'id':'registered-voice'}},
    {'preset_id':None},{'preset_id':''},{'preset_id':' '},
    {'irodori':{'caption':'override'}},{'cfg_scale_text':1},{'speed':1.2},
    {'response_format':'mp3'},{'response_format':'unknown'},{'stream_format':'sse'},
    {'model':'unknown'},{'input':'   '},
])
def test_invalid_preset_requests_never_fall_back_or_enqueue(client,extra):
    p=preset(client)
    r=speech(client,p,**extra)
    assert r.status_code==422,r.text
    assert 'detail' in r.json()
    assert client.get('/api/v1/jobs').json()['items']==[]
    assert not client.app.state.adapter.configs


def test_missing_deleted_invalid_purpose_and_redacted_validation(client):
    assert speech(client,{'id':'missing'}).status_code==404
    p=preset(client)
    assert client.post('/v1/audio/speech',headers={'X-Generation-Purpose':'unknown'},
        json={'preset_id':p['id'],'input':'test'}).status_code==422
    private='private-text-marker-'*300
    r=speech(client,p,input=private)
    assert r.status_code==422 and 'private-text-marker' not in r.text
    assert 'input' not in r.json()
    assert client.delete('/api/v1/presets/'+p['id']+'?version=1').status_code==200
    assert speech(client,p).status_code==404
    assert client.get('/api/v1/jobs').json()['items']==[]


def test_unavailable_returns_503_without_queueing(client,monkeypatch):
    p=preset(client)
    monkeypatch.setattr(client.app.state.adapter,'status',lambda:{'available':False})
    assert speech(client,p).status_code==503
    assert speech(client,{'id':'missing'}).status_code==404
    assert client.get('/api/v1/jobs').json()['items']==[]


def test_generation_failure_is_502_and_does_not_echo_internal_details(client,monkeypatch):
    p=preset(client)
    def fail(*args):
        raise RuntimeError('secret-token D:/private/model.wav entire-private-script')
    monkeypatch.setattr(client.app.state.adapter,'synthesize',fail)
    r=speech(client,p)
    assert r.status_code==502,r.text
    assert not any(s in r.text for s in ['secret-token','D:/private','entire-private-script'])
    assert 'x-preset-version' not in r.headers


def test_busy_runtime_is_queued_instead_of_rejected(client,monkeypatch):
    p=preset(client)
    monkeypatch.setattr(client.app.state.adapter,'status',lambda:{
        'available':True,'capabilities':{'runtime':{'busy':True,'loading':True}}})
    decoded(speech(client,p))


def test_old_voice_ids_are_not_interpreted_as_preset_ids(client):
    p=preset(client)
    r=client.post('/v1/audio/speech',json={'input':'test','voice':p['id']})
    assert r.status_code==400
    assert client.get('/api/v1/jobs').json()['items']==[]
    r=client.post('/v1/audio/speech',json={'input':'test','voice':'none'})
    assert r.status_code==200 and 'x-preset-version' not in r.headers
