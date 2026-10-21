from fastapi.testclient import TestClient
from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter


def app(root):
    return create_app(root,FakeInferenceAdapter(),root/'missing')


def test_saved_rules_validate_revision_and_survive_other_defaults_and_restart(tmp_path):
    with TestClient(app(tmp_path)) as c:
        prefs=c.get('/api/v1/preferences').json()
        prefs['processing']['persistent_rules']='old -> new'
        prefs=c.put('/api/v1/preferences',json=prefs).json()
        initial=c.get('/api/v1/replacement-rules').json()
        assert initial=={'revision':1,'persistent_rules':'old -> new'}
        assert c.put('/api/v1/replacement-rules',json={'revision':1,'persistent_rules':'unfinished'}).status_code==422
        assert c.get('/api/v1/replacement-rules').json()==initial
        saved=c.put('/api/v1/replacement-rules',json={'revision':1,'persistent_rules':'A -> B\nC -> D'}).json()
        assert saved['revision']==2
        assert c.put('/api/v1/replacement-rules',json={'revision':1,'persistent_rules':'bad -> overwrite'}).status_code==409
        assert c.get('/api/v1/preferences').json()==prefs
        prefs['processing']['persistent_rules']='history -> old'
        assert c.put('/api/v1/preferences',json=prefs).status_code==200
        assert c.get('/api/v1/replacement-rules').json()==saved
        batch=c.post('/api/v1/batches',json={'source':'A'}).json()
        assert batch['processing']['persistent_rules']=='history -> old'
    with TestClient(app(tmp_path)) as c:
        assert c.get('/api/v1/replacement-rules').json()==saved
        cleared=c.put('/api/v1/replacement-rules',json={'revision':2,'persistent_rules':''})
        assert cleared.status_code==200 and cleared.json()['persistent_rules']==''
