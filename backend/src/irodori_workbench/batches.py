"""UI-independent batch service shared by the editor and external callers."""
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from .storage import Batch, Job, Preference, Project, utc_now
from .configuration import Parameters, VoiceConfig, config_dict, freeze_config, merge_config, normalize_overrides
from .processing import Processing, prepare, reconcile, new_segment
from .batch_audio import retire, select_audio, remove_export, publish, expiry, sha


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class BatchCreate(Strict):
    source: str = Field(default='', max_length=500000)
    config: VoiceConfig | None = None
    processing: Processing | None = None
    output_dir: str | None = Field(default=None, max_length=1000)


class Edit(Strict):
    revision: int = Field(ge=1)
    source: str | None = Field(default=None, max_length=500000)
    script: str | None = Field(default=None, max_length=500000)
    config: VoiceConfig | None = None
    processing: Processing | None = None
    output_dir: str | None = Field(default=None, max_length=1000)
    overrides: dict[str, dict] | None = None

    @model_validator(mode='after')
    def only_one_editor(self):
        if self.source is not None and self.script is not None:
            raise ValueError('原文和校对正文必须分开提交')
        return self


class Generate(Strict):
    revision: int = Field(ge=1)
    segment_ids: list[str] | None = None
    all: bool = False
    reroll: bool = False


class Resolve(Strict):
    revision: int = Field(ge=1)
    conflict_id: str
    choice: str
    segment_id: str | None = None


class Select(Strict):
    revision: int = Field(ge=1)
    job_id: str


class RestoreSegment(Strict):
    revision: int = Field(ge=1)
    segment_id: str


class Preferences(Strict):
    revision: int = Field(ge=1)
    config: VoiceConfig
    processing: Processing
    output_dir: str
    last_batch_id: str | None = None


class ReplacementRules(Strict):
    revision: int = Field(ge=1)
    persistent_rules: str = Field(max_length=20000)


def batch_document(row):
    """Read legacy compatible-API options through the same editable config, without a DB migration."""
    doc = deepcopy(row.document)
    runtime = doc.get('runtime_options', {})
    known = {key: value for key, value in runtime.items() if key in Parameters.model_fields}
    if known:
        doc['config'] = config_dict(VoiceConfig.model_validate({**doc['config'],
            'parameters': {**known, **doc['config']['parameters']}}))
        doc['runtime_options'] = {key: value for key, value in runtime.items() if key not in known}
    return doc


class BatchService:
    def __init__(self, app, lora_settings, mode, job_view):
        self.app, self.lora_settings, self.mode, self.job_view = app, lora_settings, mode, job_view

    def defaults(self, session):
        row = session.get(Preference, 'workbench')
        if row is None:
            row = Preference(id='workbench', revision=1, document={
                'config': config_dict(VoiceConfig()), 'processing': Processing().model_dump(),
                'output_dir': str(self.app.state.output_dir.parent / 'exports'), 'last_batch_id': None})
            session.add(row)
            session.flush()
        return row

    def output_path(self, value):
        path = Path(value).expanduser()
        if not value.strip() or not path.is_absolute() or '..' in path.parts:
            raise HTTPException(422, '请填写绝对输出目录')
        return str(path)

    def validate(self, session, config):
        freeze_config(session, self.app.state.asset_dir, self.lora_settings, config, 'validation')

    def get(self, session, batch_id, revision=None):
        row = session.get(Batch, batch_id)
        if not row:
            raise HTTPException(404, '批次不存在')
        if revision is not None and row.revision != revision:
            raise HTTPException(409, '内容已被其他编辑更新，请保留草稿后重新加载')
        return row

    def view(self, session, row):
        doc = batch_document(row)
        jobs = list(session.scalars(select(Job).where(Job.workbench_batch_id == row.id).order_by(Job.created_at)))
        for s in [*doc['segments'], *doc.get('deleted_segments', [])]:
            s['effective_config'] = merge_config(doc['config'], s['overrides'])
            s['attempts'] = [{**self.job_view(j), 'stale': j.input_revision != s['input_revision']}
                             for j in jobs if j.segment_id == s['id']]
            selected = next((j for j in jobs if j.id == s['selected_job_id']), None)
            s['selected_stale'] = bool(selected and selected.input_revision != s['input_revision'])
            for key in ('machine_text', 'auto_select_job_id', 'output_sha256'):
                s.pop(key, None)
        return {'id': row.id, 'revision': row.revision, 'origin': row.origin,
                'created_at': row.created_at, 'updated_at': row.updated_at, **doc}

    def create(self, session, body, origin='workbench'):
        default = self.defaults(session).document
        config = config_dict(body.config) if body.config else deepcopy(default['config'])
        processing = body.processing.model_dump() if body.processing else deepcopy(default['processing'])
        directory = self.output_path(body.output_dir or default['output_dir'])
        self.validate(session, config)
        try:
            texts, warnings = prepare(body.source, processing)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        row = Batch(id=str(uuid4()), revision=1, origin=origin, created_at=utc_now(), updated_at=utc_now(),
                    document={'source': body.source, 'config': config, 'processing': processing,
                              'output_dir': directory, 'segments': [new_segment(t) for t in texts],
                              'conflicts': [], 'warnings': warnings, 'deleted_segments': []})
        session.add(row)
        session.flush()
        return row

    def touch(self, row, doc):
        row.document, row.revision, row.updated_at = deepcopy(doc), row.revision + 1, utc_now()
        flag_modified(row, 'document')

    def edit(self, session, row, body):
        doc = batch_document(row)
        before = deepcopy(doc)
        removed = []
        if body.config:
            doc['config'] = config_dict(body.config)
        if body.processing:
            doc['processing'] = body.processing.model_dump()
        if body.output_dir is not None:
            doc['output_dir'] = self.output_path(body.output_dir)
        self.validate(session, doc['config'])
        if body.overrides is not None:
            by_id = {s['id']: s for s in doc['segments']}
            if set(body.overrides) - set(by_id):
                raise HTTPException(422, '单句设置不属于当前批次')
            for sid, overrides in body.overrides.items():
                by_id[sid]['overrides'] = normalize_overrides(doc['config'], overrides)
        source_changed = body.source is not None and body.source != before['source']
        rules_changed = doc['processing'] != before['processing']
        if source_changed or rules_changed or body.script is not None:
            if body.source is not None:
                doc['source'] = body.source
            source_update = body.script is None
            try:
                if source_update:
                    texts, doc['warnings'] = prepare(doc['source'], doc['processing'])
                else:
                    texts = [t.strip() for t in body.script.splitlines() if t.strip()]
                    if len(texts) > 500 or any(len(t) > 4096 for t in texts):
                        raise ValueError('最多500句，每句最多4096字')
                doc['segments'], conflicts, removed = reconcile(doc['segments'], texts, source_update)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            retained_ids = {s['id'] for s in doc['segments']}
            replaced = {(c['kind'], tuple(c['segment_ids'])) for c in conflicts}
            doc['conflicts'] = [c for c in doc['conflicts'] if set(c['segment_ids']) <= retained_ids
                                and (c['kind'], tuple(c['segment_ids'])) not in replaced] + conflicts
            doc['deleted_segments'] = doc.get('deleted_segments', []) + removed
        old = {s['id']: s for s in before['segments']}
        for s in doc['segments']:
            config = merge_config(doc['config'], s['overrides'])
            self.validate(session, config)
            prior = old.get(s['id'])
            if prior and (s['text'], config) != (prior['text'], merge_config(before['config'], prior['overrides'])):
                s['input_revision'] += 1
                s['auto_select_job_id'] = None
        # No file mutation until every new segment/config has validated successfully.
        for s in removed:
            s['deleted_effective_config'] = merge_config(before['config'], s['overrides'])
            retire(session, s['selected_job_id'])
            remove_export(s)
        self.touch(row, doc)
        if (before['output_dir'] != doc['output_dir'] or
                [s['id'] for s in before['segments']] != [s['id'] for s in doc['segments']]):
            for s in doc['segments']:
                job = session.get(Job, s['selected_job_id']) if s['selected_job_id'] else None
                if job and job.audio_file and not job.purged:
                    try:
                        publish(row, s, job, self.app.state.output_dir)
                    except OSError as exc:
                        s['output_error'] = f'输出写入失败：{exc}'
            row.document = deepcopy(doc)
            flag_modified(row, 'document')

    def generate(self, session, row, body, priority=0):
        doc = batch_document(row)
        ids = body.segment_ids
        if ids is not None and (len(set(ids)) != len(ids) or set(ids) - {s['id'] for s in doc['segments']}):
            raise HTTPException(422, '台词ID重复或不属于当前批次')
        selected = [s for s in doc['segments'] if ids is None or s['id'] in ids]
        if body.reroll and len(selected) != 1:
            raise HTTPException(422, '单句重抽需要指定一句')
        submission, jobs = str(uuid4()), []
        for s in selected:
            active = session.scalar(select(Job).where(Job.workbench_batch_id == row.id, Job.segment_id == s['id'],
                                                      Job.status.in_(['pending', 'running'])))
            if active:
                if body.reroll:
                    raise HTTPException(409, '这句已有生成任务')
                continue
            chosen = session.get(Job, s['selected_job_id']) if s['selected_job_id'] else None
            if (not body.all and not body.reroll and chosen and chosen.status == 'succeeded'
                    and chosen.input_revision == s['input_revision'] and not chosen.purged):
                continue
            if not s['text'].strip():
                raise HTTPException(422, '不能生成空台词')
            config = freeze_config(session, self.app.state.asset_dir, self.lora_settings,
                                   merge_config(doc['config'], s['overrides']), s['text'])
            config['origin'] = row.origin
            if 'generation_purpose' in doc:
                config['generation_purpose'] = doc['generation_purpose']
            if snapshot := doc.get('preset_snapshot'):
                config['preset_id'] = snapshot['id']
                config['preset_version'] = snapshot['version']
                config['preset_snapshot'] = deepcopy(snapshot)
            config['runtime_options'] = deepcopy(doc.get('runtime_options', {}))
            config['speed'] = doc.get('speed', 1)
            job = Job(id=str(uuid4()), text=s['text'], status='pending', mode=self.mode, created_at=utc_now(),
                      request_config=config, workbench_batch_id=row.id, segment_id=s['id'],
                      input_revision=s['input_revision'], batch_id=submission, priority=max(priority, int(body.reroll)), purged=0)
            s['auto_select_job_id'] = job.id
            session.add(job)
            jobs.append(job)
        if not selected:
            raise HTTPException(422, '没有可生成的台词')
        row.document = doc
        session.flush()
        return {'items': [self.job_view(j) for j in jobs], 'batch_id': submission}

    def cancel(self, session, row):
        jobs = list(session.scalars(select(Job).where(Job.workbench_batch_id == row.id, Job.status == 'pending')))
        for j in jobs:
            j.status = 'cancelled'
        return {'cancelled': len(jobs)}

    def migrate_projects(self, session):
        # Preserve original tables, IDs and jobs. Import a readable batch copy once.
        if session.get(Preference, 'legacy_imported'):
            return
        for project in session.scalars(select(Project)):
            if session.get(Batch, project.id):
                continue
            original = project.document
            segments = []
            for old in original['segments']:
                s = new_segment(old['text'], merge_config(old['snapshot']['config'], old['overrides']))
                s.update({k: old.get(k) for k in ('id', 'input_revision', 'selected_job_id', 'auto_select_job_id')})
                segments.append(s)
            row = Batch(id=project.id, revision=1, origin='workbench', created_at=project.created_at,
                updated_at=project.updated_at, document={'source': '\n'.join(s['text'] for s in segments),
                'config': config_dict(VoiceConfig()), 'processing': Processing(merge_short=False).model_dump(),
                'output_dir': self.defaults(session).document['output_dir'], 'segments': segments,
                'conflicts': [], 'warnings': ['从旧版记录恢复'], 'deleted_segments': []})
            session.add(row)
            session.flush()
            for j in session.scalars(select(Job).where(Job.project_id == project.id)):
                j.workbench_batch_id = row.id
                if j.audio_file and (self.app.state.output_dir / j.audio_file).is_file():
                    j.result_metadata = {**(j.result_metadata or {}), 'audio_sha256': sha(self.app.state.output_dir / j.audio_file)}
                    if j.id not in {s['selected_job_id'] for s in segments}:
                        j.expires_at = expiry()
        session.add(Preference(id='legacy_imported', revision=1, document={}))


def register_batch_routes(app, lora_settings, mode, job_view):
    service = BatchService(app, lora_settings, mode, job_view)
    app.state.batch_service = service
    router = APIRouter(prefix='/api/v1')

    def saved_rules(session):
        row=session.get(Preference,'replacement-rules')
        if row is None:
            initial=service.defaults(session).document['processing'].get('persistent_rules','')
            row=Preference(id='replacement-rules',revision=1,document={'persistent_rules':initial})
            session.add(row)
            session.flush()
        return row

    @router.get('/replacement-rules')
    def read_rules():
        with app.state.write_lock,app.state.sessions.begin() as session:
            row=saved_rules(session)
            return {'revision':row.revision,**row.document}

    @router.put('/replacement-rules')
    def save_rules(body: ReplacementRules):
        from .processing import replacement_rules
        try:
            replacement_rules(body.persistent_rules)
        except ValueError as exc:
            raise HTTPException(422,str(exc)) from exc
        with app.state.write_lock,app.state.sessions.begin() as session:
            row=saved_rules(session)
            if row.revision!=body.revision:
                raise HTTPException(409,'长期规则已在其他页面更新，请重新载入后再保存')
            row.document={'persistent_rules':body.persistent_rules}
            row.revision+=1
            return {'revision':row.revision,**row.document}

    @router.get('/preferences')
    def preferences():
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.defaults(session)
            return {'revision': row.revision, **row.document}

    @router.put('/preferences')
    def save_preferences(body: Preferences):
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.defaults(session)
            if row.revision != body.revision:
                raise HTTPException(409, '默认设置已更新，请保留当前设置后重新加载')
            service.validate(session, config_dict(body.config))
            if body.last_batch_id:
                service.get(session, body.last_batch_id)
            row.document = {**body.model_dump(exclude={'revision'}), 'config': config_dict(body.config),
                            'output_dir': service.output_path(body.output_dir)}
            row.revision += 1
            return {'revision': row.revision, **row.document}

    @router.post('/batches', status_code=201)
    def create(body: BatchCreate):
        with app.state.write_lock, app.state.sessions.begin() as session:
            return service.view(session, service.create(session, body))

    @router.get('/batches')
    def history(search: str = ''):
        with app.state.sessions() as session:
            result = []
            for row in session.scalars(select(Batch).order_by(Batch.updated_at.desc())):
                doc = row.document
                if search and search.casefold() not in (doc['source'] + '\n' + '\n'.join(s['text'] for s in doc['segments'])).casefold():
                    continue
                jobs = list(session.scalars(select(Job).where(Job.workbench_batch_id == row.id)))
                result.append({'id': row.id, 'origin': row.origin, 'source': doc['source'],
                    'generation_purpose':doc.get('generation_purpose'),
                    'preview': next((s['text'][:80] for s in doc['segments']), doc['source'][:80]),
                    'updated_at': row.updated_at, 'segment_count': len(doc['segments']),
                    'completed_count': sum(any(j.id == s['selected_job_id'] and j.input_revision == s['input_revision'] for j in jobs) for s in doc['segments']),
                    'active_count': sum(j.status in ('pending', 'running') for j in jobs)})
            return {'items': result}

    @router.get('/batches/{bid}')
    def read(bid: str):
        with app.state.sessions() as session:
            return service.view(session, service.get(session, bid))

    @router.put('/batches/{bid}')
    def edit(bid: str, body: Edit):
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.get(session, bid, body.revision)
            service.edit(session, row, body)
            return service.view(session, row)

    @router.post('/batches/{bid}/generate', status_code=202)
    def generate(bid: str, body: Generate):
        with app.state.write_lock, app.state.sessions.begin() as session:
            return service.generate(session, service.get(session, bid, body.revision), body)

    @router.post('/batches/{bid}/cancel')
    def cancel(bid: str):
        with app.state.write_lock, app.state.sessions.begin() as session:
            return service.cancel(session, service.get(session, bid))

    @router.post('/batches/{bid}/resolve')
    def resolve(bid: str, body: Resolve):
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.get(session, bid, body.revision)
            doc = batch_document(row)
            conflict = next((c for c in doc['conflicts'] if c['id'] == body.conflict_id), None)
            if not conflict or body.choice not in ('keep', 'replace'):
                raise HTTPException(422, '请选择有效冲突及处理方式')
            segment = next((s for s in doc['segments'] if s['id'] in conflict['segment_ids']), None)
            if not segment:
                raise HTTPException(409, '冲突对应台词已经改变，请重新加载')
            if body.choice == 'replace':
                if conflict['kind'] == 'source':
                    group = [s for s in doc['segments'] if s['id'] in conflict['segment_ids']]
                    replacement, setting_conflicts, removed = reconcile(group,
                        [t for t in conflict['after'].splitlines() if t.strip()], False)
                    position = doc['segments'].index(group[0])
                    doc['segments'] = [s for s in doc['segments'] if s['id'] not in conflict['segment_ids']]
                    doc['segments'][position:position] = replacement
                    for s in replacement:
                        s['input_revision'] += 1
                        s['machine_text'] = s['text']
                        s['auto_select_job_id'] = None
                    for s in removed:
                        retire(session, s['selected_job_id'])
                        remove_export(s)
                    doc['deleted_segments'].extend(removed)
                    doc['conflicts'].extend(setting_conflicts)
                else:
                    choice = next((c for c in conflict['choices'] if c['segment_id'] == body.segment_id), None)
                    if not choice:
                        raise HTTPException(422, '请选择要保留的单句设置')
                    segment['overrides'] = choice['overrides']
                    segment['input_revision'] += 1
                    segment['auto_select_job_id'] = None
            doc['conflicts'].remove(conflict)
            service.touch(row, doc)
            return service.view(session, row)

    @router.post('/batches/{bid}/segments/{sid}/select')
    def choose(bid: str, sid: str, body: Select):
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.get(session, bid, body.revision)
            doc = batch_document(row)
            segment = next((s for s in doc['segments'] if s['id'] == sid), None)
            job = session.get(Job, body.job_id)
            if (not segment or not job or job.workbench_batch_id != bid or job.segment_id != sid
                    or job.status != 'succeeded' or job.purged or job.input_revision != segment['input_revision']):
                raise HTTPException(422, '只能选择当前输入的有效成功版本')
            row.document = doc
            select_audio(session, row, segment, job, app.state.output_dir)
            service.touch(row, doc)
            return service.view(session, row)

    @router.post('/batches/{bid}/open-output')
    def open_output(bid: str):
        with app.state.sessions() as session:
            directory = Path(service.get(session, bid).document['output_dir'])
        directory.mkdir(parents=True, exist_ok=True)
        if os.name != 'nt':
            raise HTTPException(409, '此操作仅支持本机 Windows')
        os.startfile(str(directory))
        return {'opened': True}

    @router.post('/batches/{bid}/segments/{sid}/open-output')
    def open_segment_output(bid: str, sid: str):
        with app.state.sessions() as session:
            row = service.get(session, bid)
            segment = next((s for s in row.document['segments'] if s['id'] == sid), None)
            if not segment or not segment.get('output_path'):
                raise HTTPException(404, '这句还没有已输出的音频')
            path = Path(segment['output_path'])
        if not path.is_file():
            raise HTTPException(404, '输出文件已移动或删除')
        if os.name != 'nt':
            raise HTTPException(409, '此操作仅支持本机 Windows')
        import subprocess
        # Explorer's /select opens the containing folder and highlights this audio.
        subprocess.Popen(['explorer.exe', f'/select,{path}'])
        return {'opened': True}

    @router.post('/batches/{bid}/restore-segment')
    def restore_segment(bid: str, body: RestoreSegment):
        with app.state.write_lock, app.state.sessions.begin() as session:
            row = service.get(session, bid, body.revision)
            doc = batch_document(row)
            entry = next((s for s in doc.get('deleted_segments', []) if s['id'] == body.segment_id), None)
            if not entry or any(s['id'] == body.segment_id for s in doc['segments']):
                raise HTTPException(422, '未找到可恢复台词')
            if len(doc['segments']) >= 500:
                raise HTTPException(422, '最多500句')
            doc['deleted_segments'].remove(entry)
            entry['auto_select_job_id'] = None
            if entry.get('deleted_effective_config'):
                entry['overrides'] = entry.pop('deleted_effective_config')
            service.validate(session, merge_config(doc['config'], entry['overrides']))
            doc['segments'].append(entry)
            row.document = doc
            job = session.get(Job, entry['selected_job_id']) if entry['selected_job_id'] else None
            if job and not job.purged and job.audio_file and job.input_revision == entry['input_revision']:
                select_audio(session, row, entry, job, app.state.output_dir)
            service.touch(row, doc)
            return service.view(session, row)

    @router.get('/queue')
    def queue():
        with app.state.sessions() as session:
            return {'items': [job_view(j) for j in session.scalars(select(Job).where(Job.status.in_(['pending', 'running']))
                .order_by(Job.priority.desc(), Job.created_at, Job.id))]}

    app.include_router(router)
    return service
