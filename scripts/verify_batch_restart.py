"""Capture/compare live API snapshots without shell timestamp conversions."""
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import urlopen

from validation_options import parser_for
parser=parser_for(__doc__, 'batch-validation')
parser.add_argument('action',choices=['capture','verify'])
parser.add_argument('--batch-id',action='append')
args=parser.parse_args()
ROOT=args.evidence_dir
BASE=args.url.rstrip('/')
baseline=ROOT/'restart-baseline.json'
if args.action=='capture':
    if not args.batch_id:parser.error('capture requires at least one --batch-id')
    IDS=args.batch_id
else:
    previous=json.loads(baseline.read_text(encoding='utf-8'))
    IDS=args.batch_id or [b['id'] for b in previous['batches']]
ROOT.mkdir(parents=True,exist_ok=True)


def snapshot():
    batches = [json.load(urlopen(BASE + '/api/v1/batches/' + bid)) for bid in IDS]
    jobs = [j for b in batches for s in b['segments'] for j in s['attempts']]
    hashes = {j['id']: hashlib.sha256(urlopen(BASE+j['audio_url']).read()).hexdigest()
              for j in jobs if j['audio_url']}
    return {'batches': batches, 'audio_hashes': hashes}


data = snapshot()
baseline = ROOT / 'restart-baseline.json'
if args.action == 'capture':
    baseline.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print('captured', len(data['audio_hashes']), 'audio files')
else:
    assert data == json.loads(baseline.read_text(encoding='utf-8')), 'restart changed data or audio'
    jobs = [j for b in data['batches'] for s in b['segments'] for j in s['attempts']]
    result = {'restart_equal': True, 'successful_real_jobs': sum(j['status']=='succeeded' and j['mode']=='irodori' for j in jobs),
              'audio_hashes': data['audio_hashes']}
    (ROOT/'restart-verified.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print('verified',result['successful_real_jobs'],'real successful jobs, identical JSON and WAV hashes')
