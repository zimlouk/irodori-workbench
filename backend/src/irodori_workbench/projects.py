"""Durable editing with explicit preset snapshots and immutable per-segment attempts.

Writes share the application's single-process lock with the queue claim/completion.
Project revision is an optimistic edit token; input_revision identifies an audio input.
Polling or finishing audio never invalidates an unsaved editor's edit token.
"""
from contextlib import contextmanager
from copy import deepcopy
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from .configuration import VoiceConfig, config_dict, freeze_config, merge_config, normalize_overrides
from .storage import Asset, Job, Preset, Project, utc_now
from .storage import Preference
from .preset_order import ordered_presets, order_token


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Named(StrictModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("名称不能为空")
        return value.strip()


class PresetBody(Named):
    voice_name: str = Field(min_length=1, max_length=200)
    config: VoiceConfig = Field(default_factory=VoiceConfig)

    @field_validator("voice_name")
    @classmethod
    def voice_nonblank(cls, value):
        return Named.nonblank(value)


class PresetEdit(PresetBody):
    version: int = Field(ge=1)


class PresetOrder(StrictModel):
    revision: str
    ids: list[str] | None = Field(default=None, max_length=5000)


class ProjectBody(Named):
    default_preset_id: str | None = None


class SegmentBody(StrictModel):
    id: str | None = None
    text: str = Field(default="", max_length=4096)
    speaker: str = Field(default="", max_length=200)
    preset_id: str | None = None
    overrides: dict = Field(default_factory=dict)


class ProjectEdit(ProjectBody):
    revision: int = Field(ge=1)
    segments: list[SegmentBody] = Field(max_length=500)


class Revision(StrictModel):
    revision: int = Field(ge=1)


class Generate(Revision):
    segment_ids: list[str] | None = Field(default=None, max_length=500)


class Preview(Revision):
    segment_ids: list[str] = Field(min_length=1, max_length=500)


class ApplyPresets(Preview):
    versions: dict[str, int]


class SelectResult(Revision):
    job_id: str


class Cancel(StrictModel):
    batch_id: str | None = None


def preset_view(row):
    return {key: getattr(row, key) for key in
            ("id", "voice_name", "name", "version", "config", "created_at", "updated_at")}


def snapshot(session, preset_id):
    if preset_id is None:
        return {"preset_id": None, "preset_version": None, "config": config_dict(VoiceConfig())}
    preset = session.get(Preset, preset_id)
    if preset is None:
        raise HTTPException(422, "音色预设不存在")
    return {"preset_id": preset.id, "preset_version": preset.version, "config": deepcopy(preset.config)}


def effective(segment):
    return merge_config(segment["snapshot"]["config"], segment["overrides"])


def input_key(segment):
    return segment["text"], segment["speaker"], effective(segment)


def project_view(session, project, job_view):
    document = deepcopy(project.document)
    jobs = list(session.scalars(select(Job).where(Job.project_id == project.id)
                               .order_by(Job.created_at, Job.id)))
    by_segment = {}
    for job in jobs:
        by_segment.setdefault(job.segment_id, []).append(job)
    for segment in document["segments"]:
        attempts = by_segment.get(segment["id"], [])
        segment["effective_config"] = effective(segment)
        segment["attempts"] = [{**job_view(job), "stale": job.input_revision != segment["input_revision"]}
                               for job in attempts]
        selected = next((j for j in attempts if j.id == segment["selected_job_id"]), None)
        segment["selected_stale"] = bool(selected and selected.input_revision != segment["input_revision"])
        segment.pop("auto_select_job_id", None)
    return {"id": project.id, "name": project.name, "revision": project.revision,
            "created_at": project.created_at, "updated_at": project.updated_at, **document}


def complete_project_attempt(session, job):
    """Caller holds write lock and the same transaction as successful job completion."""
    if job.project_id is None:
        return
    project = session.get(Project, job.project_id)
    if project is None:
        return
    doc = deepcopy(project.document)
    segment = next((s for s in doc["segments"] if s["id"] == job.segment_id), None)
    if (segment and segment["input_revision"] == job.input_revision
            and segment.get("auto_select_job_id") == job.id):
        segment["selected_job_id"] = job.id
        segment["auto_select_job_id"] = None
        project.document = doc


def register_project_routes(app, lora_settings, mode, job_view):
    router = APIRouter(prefix="/api/v1")

    @contextmanager
    def writing():
        with app.state.write_lock, app.state.sessions.begin() as session:
            yield session

    def get_project(session, project_id, revision=None):
        project = session.get(Project, project_id)
        if project is None:
            raise HTTPException(404, "项目不存在")
        if revision is not None and project.revision != revision:
            raise HTTPException(409, "项目已被其他编辑更新；请保留草稿并重新加载")
        return project

    def validate_config(session, config):
        freeze_config(session, app.state.asset_dir, lora_settings, config, "validation")

    def pick_segments(project, ids):
        all_segments = project.document["segments"]
        if ids is None:
            chosen = all_segments
        else:
            if len(ids) != len(set(ids)) or set(ids) - {s["id"] for s in all_segments}:
                raise HTTPException(422, "段落 ID 重复或不属于该项目")
            chosen = [s for s in all_segments if s["id"] in ids]
        if not chosen:
            raise HTTPException(422, "请至少选择一个段落")
        return chosen

    @router.get("/presets")
    def list_presets():
        with app.state.sessions() as session:
            return preset_catalog(session)

    def preset_catalog(session):
        rows, works = ordered_presets(session,lora_settings)
        pref = session.get(Preference,'preset-order')
        return {'items':[{**preset_view(p),'work':works[p.id]} for p in rows],
                'order_revision':order_token(rows,pref)}

    @router.put('/presets/order')
    def reorder_presets(body: PresetOrder):
        with writing() as session:
            rows, _ = ordered_presets(session,lora_settings)
            pref = session.get(Preference,'preset-order')
            if body.revision != order_token(rows,pref):
                raise HTTPException(409,'预设列表或顺序已改变，请刷新后再调整')
            ids = body.ids
            if ids is not None and (len(ids) != len(set(ids)) or set(ids) != {p.id for p in rows}):
                raise HTTPException(422,'排序必须包含全部预设且不能重复')
            if pref is None:
                pref = Preference(id='preset-order',revision=1,document={'ids':ids or []})
                session.add(pref)
            else:
                pref.document = {'ids':ids or []}
                pref.revision += 1
            session.flush()
            return preset_catalog(session)

    @router.post("/presets", status_code=201)
    def create_preset(body: PresetBody):
        with writing() as session:
            config = config_dict(body.config)
            validate_config(session, config)
            row = Preset(id=str(uuid4()), voice_name=body.voice_name, name=body.name,
                         config=config, version=1, created_at=utc_now(), updated_at=utc_now())
            session.add(row)
            session.flush()
            return {**preset_view(row),'work':ordered_presets(session,lora_settings)[1][row.id]}

    @router.put("/presets/{preset_id}")
    def edit_preset(preset_id: str, body: PresetEdit):
        with writing() as session:
            row = session.get(Preset, preset_id)
            if row is None:
                raise HTTPException(404, "预设不存在")
            if row.version != body.version:
                raise HTTPException(409, "预设已更新，请重新加载后编辑")
            config = config_dict(body.config)
            validate_config(session, config)
            row.voice_name, row.name, row.config = body.voice_name, body.name, config
            row.version += 1
            row.updated_at = utc_now()
            return {**preset_view(row),'work':ordered_presets(session,lora_settings)[1][row.id]}

    @router.delete('/presets/{preset_id}')
    def delete_preset(preset_id: str, version: int = Query(ge=1)):
        with writing() as session:
            row = session.get(Preset, preset_id)
            if row is None:
                raise HTTPException(404, '预设不存在')
            if row.version != version:
                raise HTTPException(409, '预设已更新，请重新加载后删除')
            # All existing batch/project inputs contain independent snapshots.
            session.delete(row)
            return {'deleted': True}

    @router.patch("/assets/{asset_id}")
    def rename_asset(asset_id: str, body: Named):
        with writing() as session:
            row = session.get(Asset, asset_id)
            if row is None:
                raise HTTPException(404, "素材不存在")
            row.name = body.name
            return {"id": row.id, "name": row.name, "duration_seconds": row.duration_seconds,
                    "sample_rate": row.sample_rate, "channels": row.channels,
                    "audio_url": f"/api/v1/assets/{row.id}/audio"}

    @router.get("/projects")
    def list_projects():
        with app.state.sessions() as session:
            return {"items": [{"id": p.id, "name": p.name, "revision": p.revision,
                               "updated_at": p.updated_at, "segment_count": len(p.document["segments"])}
                              for p in session.scalars(select(Project).order_by(Project.updated_at.desc(), Project.id))]}

    @router.post("/projects", status_code=201)
    def create_project(body: ProjectBody):
        with writing() as session:
            snap = snapshot(session, body.default_preset_id)
            validate_config(session, snap["config"])
            row = Project(id=str(uuid4()), name=body.name, revision=1,
                          created_at=utc_now(), updated_at=utc_now(),
                          document={"default_preset_id": body.default_preset_id,
                                    "default_snapshot": snap, "segments": []})
            session.add(row)
            session.flush()
            return project_view(session, row, job_view)

    @router.get("/projects/{project_id}")
    def read_project(project_id: str):
        with app.state.sessions() as session:
            return project_view(session, get_project(session, project_id), job_view)

    @router.put("/projects/{project_id}")
    def edit_project(project_id: str, body: ProjectEdit):
        with writing() as session:
            row = get_project(session, project_id, body.revision)
            doc = deepcopy(row.document)
            default_changed = body.default_preset_id != doc["default_preset_id"]
            if default_changed:
                doc["default_snapshot"] = snapshot(session, body.default_preset_id)
                doc["default_preset_id"] = body.default_preset_id
            old = {s["id"]: s for s in doc["segments"]}
            seen, segments = set(), []
            for entry in body.segments:
                if entry.id is not None and (entry.id not in old or entry.id in seen):
                    raise HTTPException(422, "段落 ID 重复或不属于该项目")
                prior = old.get(entry.id)
                if entry.id:
                    seen.add(entry.id)
                if prior and prior["preset_id"] == entry.preset_id and not (entry.preset_id is None and default_changed):
                    snap = deepcopy(prior["snapshot"])
                else:
                    snap = snapshot(session, entry.preset_id) if entry.preset_id else deepcopy(doc["default_snapshot"])
                overrides = normalize_overrides(snap["config"], entry.overrides)
                segment = {"id": entry.id or str(uuid4()), "text": entry.text,
                           "speaker": entry.speaker, "preset_id": entry.preset_id,
                           "snapshot": snap, "overrides": overrides,
                           "input_revision": prior["input_revision"] if prior else 1,
                           "selected_job_id": prior["selected_job_id"] if prior else None,
                           "auto_select_job_id": prior.get("auto_select_job_id") if prior else None}
                validate_config(session, effective(segment))
                if prior and input_key(segment) != input_key(prior):
                    segment["input_revision"] += 1
                    segment["auto_select_job_id"] = None
                segments.append(segment)
            doc["segments"] = segments
            row.document, row.name = doc, body.name
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return project_view(session, row, job_view)

    @router.post("/projects/{project_id}/generate", status_code=202)
    def generate(project_id: str, body: Generate):
        with writing() as session:
            row = get_project(session, project_id, body.revision)
            selected = pick_segments(row, body.segment_ids)
            ids = [s["id"] for s in selected]
            active = session.scalar(select(Job.id).where(Job.project_id == project_id,
                Job.segment_id.in_(ids), Job.status.in_(["pending", "running"])).limit(1))
            if active:
                raise HTTPException(409, "选中的段落已有排队或运行任务")
            batch_id, jobs = str(uuid4()), []
            doc = deepcopy(row.document)
            for segment in selected:
                if not segment["text"].strip():
                    raise HTTPException(422, "选中的段落有空白台词，请先编辑保存")
                config = freeze_config(session, app.state.asset_dir, lora_settings,
                                       effective(segment), segment["text"])
                config["project_revision"] = row.revision
                config["snapshot"] = deepcopy(segment["snapshot"])
                config["overrides"] = deepcopy(segment["overrides"])
                config["speaker"] = segment["speaker"]
                job = Job(id=str(uuid4()), text=segment["text"], status="pending", mode=mode,
                          created_at=utc_now(), request_config=config, project_id=project_id,
                          segment_id=segment["id"], input_revision=segment["input_revision"], batch_id=batch_id)
                session.add(job)
                jobs.append(job)
                next(s for s in doc["segments"] if s["id"] == segment["id"])["auto_select_job_id"] = job.id
            row.document = doc
            session.flush()
            return {"items": [job_view(job) for job in jobs], "batch_id": batch_id}

    @router.post("/projects/{project_id}/cancel")
    def cancel(project_id: str, body: Cancel):
        with writing() as session:
            get_project(session, project_id)
            query = select(Job).where(Job.project_id == project_id, Job.status == "pending")
            if body.batch_id is not None:
                query = query.where(Job.batch_id == body.batch_id)
            jobs = list(session.scalars(query))
            for job in jobs:
                job.status = "cancelled"
            return {"cancelled": len(jobs)}

    @router.post("/projects/{project_id}/segments/{segment_id}/select")
    def select_result(project_id: str, segment_id: str, body: SelectResult):
        with writing() as session:
            row = get_project(session, project_id, body.revision)
            doc = deepcopy(row.document)
            segment = next((s for s in doc["segments"] if s["id"] == segment_id), None)
            job = session.get(Job, body.job_id)
            if (segment is None or job is None or job.project_id != project_id or job.segment_id != segment_id
                    or job.status != "succeeded" or job.input_revision != segment["input_revision"]):
                raise HTTPException(422, "只能选择该段当前修订的成功结果")
            segment["selected_job_id"] = job.id
            segment["auto_select_job_id"] = None
            row.document = doc
            row.revision += 1
            row.updated_at = utc_now()
            return project_view(session, row, job_view)

    def preview_changes(session, row, ids):
        changes = []
        for segment in pick_segments(row, ids):
            preset_id = segment["snapshot"]["preset_id"]
            if preset_id is None:
                continue
            latest = snapshot(session, preset_id)
            changes.append({"segment_id": segment["id"], "preset_id": preset_id,
                "from_version": segment["snapshot"]["preset_version"], "to_version": latest["preset_version"],
                "before": effective(segment), "after": merge_config(latest["config"], segment["overrides"])})
        return changes

    @router.post("/projects/{project_id}/preset-preview")
    def preset_preview(project_id: str, body: Preview):
        with app.state.sessions() as session:
            row = get_project(session, project_id, body.revision)
            return {"revision": row.revision, "changes": preview_changes(session, row, body.segment_ids)}

    @router.post("/projects/{project_id}/apply-presets")
    def apply_presets(project_id: str, body: ApplyPresets):
        with writing() as session:
            row = get_project(session, project_id, body.revision)
            changes = preview_changes(session, row, body.segment_ids)
            if any(body.versions.get(c["preset_id"]) != c["to_version"] for c in changes):
                raise HTTPException(409, "预设已变化，请重新预览差异")
            doc = deepcopy(row.document)
            for change in changes:
                segment = next(s for s in doc["segments"] if s["id"] == change["segment_id"])
                validate_config(session, change["after"])
                segment["snapshot"] = snapshot(session, change["preset_id"])
                if change["before"] != change["after"]:
                    segment["input_revision"] += 1
                    segment["auto_select_job_id"] = None
            row.document = doc
            row.revision += 1
            row.updated_at = utc_now()
            return project_view(session, row, job_view)

    app.include_router(router)
