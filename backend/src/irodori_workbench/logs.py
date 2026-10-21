"""Bounded local diagnostics: rotating process output and old-log housekeeping."""
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import re
import threading
import time

LOG_LIMIT = 5 * 1024 * 1024
LOG_BACKUPS = 3


def cleanup_logs(directory: Path, *, now=None, keep_days=7, budget=64 * 1024 * 1024):
    if not directory.is_dir():
        return 0
    now = time.time() if now is None else now
    candidates = []
    removed = 0
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file() or not re.search(r'\.log(?:\.\d+)?$', path.name):
            continue
        try:
            stat = path.stat()
            # Never touch live output files; their writers rotate them themselves.
            protected = path.name in {'backend.log', 'inference.log'} or now - stat.st_mtime < 300
            candidates.append((stat.st_mtime, stat.st_size, path, protected))
        except OSError:
            continue
    total = sum(item[1] for item in candidates)
    for modified, size, path, protected in sorted(candidates):
        if protected or (now - modified <= keep_days * 86400 and total <= budget):
            continue
        try:
            path.unlink()
            total -= size
            removed += 1
        except OSError:
            pass  # A Windows reader/writer may still hold this file. Retry later.
    return removed


def console_line(line):
    # HTTP access polling is noisy; lifecycle, model progress and failures matter.
    if re.search(r'"(?:GET|POST|PUT|PATCH|DELETE) /', line):
        return False
    return True


class ProcessLog:
    def __init__(self, child, path, label, emit=print):
        self.handler = RotatingFileHandler(path, maxBytes=LOG_LIMIT, backupCount=LOG_BACKUPS, encoding='utf-8')
        self.handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
        self.child, self.label, self.emit = child, label, emit
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()

    def drain(self):
        try:
            for line in self.child.stdout:
                line = line.rstrip('\r\n')
                self.handler.handle(logging.LogRecord(self.label, logging.INFO, '', 0, line, (), None))
                if console_line(line):
                    self.emit(f'[{self.label}] {line}', flush=True)
        finally:
            self.child.stdout.close()
            self.handler.close()

    def close(self):
        self.thread.join(timeout=2)
