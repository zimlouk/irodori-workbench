"""Run a configured local v4 runtime with the workbench Server protocol (Python 3.10+)."""
import argparse
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('server-dir', 'runtime-dir', 'model-home', 'checkpoint', 'codec', 'env-file', 'dependency-site-packages'):
        parser.add_argument('--'+name, required=name == 'server-dir', type=Path)
    parser.add_argument('--host', choices=['127.0.0.1', 'localhost', '::1'], default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8998)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    server = args.server_dir.resolve()
    if not (server/'src/irodori_openai_tts/app.py').is_file():
        raise ValueError('Server source missing in --server-dir')
    # An explicit legacy fallback can supply dotenv/settings without shadowing the GPU environment.
    if args.dependency_site_packages:
        if not args.dependency_site_packages.is_dir():
            raise ValueError('Dependency fallback directory missing')
        sys.path.append(str(args.dependency_site_packages.resolve()))
    sys.path.insert(0, str(server/'src'))
    if args.runtime_dir:
        runtime_dir = args.runtime_dir.resolve()
        if not (runtime_dir/'irodori_tts/inference_runtime.py').is_file():
            raise ValueError('Configured v4 runtime source missing')
        sys.path.insert(0, str(runtime_dir))
    if args.env_file:
        if not args.env_file.is_file():
            raise ValueError('Server environment file missing')
        from dotenv import load_dotenv
        load_dotenv(args.env_file, override=False)
    for variable, value in [('IRODORI_CHECKPOINT', args.checkpoint), ('IRODORI_CODEC_REPO', args.codec)]:
        if value:
            os.environ[variable] = str(value.resolve())
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    if args.model_home:
        os.environ.update(HF_HOME=str(args.model_home.resolve()), HF_HUB_CACHE=str(args.model_home.resolve()/'hub'))
    for variable in ('IRODORI_CHECKPOINT', 'IRODORI_CODEC_REPO'):
        path = Path(os.environ.get(variable, '')).expanduser()
        if not path.is_absolute() and args.env_file:
            path = args.env_file.resolve().parent/path
        if not path.is_file():
            raise ValueError(f'{variable} must point to a local file')
        os.environ[variable] = str(path.resolve())
    tokenizer = Path(os.environ['IRODORI_CHECKPOINT']).parent/'tokenizer'
    for name in ('tokenizer.json', 'tokenizer_config.json'):
        if not (tokenizer/name).is_file():
            raise ValueError(f'Local tokenizer missing: {name}')
    import importlib.metadata
    if int(importlib.metadata.version('transformers').split('.')[0]) < 5:
        raise ValueError('The v4 inference environment requires Transformers 5')
    print('Local inference configuration ready; offline model loading enabled.', flush=True)
    if args.check:
        return
    os.chdir(server)
    sys.argv = [sys.argv[0], '--host', args.host, '--port', str(args.port)]
    from irodori_openai_tts.__main__ import main as serve
    serve()


if __name__ == '__main__':
    main()
