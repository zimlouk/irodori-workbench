"""P0 adapter: produces an audible test tone, never synthetic speech."""
import math
import struct
import wave
import base64
import os
import io
import httpx
from pathlib import Path
from .settings import load_settings


class FakeInferenceAdapter:
    kind = "fake"

    def status(self) -> dict:
        return {"available": True, "kind": self.kind}

    def synthesize(self, output: Path, config: dict | None = None) -> dict:
        temporary = output.with_suffix(".tmp")
        rate = 24000
        # A short quiet tone is unmistakably a diagnostic, not model speech.
        samples = (int(1800 * math.sin(2 * math.pi * 440 * i / rate)
                       * min(1, i / 240, (rate // 2 - i) / 240))
                   for i in range(rate // 2))
        with wave.open(str(temporary), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(b"".join(struct.pack("<h", value) for value in samples))
        temporary.replace(output)
        return {"sample_rate": rate, "audio_seconds": 0.5, "messages": ["测试音，不是真实语音"]}


class InferenceUncertain(RuntimeError):
    """Transport ended without proving that the GPU request ended; never auto retry."""


class IrodoriInferenceAdapter:
    kind = "irodori"

    def __init__(self, base_url: str | None = None, api_key: str | None = None, transport=None):
        settings = load_settings()
        self.base_url = (base_url or settings.server_url).rstrip("/")
        api_key = api_key if api_key is not None else settings.api_key
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.client = httpx.Client(base_url=self.base_url, headers=headers, transport=transport,
                                   trust_env=False, timeout=httpx.Timeout(900, connect=5))

    def close(self):
        self.client.close()

    def capabilities(self) -> dict:
        response = self.client.get("/v1/irodori/capabilities", timeout=5)
        response.raise_for_status()
        data = response.json()
        if data.get("protocol_version") != 1 or not data.get("multi_reference") or not data.get("managed_synthesis"):
            raise RuntimeError("推理服务缺少 P1 多参考协议，请应用 Server 补丁并重启")
        return data

    def status(self) -> dict:
        try:
            return {"available": True, "kind": self.kind, "capabilities": self.capabilities()}
        except Exception as exc:
            return {"available": False, "kind": self.kind, "error": str(exc)}

    def synthesize(self, output: Path, config: dict) -> dict:
        capabilities = self.capabilities()
        # Optional unset UI fields must not mask options frozen from compatible API calls.
        options = {**config.get('runtime_options', {}),
                   **{key: value for key, value in config['parameters'].items()
                      if value is not None or key in {'seed', 'max_ref_seconds'}}}
        options.update(ref_wavs=config["reference_paths"], no_ref=not config["reference_paths"],
                       lora_adapter=config["lora_path"] or "none", caption=config["caption"] or None,
                       chunking_enabled=False)
        options.setdefault('num_candidates', 1)
        payload = {"model": capabilities["model"], "input": config["text"],
                   "voice": "none", "response_format": "wav", "speed": config.get('speed', 1), "irodori": options}
        try:
            response = self.client.post("/v1/irodori/synthesize", json=payload)
        except httpx.TransportError as exc:
            raise InferenceUncertain("推理连接中断，当前段可能仍在 GPU 执行；不自动重试") from exc
        if response.is_error:
            try:
                error = response.json()
            except ValueError:
                error = response.text[:500]
            raise RuntimeError(f"推理服务错误 ({response.status_code}): {error}")
        body = response.json()
        audio = base64.b64decode(body["audio_base64"], validate=True)
        metadata = body["metadata"]
        with wave.open(io.BytesIO(audio)) as wav:
            if wav.getframerate() != metadata["sample_rate"] or wav.getnframes() <= 0:
                raise ValueError("推理服务返回无效音频或不匹配的采样率")
        effective = metadata["effective_config"]
        if effective.get("ref_wavs") != config["reference_paths"]:
            raise ValueError("推理服务未保留有序参考列表，拒绝接收结果")
        # Frontend must not lose random 63-bit seeds to JavaScript number precision.
        metadata["used_seed"] = str(metadata["used_seed"])
        effective["seed"] = str(effective["seed"])
        temporary = output.with_suffix(".tmp")
        temporary.write_bytes(audio)
        temporary.replace(output)
        return metadata

