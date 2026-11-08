#!/usr/bin/env python3
"""เขียน deploy record ต่อภายใต้ exclusive lock และ approval ของ caller

สำหรับเรียกภายในเท่านั้น: caller ต้องถือ b714-cutover.lock แบบ exclusive และ
อนุมัติ runtime/ledger evidence ที่ยังสด โดยคง active journal เป็น mutation gate
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile

SPEC = importlib.util.spec_from_file_location(
    'b868_journal_inspect', Path(__file__).with_name('b868-record-recovery-inspect.py'))
JOURNAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOURNAL)


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def complete_locked(root, expected_intent_sha256):
    """เขียนต่อเฉพาะ journal ที่ระบุด้วย intent hash ซึ่งผ่าน approval แล้ว"""
    root = Path(root)
    operator = root / 'operator'
    journal = operator / 'uat-record-transaction'
    deployments = root / 'deployments'
    JOURNAL.inspect_locked(root)
    intent_raw = JOURNAL.read_private(journal / 'intent.json')
    if JOURNAL.digest(intent_raw) != expected_intent_sha256:
        raise RuntimeError('COMMIT_INTENT_CHANGED')
    intent = json.loads(intent_raw)
    desired = JOURNAL.read_private(journal / 'desired.json')
    record = json.loads(desired)
    if not isinstance(record, dict) or record.get('schema') != 'UatDeploymentRecordV1' or record.get('action') != 'deploy':
        raise RuntimeError('COMMIT_DEPLOY_REQUIRED')
    if (not isinstance(record.get('sourceSha'), str) or not re.fullmatch('[0-9a-f]{40}', record['sourceSha'])
            or not intent['archive'].endswith('-' + record['sourceSha'] + '.json')):
        raise RuntimeError('COMMIT_ARCHIVE_SOURCE_MISMATCH')
    snapshots = intent['snapshots']
    original = {name: JOURNAL.read_private(journal / name) if digest is not None else None
                for name, digest in snapshots.items()}
    archive = deployments / intent['archive']
    marker = Path(str(archive) + '.committed')
    expected_previous = original['current.json'] if original['current.json'] is not None else original['previous.json']
    marker_bytes = (intent['desiredSha256'] + '\n').encode()

    def capture():
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending', 'uat-record-retirement.pending'):
            if os.path.lexists(operator / name):
                raise RuntimeError('COMMIT_OTHER_TRANSACTION_PENDING')
        JOURNAL.inspect_locked(root)
        if JOURNAL.read_private(journal / 'intent.json') != intent_raw or JOURNAL.read_private(journal / 'desired.json') != desired:
            raise RuntimeError('COMMIT_JOURNAL_CHANGED')
        for name, data in original.items():
            actual = JOURNAL.read_private(journal / name) if os.path.lexists(journal / name) else None
            if actual != data:
                raise RuntimeError('COMMIT_JOURNAL_CHANGED')
        return tuple(JOURNAL.read_private(path) if os.path.lexists(path) else None for path in
                     (archive, deployments / 'previous.json', deployments / 'current.json', marker))

    observed = capture()
    valid = {(None, original['previous.json'], original['current.json'], None),
             (desired, original['previous.json'], original['current.json'], None),
             (desired, expected_previous, original['current.json'], None),
             (desired, expected_previous, desired, None),
             (desired, expected_previous, desired, marker_bytes)}
    if observed not in valid:
        raise RuntimeError('COMMIT_STATE_INVALID')

    def check():
        if capture() != observed:
            raise RuntimeError('COMMIT_STATE_CHANGED')

    def replace(path, data):
        check()
        fd, name = tempfile.mkstemp(prefix='.uat-record-recovery-', dir=deployments)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        check()
        os.replace(name, path)
        _sync_directory(deployments)
        if JOURNAL.read_private(path) != data:
            raise RuntimeError('COMMIT_READBACK_MISMATCH')

    for name in ('intent.json', 'desired.json', *snapshots):
        path = journal / name
        if os.path.lexists(path):
            check()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    _sync_directory(journal)
    archive_staging = journal / 'forward-archive-staging.json'
    if observed[0] is None:
        check()
        if os.path.lexists(archive_staging):
            if JOURNAL.read_private(archive_staging) != desired:
                raise RuntimeError('COMMIT_ARCHIVE_STAGING_CHANGED')
        else:
            fd, staging = tempfile.mkstemp(prefix='.forward-archive-pending-', dir=journal)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(desired)
                stream.flush()
                os.fsync(stream.fileno())
            check()
            if os.path.lexists(archive_staging):
                raise RuntimeError('COMMIT_ARCHIVE_STAGING_CHANGED')
            os.replace(staging, archive_staging)
            _sync_directory(journal)
        check()
        os.link(archive_staging, archive, follow_symlinks=False)
        _sync_directory(deployments)
        if JOURNAL.read_private(archive) != desired:
            raise RuntimeError('COMMIT_READBACK_MISMATCH')
        observed = (desired, *observed[1:])
    if os.path.lexists(archive_staging):
        check()
        if JOURNAL.read_private(archive_staging) != desired:
            raise RuntimeError('COMMIT_ARCHIVE_STAGING_CHANGED')
        # path นี้เป็น staging ของ transaction ใน journal; retry เก็บ alias เดิมได้
        os.unlink(archive_staging)
        _sync_directory(journal)
    if os.stat(archive, follow_symlinks=False).st_nlink != 1:
        raise RuntimeError('COMMIT_ARCHIVE_ALIAS_REQUIRES_REVIEW')
    if observed[1] != expected_previous:
        replace(deployments / 'previous.json', expected_previous)
        observed = (observed[0], expected_previous, *observed[2:])
    if observed[2] != desired:
        replace(deployments / 'current.json', desired)
        observed = (observed[0], observed[1], desired, observed[3])
    if observed[3] is None:
        replace(marker, marker_bytes)
        observed = (observed[0], observed[1], observed[2], marker_bytes)
    check()
    for path in (archive, deployments / 'previous.json', deployments / 'current.json', marker):
        if os.path.lexists(path):
            check()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    _sync_directory(deployments)
    check()
    return {'status': 'RECORD_COMMITTED_JOURNAL_ACTIVE', 'desiredSha256': intent['desiredSha256'],
            'runtimeVerified': False, 'rollbackCertified': False}
