import asyncio
import base64
import json
import threading
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
import torch
from fastapi.testclient import TestClient
from irodori_openai_tts import app as main
from irodori_openai_tts.voices import VoiceRegistry
from irodori_tts.inference_runtime import SamplingResult


@dataclass
class Key:
    checkpoint: str = "test-checkpoint"


class Runtime:
    default_max_ref_seconds = 12.0
    default_text_max_len = 256
    default_caption_max_len = 256
    key = Key()
    model_cfg = SimpleNamespace(flow_parameterization="rf", use_speaker_condition_resolved=True,
                                use_caption_condition=True)

    def synthesize(self, req, log_fn=None):
        self.request = req
        audio = torch.zeros(1, 2400)
        return SamplingResult(audio=audio, audios=[audio], sample_rate=24000,
            stage_timings=[], total_to_decode=0.1, used_seed=9223372036854775000,
            messages=["info: encoded and concatenated 2/2 reference waveforms in input order (20 latent steps before max-length trimming)."])


@pytest.fixture(autouse=True)
def setup(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main.settings, "api_key", None)
    monkeypatch.setattr(main.settings, "preload", False)
    monkeypatch.setattr(main.settings, "voices_dir", tmp_path)
    monkeypatch.setattr(main.settings, "voice_aliases_file", None)
    monkeypatch.setattr(main, "voice_registry", VoiceRegistry(main.settings))
    monkeypatch.setattr(main, "_synthesis_semaphore", None)
    monkeypatch.setattr(main, "_active_synthesis", 0)
    runtime = Runtime()
    monkeypatch.setattr(main, "runtime_manager", SimpleNamespace(_runtime=runtime,
        get=lambda:runtime, is_loaded=True, is_loading=False, checkpoint_path="test-checkpoint"))
    return runtime


def payload(**options):
    return {"model": main.settings.model_name, "input": "こんにちは。", "irodori": options}


def test_managed_preserves_order_and_returns_actual_metadata(setup, tmp_path):
    result = TestClient(main.app).post("/v1/irodori/synthesize", json=payload(
        ref_wavs=["second.wav", "first.wav"], max_ref_seconds=None)).json()
    assert setup.request.ref_wavs == ["second.wav", "first.wav"]
    assert base64.b64decode(result["audio_base64"]).startswith(b"RIFF")
    meta = result["metadata"]
    assert meta["effective_config"]["max_ref_seconds"] == 12
    assert meta["effective_config"]["seed"] == 9223372036854775000
    assert meta["reference_summary"]["encoded_count"] == 2
    assert not (tmp_path / "saved_audio").exists()
    assert main._active_synthesis == 0


def test_legacy_speech_multi_reference_and_single_remain_valid(setup):
    client = TestClient(main.app)
    assert client.post("/v1/audio/speech", json=payload(ref_wavs=["b.wav", "a.wav"], chunking_enabled=False)).status_code == 200
    assert setup.request.ref_wavs == ["b.wav", "a.wav"]
    assert client.post("/v1/audio/speech", json=payload(ref_wav="a.wav", chunking_enabled=False)).status_code == 200
    assert setup.request.ref_wav == "a.wav"


@pytest.mark.parametrize("options", [
    {"ref_wav":"a.wav", "ref_wavs":["b.wav"]}, {"ref_wavs":[""]},
    {"ref_wavs":"a.wav"}, {"ref_wavs":["a.wav"], "no_ref":True},
])
def test_invalid_reference_combinations(options):
    assert TestClient(main.app).post("/v1/irodori/synthesize", json=payload(**options)).status_code in {400,422}


def test_alias_roundtrip_and_nested_precedence(tmp_path):
    (tmp_path / "voices.json").write_text(json.dumps({"pair":{"ref_wavs":["b.wav","a.wav"]}}))
    client = TestClient(main.app)
    row = next(row for row in client.get("/v1/audio/voices").json()["data"] if row["id"] == "pair")
    assert row["ref_wavs"] == [str(tmp_path / "b.wav"), str(tmp_path / "a.wav")]
    request = main.SpeechRequest(**{**payload(ref_wavs=["nested.wav"]), "ref_wavs":["top.wav"]})
    assert main._resolve_voice(request).ref_wavs == ["nested.wav"]


def test_cancelled_blocking_call_finishes_before_releasing_slot():
    async def scenario():
        entered, release = threading.Event(), threading.Event()
        def blocking():
            entered.set()
            release.wait(5)
        async def operation():
            slot = await main._acquire_synthesis_slot()
            try:
                await main._run_blocking(blocking)
            finally:
                main._release_synthesis_slot(slot)
        task = asyncio.create_task(operation())
        while not entered.is_set():
            await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.sleep(0.02)
        assert main._active_synthesis == 1
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert main._active_synthesis == 0
    asyncio.run(scenario())
