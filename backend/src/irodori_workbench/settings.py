"""Shared, stdlib-only installation settings. Business preferences stay in SQLite."""
from dataclasses import dataclass, field
import os
from pathlib import Path
import tomllib
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    root: Path
    config_file: Path
    mode: str
    port: int
    dev_port: int
    data_dir: Path
    server_url: str
    launch_mode: str
    server_dir: Path | None
    runtime_python: Path | None
    runtime_dir: Path | None
    model_home: Path | None
    checkpoint: Path | None
    codec: Path | None
    dependency_site_packages: Path | None
    env_file: Path | None
    lora_settings: Path
    lora_dir: Path
    encoder_python: Path | None
    voice_profile: Path | None
    api_key: str | None = field(default=None, repr=False)

    @property
    def url(self):
        return f'http://127.0.0.1:{self.port}'

    @property
    def allowed_origins(self):
        return {f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost')
                for port in (self.port, self.dev_port)}

    def child_environment(self):
        env = os.environ.copy()
        env.update(IRODORI_WORKBENCH_CONFIG=str(self.config_file),
                   IRODORI_WORKBENCH_MODE=self.mode, IRODORI_WORKBENCH_PORT=str(self.port),
                   IRODORI_WORKBENCH_DEV_PORT=str(self.dev_port), IRODORI_WORKBENCH_DATA=str(self.data_dir),
                   IRODORI_SERVER_URL=self.server_url, IRODORI_LORA_SETTINGS=str(self.lora_settings),
                   IRODORI_LORA_DIR=str(self.lora_dir))
        return env


FIELDS = {
    'workbench': {'mode', 'port', 'dev_port', 'data_dir'},
    'inference': {'launch_mode', 'url', 'server_dir', 'python', 'runtime_dir', 'model_home',
                  'checkpoint', 'codec', 'dependency_site_packages', 'env_file'},
    'lora': {'root', 'catalog'},
    'encoding': {'python'},
    'presets': {'profile'},
}


def load_settings(config_file=None, *, root=None, environ=None, overrides=None):
    root = Path(root or ROOT).resolve()
    env = os.environ if environ is None else environ
    filename = Path(config_file or env.get('IRODORI_WORKBENCH_CONFIG') or root/'config.local.toml').expanduser().resolve()
    if config_file is not None and not filename.is_file():
        raise ValueError(f'配置文件不存在：{filename}')
    document = tomllib.loads(filename.read_text(encoding='utf-8-sig')) if filename.is_file() else {}
    for section, values in document.items():
        if section not in FIELDS or not isinstance(values, dict) or set(values)-FIELDS[section]:
            raise ValueError(f'配置中存在未知字段或无效分组：{section}')
    base = filename.parent

    def value(section, name, variable, default=None, cli=None):
        if cli and overrides and overrides.get(cli) is not None:
            return overrides[cli]
        return env.get(variable, document.get(section, {}).get(name, default))

    def path(section, name, variable, default=None, cli=None):
        result = value(section, name, variable, default, cli)
        if result in (None, ''):
            return None
        if not isinstance(result, str):
            raise ValueError(f'{section}.{name} 必须是路径字符串')
        result = Path(result).expanduser()
        return (result if result.is_absolute() else base/result).resolve()

    def port(name, variable, default):
        raw = value('workbench', name, variable, default, name)
        if isinstance(raw, bool) or not str(raw).isdigit() or not 1 <= int(raw) <= 65535:
            raise ValueError(f'workbench.{name} 必须是1–65535的整数')
        return int(raw)

    mode = value('workbench', 'mode', 'IRODORI_WORKBENCH_MODE', 'irodori', 'mode')
    if mode not in {'irodori', 'fake'}:
        raise ValueError('workbench.mode 必须是 irodori 或 fake')
    launch = value('inference', 'launch_mode', 'IRODORI_LAUNCH_MODE', 'external')
    if launch not in {'external', 'managed'}:
        raise ValueError('inference.launch_mode 必须是 external 或 managed')
    url = value('inference', 'url', 'IRODORI_SERVER_URL', 'http://127.0.0.1:8998', 'server_url')
    if not isinstance(url, str):
        raise ValueError('inference.url 必须是本机HTTP地址')
    parsed = urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('Windows本机版本的 inference.url 必须是本机HTTP根地址，不包含凭据')
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError('inference.url 端口无效') from exc
    runtime = path('inference', 'python', 'IRODORI_RUNTIME_PYTHON')
    encoder = path('encoding', 'python', 'IRODORI_ENCODER_PYTHON')
    if encoder is None and 'IRODORI_ENCODER_PYTHON' not in env and 'python' not in document.get('encoding', {}):
        encoder = runtime  # Compatibility with legacy environment-only installation.
    return Settings(root, filename, mode, port('port', 'IRODORI_WORKBENCH_PORT', 8999),
        port('dev_port', 'IRODORI_WORKBENCH_DEV_PORT', 5173),
        path('workbench', 'data_dir', 'IRODORI_WORKBENCH_DATA', './data', 'data_dir') or base/'data',
        url.rstrip('/'), launch, path('inference', 'server_dir', 'IRODORI_SERVER_DIR'), runtime,
        path('inference', 'runtime_dir', 'IRODORI_RUNTIME_DIR'),
        path('inference', 'model_home', 'IRODORI_MODEL_HOME'),
        path('inference', 'checkpoint', 'IRODORI_CHECKPOINT'),
        path('inference', 'codec', 'IRODORI_CODEC_REPO'),
        path('inference', 'dependency_site_packages', 'IRODORI_DEPENDENCY_SITE_PACKAGES'),
        path('inference', 'env_file', 'IRODORI_SERVER_ENV_FILE'),
        path('lora', 'catalog', 'IRODORI_LORA_SETTINGS', './config/loras.json') or base/'config/loras.json',
        path('lora', 'root', 'IRODORI_LORA_DIR', './models/loras') or base/'models/loras',
        encoder,
        path('presets', 'profile', 'IRODORI_VOICE_PROFILE'),
        env.get('IRODORI_SERVER_API_KEY') or None)


def voice_profile():
    import json
    path = load_settings().voice_profile
    if path is None:
        return {}
    if not path.is_file():
        raise ValueError('presets.profile 文件不存在')
    profile = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(profile, dict):
        raise ValueError('presets.profile 必须是JSON对象')
    return profile
