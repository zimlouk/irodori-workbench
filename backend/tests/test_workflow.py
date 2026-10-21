import io
import time
import wave
from uuid import uuid4

from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.storage import Job, open_store, utc_now
from irodori_workbench.inference import FakeInferenceAdapter
import pytest


@pytest.fixture(autouse=True)
def fake_mode(monkeypatch):
    monkeypatch.setenv("IRODORI_WORKBENCH_MODE", "fake")


def wait_job(client, job_id):
    for _ in range(100):
        job = client.get(f"/api/v1/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed"}:
            return job
        time.sleep(0.03)
    raise AssertionError("job did not finish")


def test_generate_and_restart(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/v1/status").json()["mode"] == "fake"
        text = "  テスト。\n次の行。  "
        response = client.post("/api/v1/jobs", json={"text": text})
        assert response.status_code == 202
        job = wait_job(client, response.json()["id"])
        assert job["status"] == "succeeded"
        assert job["text"] == text
        audio = client.get(job["audio_url"])
        with wave.open(io.BytesIO(audio.content)) as wav:
            assert wav.getframerate() == 24000
            assert wav.getnframes() == 12000
    with TestClient(create_app(tmp_path)) as client:
        assert client.get(f'/api/v1/jobs/{job["id"]}').json() == job
        assert client.get(job["audio_url"]).content == audio.content


def test_validation_and_origin(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        for text in ["", " \n ", "a" * 4097]:
            assert client.post("/api/v1/jobs", json={"text": text}).status_code == 422
        assert client.post("/api/v1/jobs", json={"text": "x"},
                           headers={"Origin": "https://example.org"}).status_code == 403
        assert client.get("/api/v1/jobs/missing/audio").status_code == 404
        assert client.get("/api/unknown").status_code == 404


def test_interrupted_jobs_are_not_replayed(tmp_path):
    engine, sessions = open_store(tmp_path)
    job_id = str(uuid4())
    with sessions.begin() as session:
        session.add(Job(id=job_id, text="uncompleted", status="running", mode="fake", created_at=utc_now()))
    engine.dispose()
    with TestClient(create_app(tmp_path)) as client:
        job = client.get(f"/api/v1/jobs/{job_id}").json()
        assert job["status"] == "interrupted"
        assert job["audio_url"] is None


def test_failure_is_persisted(tmp_path):
    class BrokenAdapter:
        def synthesize(self, output, config):
            raise RuntimeError("test adapter unavailable")
    with TestClient(create_app(tmp_path, BrokenAdapter())) as client:
        response = client.post("/api/v1/jobs", json={"text": "test"})
        job = wait_job(client, response.json()["id"])
        assert job["status"] == "failed"
        assert "test adapter unavailable" in job["error"]
        assert job["audio_url"] is None

