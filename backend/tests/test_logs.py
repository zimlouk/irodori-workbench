import io
import os
from types import SimpleNamespace

from irodori_workbench.logs import ProcessLog, cleanup_logs


def test_cleanup_age_budget_and_protected_files(tmp_path):
    now = 2_000_000
    def file(name, age, size=10):
        path = tmp_path / name
        path.write_bytes(b'x' * size)
        os.utime(path, (now-age, now-age))
        return path
    expired = file('old.log', 8*86400)
    backup = file('backend.log.1', 6*86400)
    recent = file('test.log', 3600)
    live = file('backend.log', 9*86400)
    writing = file('active.log', 10)
    pid = file('backend.pid', 9*86400)
    other = file('keep.txt', 9*86400)
    assert cleanup_logs(tmp_path, now=now, budget=25) == 3
    assert not any(p.exists() for p in [expired, backup, recent])
    assert all(p.exists() for p in [live, writing, pid, other])


def test_relay_rotates_file_and_only_echoes_useful_lines(tmp_path, monkeypatch):
    import irodori_workbench.logs as logs
    monkeypatch.setattr(logs, 'LOG_LIMIT', 160)
    monkeypatch.setattr(logs, 'LOG_BACKUPS', 2)
    lines = ['model loading ' + 'x'*45 + '\n']*10 + ['INFO: "GET /api/v1/status HTTP/1.1" 200\n', 'ready\n']
    emitted = []
    child = SimpleNamespace(stdout=io.StringIO(''.join(lines)))
    relay = ProcessLog(child, tmp_path/'backend.log', 'backend', emit=lambda msg, **kw: emitted.append(msg))
    relay.close()
    assert len(list(tmp_path.glob('*.log*'))) == 3
    assert all('GET /' not in line for line in emitted)
    assert emitted[-1] == '[backend] ready'
    assert 'ready' in (tmp_path/'backend.log').read_text(encoding='utf-8')
