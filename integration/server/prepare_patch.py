"""Build minimal additions on top of the captured local Server, never Git HEAD."""
from pathlib import Path
import difflib

import argparse
import subprocess
parser=argparse.ArgumentParser(description="Rebuild protocol patches from the pinned Server commit")
parser.add_argument('--server-dir',required=True,type=Path)
parser.add_argument('--output',required=True,type=Path)
args=parser.parse_args()
ROOT=args.output.resolve()
(ROOT/'baseline').mkdir(parents=True,exist_ok=True)
(ROOT/'patched').mkdir(exist_ok=True)
for filename in ('app.py','voices.py'):
    content=subprocess.run(['git','-C',str(args.server_dir),'show','1fc3e100ed8e14ff30f6bfa6cb711a948960f8ce:src/irodori_openai_tts/'+filename],capture_output=True,check=True).stdout
    (ROOT/'baseline'/filename).write_bytes(content.replace(b'\r\n',b'\n'))
(ROOT/'managed_endpoints.py.inc').write_text((Path(__file__).parent/'managed_endpoints.py.inc').read_text(encoding='utf-8'),encoding='utf-8')

app = (ROOT / "baseline/app.py").read_text(encoding="utf-8")
voices = (ROOT / "baseline/voices.py").read_text(encoding="utf-8")

voices = voices.replace('    no_ref: bool = False\n', '''    no_ref: bool = False
    ref_wavs: list[str] | None = None

    def __post_init__(self):
        if self.ref_wavs is not None:
            if not isinstance(self.ref_wavs, list) or any(
                not isinstance(path, str) or not path.strip() for path in self.ref_wavs
            ):
                raise ValueError("ref_wavs must be an ordered list of non-empty paths.")
            if self.ref_wavs and (self.ref_wav is not None or self.no_ref):
                raise ValueError("ref_wavs cannot be combined with ref_wav or no_ref.")
''', 1)
voices = voices.replace('        ref_wav = raw_spec.get("ref_wav")', '''        ref_wavs = raw_spec.get("ref_wavs")
        if ref_wavs is not None and (not isinstance(ref_wavs, list) or any(
            not isinstance(path, str) or not path.strip() for path in ref_wavs
        )):
            raise ValueError("ref_wavs must be an ordered list of non-empty paths.")
        ref_wav = raw_spec.get("ref_wav")''')
voices = voices.replace('            no_ref=no_ref,', '''            no_ref=no_ref,
            ref_wavs=None if ref_wavs is None else [str(self._resolve_voice_path(path)) for path in ref_wavs],''')
app = app.replace('from dataclasses import replace', 'from dataclasses import asdict, replace')
app = app.replace('_synthesis_semaphore_limit: int | None = None', '_synthesis_semaphore_limit: int | None = None\n_active_synthesis = 0')
app = app.replace('    ref_wav: str | None = None', '    ref_wav: str | None = None\n    ref_wavs: list[str] | None = None', 1)
app = app.replace('                "ref_wav": voice.ref_wav,', '                "ref_wav": voice.ref_wav,\n                "ref_wavs": voice.ref_wavs,')
app = app.replace('    explicit_ref_wav = options.ref_wav', '    explicit_ref_wavs = options.ref_wavs\n    if explicit_ref_wavs is None:\n        explicit_ref_wavs = _extra(payload, "ref_wavs")\n    explicit_ref_wav = options.ref_wav')
app = app.replace('        explicit_ref_wav is not None\n', '        explicit_ref_wavs is not None\n        or explicit_ref_wav is not None\n', 1)
app = app.replace('            voice_id="request",', '            voice_id="request",\n            ref_wavs=explicit_ref_wavs,', 1)
# VoiceSpec validates new explicit/alias references; map errors to client errors.
app = app.replace('    voice = _resolve_voice(payload)', '''    try:
        voice = _resolve_voice(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc''', 1)
app = app.replace('        ref_wav=voice.ref_wav,', '        ref_wav=voice.ref_wav,\n        ref_wavs=voice.ref_wavs,', 1)
app = app.replace('        "  Reference latent: %s\\n"', '        "  Reference audios (ordered): %s\\n"\n        "  Reference latent: %s\\n"', 1)
app = app.replace('        reference_path(request.ref_wav),', '        reference_path(request.ref_wav),\n        [reference_path(path) for path in (request.ref_wavs or [])],', 1)
app = app.replace('    return await loop.run_in_executor(None, partial(func, *args, **kwargs))', '''    future = loop.run_in_executor(None, partial(func, *args, **kwargs))
    try:
        return await asyncio.shield(future)
    except asyncio.CancelledError:
        # A disconnected caller must not free the GPU slot while its thread runs.
        try:
            await asyncio.shield(future)
        finally:
            raise''', 1)
app = app.replace('async def _acquire_synthesis_slot() -> asyncio.Semaphore:\n', 'async def _acquire_synthesis_slot() -> asyncio.Semaphore:\n    global _active_synthesis\n')
app = app.replace('        await asyncio.wait_for(semaphore.acquire(), timeout=timeout)\n', '        await asyncio.wait_for(semaphore.acquire(), timeout=timeout)\n        _active_synthesis += 1\n', 1)
app = app.replace('def _release_synthesis_slot(semaphore: asyncio.Semaphore) -> None:\n    semaphore.release()', 'def _release_synthesis_slot(semaphore: asyncio.Semaphore) -> None:\n    global _active_synthesis\n    _active_synthesis = max(0, _active_synthesis - 1)\n    semaphore.release()')

if 'def _log_speech_request(' not in app:
    app += '\n\ndef _log_speech_request(request, voice):\n    logger.info("managed request: voice=%s references=%d chars=%d", voice.voice_id, len(request.ref_wavs or ([request.ref_wav] if request.ref_wav else [])), len(request.text))\n'

app += '\n\n' + (ROOT / 'managed_endpoints.py.inc').read_text(encoding='utf-8')
for name, text in [('app.py', app), ('voices.py', voices)]:
    (ROOT / 'patched' / name).write_text(text, encoding='utf-8')
    before = (ROOT / 'baseline' / name).read_text(encoding='utf-8')
    diff = ''.join(difflib.unified_diff(before.splitlines(True), text.splitlines(True),
                  fromfile='a/src/irodori_openai_tts/' + name, tofile='b/src/irodori_openai_tts/' + name))
    (ROOT / (name + '.patch')).write_text(diff, encoding='utf-8')
