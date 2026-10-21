"""Read-only LoRA allowlist, plus immutable uploaded PCM WAV assets."""
import hashlib
import io
import json
import wave
import os
import re
from pathlib import Path
from .settings import load_settings, voice_profile


def lora_catalog(settings_path: Path) -> list[dict]:
    data = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.is_file() else {}
    settings = load_settings()
    fallback = settings.lora_dir if settings_path.resolve() == settings.lora_settings else settings_path.parent.parent/'lora_output'
    root = Path(os.environ.get('IRODORI_LORA_DIR', fallback)).resolve()
    result = []
    registered_folders = set()
    names = {family:name for _, characters in voice_profile().get('works', []) for family,name in characters}

    def identity(path):
        # Relative identities survive drive/directory relocation. Explicit IDs keep legacy presets unchanged.
        relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else path.name
        return hashlib.sha256(('lora:'+relative.casefold()).encode()).hexdigest()[:20]

    for item in data.get("loras", []):
        source = Path(item['path']).expanduser()
        resolved = (source if source.is_absolute() else root/source).resolve()
        if not resolved.is_relative_to(root):
            continue
        if root.is_dir():
            if not resolved.is_relative_to(root):
                continue
            folder = resolved.relative_to(root).parts[0]
            registered_folders.add(folder)
            names.setdefault(folder.split('_v')[0], re.sub(r'(?:_\d+|（\d+）)$', '', item['name']))
        path = str(resolved)
        result.append({"id": item.get('id') or identity(resolved),
                       "aliases": [hashlib.sha256(path.encode()).hexdigest()[:20], *item.get('aliases', [])],
                       "name": item["name"], "path": path, "available": Path(path).exists()})
    # Keep all existing IDs/checkpoints and expose other v4 training runs as choices.
    if root.is_dir():
        folders = {}
        for folder in root.iterdir():
            if not folder.is_dir():
                continue
            family = folder.name.split('_v')[0]
            version = re.search(r'_v(\d+(?:_\d+)*)', folder.name)
            numbers = tuple(map(int, version[1].split('_'))) if version else (4,)
            if folder.name in registered_folders or numbers[0] < 4:
                continue
            folders.setdefault(family, []).append((numbers, folder))
        for family, choices in sorted(folders.items()):
            for _, folder in sorted(choices, reverse=True):
                candidates = [folder / 'checkpoint_final', folder]
                others = list(folder.glob('checkpoint_best_val_loss_*'))
                others.sort(key=lambda p: float(p.name.rsplit('_', 1)[-1]) if re.search(r'_\d+\.\d+$', p.name) else float('inf'))
                candidates += others + sorted(folder.glob('checkpoint_*'), reverse=True)
                checkpoint = next((p for p in candidates if (p / 'adapter_config.json').is_file()
                                   and (p / 'adapter_model.safetensors').is_file()), None)
                if checkpoint:
                    resolved = checkpoint.resolve()
                    if not resolved.is_relative_to(root):
                        continue
                    path = str(resolved)
                    result.append({'id': identity(resolved), 'aliases': [hashlib.sha256(path.encode()).hexdigest()[:20]],
                                   'name': names.get(family, folder.name),
                                   'path': path, 'available': True})
    for item in result:
        path = Path(item['path'])
        relative = path.relative_to(root) if path.is_relative_to(root) else Path(path.name)
        folder = relative.parts[0]
        match = re.search(r'_v(\d+(?:_\d+)*)', folder)
        item.update(family=folder.split('_v')[0], model_version='v'+match[1] if match else '',
                    checkpoint=path.name, relative_path=str(relative))
    families = list(dict.fromkeys(item['family'] for item in result))
    result.sort(key=lambda item: families.index(item['family']))
    return result


def find_lora(settings_path, identifier):
    return next((item for item in lora_catalog(settings_path)
                 if identifier == item['id'] or identifier in item.get('aliases', [])), None)


def inspect_wav(data: bytes) -> dict:
    try:
        with wave.open(io.BytesIO(data)) as wav:
            rate, channels, frames = wav.getframerate(), wav.getnchannels(), wav.getnframes()
            if rate < 8000 or rate > 192000 or channels not in {1, 2} or frames <= 0:
                raise ValueError("参考 WAV 必须是单/双声道、8–192kHz 的非空音频")
            if frames / rate > 180:
                raise ValueError("单条参考音频不能超过 180 秒")
            if wav.getsampwidth() not in {1, 2, 3, 4}:
                raise ValueError("不支持的 PCM 位深")
            if len(wav.readframes(frames)) != frames * channels * wav.getsampwidth():
                raise ValueError("WAV 文件内容不完整")
            return {"duration_seconds": frames / rate, "sample_rate": rate, "channels": channels}
    except (wave.Error, EOFError) as exc:
        raise ValueError("请上传有效的 PCM WAV 文件") from exc
