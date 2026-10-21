"""Start the local workbench and its inference service; never kill an unrelated process."""
from contextlib import ExitStack
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from urllib.request import Request
import webbrowser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend/src'))
from irodori_workbench.logs import ProcessLog, cleanup_logs
from irodori_workbench.settings import load_settings

PORT = int(os.environ.get('IRODORI_WORKBENCH_PORT', '8999'))
URL = f"http://127.0.0.1:{PORT}"
SERVER_URL = os.environ.get("IRODORI_SERVER_URL", "http://127.0.0.1:8998").rstrip("/")
SETTINGS = None


def say(message):
    print(time.strftime('[%H:%M:%S] ') + message, flush=True)


def launch(arguments, cwd, env, path, label, stack):
    child = subprocess.Popen(arguments, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding='utf-8', errors='replace', bufsize=1)
    stack.callback(ProcessLog(child, path, label).close)
    return child


def terminate_owned(child):
    """Windows venv python.exe can be a shim; close its owned descendants as well."""
    if child.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        child.terminate()
    child.wait(timeout=10)


def server_status():
    headers = {}
    key = SETTINGS.api_key if SETTINGS else os.environ.get('IRODORI_SERVER_API_KEY')
    if key:
        headers["Authorization"] = "Bearer " + key
    with urlopen(Request(SERVER_URL + "/v1/irodori/capabilities", headers=headers), timeout=2) as response:
        result = json.load(response)
    if result.get("protocol_version") != 1 or not result.get("managed_synthesis") or not result.get("multi_reference"):
        raise RuntimeError("Irodori Server needs the P1 protocol patch.")
    return result


def start_server(env, logs, stack):
    say('检查 Irodori 推理服务…')
    try:
        server_status()
        say('推理服务已运行，可直接复用。')
        return None
    except Exception:
        pass
    settings = SETTINGS or load_settings(root=ROOT)
    if settings.launch_mode == 'external':
        say('仅连接模式：推理服务尚未就绪，请启动配置的本机 Server。')
        return None
    parsed = urlsplit(SERVER_URL)
    inference_port = parsed.port or 80
    try:
        with socket.create_connection((parsed.hostname, inference_port), timeout=.5):
            say(f'推理端口 {inference_port} 已被占用，保留原进程，请检查协议或认证。')
            return None
    except OSError:
        pass
    problems = managed_problems(settings)
    if problems:
        say('推理配置未完成：' + '；'.join(problems))
        return None
    server_dir, interpreter = settings.server_dir, settings.runtime_python
    server_env = env.copy()
    server_env.pop("PYTHONPATH", None)
    server_env["IRODORI_MAX_CONCURRENT_SYNTHESIS"] = "1"
    server_env["IRODORI_PRELOAD"] = "false"
    server_env['PYTHONUNBUFFERED'] = '1'
    say('正在启动推理服务；首次导入 PyTorch 需要一些时间，工作台页面已经可用。')
    arguments = [str(interpreter), '-u', str(ROOT/'scripts/run_inference.py'),
                 '--server-dir', str(server_dir), '--host', parsed.hostname, '--port', str(inference_port)]
    for flag, path in [('--runtime-dir', settings.runtime_dir), ('--model-home', settings.model_home),
                       ('--checkpoint', settings.checkpoint), ('--codec', settings.codec),
                       ('--env-file', settings.env_file), ('--dependency-site-packages', settings.dependency_site_packages)]:
        if path:
            arguments += [flag, str(path)]
    child = launch(arguments,
                  server_dir, server_env, logs / 'inference.log', '推理', stack)
    (logs.parent / "inference.pid").write_text(str(child.pid))
    started = time.monotonic()
    next_notice = started
    while time.monotonic() - started < 120:
        if child.poll() is not None:
            print("Inference startup failed; see", logs / "inference.log", flush=True)
            return child
        try:
            server_status()
            say('推理服务已就绪；模型会在首次生成时加载。')
            return child
        except Exception:
            if time.monotonic() >= next_notice:
                say(f'推理服务正在初始化… 已等待 {int(time.monotonic() - started)} 秒')
                next_notice = time.monotonic() + 3
            time.sleep(0.5)
    print("Inference startup is still pending; see", logs / "inference.log", flush=True)
    return child


def healthy():
    for endpoint in ('/api/v1/health', '/api/v1/status'):
        try:
            with urlopen(URL + endpoint, timeout=1) as response:
                return json.load(response).get("service") == "irodori-workbench"
        except Exception:
            pass
    return False


def managed_problems(settings):
    problems = []
    if not settings.runtime_python or not settings.runtime_python.is_file():
        problems.append('inference.python 不是有效解释器')
    if not settings.server_dir or not (settings.server_dir/'src/irodori_openai_tts/app.py').is_file():
        problems.append('inference.server_dir 缺少 Server 源码')
    for name, path in [('runtime_dir', settings.runtime_dir), ('model_home', settings.model_home),
                       ('dependency_site_packages', settings.dependency_site_packages)]:
        if path and not path.is_dir():
            problems.append(f'inference.{name} 目录不存在')
    for name, path in [('checkpoint', settings.checkpoint), ('codec', settings.codec), ('env_file', settings.env_file)]:
        if path and not path.is_file():
            problems.append(f'inference.{name} 文件不存在')
    if not (settings.checkpoint and settings.codec) and not settings.env_file:
        problems.append('请配置 checkpoint/codec，或指定包含模型路径的 env_file')
    return problems


def main():
    global SETTINGS, PORT, URL, SERVER_URL
    say('正在启动 Irodori 工作台：检查本地服务和文件…')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--mode', choices=['fake', 'irodori'])
    parser.add_argument('--port', type=int)
    parser.add_argument('--dev-port', type=int)
    parser.add_argument('--data-dir')
    parser.add_argument('--server-url')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--check', action='store_true', help='Validate configuration without starting services')
    args = parser.parse_args()
    SETTINGS = load_settings(args.config, root=ROOT, overrides=vars(args))
    PORT, URL, SERVER_URL = SETTINGS.port, SETTINGS.url, SETTINGS.server_url
    if args.check:
        problems = managed_problems(SETTINGS) if SETTINGS.mode == 'irodori' and SETTINGS.launch_mode == 'managed' else []
        print(f'配置：{SETTINGS.config_file}\n工作台：{URL}\n数据：{SETTINGS.data_dir}\n模式：{SETTINGS.mode}/{SETTINGS.launch_mode}')
        if problems:
            raise ValueError('；'.join(problems))
        say('配置检查通过；没有启动服务或加载模型。')
        return
    open_browser = not args.no_browser
    if not (ROOT / "frontend/dist/index.html").exists():
        raise RuntimeError("Frontend missing. Run npm ci and npm run build in frontend first.")
    if healthy():
        print("Opening existing workbench:", URL)
        if open_browser:
            webbrowser.open(URL)
        return
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            raise RuntimeError(f"Port {PORT} is occupied or an existing workbench is unhealthy; inspect it before starting.")
    data_dir = SETTINGS.data_dir
    logs = data_dir / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    removed = cleanup_logs(logs)
    say(f'日志：{logs}；单文件5MiB轮转，保留3份旧卷；历史日志保留7天（本次清理{removed}份）。')
    env = SETTINGS.child_environment()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(ROOT / "backend/src")
    env['PYTHONUNBUFFERED'] = '1'
    with ExitStack() as stack:
        say('正在启动工作台后端…')
        child = launch([sys.executable, '-u', "-m", "uvicorn", "irodori_workbench.app:create_app",
                         "--factory", "--host", "127.0.0.1", "--port", str(PORT), "--workers", "1", '--no-access-log'],
                        ROOT, env, logs / 'backend.log', '工作台', stack)
        (data_dir / "backend.pid").write_text(str(child.pid))
        inference_child = None
        try:
            started = time.monotonic()
            next_notice = started
            while time.monotonic() - started < 45:
                if child.poll() is not None:
                    raise RuntimeError(f"Backend exited. See {logs / 'backend.log'}")
                if healthy():
                    break
                if time.monotonic() >= next_notice:
                    say(f'等待工作台后端就绪… 已等待 {int(time.monotonic() - started)} 秒')
                    next_notice = time.monotonic() + 2
                time.sleep(0.2)
            else:
                raise RuntimeError(f"Startup timed out. See {logs / 'backend.log'}")
            print("Irodori workbench:", URL, "\nCtrl+C to stop. Log:", logs / "backend.log")
            if open_browser:
                webbrowser.open(URL)
                say('工作台页面已打开。')
            if env.get("IRODORI_WORKBENCH_MODE", "irodori") == "irodori":
                inference_child = start_server(env, logs, stack)
            say('启动检查完成；关键日志会继续显示。Ctrl+C 可停止本次启动的工作台。')
            child.wait()
            if child.returncode:
                raise RuntimeError(f"Backend exited with {child.returncode}; see {logs / 'backend.log'}")
        except KeyboardInterrupt:
            pass
        finally:
            if child.poll() is None:
                terminate_owned(child)
            if inference_child and inference_child.poll() is None:
                # Keep the pipe reader alive until this process's current inference ends.
                # Closing it while the GPU is busy can break the child's stdout.
                next_notice = 0
                while inference_child.poll() is None:
                    try:
                        state = server_status()["runtime"]
                        if state["busy"] or state["loading"]:
                            if time.monotonic() >= next_notice:
                                say('正在等待当前推理结束后关闭服务…')
                                next_notice = time.monotonic() + 5
                            time.sleep(1)
                            continue
                        terminate_owned(inference_child)
                    except Exception:
                        if time.monotonic() >= next_notice:
                            say('暂时无法确认推理状态，保留日志监控并继续等待…')
                            next_notice = time.monotonic() + 5
                        time.sleep(2)


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    try:
        main()
    except Exception as exc:
        print(f"Startup error: {exc}", file=sys.stderr)
        sys.exit(1)
