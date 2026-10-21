import importlib.util
import sys
import os
import csv
import io
import subprocess
import pytest
from pathlib import Path


def launcher_module():
    spec = importlib.util.spec_from_file_location('workbench_launcher', Path(__file__).parents[2] / 'scripts/start.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_cmd_keeps_crlf_for_utf8_messages():
    raw=(Path(__file__).parents[2]/'Start-Workbench.cmd').read_bytes()
    assert b'\r\n' in raw, 'CMD startup script must use Windows CRLF line endings'
    assert b'\n' not in raw.replace(b'\r\n',b''), 'Bare LF breaks CMD parsing of UTF-8 startup messages'


@pytest.mark.skipif(os.name != 'nt', reason='Windows process tree behavior')
def test_owned_shutdown_stops_venv_shim_descendants():
    launcher = launcher_module()
    child_code = 'import time; time.sleep(60)'
    parent_code = f'import subprocess,sys; child=subprocess.Popen([sys.executable,"-c",{child_code!r}]); print(child.pid,flush=True); child.wait()'
    parent = subprocess.Popen([sys.executable, '-u', '-c', parent_code], stdout=subprocess.PIPE, text=True)
    try:
        child_pid = parent.stdout.readline().strip()
        assert child_pid.isdigit()
        launcher.terminate_owned(parent)
        result = subprocess.run(['tasklist', '/FI', 'PID eq '+child_pid, '/FO', 'CSV', '/NH'],
                                capture_output=True, text=True, check=True)
        assert not any(len(row)>1 and row[1]==child_pid for row in csv.reader(io.StringIO(result.stdout)))
    finally:
        if parent.poll() is None:
            launcher.terminate_owned(parent)
        parent.stdout.close()


def test_startup_shows_feedback_before_slow_probe(tmp_path, monkeypatch, capsys):
    launcher = launcher_module()
    frontend = tmp_path / 'frontend/dist'
    frontend.mkdir(parents=True)
    (frontend / 'index.html').write_text('ready')
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(sys, 'argv', ['start.py', '--no-browser'])

    def slow_probe():
        assert '启动' in capsys.readouterr().out, '首次探测前没有任何启动反馈'
        return True

    monkeypatch.setattr(launcher, 'healthy', slow_probe)
    launcher.main()


def test_opens_page_before_starting_inference(tmp_path, monkeypatch):
    launcher = launcher_module()
    frontend = tmp_path/'frontend/dist'
    frontend.mkdir(parents=True)
    (frontend/'index.html').write_text('ready')
    monkeypatch.setattr(launcher,'ROOT',tmp_path)
    monkeypatch.setattr(sys,'argv',['start.py'])
    monkeypatch.setenv('IRODORI_WORKBENCH_DATA',str(tmp_path/'data'))
    monkeypatch.setenv('IRODORI_WORKBENCH_MODE','irodori')
    healthy = iter([False,True])
    monkeypatch.setattr(launcher,'healthy',lambda: next(healthy))
    class Socket:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def connect_ex(self,*args): return 1
    class Child:
        pid = 123
        returncode = 0
        def poll(self): return 0
        def wait(self,**kw): return 0
    child = Child()
    # The startup loop must see a running process, then wait() completes it.
    child.returncode = None
    child.poll = lambda: child.returncode
    def done(**kw): child.returncode = 0
    child.wait = done
    monkeypatch.setattr(launcher.socket,'socket',Socket)
    monkeypatch.setattr(launcher,'launch',lambda *args: child)
    events=[]
    monkeypatch.setattr(launcher.webbrowser,'open',lambda url: events.append('browser'))
    monkeypatch.setattr(launcher,'start_server',lambda *args: events.append('inference'))
    launcher.main()
    assert events == ['browser','inference']
