"""Explicit real-GPU acceptance, never run by the unit test suite."""
import io
import json
from pathlib import Path
from urllib.request import Request, urlopen
import wave

from validation_options import parser_for, require_generation
parser=parser_for(__doc__, 'batch-validation')
args=parser.parse_args()
require_generation(parser,args)
BASE = args.url.rstrip('/')
ROOT = Path(__file__).resolve().parents[1]
OUT = args.evidence_dir
OUT.mkdir(parents=True,exist_ok=True)


def request(path, data=None, headers=None):
    return urlopen(Request(BASE + path, data=json.dumps(data, ensure_ascii=False).encode() if data else None,
                          headers={'Content-Type': 'application/json', **(headers or {})}), timeout=900)


def main():
    original = json.loads((OUT / 'api-submission.json').read_text(encoding='utf-8-sig'))
    config = original['segments'][0]['attempts'][0]['request_config']
    payload = {'model':'irodori-tts','input':'これは外部アプリからの確認です。ありがとうございます。',
               'voice':'none','response_format':'wav','speed':1.0,
               'irodori':{'chunking_enabled':False,'seed':'1234567890123456789','num_steps':40,
                          'lora_adapter':config['lora_path'], 'ref_wavs':config['reference_paths'], 'cfg_scale_text':2.0}}
    with request('/v1/audio/speech', payload, {'X-Application-Id':'st-compat-validation'}) as response:
        audio = response.read()
        bid = response.headers['X-Workbench-Batch']
        metadata = {'batch_id':bid,'used_seed':response.headers['X-Irodori-Seed'],'bytes':len(audio)}
    with wave.open(io.BytesIO(audio)) as wav:
        metadata.update(sample_rate=wav.getframerate(), seconds=wav.getnframes()/wav.getframerate())
    (OUT/'compatible-response.wav').write_bytes(audio)
    (OUT/'compatible-result.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    with request('/api/v1/batches/'+bid) as response:
        (OUT/'compatible-batch.json').write_bytes(response.read())
    print(json.dumps(metadata,ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
