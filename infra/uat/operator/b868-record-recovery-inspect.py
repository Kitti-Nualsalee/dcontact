#!/usr/bin/env python3
"""ตรวจ journal release record แบบอ่านอย่างเดียว; ไม่ตัดสินใจแก้หรือรับรอง runtime."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat


class InvalidJournal(Exception):
    pass


def read_private(path, limit=8388608):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > limit):
            raise InvalidJournal('INVALID_FILE')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise InvalidJournal('INVALID_FILE')
        return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def optional_digest(path):
    if not os.path.lexists(path):
        return None
    return digest(read_private(path))


def inspect_locked(root):
    operator = root / 'operator'
    journal = operator / 'uat-record-transaction'
    for directory in (root, operator, journal, root / 'deployments'):
        info = os.lstat(directory)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077):
            raise InvalidJournal('INVALID_DIRECTORY')
    intent = json.loads(read_private(journal / 'intent.json'))
    if not isinstance(intent, dict) or intent.get('schema') != 'UatRecordIntentV1':
        raise InvalidJournal('INVALID_INTENT')
    archive = intent.get('archive')
    if not isinstance(archive, str) or not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[0-9a-f]{40}\.json', archive):
        raise InvalidJournal('INVALID_ARCHIVE_NAME')
    desired = read_private(journal / 'desired.json')
    desired_sha = digest(desired)
    if desired_sha != intent.get('desiredSha256'):
        raise InvalidJournal('DESIRED_MISMATCH')
    expected = intent.get('snapshots')
    if not isinstance(expected, dict) or set(expected) != {'current.json', 'previous.json'}:
        raise InvalidJournal('INVALID_SNAPSHOTS')
    for name, wanted in expected.items():
        saved = optional_digest(journal / name)
        if saved != wanted or (wanted is not None and not re.fullmatch(r'[0-9a-f]{64}', wanted)):
            raise InvalidJournal('SNAPSHOT_MISMATCH')
    deployments = root / 'deployments'
    live = {name: optional_digest(deployments / name) for name in expected}
    archive_path = deployments / archive
    archive_sha = optional_digest(archive_path)
    marker_path = Path(str(archive_path) + '.committed')
    marker = read_private(marker_path, 65).decode('ascii') if os.path.lexists(marker_path) else None
    if archive_sha not in (None, desired_sha) or marker not in (None, desired_sha + '\n'):
        raise InvalidJournal('ARCHIVE_MISMATCH')
    if live['current.json'] not in (expected['current.json'], desired_sha):
        raise InvalidJournal('CURRENT_CHANGED')
    if live['previous.json'] not in (expected['previous.json'], expected['current.json']):
        raise InvalidJournal('PREVIOUS_CHANGED')
    original = (expected['current.json'], expected['previous.json'])
    previous_after = expected['current.json'] if expected['current.json'] is not None else expected['previous.json']
    allowed = {original, (expected['current.json'], previous_after), (desired_sha, previous_after)}
    if (live['current.json'], live['previous.json']) not in allowed:
        raise InvalidJournal('IMPOSSIBLE_POINTER_STATE')
    if marker is not None and (archive_sha is None or live['current.json'] != desired_sha):
        raise InvalidJournal('IMPOSSIBLE_COMMIT_STATE')
    if archive_sha is None and (live['current.json'] != expected['current.json']
                                or live['previous.json'] != expected['previous.json']):
        raise InvalidJournal('IMPOSSIBLE_POINTER_STATE')
    return {
        'status': 'INSPECTED', 'desiredSha256': desired_sha,
        'current': 'desired' if live['current.json'] == desired_sha else 'original',
        'previous': 'original' if live['previous.json'] == expected['previous.json'] else 'current-before',
        'archivePresent': archive_sha is not None, 'markerPresent': marker is not None,
        'runtimeVerified': False, 'recoveryAuthorized': False,
    }


def inspect(root):
    lock = root / 'operator' / 'b714-cutover.lock'
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise InvalidJournal('INVALID_LOCK')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        named = os.lstat(lock)
        if (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or not stat.S_ISREG(named.st_mode):
            raise InvalidJournal('INVALID_LOCK')
        return inspect_locked(root)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/dcontact-uat'))
    args = parser.parse_args()
    try:
        result = inspect(args.root)
    except (OSError, ValueError, TypeError, UnicodeError, InvalidJournal):
        result = {'status': 'INVALID_OR_INCOMPLETE', 'runtimeVerified': False, 'recoveryAuthorized': False}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['status'] == 'INSPECTED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
