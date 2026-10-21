"""Explicit real-GPU project acceptance. Run create, restart backend, then verify."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import time

import httpx

from validation_options import parser_for, require_generation
parser=parser_for(__doc__, 'p2-validation')
parser.add_argument('action',choices=['create','verify'])
parser.add_argument('--lora-a')
parser.add_argument('--lora-b')
args=parser.parse_args()
if args.action=='create':
    require_generation(parser,args)
    if not args.lora_a or not args.lora_b:parser.error('create requires --lora-a and --lora-b (model IDs or names)')
EVIDENCE = args.evidence_dir
EVIDENCE.mkdir(parents=True,exist_ok=True)
client = httpx.Client(base_url=args.url.rstrip('/')+'/api/v1', trust_env=False, timeout=30)


def api(method, path, **kwargs):
    r = client.request(method, path, **kwargs)
    r.raise_for_status()
    return r.json()


def save(p, segments):
    return api('PUT', '/projects/'+p['id'], json={
        'revision':p['revision'], 'name':p['name'], 'default_preset_id':p['default_preset_id'],
        'segments':[{k:s[k] for k in ('id','text','speaker','preset_id','overrides') if k in s} for s in segments]})


def wait(p):
    deadline = time.monotonic()+900
    while time.monotonic() < deadline:
        p = api('GET','/projects/'+p['id'])
        jobs = [j for s in p['segments'] for j in s['attempts']]
        if jobs and all(j['status'] not in ('pending','running') for j in jobs):
            assert all(j['status']=='succeeded' for j in jobs), jobs
            return p
        time.sleep(2)
    raise RuntimeError('real project timed out')


def create():
    status = api('GET','/status')
    assert status['mode']=='irodori' and status['inference']['available']
    loras = api('GET','/loras')['items']
    assets = api('GET','/assets')['items']
    presets = []
    for voice, prefix in [(args.lora_a,'amana'),(args.lora_b,'meguru')]:
        lora = next(x for x in loras if voice in (x['id'],x['name']) and x['available'])
        refs = [next(x['id'] for x in assets if x['name']==f'p1-{prefix}-{i}.wav') for i in (2,1)]
        presets.append(api('POST','/presets',json={'voice_name':voice,'name':'P2 验收日常',
            'config':{'lora_id':lora['id'],'reference_asset_ids':refs,'caption':'',
                      'parameters':{'seed':'1234567890123456789','num_steps':40}}}))
    p = api('POST','/projects',json={'name':'P2 双人物持久化验收','default_preset_id':presets[0]['id']})
    p = save(p,[{'text':'おはよう。今日は一緒に出かけましょう。','speaker':'甘奈','preset_id':None,'overrides':{}},
                {'text':'いいですね。とても楽しみです。','speaker':'めぐる','preset_id':presets[1]['id'],'overrides':{}}])
    initial_revision = p['revision']
    api('POST','/projects/'+p['id']+'/generate',json={'revision':p['revision']})
    p = wait(p)
    print('two speakers succeeded',flush=True)
    for s in p['segments']:
        job = s['attempts'][0]
        assert job['result_metadata']['used_seed']=='1234567890123456789'
        assert job['result_metadata']['reference_summary']['encoded_count']==2
        assert job['request_config']['reference_asset_ids']==s['snapshot']['config']['reference_asset_ids']
        assert s['selected_job_id']==job['id']
    first_job = p['segments'][0]['selected_job_id']
    changed = deepcopy(presets[0])
    changed['config']['parameters']['num_steps'] = 41
    api('PUT','/presets/'+changed['id'],json={k:changed[k] for k in ('version','voice_name','name','config')})
    unchanged = api('GET','/projects/'+p['id'])
    assert unchanged == p and unchanged['revision']==initial_revision
    segment_ids = [p['segments'][0]['id']]
    preview = api('POST','/projects/'+p['id']+'/preset-preview',json={'revision':p['revision'],'segment_ids':segment_ids})
    assert preview['changes'][0]['before']['parameters']['num_steps']==40
    assert preview['changes'][0]['after']['parameters']['num_steps']==41
    p = api('POST','/projects/'+p['id']+'/apply-presets',json={'revision':p['revision'],
        'segment_ids':segment_ids,'versions':{presets[0]['id']:2}})
    assert p['segments'][0]['selected_stale']
    entries = deepcopy(p['segments'])
    entries[0]['text']='それでは、駅で待っていますね。'
    p = save(p,entries)
    api('POST','/projects/'+p['id']+'/generate',json={'revision':p['revision'],'segment_ids':segment_ids})
    p = wait(p)
    assert len(p['segments'][0]['attempts'])==2
    assert p['segments'][0]['attempts'][0]['stale']
    assert p['segments'][0]['selected_job_id']!=first_job
    assert p['segments'][0]['attempts'][1]['request_config']['parameters']['num_steps']==41
    assert len(p['segments'][1]['attempts'])==1
    # Same-input reroll retains both valid versions and allows choosing the earlier one.
    second_id = p['segments'][1]['id']
    old_selected = p['segments'][1]['selected_job_id']
    api('POST','/projects/'+p['id']+'/generate',json={'revision':p['revision'],'segment_ids':[second_id]})
    p=wait(p)
    p=api('POST',f'/projects/{p["id"]}/segments/{second_id}/select',json={'revision':p['revision'],'job_id':old_selected})
    assert p['segments'][1]['selected_job_id']==old_selected
    hashes={}
    for s in p['segments']:
        for j in s['attempts']:
            r=client.get(j['audio_url'].removeprefix('/api/v1'))
            r.raise_for_status()
            assert r.content[:4]==b'RIFF'
            hashes[j['id']]=hashlib.sha256(r.content).hexdigest()
    (EVIDENCE/'before-restart.json').write_text(json.dumps({'project':p,'audio_hashes':hashes,
        'presets':presets,'preview':preview},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'project_id':p['id'],'real_attempts':4,'snapshot_isolation':True,'selection':True}),flush=True)


def verify():
    evidence=json.loads((EVIDENCE/'before-restart.json').read_text(encoding='utf-8'))
    p=api('GET','/projects/'+evidence['project']['id'])
    assert p==evidence['project'], 'project changed across restart'
    for j, digest in evidence['audio_hashes'].items():
        r=client.get('/jobs/'+j+'/audio')
        r.raise_for_status()
        assert hashlib.sha256(r.content).hexdigest()==digest
    (EVIDENCE/'restart-verified.json').write_text(json.dumps({'project_id':p['id'],
        'revision':p['revision'],'audio_files':len(evidence['audio_hashes']),'passed':True},indent=2),encoding='utf-8')
    print('Restart: project, snapshots, versions, selection and four audio hashes preserved.',flush=True)


if __name__=='__main__':
    create() if args.action == 'create' else verify()
