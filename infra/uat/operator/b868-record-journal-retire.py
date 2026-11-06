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


def retire(root, expected_desired_sha256):
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
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending'):
            if os.path.lexists(operator / name):
                raise RuntimeError('OTHER_TRANSACTION_PENDING')
        state = JOURNAL.inspect_locked(root)
        if state['desiredSha256'] != expected_desired_sha256:
            raise RuntimeError('RETIRE_DESIRED_CHANGED')
        if not state['markerPresent'] or state['current'] != 'desired':
            raise RuntimeError('RETIRE_COMMITTED_TRANSACTION_REQUIRED')
        # rename เก็บ intent/snapshots ทั้ง directory: ไม่ลบหลักฐาน ไม่แตะ deployment pointer
        destination = Path(tempfile.mkdtemp(prefix='uat-record-completed-', dir=operator))
        try:
            if JOURNAL.inspect_locked(root) != state:
                raise RuntimeError('RETIRE_JOURNAL_CHANGED')
            os.rename(operator / 'uat-record-transaction', destination)
        except BaseException:
            destination.rmdir()
            raise
        parent = os.open(operator, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        if JOURNAL.digest(JOURNAL.read_private(destination / 'desired.json')) != expected_desired_sha256:
            raise RuntimeError('RETIRE_READBACK_MISMATCH')
        return {'status': 'COMMITTED_JOURNAL_RETAINED', 'retainedDirectory': destination.name,
                'desiredSha256': expected_desired_sha256, 'pointersChanged': False,
                'runtimeVerified': False, 'rollbackCertified': False}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/dcontact-uat'))
    parser.add_argument('--expected-desired-sha256', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(retire(args.root, args.expected_desired_sha256), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, RuntimeError, JOURNAL.InvalidJournal):
        print(json.dumps({'status': 'RETIRE_FAILED', 'runtimeVerified': False, 'rollbackCertified': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
