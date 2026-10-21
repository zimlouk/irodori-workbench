"""External applications use the same durable batch service, even without a UI."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import wave
from uuid import uuid4

from fastapi import HTTPException, Request, UploadFile, File
from fastapi.responses import Response, StreamingResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from .batches import BatchCreate, Generate
from .configuration import VoiceConfig, config_dict, merge_config
from .processing import Processing
from .storage import Job, Preset, Asset, utc_now
from .catalog import lora_catalog, inspect_wav
from .batch_audio import sha
from .settings import load_settings


class External(BatchCreate):
    origin: str = Field(default='api', min_length=1, max_length=100)
    preset_id: str | None = None
    overrides: dict = Field(default_factory=dict)


class Speech(BaseModel):
    model_config = ConfigDict(extra='allow', allow_inf_nan=False)
    model: str = 'irodori-tts'
    input: str = Field(min_length=1, max_length=4096)
    voice: str | dict | None = 'none'
    preset_id: str | None = Field(default=None, min_length=1, max_length=200)
    response_format: str = 'wav'
    speed: float = Field(default=1, ge=.25, le=4)
    stream_format: str | None = None
    irodori: dict = Field(default_factory=dict)
    processing: Processing = Field(default_factory=lambda: Processing(mode='passthrough'))


def split_compatible(text, minimum=120, first=None):
    chunks, part, count = [], '', 0
    for c in text:
        part += c
        count += int(not c.isspace())
        if c in '。！？!?\n' and count >= (first if first is not None and not chunks else minimum):
            if part.strip():
                chunks.append(part.strip())
            part, count = '', 0
    if part.strip():
        chunks.append(part.strip())
    return chunks


def encode(wav_bytes, fmt):
    if fmt == 'wav':
        return wav_bytes
    if fmt == 'pcm':
        with wave.open(io.BytesIO(wav_bytes)) as wav:
            return wav.readframes(wav.getnframes())
    # Encoding only in the existing runtime environment; business process never imports torch.
    python = str(load_settings().encoder_python or sys.executable)
    code = "import sys,io,soundfile as sf; a,r=sf.read(io.BytesIO(sys.stdin.buffer.read()),dtype='float32',always_2d=True); b=io.BytesIO(); f=sys.argv[1]; sf.write(b,a,r,format={'mp3':'MP3','flac':'FLAC','opus':'OGG'}[f],subtype='OPUS' if f=='opus' else None); sys.stdout.buffer.write(b.getvalue())"
    try:
        result = subprocess.run([python, '-c', code, fmt], input=wav_bytes, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(502, '音频编码器不可用，请配置 encoding.python 或使用wav格式') from exc
    if result.returncode:
        raise HTTPException(502, '音频编码失败，请检查编码环境的 soundfile 支持或使用wav格式')
    return result.stdout


def join_wavs(paths):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out:
        params = None
        for path in paths:
            with wave.open(str(path), 'rb') as inp:
                key = (inp.getnchannels(), inp.getsampwidth(), inp.getframerate())
                if params is None:
                    params = key
                    out.setnchannels(key[0]); out.setsampwidth(key[1]); out.setframerate(key[2])
                elif params != key:
                    raise HTTPException(502, '生成段落音频格式不一致')
                out.writeframes(inp.readframes(inp.getnframes()))
    return buf.getvalue()


def register_external_routes(app, service):
    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exc):
        if getattr(request.scope.get('route'), 'path', None) == '/v1/audio/speech':
            # Validation details otherwise echo the original text or full request.
            return JSONResponse({'detail':'语音请求参数不合法，请检查输入长度和参数类型'},status_code=422)
        return await request_validation_exception_handler(request, exc)

    def adapter():
        return app.state.adapter

    def voices():
        if not hasattr(adapter(), 'client'):
            return {'object': 'list', 'data': [{'id': 'none', 'no_ref': True}]}
        r = adapter().client.get('/v1/audio/voices', timeout=10)
        r.raise_for_status()
        return r.json()

    def import_reference(session, value):
        path = Path(value).resolve()
        if path.suffix.lower() != '.wav' or not path.is_file() or path.stat().st_size > 30 * 1024 * 1024:
            raise HTTPException(422, '参考路径必须指向本机30MiB以内PCM WAV')
        data = path.read_bytes()
        try:
            info = inspect_wav(data)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        digest = sha(path)
        existing = session.scalar(select(Asset).where(Asset.sha256 == digest))
        if existing:
            return existing.id
        aid = str(uuid4())
        target = app.state.asset_dir / (aid + '.wav')
        target.write_bytes(data)
        session.add(Asset(id=aid, name=path.name, filename=target.name, sha256=digest, created_at=utc_now(), **info))
        session.flush()
        return aid

    def build(session, body):
        # External defaults are stable service defaults, never the current editor.
        config = config_dict(body.config or VoiceConfig())
        if body.preset_id:
            preset = session.get(Preset, body.preset_id)
            if not preset:
                raise HTTPException(422, '音色不存在')
            config = deepcopy_config = json.loads(json.dumps(preset.config))
            if body.config:
                config = merge_config(deepcopy_config, body.config.model_dump(exclude_unset=True))
        config = merge_config(config, body.overrides)
        row = service.create(session, BatchCreate(source=body.source, config=VoiceConfig.model_validate(config),
                    processing=body.processing or Processing(mode='passthrough'), output_dir=body.output_dir), body.origin)
        service.generate(session, row, Generate(revision=row.revision), priority=1)
        return row

    @app.post('/api/v1/synthesize', status_code=202)
    def synthesize(body: External):
        with app.state.write_lock, app.state.sessions.begin() as session:
            return service.view(session, build(session, body))

    @app.get('/v1/models')
    def models():
        return {'object': 'list', 'data': [{'id': 'irodori-tts', 'object': 'model', 'created': 0, 'owned_by': 'irodori-tts'}]}

    @app.get('/v1/audio/voices')
    def list_voices():
        return voices()

    @app.post('/v1/audio/voices', status_code=201)
    async def upload_voice(file: UploadFile = File(...)):
        try:
            data = await file.read(30 * 1024 * 1024 + 1)
            if len(data) > 30 * 1024 * 1024:
                raise HTTPException(413, '参考超过30MiB')
            inspect_wav(data)
            if not hasattr(adapter(), 'client'):
                raise HTTPException(409, '测试模式无Server音色上传')
            r = await asyncio.to_thread(adapter().client.post, '/v1/audio/voices',
                files={'file': (Path(file.filename or 'reference.wav').name, data, 'audio/wav')})
            return JSONResponse(r.json(), status_code=r.status_code)
        finally:
            await file.close()

    def submit_preset(payload, origin, purpose):
        with app.state.sessions() as session:
            preset = session.get(Preset,payload.preset_id)
            if preset is None:
                raise HTTPException(404,'声音预设不存在或已删除')
            snapshot = {'id':preset.id, 'version':preset.version,
                        'voice_name':preset.voice_name, 'name':preset.name,
                        'config':json.loads(json.dumps(preset.config))}
        try:
            available = adapter().status().get('available',False)
        except Exception:
            available = False
        if not available:
            raise HTTPException(503,'推理服务尚未就绪，请稍后再试')
        # Busy/loading is allowed: this enters the existing priority queue.
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.create(session,BatchCreate(source=payload.input,
                config=VoiceConfig.model_validate(snapshot['config']),processing=payload.processing),origin)
            row.document = {**row.document,'generation_purpose':purpose,'preset_snapshot':snapshot}
            result = service.generate(session,row,Generate(revision=row.revision),priority=1)
            return row.id,[j['id'] for j in result['items']],snapshot['version']

    def submit_speech(payload, origin, purpose):
        preset_request = 'preset_id' in payload.model_fields_set
        if preset_request:
            if not payload.preset_id or not payload.preset_id.strip():
                raise HTTPException(422,'preset_id 必须是非空的预设 ID')
            if 'voice' in payload.model_fields_set:
                raise HTTPException(422,'preset_id 与显式传入的 voice 不能同时使用')
            if payload.irodori or payload.model_extra or payload.speed != 1:
                raise HTTPException(422,'按预设生成时不能覆盖预设的声音和生成参数')
            if payload.model != 'irodori-tts':
                raise HTTPException(422,'不支持的模型名')
            if payload.response_format != 'wav' or payload.stream_format is not None:
                raise HTTPException(422,'按预设调用当前支持完整 WAV 响应')
            return submit_preset(payload,origin,purpose)
        if payload.model != 'irodori-tts':
            raise HTTPException(400, '不支持的模型名')
        if payload.response_format not in ('wav', 'pcm', 'mp3', 'flac', 'opus'):
            raise HTTPException(400, '支持wav/pcm/mp3/flac/opus格式')
        if payload.stream_format not in (None, 'sse'):
            raise HTTPException(400, 'stream_format只支持sse')
        options = {**(payload.model_extra or {}), **payload.irodori}
        voice_id = payload.voice.get('id') or payload.voice.get('voice_id') if isinstance(payload.voice, dict) else payload.voice
        # Resolve registered references before locking; no GPU work in this route.
        explicit_ref = any(k in options for k in ('ref_wav', 'ref_wavs', 'ref_latent', 'ref_embed')) or options.get('no_ref')
        if not explicit_ref and voice_id not in (None, '', 'none', 'no_ref', 'no-ref', 'null', 'text-only'):
            voice = next((v for v in voices()['data'] if v['id'] == voice_id), None)
            if voice is None:
                raise HTTPException(400, '未找到音色')
            options = {**voice, **options}
        if options.get('ref_wav') and options.get('ref_wavs'):
            raise HTTPException(422, 'ref_wav和ref_wavs不能同时指定')
        paths = options.get('ref_wavs') or ([options['ref_wav']] if options.get('ref_wav') else [])
        if options.get('no_ref'):
            paths = []
        if options.get('ref_latent') or options.get('ref_embed'):
            # Managed protocol supports waveform references only; don't silently discard input.
            raise HTTPException(422, '中间层当前仅支持WAV参考，请使用ref_wavs或素材ID')
        with app.state.write_lock, app.state.sessions.begin() as session:
            config = config_dict(VoiceConfig())
            config['reference_asset_ids'] = [import_reference(session, p) for p in paths]
            lora = options.get('lora_adapter')
            if lora and str(lora).lower() not in ('none', 'null', 'base', 'off', 'disable', 'disabled'):
                choices = lora_catalog(service.lora_settings)
                found = next((l for l in choices if l['id'] == lora or lora in l.get('aliases', []) or l['name'] == lora or Path(l['path']).resolve() == Path(lora).resolve()), None)
                if not found:
                    raise HTTPException(422, 'LoRA未在本机目录中登记')
                config['lora_id'] = found['id']
            config['caption'] = options.get('caption') or ''
            from .configuration import Parameters
            for key in Parameters.model_fields:
                if key in options and (options[key] is not None or key != 'num_steps'):
                    config['parameters'][key] = options[key]
            row = service.create(session, BatchCreate(source=payload.input,
                config=VoiceConfig.model_validate(config), processing=payload.processing), origin)
            if options.get('chunking_enabled') and not options.get('seconds') and payload.processing.mode == 'passthrough':
                from .processing import new_segment
                minimum = int(options.get('chunk_min_chars') or 120)
                first = options.get('first_sentence_chunk_min_chars')
                if minimum < 1 or (first is not None and int(first) < 1):
                    raise HTTPException(422, '分句最小字数需大于0')
                doc = dict(row.document)
                doc['segments'] = [new_segment(t) for t in split_compatible(payload.input, minimum, int(first) if first else None)]
                row.document = doc
            # Preserve advanced Server options for immutable calls and later rerolls.
            allowed = {'seconds','duration_scale','min_seconds','max_seconds','ref_normalize_db','ref_ensure_max',
                't_schedule_mode','sway_coeff','num_candidates','decode_mode','cfg_scale_text','cfg_scale_caption',
                'cfg_scale_speaker','cfg_guidance_mode','cfg_scale','cfg_min_t','cfg_max_t','truncation_factor',
                'rescale_k','rescale_sigma','context_kv_cache','speaker_kv_scale','speaker_kv_min_t',
                'speaker_kv_max_layers','trim_tail','tail_window_size','tail_std_threshold','tail_mean_threshold',
                'max_text_len','max_caption_len'}
            advanced = {k: v for k, v in options.items() if k in allowed and k not in Parameters.model_fields}
            doc = dict(row.document)
            doc['runtime_options'], doc['speed'] = advanced, payload.speed
            doc['generation_purpose'] = purpose
            row.document = doc
            result = service.generate(session, row, Generate(revision=row.revision), priority=1)
            return row.id, [j['id'] for j in result['items']], None

    async def wait_job(job_id, request, safe_errors=False):
        deadline = asyncio.get_running_loop().time() + 1800
        while True:
            if await request.is_disconnected():
                raise asyncio.CancelledError()
            with app.state.sessions() as session:
                job = session.get(Job, job_id)
                if job.status == 'succeeded':
                    return app.state.output_dir / job.audio_file, job.result_metadata or {}
                if job.status in ('failed', 'interrupted', 'cancelled'):
                    raise HTTPException(502,'语音生成失败，请在工作台记录中查看任务状态' if safe_errors else job.error or job.status)
            if asyncio.get_running_loop().time() > deadline:
                raise HTTPException(504, '等待生成超时，结果仍可从记录找回')
            await asyncio.sleep(.1)

    @app.post('/v1/audio/speech')
    async def speech(payload: Speech, request: Request):
        if not payload.input.strip():
            raise HTTPException(422,'待朗读文本不能为空')
        purpose = request.headers.get('x-generation-purpose','call')
        if purpose not in ('call','preview'):
            raise HTTPException(422,'X-Generation-Purpose 只支持 call 或 preview')
        origin = request.headers.get('x-application-id', 'api')[:100]
        bid, ids, preset_version = await asyncio.to_thread(submit_speech, payload, origin, purpose)
        app.state.audio_leases.update(ids)
        media = {'wav':'audio/wav','pcm':'audio/pcm','mp3':'audio/mpeg','flac':'audio/flac','opus':'audio/opus'}[payload.response_format]

        def cancel_rest():
            if preset_version is None:
                with app.state.write_lock, app.state.sessions.begin() as session:
                    service.cancel(session, service.get(session, bid))
            for jid in ids:
                app.state.audio_leases[jid] -= 1
                if app.state.audio_leases[jid] <= 0:
                    app.state.audio_leases.pop(jid, None)

        if payload.stream_format == 'sse':
            async def events():
                try:
                    for index, jid in enumerate(ids):
                        path, metadata = await wait_job(jid, request)
                        data = await asyncio.to_thread(encode, path.read_bytes(), payload.response_format)
                        with app.state.sessions() as session:
                            text = session.get(Job, jid).text
                        body = {'index':index,'text':text,'format':payload.response_format,'media_type':media,
                                'audio_base64':base64.b64encode(data).decode(), 'seed':metadata.get('used_seed'),
                                'total_to_decode':metadata.get('total_to_decode',0)}
                        yield 'event: audio_chunk\ndata: ' + json.dumps(body, ensure_ascii=False) + '\n\n'
                    yield 'event: done\ndata: ' + json.dumps({'chunks':len(ids)}) + '\n\n'
                except HTTPException as exc:
                    yield 'event: error\ndata: ' + json.dumps({'error':{'message':str(exc.detail),'type':'server_error','code':'stream_error'}}) + '\n\n'
                finally:
                    cancel_rest()
            return StreamingResponse(events(), media_type='text/event-stream', headers={'X-Workbench-Batch':bid, 'Cache-Control':'no-cache'})
        try:
            paths, metadata = [], {}
            for jid in ids:
                path, metadata = await wait_job(jid, request, safe_errors=preset_version is not None)
                paths.append(path)
            try:
                audio = await asyncio.to_thread(join_wavs, paths)
            except (OSError,wave.Error) as exc:
                raise HTTPException(502,'生成音频不可读取，请从工作台记录检查结果') from exc
            data = await asyncio.to_thread(encode, audio, payload.response_format)
            headers = {'X-Workbench-Batch':bid, 'X-Job-Id':ids[0],
                'X-Irodori-Seed':str(metadata.get('used_seed','')), 'Content-Disposition':f'attachment; filename="speech.{payload.response_format}"'}
            if preset_version is not None:
                headers['X-Preset-Version'] = str(preset_version)
            return Response(data, media_type=media, headers=headers)
        finally:
            cancel_rest()
