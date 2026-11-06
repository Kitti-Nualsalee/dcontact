#!/usr/bin/env python3
"""เก็บ journal ที่ commit ครบแล้วภายใต้ lock; ไม่ซ่อม pointer หรือรับรอง rollback."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile

SPEC = importlib.util.spec_from_file_location(
    'b868_journal_inspect', Path(__file__).with_name('b868-record-recovery-inspect.py'))
JOURNAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JOURNAL)


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
        state = JOURNAL.inspect_locked(root)
        intent_raw = JOURNAL.read_private(operator / 'uat-record-transaction/intent.json')
        if JOURNAL.digest(intent_raw) != expected_intent_sha256:
            raise RuntimeError('RETIRE_INTENT_CHANGED')
        intent = json.loads(intent_raw)
        if state['desiredSha256'] != expected_desired_sha256:
            raise RuntimeError('RETIRE_DESIRED_CHANGED')
        if not state['markerPresent'] or state['current'] != 'desired':
            raise RuntimeError('RETIRE_COMMITTED_TRANSACTION_REQUIRED')
        snapshots = intent['snapshots']
        expected_previous = snapshots['current.json'] if snapshots['current.json'] is not None else snapshots['previous.json']
        if JOURNAL.optional_digest(root / 'deployments/previous.json') != expected_previous:
            raise RuntimeError('RETIRE_PREVIOUS_NOT_COMMITTED')
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
            if (JOURNAL.inspect_locked(root) != state
                    or JOURNAL.read_private(operator / 'uat-record-transaction/intent.json') != intent_raw):
                raise RuntimeError('RETIRE_JOURNAL_CHANGED')
            os.rename(operator / 'uat-record-transaction', destination)
            os.fsync(parent)
            if (JOURNAL.digest(JOURNAL.read_private(destination / 'desired.json')) != expected_desired_sha256
                    or JOURNAL.read_private(destination / 'intent.json') != intent_raw):
                raise RuntimeError('RETIRE_READBACK_MISMATCH')
            for name, expected in snapshots.items():
                if JOURNAL.optional_digest(destination / name) != expected:
                    raise RuntimeError('RETIRE_READBACK_MISMATCH')
            os.unlink(pending)
            try:
                os.fsync(parent)
            except OSError:
                # หาก fsync การถอน gate ล้ม ต้องคืน gate ก่อนปล่อย lock
                fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(pending_raw)
                    stream.flush()
                raise
        finally:
            os.close(parent)
        return {'status': 'COMMITTED_JOURNAL_RETAINED', 'retainedDirectory': destination.name,
                'desiredSha256': expected_desired_sha256, 'pointersChanged': False,
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
