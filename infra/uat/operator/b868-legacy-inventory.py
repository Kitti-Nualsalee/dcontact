#!/usr/bin/env python3
"""สำรวจ release record รุ่นเดิมแบบอ่านอย่างเดียว; ไม่รับรอง provenance หรือ rollback."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat


class InventoryError(Exception):
    pass


def read_private(path, limit=8388608):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > limit):
            raise InventoryError('INVALID_FILE')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise InventoryError('INVALID_FILE')
        return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect(root):
    operator, deployments = root / 'operator', root / 'deployments'
    for directory in (root, operator, deployments):
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise InventoryError('INVALID_DIRECTORY')
    lock_path = operator / 'b714-cutover.lock'
    lock = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(lock)
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid() or opened.st_mode & 0o077:
            raise InventoryError('INVALID_LOCK')
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        named = os.lstat(lock_path)
        if not stat.S_ISREG(named.st_mode) or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise InventoryError('INVALID_LOCK')
        if any(os.path.lexists(operator / name) for name in
               ('uat-record-transaction', 'uat-rollback.pending', 'b714-reconciliation.pending')):
            raise InventoryError('TRANSACTION_PENDING')
        pointers = {}
        for name in ('current', 'previous'):
            path = deployments / (name + '.json')
            pointers[name] = sha(read_private(path)) if os.path.lexists(path) else None
        rows = []
        paths = sorted(deployments.glob('*-*.json'))
        if len(paths) > 10000:
            raise InventoryError('TOO_MANY_ARCHIVES')
        for path in paths:
            raw = read_private(path)
            record = json.loads(raw)
            if not isinstance(record, dict):
                raise InventoryError('INVALID_RECORD')
            source = record.get('sourceSha')
            if not isinstance(source, str) or not re.fullmatch('[0-9a-f]{40}', source):
                raise InventoryError('INVALID_SOURCE')
            raw_hash = sha(raw)
            marker_path = Path(str(path) + '.committed')
            if not os.path.lexists(marker_path):
                marker = 'UNMARKED'
            else:
                marker = ('MATCH' if read_private(marker_path, 65) == (raw_hash + '\n').encode()
                          else 'MISMATCH')
            schema = record.get('schema')
            action = record.get('action')
            if schema not in ('UatDeploymentRecordV1', 'UatDeploymentReconciliationV1'):
                schema = 'UNKNOWN'
            if action not in ('deploy', 'rollback', 'reconciliation'):
                action = 'UNKNOWN'
            rows.append({'sha256': raw_hash, 'sourceSha': source, 'schema': schema,
                         'action': action, 'marker': marker,
                         'matchesCurrent': raw_hash == pointers['current'],
                         'matchesPrevious': raw_hash == pointers['previous'],
                         'provenance': 'UNVERIFIED', 'rollbackCertified': False})
        return {'status': 'INSPECTED', 'archives': rows, 'pointerSha256': pointers,
                'runtimeVerified': False, 'rollbackCertified': False}
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/dcontact-uat'))
    args = parser.parse_args()
    try:
        result = inspect(args.root)
    except (OSError, ValueError, TypeError, InventoryError):
        result = {'status': 'INVALID_OR_BUSY', 'runtimeVerified': False, 'rollbackCertified': False}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['status'] == 'INSPECTED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
