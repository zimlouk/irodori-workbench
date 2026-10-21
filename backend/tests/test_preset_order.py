import json
import pytest
from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter


@pytest.fixture(autouse=True)
def example_grouping(monkeypatch, tmp_path):
    profile = tmp_path/'test-profile.json'
    profile.write_text(json.dumps({'works': [[f'Work {letter}', [[f'speaker_{letter.lower()}', f'Speaker {letter}']]] for letter in 'ABCDE']}), encoding='utf-8')
    monkeypatch.setenv('IRODORI_VOICE_PROFILE', str(profile))


def app(root):
    return create_app(root,FakeInferenceAdapter(),root/'missing')


@pytest.fixture
def client(tmp_path):
    with TestClient(app(tmp_path)) as c:
        yield c


def create(c,name):
    r=c.post('/api/v1/presets',json={'voice_name':name,'name':'默认'})
    assert r.status_code==201,r.text
    return r.json()


def catalog(c):
    r=c.get('/api/v1/presets')
    assert r.status_code==200
    return r.json()


def test_default_work_groups_and_manual_order_survive_restart(tmp_path):
    with TestClient(app(tmp_path)) as c:
        for name in ['Speaker E','Speaker D','Speaker C','Speaker B','Speaker A','自定义角色']:
            create(c,name)
        before=catalog(c)
        assert [p['voice_name'] for p in before['items']]==[
            'Speaker A','Speaker B','Speaker C','Speaker D','Speaker E','自定义角色']
        assert [p['work'] for p in before['items']]==[
            'Work A','Work B','Work C',
            'Work D','Work E','其他']
        order=[p['id'] for p in reversed(before['items'])]
        preferences=c.get('/api/v1/preferences').json()
        response=c.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':order})
        assert response.status_code==200,response.text
        saved=response.json()
        assert [p['id'] for p in saved['items']]==order
        assert saved['items']==list(reversed(before['items']))
        assert c.get('/api/v1/preferences').json()==preferences
    with TestClient(app(tmp_path)) as c:
        assert catalog(c)==saved
        reset=c.put('/api/v1/presets/order',json={'revision':saved['order_revision'],'ids':None})
        assert reset.status_code==200
        assert reset.json()['items']==before['items']


def test_order_rejects_duplicates_missing_ids_and_concurrent_edits(client):
    a=create(client,'Speaker A'); b=create(client,'Speaker B')
    before=catalog(client)
    for ids in [[a['id']],[a['id'],a['id']],[a['id'],'missing']]:
        assert client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':ids}).status_code==422
        assert catalog(client)==before
    order=[b['id'],a['id']]
    r=client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':order})
    assert r.status_code==200
    assert client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':None}).status_code==409
    current=catalog(client)
    create(client,'Speaker D')
    assert client.put('/api/v1/presets/order',json={'revision':current['order_revision'],'ids':order}).status_code==409
