"""Configuration inheritance and immutable inference inputs shared by quick jobs and projects."""
from copy import deepcopy
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .catalog import lora_catalog
from .storage import Asset


class Parameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    num_steps: int = Field(default=40, ge=1, le=100)
    seed: int | None = Field(default=None, ge=0, le=9223372036854775807)
    max_ref_seconds: float | None = Field(default=None, gt=0, le=180)
    # Unset options follow the installed Server/checkpoint defaults, including old presets.
    cfg_scale_text: float | None = Field(default=None, ge=0, le=10)
    cfg_scale_caption: float | None = Field(default=None, ge=0, le=10)
    cfg_scale_speaker: float | None = Field(default=None, ge=0, le=10)
    cfg_guidance_mode: Literal['independent', 'joint', 'alternating'] | None = None
    cfg_scale: float | None = Field(default=None, ge=0, le=10)
    cfg_min_t: float | None = Field(default=None, ge=0, le=1)
    cfg_max_t: float | None = Field(default=None, ge=0, le=1)
    seconds: float | None = Field(default=None, gt=0)
    duration_scale: float | None = Field(default=None, gt=0)
    min_seconds: float | None = Field(default=None, gt=0)
    max_seconds: float | None = Field(default=None, gt=0)
    t_schedule_mode: Literal['linear', 'sway'] | None = None
    sway_coeff: float | None = None
    truncation_factor: float | None = Field(default=None, gt=0)
    rescale_k: float | None = Field(default=None, gt=0)
    rescale_sigma: float | None = Field(default=None, gt=0)
    context_kv_cache: bool | None = None
    speaker_kv_scale: float | None = Field(default=None, gt=0)
    ref_normalize_db: float | None = None
    ref_ensure_max: bool | None = None
    trim_tail: bool | None = None


class VoiceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lora_id: str | None = None
    reference_asset_ids: list[str] = Field(default_factory=list, max_length=32)
    caption: str = Field(default="", max_length=2048)
    parameters: Parameters = Field(default_factory=Parameters)


class CreateJob(VoiceConfig):
    text: str = Field(min_length=1, max_length=4096)

    @field_validator("text")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("请输入非空文本")
        return value


def config_dict(config: VoiceConfig) -> dict:
    result = config.model_dump()
    seed = result["parameters"]["seed"]
    result["parameters"]["seed"] = str(seed) if seed is not None else None
    # Keep the original three fields stable; optional null means runtime default.
    result['parameters'] = {key: value for key, value in result['parameters'].items()
                            if value is not None or key in {'seed', 'max_ref_seconds'}}
    return result


def merge_config(base: dict, overrides: dict) -> dict:
    # Validate supplied fields without filling defaults into the override itself.
    permitted = {"lora_id", "reference_asset_ids", "caption", "parameters"}
    if set(overrides) - permitted:
        raise HTTPException(422, "未知的覆盖字段")
    merged = deepcopy(base)
    for key, value in overrides.items():
        if key == "parameters":
            if not isinstance(value, dict):
                raise HTTPException(422, "parameters 必须为对象")
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    try:
        return config_dict(VoiceConfig.model_validate(merged))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def normalize_overrides(base: dict, overrides: dict) -> dict:
    effective = merge_config(base, overrides)
    return {key: ({p: effective[key].get(p) for p in value} if key == "parameters" else effective[key])
            for key, value in overrides.items()}


def freeze_config(session, asset_dir, lora_settings, config: dict, text: str) -> dict:
    body = CreateJob.model_validate({**config, "text": text})
    lora = None
    if body.lora_id is not None:
        from .catalog import find_lora
        lora = find_lora(lora_settings, body.lora_id)
        if not lora or not lora["available"]:
            raise HTTPException(422, "LoRA 不存在或文件已失效")
    paths, hashes = [], []
    for asset_id in body.reference_asset_ids:
        asset = session.get(Asset, asset_id)
        if not asset or not (asset_dir / asset.filename).is_file():
            raise HTTPException(422, f"参考素材不存在：{asset_id}")
        paths.append(str((asset_dir / asset.filename).resolve()))
        hashes.append(asset.sha256)
    return {**config_dict(body), "lora_path": lora["path"] if lora else None,
            "reference_paths": paths, "reference_sha256": hashes}
