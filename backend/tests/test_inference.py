import base64
import io
import json
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

from irodori_workbench.app import create_app
from irodori_workbench.inference import FakeInferenceAdapter, IrodoriInferenceAdapter, InferenceUncertain


def wav_bytes():
    data = io.BytesIO()
    with wave.open(data, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0\0" * 2400)
    return data.getvalue()


def caps():
    return {"protocol_version": 1, "multi_reference": True, "managed_synthesis": True,
            "model": "irodori-tts", "runtime": {"busy": False, "loading": False}}


def test_real_adapter_preserves_order_and_precision(tmp_path):
    seen = []
    def respond(request):
        if request.method == "GET":
            return httpx.Response(200, json=caps())
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"audio_base64": base64.b64encode(wav_bytes()).decode(),
            "metadata": {"sample_rate": 24000, "used_seed": 9223372036854775000,
                "effective_config": {"ref_wavs": body["irodori"]["ref_wavs"], "seed": 9223372036854775000}}})
    adapter = IrodoriInferenceAdapter(transport=httpx.MockTransport(respond))
    result = adapter.synthesize(tmp_path / "out.wav", {"text": "test", "parameters": {
        "seed": None, 'cfg_scale_text': 2.4, 'cfg_scale_caption': 1.7,
        'cfg_scale_speaker': 4.2, 'cfg_scale': None, 'context_kv_cache': False,
        'duration_scale': 1.1, 't_schedule_mode': 'sway', 'sway_coeff': -0.8},
        "reference_paths": ["second.wav", "first.wav"], "lora_path": None, "caption": ""})
    assert result["used_seed"] == "9223372036854775000"
    assert seen[0]["irodori"]["ref_wavs"] == ["second.wav", "first.wav"]
    assert seen[0]["irodori"]["chunking_enabled"] is False
    assert seen[0]["irodori"]["lora_adapter"] == "none"
    assert seen[0]["irodori"]["caption"] is None
    for key, value in {'cfg_scale_text': 2.4, 'cfg_scale_caption': 1.7, 'cfg_scale_speaker': 4.2,
                       'context_kv_cache': False, 'duration_scale': 1.1,
                       't_schedule_mode': 'sway', 'sway_coeff': -0.8}.items():
        assert seen[0]['irodori'][key] == value
    assert 'cfg_scale' not in seen[0]['irodori']
    assert (tmp_path / "out.wav").read_bytes() == wav_bytes()
    adapter.close()


def test_missing_capability_is_not_downgraded(tmp_path):
    adapter = IrodoriInferenceAdapter(transport=httpx.MockTransport(lambda req:httpx.Response(200,json={})))
    assert adapter.status()["available"] is False
    with pytest.raises(RuntimeError, match="P1"):
        adapter.synthesize(tmp_path / "out.wav", {})
    assert not (tmp_path / "out.wav").exists()
    adapter.close()


def test_timeout_is_not_retried(tmp_path):
    calls = []
    def respond(request):
        if request.method == "GET":
            return httpx.Response(200,json=caps())
        calls.append(request)
        raise httpx.ReadTimeout("timeout")
    adapter = IrodoriInferenceAdapter(transport=httpx.MockTransport(respond))
    with pytest.raises(InferenceUncertain):
        adapter.synthesize(tmp_path / "out.wav", {"text":"test","parameters":{},
            "reference_paths":[],"lora_path":None,"caption":""})
    assert len(calls) == 1
    adapter.close()


def test_assets_and_frozen_input(tmp_path):
    with TestClient(create_app(tmp_path, FakeInferenceAdapter(), tmp_path / "missing.json")) as client:
        assert client.post("/api/v1/assets", files={"file":("bad.wav", b"not wav")}).status_code == 422
        first = client.post("/api/v1/assets", files={"file":("first.wav", wav_bytes())}).json()
        second = client.post("/api/v1/assets", files={"file":("second.wav", wav_bytes())}).json()
        result = client.post("/api/v1/jobs", json={"text":"test", "reference_asset_ids":[second["id"],first["id"]],
                             "parameters":{"seed":"1234567890123456789"}})
        assert result.status_code == 202
        config = result.json()["request_config"]
        assert config["parameters"]["seed"] == "1234567890123456789"
        assert config["reference_asset_ids"] == [second["id"],first["id"]]
        assert [path.split("\\")[-1] for path in config["reference_paths"]] == [second["id"]+".wav",first["id"]+".wav"]
        assert client.post("/api/v1/jobs",json={"text":"x","lora_id":"D:/arbitrary"}).status_code == 422
        assert client.post("/api/v1/jobs",json={"text":"x","reference_asset_ids":["missing"]}).status_code == 422
        assert client.post("/api/v1/jobs",json={"text":"x","parameters":{"ref_wavs":["secret"]}}).status_code == 422
        assert client.get(first["audio_url"]).content == wav_bytes()
