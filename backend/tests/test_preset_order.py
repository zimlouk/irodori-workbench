import pytest
from pathlib import Path
from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter


@pytest.fixture(autouse=True)
def example_grouping(monkeypatch):
    monkeypatch.setenv('IRODORI_VOICE_PROFILE', str(Path(__file__).parents[2]/'config/voice-profile.example.json'))


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
        for name in ['一色いろは','伊吹翼','星井美希','高垣楓','櫻木真乃','自定义角色']:
            create(c,name)
        before=catalog(c)
        assert [p['voice_name'] for p in before['items']]==[
            '櫻木真乃','高垣楓','星井美希','伊吹翼','一色いろは','自定义角色']
        assert [p['work'] for p in before['items']]==[
            '偶像大师 闪耀色彩','偶像大师 灰姑娘女孩','偶像大师（本家）',
            '偶像大师 百万现场','我的青春恋爱物语果然有问题','其他']
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
    a=create(client,'櫻木真乃'); b=create(client,'高垣楓')
    before=catalog(client)
    for ids in [[a['id']],[a['id'],a['id']],[a['id'],'missing']]:
        assert client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':ids}).status_code==422
        assert catalog(client)==before
    order=[b['id'],a['id']]
    r=client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':order})
    assert r.status_code==200
    assert client.put('/api/v1/presets/order',json={'revision':before['order_revision'],'ids':None}).status_code==409
    current=catalog(client)
    create(client,'伊吹翼')
    assert client.put('/api/v1/presets/order',json={'revision':current['order_revision'],'ids':order}).status_code==409
