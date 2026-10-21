import threading
import time

from fastapi.testclient import TestClient
import pytest

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter
from irodori_workbench.storage import Job, open_store, utc_now
from test_inference import wav_bytes


def checked(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def preset(client, **config):
    return checked(client.post('/api/v1/presets', json={
        'voice_name': '甘奈', 'name': '日常', 'config': config}), 201)


def project(client, preset_id=None):
    return checked(client.post('/api/v1/projects', json={
        'name': '二人の会話', 'default_preset_id': preset_id}), 201)


def save(client, p, segments):
    return checked(client.put('/api/v1/projects/' + p['id'], json={
        'name': p['name'], 'revision': p['revision'],
        'default_preset_id': p['default_preset_id'], 'segments': segments}))


def editable(s):
    return {k: s[k] for k in ('id', 'text', 'speaker', 'preset_id', 'overrides')}


def read(client, p):
    return checked(client.get('/api/v1/projects/' + p['id']))


def generate(client, p, ids=None):
    body = {'revision': p['revision']}
    if ids is not None:
        body['segment_ids'] = ids
    return checked(client.post('/api/v1/projects/' + p['id'] + '/generate', json=body), 202)


def finished(client, p):
    for _ in range(150):
        current = read(client, p)
        jobs = [j for s in current['segments'] for j in s['attempts']]
        if jobs and all(j['status'] not in ('pending', 'running') for j in jobs):
            return current
        time.sleep(.02)
    raise AssertionError('queue did not finish')


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path, FakeInferenceAdapter(), tmp_path / 'missing')) as client:
        yield client


def test_delete_preset_requires_current_version_and_preserves_snapshots(client):
    pre = preset(client, caption='warm')
    p = save(client, project(client, pre['id']), [{'text':'こんにちは'}])
    before = read(client, p)
    path = '/api/v1/presets/' + pre['id']
    assert client.delete(path).status_code == 422
    assert client.delete(path+'?version=2').status_code == 409
    assert len(checked(client.get('/api/v1/presets'))['items']) == 1
    assert checked(client.delete(path+'?version=1')) == {'deleted':True}
    assert checked(client.get('/api/v1/presets'))['items'] == []
    assert read(client,p) == before
    assert client.delete(path+'?version=1').status_code == 404


def test_snapshot_override_preview_and_version_conflict(client):
    a = checked(client.post('/api/v1/assets', files={'file': ('a.wav', wav_bytes())}), 201)
    b = checked(client.post('/api/v1/assets', files={'file': ('b.wav', wav_bytes())}), 201)
    pre = preset(client, reference_asset_ids=[b['id'], a['id']], caption='warm',
                 parameters={'seed': '9223372036854775807', 'num_steps': 42})
    p = project(client, pre['id'])
    p = save(client, p, [{'text':'こんにちは', 'speaker':'甘奈'},
                         {'text':'はい', 'speaker':'めぐる', 'overrides': {
                             'reference_asset_ids': [], 'caption':'', 'lora_id':None,
                             'parameters':{'seed':None}}}])
    assert p['segments'][0]['effective_config']['reference_asset_ids'] == [b['id'], a['id']]
    assert p['segments'][0]['effective_config']['parameters']['seed'] == '9223372036854775807'
    config = p['segments'][1]['effective_config']
    assert config['reference_asset_ids'] == [] and config['caption'] == ''
    assert config['parameters'] == {'seed':None, 'num_steps':42, 'max_ref_seconds':None}
    pre['config']['caption'] = 'new'
    body = {k:pre[k] for k in ('version','voice_name','name','config')}
    updated = checked(client.put('/api/v1/presets/' + pre['id'], json=body))
    assert client.put('/api/v1/presets/' + pre['id'], json=body).status_code == 409
    assert read(client,p)['segments'][0]['effective_config']['caption'] == 'warm'
    ids = [s['id'] for s in p['segments']]
    preview = checked(client.post('/api/v1/projects/'+p['id']+'/preset-preview',
        json={'revision':p['revision'], 'segment_ids':ids}))
    assert preview['changes'][0]['after']['caption'] == 'new'
    assert preview['changes'][1]['after']['caption'] == ''
    assert client.post('/api/v1/projects/'+p['id']+'/apply-presets', json={
        'revision':p['revision'], 'segment_ids':ids, 'versions':{pre['id']:1}}).status_code == 409
    new = checked(client.post('/api/v1/projects/'+p['id']+'/apply-presets', json={
        'revision':p['revision'], 'segment_ids':ids, 'versions':{pre['id']:updated['version']}}))
    assert new['segments'][0]['input_revision'] == 2
    assert new['segments'][1]['input_revision'] == 1
    assert new['segments'][1]['overrides'] == p['segments'][1]['overrides']
    jobs = generate(client, new)['items']
    assert jobs[0]['request_config']['reference_asset_ids'] == [b['id'], a['id']]
    assert jobs[1]['request_config']['reference_paths'] == []
    checked(client.patch('/api/v1/assets/'+a['id'],json={'name':'参考一'}))
    assert checked(client.get('/api/v1/assets'))['items'][0]['name'] == '参考一'


def test_order_identity_more_than_sixteen_and_edit_conflicts(client):
    p = save(client, project(client), [{'text':str(i)} for i in range(20)])
    old = p
    original = [s['id'] for s in p['segments']]
    p = save(client,p,[editable(s) for s in reversed(p['segments'])])
    assert [s['id'] for s in p['segments']] == original[::-1]
    assert all(s['input_revision'] == 1 for s in p['segments'])
    assert client.put('/api/v1/projects/'+p['id'],json={
        'name':'stale','revision':old['revision'],'segments':[]}).status_code == 409
    assert client.put('/api/v1/projects/'+p['id'],json={
        'name':'bad','revision':p['revision'],'segments':[editable(p['segments'][0])]*2}).status_code == 422


def test_result_versions_stale_selection_and_restart(tmp_path):
    def app():
        return create_app(tmp_path,FakeInferenceAdapter(),tmp_path/'missing')
    with TestClient(app()) as c:
        p = save(c,project(c),[{'text':'first','speaker':'A'},{'text':'second','speaker':'B'}])
        first = generate(c,p)['items']
        p = finished(c,p)
        assert [s['selected_job_id'] for s in p['segments']] == [j['id'] for j in first]
        generate(c,p,[p['segments'][0]['id']])
        p = finished(c,p)
        assert len(p['segments'][0]['attempts']) == 2
        selected = checked(c.post('/api/v1/projects/'+p['id']+'/segments/'+p['segments'][0]['id']+'/select',
            json={'revision':p['revision'],'job_id':first[0]['id']}))
        entries = [editable(s) for s in selected['segments']]
        entries[0]['text'] = 'edited'
        p = save(c,selected,entries)
        assert p['segments'][0]['selected_stale'] is True
        assert all(j['stale'] for j in p['segments'][0]['attempts'])
        assert c.post('/api/v1/projects/'+p['id']+'/segments/'+p['segments'][0]['id']+'/select',
            json={'revision':p['revision'],'job_id':first[0]['id']}).status_code == 422
    with TestClient(app()) as c:
        restored = read(c,p)
        assert restored == p
        attempt = restored['segments'][0]['attempts'][0]
        assert c.get(attempt['audio_url']).content[:4] == b'RIFF'


class BlockingAdapter(FakeInferenceAdapter):
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = []

    def synthesize(self, output, config):
        self.calls.append(config)
        self.entered.set()
        assert self.release.wait(5)
        return super().synthesize(output, config)


def test_edit_while_running_cancel_pending_and_no_duplicate(tmp_path):
    adapter = BlockingAdapter()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        try:
            p = save(c,project(c),[{'text':'original'}, {'text':'second'}])
            batch = generate(c,p)
            assert adapter.entered.wait(2)
            assert c.post('/api/v1/projects/'+p['id']+'/generate',json={'revision':p['revision']}).status_code == 409
            entries = [editable(s) for s in p['segments']]
            entries[0]['text'] = 'new text'
            p = save(c,p,entries)
            cancelled = checked(c.post('/api/v1/projects/'+p['id']+'/cancel',json={'batch_id':batch['batch_id']}))
            assert cancelled['cancelled'] == 1
        finally:
            adapter.release.set()
        p = finished(c,p)
        assert adapter.calls[0]['text'] == 'original'
        assert len(adapter.calls) == 1
        assert p['segments'][0]['selected_job_id'] is None
        assert p['segments'][0]['attempts'][0]['stale'] is True
        assert p['segments'][1]['attempts'][0]['status'] == 'cancelled'


def test_user_selection_not_overwritten_by_late_attempt(tmp_path):
    adapter = BlockingAdapter()
    adapter.release.set()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        p = save(c,project(c),[{'text':'same'}])
        first = generate(c,p)['items'][0]
        p = finished(c,p)
        adapter.release.clear()
        adapter.entered.clear()
        generate(c,p)
        try:
            assert adapter.entered.wait(2)
            p = checked(c.post('/api/v1/projects/'+p['id']+'/segments/'+p['segments'][0]['id']+'/select',
                json={'revision':p['revision'],'job_id':first['id']}))
        finally:
            adapter.release.set()
        p = finished(c,p)
        assert p['segments'][0]['selected_job_id'] == first['id']


def test_failed_segment_does_not_stop_batch(tmp_path):
    class FailFirst(FakeInferenceAdapter):
        def synthesize(self, output, config):
            if config['text'] == 'fail':
                raise RuntimeError('intentional first-segment failure')
            return super().synthesize(output, config)
    with TestClient(create_app(tmp_path,FailFirst(),tmp_path/'missing')) as c:
        p = save(c,project(c),[{'text':'fail'},{'text':'continue'}])
        generate(c,p)
        p = finished(c,p)
        assert p['segments'][0]['attempts'][0]['status'] == 'failed'
        assert 'intentional' in p['segments'][0]['attempts'][0]['error']
        assert p['segments'][1]['attempts'][0]['status'] == 'succeeded'
        assert p['segments'][1]['selected_job_id'] is not None


def test_default_change_updates_only_inheriting_segments(client):
    first = preset(client,caption='first')
    second = preset(client,caption='second')
    p = save(client,project(client,first['id']),[{'text':'a'}, {'text':'b','preset_id':first['id']}])
    p['default_preset_id'] = second['id']
    p = save(client,p,[editable(s) for s in p['segments']])
    assert [s['effective_config']['caption'] for s in p['segments']] == ['second','first']
    assert [s['input_revision'] for s in p['segments']] == [2,1]


def test_cancel_during_capability_check_does_not_claim(tmp_path):
    class SlowStatus(BlockingAdapter):
        kind = 'irodori'
        def status(self):
            self.entered.set()
            assert self.release.wait(5)
            return {'available':True, 'capabilities':{'runtime':{'busy':False,'loading':False}}}
    adapter = SlowStatus()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        p = save(c,project(c),[{'text':'never run'}])
        generate(c,p)
        try:
            assert adapter.entered.wait(2)
            assert checked(c.post('/api/v1/projects/'+p['id']+'/cancel',json={}))['cancelled'] == 1
        finally:
            adapter.release.set()
        p = finished(c,p)
        assert p['segments'][0]['attempts'][0]['status'] == 'cancelled'
        assert not adapter.calls


def test_invalid_overrides_and_blank_generation_are_atomic(client):
    p = project(client)
    for overrides in ({'reference_asset_ids':None},{'parameters':None}, {'parameters':{'num_steps':None}},
                      {'parameters':{'seed':'9223372036854775808'}},{'path':'secret'}):
        assert client.put('/api/v1/projects/'+p['id'],json={'name':p['name'],'revision':p['revision'],
            'segments':[{'text':'x','overrides':overrides}]}).status_code == 422
    p = save(client,p,[{'text':'valid'}, {'text':' '}])
    assert client.post('/api/v1/projects/'+p['id']+'/generate',json={'revision':p['revision']}).status_code == 422
    assert all(not s['attempts'] for s in read(client,p)['segments'])


def test_restart_interrupts_without_replay(tmp_path):
    engine,sessions = open_store(tmp_path)
    with sessions.begin() as s:
        for status in ('pending','running'):
            s.add(Job(id=status,text='x',status=status,mode='fake',created_at=utc_now()))
    engine.dispose()
    adapter = BlockingAdapter()
    with TestClient(create_app(tmp_path,adapter,tmp_path/'missing')) as c:
        jobs = checked(c.get('/api/v1/jobs'))['items']
        assert all(j['status']=='interrupted' for j in jobs)
        assert not adapter.calls
