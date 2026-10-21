import asyncio
import os
import hashlib
from threading import RLock
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, update
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.background import BackgroundTask
from pydantic import ValidationError

from .inference import FakeInferenceAdapter, IrodoriInferenceAdapter, InferenceUncertain
from .storage import Job, Asset, open_store, utc_now
from .catalog import inspect_wav, lora_catalog
from .configuration import CreateJob
from .projects import register_project_routes, complete_project_attempt
from .batches import register_batch_routes, BatchCreate, Generate
from .configuration import VoiceConfig
from .processing import Processing
from .batch_audio import complete_batch_attempt, cleanup, sha
from .logs import cleanup_logs
from .settings import load_settings

ROOT = Path(__file__).resolve().parents[3]


def job_view(job: Job) -> dict:
    return {"id": job.id, "text": job.text, "status": job.status, "mode": job.mode,
            "created_at": job.created_at, "error": job.error,
            "request_config": job.request_config, "result_metadata": job.result_metadata,
            "project_id": job.project_id, "segment_id": job.segment_id,
            "input_revision": job.input_revision, "batch_id": job.batch_id,
            "workbench_batch_id": job.workbench_batch_id, "priority": job.priority,
            "origin": (job.request_config or {}).get('origin', 'workbench'),
            "generation_purpose": (job.request_config or {}).get('generation_purpose'),
            "preset_id": (job.request_config or {}).get('preset_id'),
            "preset_version": (job.request_config or {}).get('preset_version'),
            "expires_at": job.expires_at, "purged": bool(job.purged),
            "audio_url": f"/api/v1/jobs/{job.id}/audio" if job.audio_file else None}


def create_app(data_dir: Path | None = None, adapter=None, lora_settings: Path | None = None) -> FastAPI:
    settings = load_settings()
    data_dir = data_dir or settings.data_dir
    mode = settings.mode
    adapter = adapter or (FakeInferenceAdapter() if mode == "fake" else IrodoriInferenceAdapter(settings.server_url, settings.api_key))
    mode = getattr(adapter, "kind", "fake")
    lora_settings = lora_settings or settings.lora_settings

    @asynccontextmanager
    async def lifespan(app):
        engine, sessions = open_store(data_dir)
        output_dir = data_dir / "outputs"
        output_dir.mkdir(exist_ok=True)
        app.state.sessions = sessions
        app.state.adapter = adapter
        app.state.write_lock = RLock()
        app.state.output_dir = output_dir
        app.state.asset_dir = data_dir / "assets"
        app.state.asset_dir.mkdir(exist_ok=True)
        app.state.audio_leases = Counter()
        # Unfinished attempts remain inspectable; retry creates a new frozen attempt.
        with sessions.begin() as session:
            session.execute(update(Job).where(Job.status.in_(["pending", "running"])).values(
                status="interrupted", error="服务重启，任务结果未确认；请检查历史后手动重试"))
        stop = asyncio.Event()
        with app.state.write_lock, sessions.begin() as session:
            app.state.batch_service.migrate_projects(session)

        async def run_jobs():
            while not stop.is_set():
                with sessions.begin() as session:
                    job = session.scalar(select(Job).where(Job.status == "pending")
                                         .order_by(Job.priority.desc(), Job.created_at, Job.id).limit(1))
                    job_id = job.id if job else None
                if job_id is None:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=0.1)
                    except TimeoutError:
                        pass
                    continue
                if mode == "irodori":
                    state = await asyncio.to_thread(adapter.status)
                    if not state["available"] or state["capabilities"]["runtime"]["busy"] or state["capabilities"]["runtime"]["loading"]:
                        try:
                            await asyncio.wait_for(stop.wait(), timeout=2)
                        except TimeoutError:
                            pass
                        continue
                with app.state.write_lock, sessions.begin() as session:
                    # A high-priority request may have arrived during capability lookup.
                    job = session.scalar(select(Job).where(Job.status == 'pending')
                                         .order_by(Job.priority.desc(), Job.created_at, Job.id).limit(1))
                    if not job or job.status != "pending":
                        continue  # Cancellation may have won while capability query ran.
                    job_id = job.id
                    job.status = "running"
                    config = job.request_config
                try:
                    filename = f"{job_id}.wav"
                    metadata = await asyncio.to_thread(adapter.synthesize, output_dir / filename, config)
                    metadata['audio_sha256'] = sha(output_dir / filename)
                    with app.state.write_lock, sessions.begin() as session:
                        job = session.get(Job, job_id)
                        job.status = "succeeded"
                        job.audio_file = filename
                        job.result_metadata = metadata
                        complete_project_attempt(session, job)
                        complete_batch_attempt(session, job, output_dir)
                except Exception as exc:
                    with app.state.write_lock, sessions.begin() as session:
                        job = session.get(Job, job_id)
                        job.status = "interrupted" if isinstance(exc, InferenceUncertain) else "failed"
                        job.error = f"{type(exc).__name__}: {exc}"

        async def maintain_audio():
            while not stop.is_set():
                try:
                    with app.state.write_lock, sessions.begin() as session:
                        cleanup(session, output_dir, app.state.audio_leases)
                except OSError:
                    pass  # Locked/moved files remain registered and can be retried later.
                await asyncio.to_thread(cleanup_logs, data_dir / 'logs')
                try:
                    await asyncio.wait_for(stop.wait(), timeout=60)
                except TimeoutError:
                    pass
        worker = asyncio.create_task(run_jobs())
        maintenance = asyncio.create_task(maintain_audio())
        try:
            yield
        finally:
            stop.set()
            await worker
            await maintenance
            engine.dispose()
            if hasattr(adapter, "close"):
                adapter.close()

    app = FastAPI(title="Irodori Workbench", version="0.4.0", lifespan=lifespan)
    @app.exception_handler(ValidationError)
    async def invalid_configuration(_request, exc):
        if getattr(_request.scope.get('route'),'path',None) == '/v1/audio/speech':
            return JSONResponse({'detail':'语音生成配置不合法，请检查预设或生成参数'},status_code=422)
        return JSONResponse({'detail': str(exc)}, status_code=422)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.middleware("http")
    async def local_writes(request: Request, call_next):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            allowed = settings.allowed_origins
            if origin and origin not in allowed:
                return JSONResponse({"detail": "不允许的页面来源"}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": "不允许跨站写入"}, status_code=403)
        return await call_next(request)

    @app.get('/api/v1/health')
    def health():
        return {'service': 'irodori-workbench', 'ready': True}

    @app.get("/api/v1/status")
    def status():
        with app.state.sessions() as session:
            session.execute(select(1))
        inference = adapter.status() if hasattr(adapter, "status") else {"available": True, "kind": mode}
        return {"service": "irodori-workbench", "mode": mode, "database": "ok",
                "inference": inference, "version": "0.4.0"}

    @app.get("/api/v1/loras")
    def list_loras():
        return {"items": [{key: value for key, value in item.items() if key not in {"path", "aliases"}}
                          for item in lora_catalog(lora_settings)]}

    def asset_view(asset):
        return {"id": asset.id, "name": asset.name, "duration_seconds": asset.duration_seconds,
                "sample_rate": asset.sample_rate, "channels": asset.channels,
                "audio_url": f"/api/v1/assets/{asset.id}/audio"}

    @app.get("/api/v1/assets")
    def list_assets():
        with app.state.sessions() as session:
            return {"items": [asset_view(asset) for asset in session.scalars(select(Asset).order_by(Asset.created_at))]}

    @app.post("/api/v1/assets", status_code=201)
    async def upload_asset(file: UploadFile = File(...)):
        try:
            if Path(file.filename or "").suffix.lower() != ".wav":
                raise HTTPException(422, "P1 只接受 PCM WAV 参考音频")
            data = await file.read(30 * 1024 * 1024 + 1)
            if len(data) > 30 * 1024 * 1024:
                raise HTTPException(413, "参考文件超过 30MiB")
            try:
                info = inspect_wav(data)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            asset_id = str(uuid4())
            filename = asset_id + ".wav"
            path = app.state.asset_dir / filename
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
            with app.state.sessions.begin() as session:
                asset = Asset(id=asset_id, name=Path(file.filename).name, filename=filename,
                              sha256=hashlib.sha256(data).hexdigest(), created_at=utc_now(), **info)
                session.add(asset)
                session.flush()
                return asset_view(asset)
        finally:
            await file.close()

    @app.get("/api/v1/assets/{asset_id}/audio")
    def asset_audio(asset_id: str):
        with app.state.sessions() as session:
            asset = session.get(Asset, asset_id)
            if not asset or not (app.state.asset_dir / asset.filename).is_file():
                raise HTTPException(404, "素材不存在")
            return FileResponse(app.state.asset_dir / asset.filename, media_type="audio/wav")

    @app.post("/api/v1/jobs", status_code=202)
    def create_job(body: CreateJob):
        with app.state.write_lock, app.state.sessions.begin() as session:
            # Preserve the old single-job response while sharing the new API pipeline.
            batch = service.create(session, BatchCreate(source=body.text,
                config=VoiceConfig.model_validate(body.model_dump(exclude={'text'})),
                processing=Processing(mode='passthrough')), origin='api')
            result = service.generate(session, batch, Generate(revision=batch.revision), priority=1)
            return result['items'][0]

    @app.get("/api/v1/jobs")
    def list_jobs():
        with app.state.sessions() as session:
            jobs = session.scalars(select(Job).order_by(Job.created_at.desc(), Job.id).limit(100))
            return {"items": [job_view(job) for job in jobs]}

    @app.get("/api/v1/jobs/{job_id}")
    def get_job(job_id: str):
        with app.state.sessions() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise HTTPException(404, "任务不存在")
            return job_view(job)

    @app.get("/api/v1/jobs/{job_id}/audio")
    def get_audio(job_id: str):
        with app.state.write_lock, app.state.sessions() as session:
            job = session.get(Job, job_id)
            if not job or not job.audio_file:
                raise HTTPException(404, "音频尚不可用")
            path = app.state.output_dir / job.audio_file
            if not path.is_file():
                raise HTTPException(404, "音频文件缺失")
            app.state.audio_leases[job_id] += 1
            def release():
                with app.state.write_lock:
                    app.state.audio_leases[job_id] -= 1
                    if app.state.audio_leases[job_id] <= 0:
                        app.state.audio_leases.pop(job_id, None)
            return FileResponse(path, media_type="audio/wav", background=BackgroundTask(release))

    register_project_routes(app, lora_settings, mode, job_view)
    service = register_batch_routes(app, lora_settings, mode, job_view)
    from .external_api import register_external_routes
    register_external_routes(app, service)

    # A missing API route must remain a 404, never the frontend's HTML.
    @app.api_route("/api/{unknown:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def unknown_api(unknown: str):
        raise HTTPException(404, "接口不存在")

    dist = ROOT / "frontend" / "dist"
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:
        @app.get("/")
        def frontend_missing():
            return JSONResponse({"detail": "前端尚未构建，请运行 frontend 下的 npm run build"}, status_code=503)
    return app

