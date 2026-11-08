#!/usr/bin/env python3
"""เก็บ journal ที่ commit ครบแล้วภายใต้ lock; ไม่ซ่อม pointer หรือรับรอง rollback."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile

SPEC = importlib.util.spec_from_file_location(
    'b868_journal_inspect', Path(__file__).with_name('b868-record-recovery-inspect.py'))
JOURNAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOURNAL)


def sync_private(path, expected_sha256):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > 8388608
                or JOURNAL.digest(stream.read(8388609)) != expected_sha256):
            raise RuntimeError('RETIRE_SYNC_FILE_CHANGED')
        os.fsync(stream.fileno())
        named = os.lstat(path)
        if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('RETIRE_SYNC_FILE_CHANGED')


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def forward_evidence(journal, expected_intent_sha256, expected_desired_sha256):
    path = journal / 'forward-postcheck.json'
    if not os.path.lexists(path) and not any(journal.glob('forward-request-*.json')):
        return {}
    raw = JOURNAL.read_private(path)
    report = json.loads(raw)
    if (not isinstance(report, dict) or report.get('schema') != 'UatForwardPostcheckV1'
            or report.get('status') != 'MATCHED_LIVE_RECORD_EVIDENCE'
            or report.get('rollbackCertified') is not False
            or report.get('intentSha256') != expected_intent_sha256
            or report.get('desiredSha256') != expected_desired_sha256
            or not isinstance(report.get('request'), str)
            or not re.fullmatch(r'forward-request-[A-Za-z0-9_-]+\.json', report['request'])
            or any(not re.fullmatch('[0-9a-f]{64}', str(report.get(name, ''))) for name in
                   ('requestSha256', 'evidenceSha256', 'opsObservationSha256', 'ledgerSha256', 'protectedRuntimeSha256'))):
        raise RuntimeError('RETIRE_FORWARD_EVIDENCE_INVALID')
    request_raw = JOURNAL.read_private(journal / report['request'])
    request = json.loads(request_raw)
    if (JOURNAL.digest(request_raw) != report['requestSha256'] or not isinstance(request, dict)
            or request.get('schema') != 'UatForwardRecordRequestV1'
            or request.get('decision') != 'FORWARD_COMPLETE_RECORD_ONLY'
            or request.get('intentSha256') != expected_intent_sha256
            or request.get('desiredSha256') != expected_desired_sha256
            or request.get('evidenceSha256') != report['evidenceSha256']):
        raise RuntimeError('RETIRE_FORWARD_EVIDENCE_INVALID')
    return {'forward-postcheck.json': raw, report['request']: request_raw}


def retire(root, expected_desired_sha256, expected_intent_sha256):
    root = Path(root)
    operator = root / 'operator'
    lock_path = operator / 'b714-cutover.lock'
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('RETIRE_LOCK_INVALID')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        named = os.lstat(lock_path)
        if not stat.S_ISREG(named.st_mode) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError('RETIRE_LOCK_INVALID')
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending', 'uat-record-retirement.pending'):
            if os.path.lexists(operator / name):
                raise RuntimeError('OTHER_TRANSACTION_PENDING')
        if os.path.lexists(operator / 'uat-record-transaction/forward-postcheck.pending'):
            raise RuntimeError('FORWARD_POSTCHECK_REQUIRED')
        state = JOURNAL.inspect_locked(root)
        intent_raw = JOURNAL.read_private(operator / 'uat-record-transaction/intent.json')
        if JOURNAL.digest(intent_raw) != expected_intent_sha256:
            raise RuntimeError('RETIRE_INTENT_CHANGED')
        intent = json.loads(intent_raw)
        if state['desiredSha256'] != expected_desired_sha256:
            raise RuntimeError('RETIRE_DESIRED_CHANGED')
        if not state['markerPresent'] or state['current'] != 'desired':
            raise RuntimeError('RETIRE_COMMITTED_TRANSACTION_REQUIRED')
        if os.stat(root / 'deployments' / intent['archive'], follow_symlinks=False).st_nlink != 1:
            raise RuntimeError('RETIRE_ARCHIVE_ALIAS_REQUIRES_REVIEW')
        snapshots = intent['snapshots']
        expected_previous = snapshots['current.json'] if snapshots['current.json'] is not None else snapshots['previous.json']
        if JOURNAL.optional_digest(root / 'deployments/previous.json') != expected_previous:
            raise RuntimeError('RETIRE_PREVIOUS_NOT_COMMITTED')
        proof_files = forward_evidence(operator / 'uat-record-transaction', expected_intent_sha256,
                                       expected_desired_sha256)
        # rename เก็บ intent/snapshots ทั้ง directory: ไม่ลบหลักฐาน ไม่แตะ deployment pointer
        destination = Path(tempfile.mkdtemp(prefix='uat-record-completed-', dir=operator))
        pending = operator / 'uat-record-retirement.pending'
        pending_raw = json.dumps({'schema': 'UatRecordRetirementPendingV1',
                                 'retainedDirectory': destination.name,
                                 'intentSha256': expected_intent_sha256,
                                 'desiredSha256': expected_desired_sha256}).encode()
        parent = os.open(operator, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            # gate นี้อยู่ต่อเมื่อ rename/fsync/readback ล้ม และทุก writer ต้องปฏิเสธ
            fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(pending_raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.fsync(parent)
            journal = operator / 'uat-record-transaction'
            sync_private(journal / 'intent.json', expected_intent_sha256)
            sync_private(journal / 'desired.json', expected_desired_sha256)
            for name, expected in snapshots.items():
                if expected is not None:
                    sync_private(journal / name, expected)
            for name, raw in proof_files.items():
                sync_private(journal / name, JOURNAL.digest(raw))
            sync_directory(journal)
            deployments = root / 'deployments'
            sync_private(deployments / intent['archive'], expected_desired_sha256)
            sync_private(deployments / 'current.json', expected_desired_sha256)
            if expected_previous is not None:
                sync_private(deployments / 'previous.json', expected_previous)
            marker_sha = JOURNAL.digest((expected_desired_sha256 + '\n').encode())
            sync_private(deployments / (intent['archive'] + '.committed'), marker_sha)
            sync_directory(deployments)
            if (JOURNAL.inspect_locked(root) != state
                    or JOURNAL.read_private(operator / 'uat-record-transaction/intent.json') != intent_raw
                    or any(JOURNAL.read_private(journal / name) != raw for name, raw in proof_files.items())):
                raise RuntimeError('RETIRE_JOURNAL_CHANGED')
            os.rename(operator / 'uat-record-transaction', destination)
            os.fsync(parent)
            if (JOURNAL.digest(JOURNAL.read_private(destination / 'desired.json')) != expected_desired_sha256
                    or JOURNAL.read_private(destination / 'intent.json') != intent_raw):
                raise RuntimeError('RETIRE_READBACK_MISMATCH')
            for name, expected in snapshots.items():
                if JOURNAL.optional_digest(destination / name) != expected:
                    raise RuntimeError('RETIRE_READBACK_MISMATCH')
            if any(JOURNAL.read_private(destination / name) != raw for name, raw in proof_files.items()):
                raise RuntimeError('RETIRE_READBACK_MISMATCH')
            # ทุก record/snapshot/marker และ directory ที่เกี่ยวข้อง durable แล้ว
            # unlink เป็นจุดจบของ gate; crash หลังจุดนี้อาจทำให้ gate กลับมา แต่ข้อมูลครบ
            os.unlink(pending)
            cleanup_durable = True
            try:
                os.fsync(parent)
            except OSError:
                cleanup_durable = False
        finally:
            os.close(parent)
        return {'status': 'COMMITTED_JOURNAL_RETAINED', 'retainedDirectory': destination.name,
                'desiredSha256': expected_desired_sha256, 'pointersChanged': False,
                'cleanupDurable': cleanup_durable,
                'warning': None if cleanup_durable else 'RETIRE_GATE_REMOVAL_DURABILITY_UNKNOWN',
                'runtimeVerified': False, 'rollbackCertified': False}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/dcontact-uat'))
    parser.add_argument('--expected-desired-sha256', required=True)
    parser.add_argument('--expected-intent-sha256', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(retire(args.root, args.expected_desired_sha256, args.expected_intent_sha256), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, RuntimeError, JOURNAL.InvalidJournal):
        print(json.dumps({'status': 'RETIRE_FAILED', 'runtimeVerified': False, 'rollbackCertified': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
