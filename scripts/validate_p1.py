"""Explicit local GPU acceptance run, not part of ordinary unit tests."""
import io
import json
from pathlib import Path
import time
import wave
import httpx

from validation_options import parser_for, require_generation
parser=parser_for(__doc__, 'p1-validation')
parser.add_argument('--fixtures-dir',type=Path,required=True)
parser.add_argument('--lora-a',required=True)
parser.add_argument('--lora-b',required=True)
parser.add_argument('--legacy-audio-dir',type=Path)
args=parser.parse_args()
require_generation(parser,args)
ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = args.evidence_dir
EVIDENCE.mkdir(parents=True,exist_ok=True)
client = httpx.Client(base_url=args.url, trust_env=False, timeout=15)
status = client.get("/api/v1/status").json()
assert status["mode"] == "irodori" and status["inference"]["available"], status
loras = client.get("/api/v1/loras").json()["items"]
amana = next(item for item in loras if args.lora_a in (item["id"],item["name"]) and item["available"])
meguru = next(item for item in loras if args.lora_b in (item["id"],item["name"]) and item["available"])


def references(name):
    existing = {item["name"]: item["id"] for item in client.get("/api/v1/assets").json()["items"]}
    if all(f"p1-{name}-{index}.wav" in existing for index in (1, 2)):
        return [existing[f"p1-{name}-{index}.wav"] for index in (1, 2)]
    source = args.fixtures_dir / (name + ".wav")
    result = []
    with wave.open(str(source)) as wav:
        channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
        total = wav.getnframes()
        parts = [wav.readframes(total // 2), wav.readframes(total - total // 2)]
    for index, frames in enumerate(parts):
        data = io.BytesIO()
        with wave.open(data, "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(width)
            wav.setframerate(rate)
            wav.writeframes(frames)
        filename = f"p1-{name}-{index+1}.wav"
        response = client.post("/api/v1/assets", files={"file": (filename, data.getvalue(), "audio/wav")})
        response.raise_for_status()
        result.append(response.json()["id"])
    return result


amana_refs, meguru_refs = references("amana"), references("meguru")
cases = [
    ("base-no-reference", None, [], None),
    ("base-single-reference", None, amana_refs[:1], None),
    ("base-multi-reference", None, amana_refs, None),
    ("amana-no-reference", amana["id"], [], None),
    ("amana-multi-reference", amana["id"], amana_refs[::-1], None),
    ("meguru-multi-reference", meguru["id"], meguru_refs, None),
    ("meguru-reference-cap", meguru["id"], meguru_refs, 0.2),
]
legacy_dir = args.legacy_audio_dir
before = {path.name for path in legacy_dir.iterdir()} if legacy_dir and legacy_dir.exists() else set()
summary = []
for name, lora, refs, cap in cases:
    body = {"text": "こんにちは。今日はいい天気ですね。", "lora_id": lora,
            "reference_asset_ids": refs, "parameters": {"num_steps":40,"seed":"1234567890123456789","max_ref_seconds":cap}}
    response = client.post("/api/v1/jobs", json=body)
    response.raise_for_status()
    job_id = response.json()["id"]
    print(f"Started {name}: {job_id}", flush=True)
    deadline = time.monotonic() + 1200
    last_report = time.monotonic()
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/jobs/{job_id}").json()
        if job["status"] in {"succeeded","failed","interrupted"}:
            break
        if time.monotonic() - last_report > 30:
            print(f"  {name}: {job['status']}", flush=True)
            last_report = time.monotonic()
        time.sleep(2)
    else:
        raise TimeoutError(job_id)
    (EVIDENCE / (name + ".json")).write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    assert job["status"] == "succeeded", job.get("error")
    metadata = job["result_metadata"]
    assert metadata["used_seed"] == "1234567890123456789"
    assert metadata["effective_config"]["ref_wavs"] == job["request_config"]["reference_paths"]
    assert metadata["reference_summary"]["selected_count"] == len(refs)
    if cap:
        assert metadata["reference_summary"]["encoded_count"] == 1
        assert any("Trimming" in message for message in metadata["messages"])
    elif refs:
        assert metadata["reference_summary"]["encoded_count"] == len(refs)
    audio_response = client.get(job["audio_url"])
    audio_response.raise_for_status()
    with wave.open(io.BytesIO(audio_response.content)) as audio:
        assert audio.getnframes() > 0
        assert audio.getframerate() == metadata["sample_rate"]
    (EVIDENCE / (name + ".wav")).write_bytes(audio_response.content)
    entry = {"case":name,"job_id":job_id,"audio_seconds":metadata["audio_seconds"],
             "reference_summary":metadata["reference_summary"]}
    summary.append(entry)
    print(json.dumps(entry, ensure_ascii=False), flush=True)
after = {path.name for path in legacy_dir.iterdir()} if legacy_dir and legacy_dir.exists() else set()
assert legacy_dir is None or after == before, "Managed requests unexpectedly created legacy saved_audio copies"
(EVIDENCE / "summary.json").write_text(json.dumps({"cases":summary,"legacy_saved_audio_unchanged":(after==before if legacy_dir else None)},ensure_ascii=False,indent=2),encoding="utf-8")
print("P1 acceptance matrix passed", flush=True)
