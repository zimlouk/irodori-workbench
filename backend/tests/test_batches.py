import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter
from irodori_workbench.storage import Job, Batch
from irodori_workbench.processing import prepare, Processing
from irodori_workbench.batch_audio import cleanup


def checked(r, status=200):
    assert r.status_code == status, r.text
    return r.json()


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path, FakeInferenceAdapter(), tmp_path/'missing')) as c:
        yield c


def create(c, source='一つ目です。\n二つ目です。', **kw):
    return checked(c.post('/api/v1/batches', json={'source':source, 'processing':{'merge_short':False}, **kw}),201)


def edit(c,b,**kw):
    return checked(c.put('/api/v1/batches/'+b['id'], json={'revision':b['revision'],**kw}))


def read(c,b):
    return checked(c.get('/api/v1/batches/'+b['id']))


def generate(c,b,**kw):
    return checked(c.post('/api/v1/batches/'+b['id']+'/generate',json={'revision':b['revision'],**kw}),202)


def finished(c,b,count):
    for _ in range(200):
        r=read(c,b)
        jobs=[j for s in r['segments'] for j in s['attempts']]
        if len(jobs)>=count and all(j['status'] not in ('pending','running') for j in jobs):
            return r
        time.sleep(.01)
    raise AssertionError('queue not finished')


def test_open_audio_uses_published_file_and_handles_missing_output(client, monkeypatch):
    import subprocess
    b = create(client, output_dir=str(client.app.state.output_dir.parent/'folder with spaces'))
    sid = b['segments'][0]['id']
    endpoint = '/api/v1/batches/'+b['id']+'/segments/'+sid+'/open-output'
    assert client.post(endpoint).status_code == 404
    generate(client,b)
    b = finished(client,b,2)
    selected = b['segments'][0]
    path = Path(selected['output_path'])
    assert path.is_file()
    calls = []
    monkeypatch.setattr(subprocess,'Popen',lambda args: calls.append(args))
    assert checked(client.post(endpoint)) == {'opened':True}
    assert calls == [['explorer.exe', '/select,'+str(path)]]
    path.unlink()
    assert client.post(endpoint).status_code == 404
    assert len(calls) == 1


def test_health_does_not_probe_inference(client, monkeypatch):
    def blocked():
        raise AssertionError('Health must not wait for inference')
    monkeypatch.setattr(client.app.state.adapter,'status',blocked)
    assert checked(client.get('/api/v1/health')) == {'service':'irodori-workbench','ready':True}


def test_preparation_rules_and_boundaries():
    opt=Processing(mode='article',limit=12,short=6).model_dump()
    source='説明「はい。」「そうですね。」\n\n「別の場面。」語り「次です。」'
    result,_=prepare(source,opt)
    assert result==['はい。そうですね。','別の場面。','次です。']
    assert all(len(t)<=12 for t in prepare('「'+ 'あ'*40+'」',opt)[0])
    opt.update(mode='passthrough',persistent_rules='a -> b')
    assert prepare('a\n a',opt)[0]==['a\n a']
    opt.update(mode='lines',merge_short=False)
    assert prepare('a\na',opt)[0]==['b','b']


def test_autosave_manual_source_conflict_and_resolve(client):
    b=create(client,'原文です。\nそのまま。')
    original_ids=[s['id'] for s in b['segments']]
    b=edit(client,b,script='手工校对。\nそのまま。')
    assert [s['id'] for s in b['segments']]==original_ids
    b=edit(client,b,source='新しい原文。\nそのまま。')
    assert b['segments'][0]['text']=='手工校对。'
    assert b['conflicts'][0]['after']=='新しい原文。'
    conflict=b['conflicts'][0]
    b=checked(client.post('/api/v1/batches/'+b['id']+'/resolve',json={
        'revision':b['revision'],'conflict_id':conflict['id'],'choice':'replace'}))
    assert b['segments'][0]['text']=='新しい原文。' and not b['conflicts']
    assert b['segments'][1]['id']==original_ids[1]


def test_identity_moves_split_merge_and_override_conflict(client):
    b=create(client,'長い台詞です。\n別の台詞です。')
    a,d=b['segments']
    b=edit(client,b,overrides={a['id']:{'caption':'耳语'},d['id']:{'caption':'明るく'}})
    b=edit(client,b,script='別の台詞です。\n長い台詞です。')
    assert [s['id'] for s in b['segments']]==[d['id'],a['id']]
    b=edit(client,b,script='別の台詞です。長い台詞です。')
    assert b['conflicts'][0]['kind']=='overrides'
    conflict=b['conflicts'][0]
    b=checked(client.post('/api/v1/batches/'+b['id']+'/resolve',json={
        'revision':b['revision'],'conflict_id':conflict['id'],'choice':'replace','segment_id':a['id']}))
    assert b['segments'][0]['overrides']=={'caption':'耳语'}
    b=edit(client,b,script='別の台詞です。\n長い台詞です。')
    assert all(s['overrides']=={'caption':'耳语'} for s in b['segments'])


def test_versions_output_selection_delete_and_retention(client):
    b=create(client,'同じ台詞。')
    generate(client,b)
    b=finished(client,b,1)
    s=b['segments'][0]
    first=s['selected_job_id']
    output=Path(s['output_path'])
    assert output.is_file()
    assert generate(client,b)['items']==[]
    generate(client,b,segment_ids=[s['id']],reroll=True)
    b=finished(client,b,2)
    s=b['segments'][0]
    second=s['selected_job_id']
    assert first!=second
    assert len(list(output.parent.glob('*.wav')))==1
    assert next(j for j in s['attempts'] if j['id']==first)['expires_at']
    b=checked(client.post(f"/api/v1/batches/{b['id']}/segments/{s['id']}/select",json={
        'revision':b['revision'],'job_id':first}))
    assert b['segments'][0]['selected_job_id']==first
    with client.app.state.write_lock,client.app.state.sessions.begin() as session:
        j=session.get(Job,second)
        j.expires_at=(datetime.now(timezone.utc)-timedelta(days=1)).isoformat()
        cleanup(session,client.app.state.output_dir)
    b=read(client,b)
    assert next(j for j in b['segments'][0]['attempts'] if j['id']==second)['purged']
    assert checked(client.get('/api/v1/jobs/'+first))['audio_url']
    b=edit(client,b,script='改文。')
    assert output.exists() and b['segments'][0]['selected_stale']
    generate(client,b)
    b=finished(client,b,3)
    assert not output.exists()
    assert len(list(output.parent.glob('*.wav')))==1
    b=edit(client,b,script='')
    assert not list(output.parent.glob('*.wav'))


def test_modified_external_file_not_removed_or_overwritten(client):
    b=create(client,'file')
    generate(client,b)
    b=finished(client,b,1)
    p=Path(b['segments'][0]['output_path']); p.write_bytes(b'user modified')
    generate(client,b,segment_ids=[b['segments'][0]['id']],reroll=True)
    b=finished(client,b,2)
    assert p.read_bytes()==b'user modified'
    assert b['segments'][0]['output_error']
    edit(client,b,script='')
    assert p.read_bytes()==b'user modified'


def test_settings_defaults_and_external_independent(client):
    prefs=checked(client.get('/api/v1/preferences'))
    prefs['config']['caption']='editor only'
    prefs['processing']['temporary_rules']='foo -> bar'
    prefs=checked(client.put('/api/v1/preferences',json=prefs))
    b=checked(client.post('/api/v1/batches',json={'source':'foo'}),201)
    assert b['config']['caption']=='editor only' and b['segments'][0]['text']=='bar'
    external=checked(client.post('/api/v1/synthesize',json={'source':'foo','origin':'another-app'}),202)
    assert external['config']['caption']=='' and external['segments'][0]['text']=='foo'
    assert external['origin']=='another-app'
    job=external['segments'][0]['attempts'][0]
    assert job['priority']==1
    assert checked(client.get('/api/v1/batches?search=foo'))['items']


def test_conflicts_atomic_bad_rules_and_seed(client):
    b=create(client,'aaa',config={'parameters':{'seed':'1234567890123456789'}})
    b=edit(client,b,script='bbb')
    assert client.put('/api/v1/batches/'+b['id'],json={'revision':1,'script':'lost'}).status_code==409
    assert read(client,b)['segments'][0]['text']=='bbb'
    assert read(client,b)['config']['parameters']['seed']=='1234567890123456789'
    assert client.put('/api/v1/batches/'+b['id'],json={'revision':b['revision'],
        'processing':{'temporary_rules':'invalid'}}).status_code==422
    assert read(client,b)==b


def test_priority_new_batch_cancel_and_late_finish(tmp_path):
    class Block(FakeInferenceAdapter):
        def __init__(self):
            self.started=threading.Event();self.release=threading.Event();self.texts=[]
        def synthesize(self,path,config):
            self.texts.append(config['text'])
            if len(self.texts)==1:
                self.started.set(); assert self.release.wait(5)
            return super().synthesize(path,config)
    adapter=Block()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        b=create(c,'first\nsecond')
        generate(c,b)
        assert adapter.started.wait(3)
        b=edit(c,b,script='changed\nsecond')
        e=checked(c.post('/api/v1/synthesize',json={'source':'priority','origin':'generic'}),202)
        new=create(c,'new-batch')
        generate(c,new)
        checked(c.post('/api/v1/batches/'+new['id']+'/cancel',json={}))
        adapter.release.set()
        b=finished(c,b,2)
        finished(c,e,1)
        assert adapter.texts==['first','priority','second']
        assert not b['segments'][0]['selected_job_id']
        assert b['segments'][0]['attempts'][0]['expires_at']
        assert read(c,new)['segments'][0]['attempts'][0]['status']=='cancelled'


def test_compatible_speech_and_sse_share_records(client):
    r=client.post('/v1/audio/speech',headers={'X-Application-Id':'st-example'},json={
        'model':'irodori-tts','input':'未処理\nそのまま','voice':'none','response_format':'wav',
        'irodori':{'chunking_enabled':False,'seed':'1234567890123456789','cfg_scale_text':2.1},'speed':1.2})
    assert r.status_code==200,r.text
    assert r.content[:4]==b'RIFF'
    b=checked(client.get('/api/v1/batches/'+r.headers['x-workbench-batch']))
    assert b['origin']=='st-example' and len(b['segments'])==1
    req=b['segments'][0]['attempts'][0]['request_config']
    assert req['parameters']['cfg_scale_text']==2.1 and req['speed']==1.2
    assert 'cfg_scale_text' not in req['runtime_options']
    r=client.post('/v1/audio/speech',json={'input':'最初。次。','stream_format':'sse',
        'irodori':{'chunking_enabled':True,'chunk_min_chars':1}})
    assert r.status_code==200
    assert r.text.count('event: audio_chunk')==2 and 'event: done' in r.text


def test_batch_restart_persists_snapshot_and_output(tmp_path):
    with TestClient(create_app(tmp_path,FakeInferenceAdapter(),tmp_path/'missing')) as c:
        b=create(c,'persist')
        generate(c,b)
        b=finished(c,b,1)
        data=Path(b['segments'][0]['output_path']).read_bytes()
    with TestClient(create_app(tmp_path,FakeInferenceAdapter(),tmp_path/'missing')) as c:
        assert read(c,b)==b
        assert Path(b['segments'][0]['output_path']).read_bytes()==data


def test_output_reorder_republish_and_invalid_update_is_atomic(client):
    b=create(client,'aaaa\nbbbb')
    generate(client,b)
    b=finished(client,b,2)
    first=Path(b['segments'][0]['output_path'])
    second=Path(b['segments'][1]['output_path'])
    b=edit(client,b,script='bbbb\naaaa')
    assert not first.exists() and not second.exists()
    assert '_001_' in b['segments'][0]['output_path']
    assert '_002_' in b['segments'][1]['output_path']
    files=[Path(s['output_path']) for s in b['segments']]
    assert client.put('/api/v1/batches/'+b['id'],json={'revision':b['revision'],
        'script':'bbbb','overrides':{b['segments'][0]['id']:{'reference_asset_ids':['missing']}}}).status_code==422
    assert all(p.exists() for p in files)
    assert read(client,b)==b


def test_expiry_lease_and_selected_protection(client):
    b=create(client,'retain')
    generate(client,b)
    b=finished(client,b,1)
    generate(client,b,reroll=True,segment_ids=[b['segments'][0]['id']])
    b=finished(client,b,2)
    selected=b['segments'][0]['selected_job_id']
    old=next(j['id'] for j in b['segments'][0]['attempts'] if j['id']!=selected)
    with client.app.state.write_lock,client.app.state.sessions.begin() as session:
        for j in session.scalars(select(Job)):
            j.expires_at='2000-01-01T00:00:00+00:00'
        session.flush()
        cleanup(session,client.app.state.output_dir,{old})
        assert all(j.audio_file for j in session.scalars(select(Job)))
        cleanup(session,client.app.state.output_dir)
    b=read(client,b)
    assert next(j for j in b['segments'][0]['attempts'] if j['id']==selected)['audio_url']
    assert next(j for j in b['segments'][0]['attempts'] if j['id']==old)['purged']


def test_invalid_compatible_options_respond_422(client):
    assert client.post('/v1/audio/speech',json={'input':'text','irodori':{'seed':-1}}).status_code==422
    assert client.post('/v1/audio/speech',json={'input':'text','irodori':{'ref_embed':'not-supported'}}).status_code==422
    assert checked(client.get('/api/v1/batches'))['items']==[]


def test_source_auto_merge_preserves_whole_manual_group(client):
    b=create(client,'長い最初の台詞がここにあります。\n二番目の台詞は変更しません。')
    b=edit(client,b,script='手工校对。\n二番目の台詞は変更しません。')
    b=edit(client,b,source='短い。\n二番目の台詞は変更しません。',processing={'merge_short':True})
    assert [s['text'] for s in b['segments']]==['手工校对。','二番目の台詞は変更しません。']
    c=b['conflicts'][0]
    assert len(c['segment_ids'])==2 and '二番目' in c['before']
    b=checked(client.post('/api/v1/batches/'+b['id']+'/resolve',json={
        'revision':b['revision'],'conflict_id':c['id'],'choice':'replace'}))
    assert [s['text'] for s in b['segments']]==['短い。二番目の台詞は変更しません。']


def test_deleted_line_can_be_recovered_with_audio(client):
    b=create(client,'recover')
    generate(client,b)
    b=finished(client,b,1)
    sid=b['segments'][0]['id']
    b=edit(client,b,script='')
    assert b['deleted_segments'][0]['attempts'][0]['expires_at']
    b=checked(client.post('/api/v1/batches/'+b['id']+'/restore-segment',json={
        'revision':b['revision'],'segment_id':sid}))
    assert b['segments'][0]['id']==sid and not b['deleted_segments']
    assert Path(b['segments'][0]['output_path']).exists()
    assert b['segments'][0]['attempts'][0]['expires_at'] is None


def test_legacy_single_job_also_creates_api_batch(client):
    job=checked(client.post('/api/v1/jobs',json={'text':'legacy'}),202)
    assert job['priority']==1 and job['workbench_batch_id']
    batch=checked(client.get('/api/v1/batches/'+job['workbench_batch_id']))
    assert batch['origin']=='api' and batch['source']=='legacy'


def test_voice_parameters_preset_overrides_and_frozen_attempt(client):
    parameters = {'num_steps': 24, 'seed': '1234567890123456789', 'cfg_scale_text': 2.5,
        'cfg_scale_caption': 1.6, 'cfg_scale_speaker': 4.5, 'cfg_guidance_mode': 'independent',
        'cfg_min_t': 0.4, 'cfg_max_t': 1.0, 'duration_scale': 1.1, 't_schedule_mode': 'sway',
        'sway_coeff': -0.7, 'context_kv_cache': False, 'trim_tail': False}
    preset = checked(client.post('/api/v1/presets', json={'voice_name': 'test', 'name': 'advanced',
        'config': {'caption': 'preset voice', 'parameters': parameters}}), 201)
    b = create(client, config=preset['config'])
    first, second = b['segments']
    b = edit(client, b, overrides={first['id']: {
        'caption': 'single voice', 'parameters': {'cfg_scale_text': 1.2, 'cfg_scale_caption': None}}})
    config = b['segments'][0]['effective_config']
    assert config['caption'] == 'single voice'
    assert config['parameters']['cfg_scale_text'] == 1.2
    assert 'cfg_scale_caption' not in config['parameters']
    assert config['parameters']['context_kv_cache'] is False
    assert b['segments'][1]['effective_config']['caption'] == 'preset voice'
    generate(client, b)
    b = finished(client, b, 2)
    frozen = b['segments'][0]['attempts'][0]['request_config']
    assert frozen['caption'] == 'single voice' and frozen['parameters']['cfg_scale_text'] == 1.2
    assert frozen['parameters']['seed'] == '1234567890123456789'
    revisions = [s['input_revision'] for s in b['segments']]
    config = b['config']
    config['parameters']['cfg_scale_text'] = 3.7
    b = edit(client, b, config=config)
    assert [s['input_revision'] for s in b['segments']] == [revisions[0], revisions[1] + 1]
    assert b['segments'][0]['attempts'][0]['request_config'] == frozen
    assert checked(client.get('/api/v1/presets'))['items'][0]['config']['parameters']['cfg_scale_text'] == 2.5


@pytest.mark.parametrize('parameters', [
    {'cfg_scale_text': -1}, {'cfg_guidance_mode': 'unknown'}, {'cfg_min_t': 2},
    {'duration_scale': 0}, {'seconds': -1}, {'rescale_k': 0}, {'t_schedule_mode': 'unknown'},
])
def test_invalid_voice_parameters_do_not_create_batch(client, parameters):
    checked(client.post('/api/v1/batches', json={'source': 'invalid',
        'config': {'parameters': parameters}}), 422)
    assert not checked(client.get('/api/v1/batches'))['items']


def test_legacy_runtime_options_are_editable_and_can_be_cleared(client):
    b = create(client, 'legacy runtime')
    with client.app.state.sessions.begin() as session:
        row = session.get(Batch, b['id'])
        row.document = {**row.document, 'runtime_options': {
            'cfg_scale_text': 2.2, 'context_kv_cache': False, 'tail_window_size': 22}}
    b = read(client, b)
    assert b['config']['parameters']['cfg_scale_text'] == 2.2
    assert b['config']['parameters']['context_kv_cache'] is False
    assert b['runtime_options'] == {'tail_window_size': 22}
    config = b['config']
    config['parameters']['cfg_scale_text'] = None
    b = edit(client, b, config=config)
    generate(client, b)
    b = finished(client, b, 1)
    frozen = b['segments'][0]['attempts'][0]['request_config']
    assert 'cfg_scale_text' not in frozen['parameters']
    assert 'cfg_scale_text' not in frozen['runtime_options']
    assert frozen['parameters']['context_kv_cache'] is False
    assert frozen['runtime_options']['tail_window_size'] == 22
