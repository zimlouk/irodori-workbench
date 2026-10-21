# Workbench protocol: JSON envelope avoids lossy/size-limited HTTP metadata headers.
@app.get("/v1/irodori/capabilities", dependencies=[Depends(require_auth)])
def workbench_capabilities() -> dict[str, Any]:
    loaded = getattr(runtime_manager, "_runtime", None)
    return {
        "protocol_version": 1, "multi_reference": True, "managed_synthesis": True,
        "model": settings.model_name,
        "defaults": {"max_ref_seconds": getattr(loaded, "default_max_ref_seconds", None)},
        "runtime": {"loaded": runtime_manager.is_loaded, "loading": runtime_manager.is_loading,
                    "busy": _active_synthesis > 0},
    }


def _workbench_effective_config(runtime, request, result):
    from irodori_tts.inference_runtime import normalize_text, resolve_cfg_scales
    config = asdict(request)
    config.update(seed=result.used_seed, text=normalize_text(request.text).strip(),
                  caption=(request.caption or "").strip(),
                  max_ref_seconds=request.max_ref_seconds if request.max_ref_seconds is not None else runtime.default_max_ref_seconds,
                  max_text_len=request.max_text_len if request.max_text_len is not None else runtime.default_text_max_len,
                  max_caption_len=request.max_caption_len if request.max_caption_len is not None else runtime.default_caption_max_len)
    meanflow = runtime.model_cfg.flow_parameterization == "meanflow"
    config["num_steps"] = request.num_steps if request.num_steps is not None else (4 if meanflow else 40)
    speaker = bool(runtime.model_cfg.use_speaker_condition_resolved and not request.no_ref)
    if meanflow:
        config.update(cfg_guidance_mode="independent", cfg_scale_text=0.0,
                      cfg_scale_caption=0.0, cfg_scale_speaker=0.0,
                      speaker_kv_scale=None, speaker_kv_min_t=None, speaker_kv_max_layers=None)
        config["ignored_controls"] = ["cfg_scale", "cfg_min_t", "cfg_max_t", "t_schedule_mode",
                                      "sway_coeff", "truncation_factor", "rescale_k", "rescale_sigma"]
    else:
        text_scale, caption_scale, speaker_scale, _ = resolve_cfg_scales(
            cfg_guidance_mode=request.cfg_guidance_mode,
            cfg_scale_text=request.cfg_scale_text, cfg_scale_caption=request.cfg_scale_caption,
            cfg_scale_speaker=request.cfg_scale_speaker, cfg_scale=request.cfg_scale,
            use_caption_condition=bool(runtime.model_cfg.use_caption_condition and config["caption"]),
            use_speaker_condition=speaker)
        config.update(cfg_scale_text=text_scale, cfg_scale_caption=caption_scale, cfg_scale_speaker=speaker_scale)
        active_kv = speaker and request.speaker_kv_scale is not None
        config["speaker_kv_scale"] = request.speaker_kv_scale if active_kv else None
        config["speaker_kv_min_t"] = (request.speaker_kv_min_t if request.speaker_kv_min_t is not None else 0.9) if active_kv else None
    if config["seconds"] is not None:
        config["seconds"] = min(request.max_seconds, max(request.min_seconds, request.seconds))
    config["checkpoint"] = runtime_manager.checkpoint_path
    config["runtime_key"] = asdict(runtime.key)
    config["audio_seconds"] = _audio_duration_seconds(result.audio, result.sample_rate)
    return config


@app.post("/v1/irodori/synthesize", dependencies=[Depends(require_auth)])
async def workbench_synthesize(payload: SpeechRequest) -> dict[str, Any]:
    import re
    _validate_speech_payload(payload)
    if payload.stream_format is not None or payload.response_format not in {None, "wav"}:
        raise HTTPException(400, "Managed synthesis supports a single WAV result only.")
    try:
        voice = _resolve_voice(payload)
        request = _build_sampling_request(payload, voice)
        _validate_sampling_request(request)
        if request.num_candidates != 1:
            raise ValueError("Managed synthesis requires num_candidates=1.")
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    # One segment, one lifecycle slot. No old saved_audio copy and no internal chunking.
    slot = await _acquire_synthesis_slot()
    try:
        runtime = await _run_blocking(runtime_manager.get)
        _log_speech_request(request, voice)
        result = await _run_blocking(runtime.synthesize, request, log_fn=_log_runtime_message)
        effective = _workbench_effective_config(runtime, request, result)
        audio_bytes = await _run_blocking(encode_audio, result.audio, result.sample_rate, "wav")
        paths = ([request.ref_wav] if request.ref_wav else []) + list(request.ref_wavs or [])
        encoded = 0 if request.no_ref or not runtime.model_cfg.use_speaker_condition_resolved else (1 if len(paths) == 1 else None)
        for message in result.messages:
            match = re.search(r"encoded and concatenated (\d+)/(\d+) reference waveforms", message)
            if match:
                encoded = int(match.group(1))
        return {"audio_base64": base64.b64encode(audio_bytes).decode("ascii"), "metadata": {
            "used_seed": result.used_seed, "sample_rate": result.sample_rate,
            "audio_seconds": _audio_duration_seconds(result.audio, result.sample_rate),
            "messages": result.messages, "effective_config": effective,
            "reference_summary": {"selected_count": len(paths), "encoded_count": encoded,
                                  "max_ref_seconds": effective["max_ref_seconds"]},
            "stage_timings": result.stage_timings, "total_to_decode": result.total_to_decode}}
    except RuntimeLoadTimeoutError as exc:
        raise HTTPException(503, str(exc)) from exc
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        _release_synthesis_slot(slot)
