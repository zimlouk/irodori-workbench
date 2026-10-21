"""Registered output publication and seven-day retention of superseded attempts."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import re
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from .storage import Batch, Job, Project, utc_now


def expiry():
    return (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def retire(session, job_id):
    job = session.get(Job, job_id) if job_id else None
    if job and not job.expires_at:
        job.expires_at = expiry()


def remove_export(segment):
    """Never remove a file replaced/edited outside this workbench."""
    if segment.get("output_path"):
        p = Path(segment["output_path"])
        if p.is_file():
            if sha(p) != segment.get("output_sha256"):
                segment["output_error"] = "输出已被外部修改，保留该文件，请手动处理"
                return False
            p.unlink()
        segment["output_path"] = None
        segment["output_sha256"] = None
    return True


def publish(batch, segment, job, output_dir):
    if not job.audio_file or job.purged:
        return
    directory = Path(batch.document["output_dir"]).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', job.text).strip(' .')[:55] or '台词'
    # Batch UUID avoids cross-day/cross-app timestamp collisions. Segment ID also
    # avoids path reuse after deletion or reordering while retaining readable order.
    index = next(i for i, s in enumerate(batch.document['segments'], 1) if s['id'] == segment['id'])
    name = f"{text}_{batch.id[:8]}_{index:03d}_{segment['id'][:6]}.wav"
    target = directory / name
    previous = segment.get('output_path')
    if target.exists() and (str(target) != previous or sha(target) != segment.get('output_sha256')):
        segment['output_error'] = '目标文件已存在且归属不明，未覆盖，请调整输出目录'
        return
    source = output_dir / job.audio_file
    temporary = target.with_name('.' + uuid4().hex + '.tmp')
    try:
        temporary.write_bytes(source.read_bytes())
        # Write the new copy successfully before removing the old selected copy.
        if previous and str(target) != previous and not remove_export(segment):
            return
        temporary.replace(target)
        segment['output_path'], segment['output_sha256'] = str(target), sha(target)
        segment['output_error'] = None
    finally:
        temporary.unlink(missing_ok=True)


def select_audio(session, batch, segment, job, output_dir):
    if segment.get('selected_job_id') != job.id:
        retire(session, segment.get('selected_job_id'))
    segment['selected_job_id'], segment['auto_select_job_id'] = job.id, None
    job.expires_at = None
    try:
        publish(batch, segment, job, output_dir)
    except OSError as exc:
        segment['output_error'] = f'音频已保存，输出目录写入失败：{exc}'


def complete_batch_attempt(session, job, output_dir):
    if not job.workbench_batch_id:
        return
    batch = session.get(Batch, job.workbench_batch_id)
    if not batch:
        return
    batch.document = deepcopy(batch.document)
    flag_modified(batch, 'document')
    segment = next((s for s in batch.document['segments'] if s['id'] == job.segment_id), None)
    if segment and segment['input_revision'] == job.input_revision and segment.get('auto_select_job_id') == job.id:
        select_audio(session, batch, segment, job, output_dir)
    else:
        job.expires_at = expiry()
    # Replace JSON identity after nested edits (SQLAlchemy JSON isn't MutableDict).
    batch.document = deepcopy(batch.document)
    flag_modified(batch, 'document')


def cleanup(session, output_dir, leased=()):
    protected = set(leased)
    for row in session.scalars(select(Batch)):
        protected.update(s['selected_job_id'] for s in row.document['segments'] if s.get('selected_job_id'))
    for row in session.scalars(select(Project)):
        if not session.get(Batch, row.id):
            protected.update(s['selected_job_id'] for s in row.document['segments'] if s.get('selected_job_id'))
    for job in session.scalars(select(Job).where(Job.expires_at.is_not(None), Job.purged == 0)):
        if job.id in protected or job.status in ('running', 'pending') or job.expires_at > utc_now():
            continue
        if job.audio_file:
            # Managed filenames are only UUID.wav. Never trust paths from imported JSON.
            if job.audio_file != job.id + '.wav':
                continue
            path = output_dir / job.audio_file
            metadata = job.result_metadata or {}
            if path.is_file():
                if not metadata.get('audio_sha256') or sha(path) != metadata['audio_sha256']:
                    continue
                path.unlink()
        job.audio_file, job.purged = None, 1
