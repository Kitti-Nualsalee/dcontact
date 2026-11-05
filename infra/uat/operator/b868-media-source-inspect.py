#!/usr/bin/env python3
"""ตรวจ media source และ mount แบบอ่านอย่างเดียว โดยไม่รับรอง rollback."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from datetime import datetime, timezone

ROOT = Path('/opt/dcontact-uat')
CONTAINER = 'dcontact-uat-freeswitch-1'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def read_file(path, limit, owner=True):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_size > limit
                or (owner and (info.st_uid != os.geteuid() or info.st_mode & 0o077))):
            raise RuntimeError('MEDIA_INPUT_INVALID')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError('MEDIA_INPUT_TOO_LARGE')
        return data


def tree_digest(tree, expected_identity=None):
    if not tree.is_absolute():
        raise RuntimeError('MEDIA_TREE_INVALID')
    fingerprints = {}
    total = 0
    count = 0
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in tree.parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if expected_identity is not None and (info.st_dev, info.st_ino) != expected_identity:
            raise RuntimeError('MEDIA_TREE_IDENTITY_MISMATCH')
        def walk_error(error):
            raise error
        for directory, dirs, files, directory_fd in os.fwalk('.', dir_fd=fd, follow_symlinks=False, onerror=walk_error):
            for name in dirs + files:
                count += 1
                if count > 128:
                    raise RuntimeError('MEDIA_TREE_INVALID')
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                    raise RuntimeError('MEDIA_TREE_INVALID')
                if stat.S_ISREG(info.st_mode):
                    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    with os.fdopen(file_fd, 'rb') as stream:
                        opened = os.fstat(stream.fileno())
                        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise RuntimeError('MEDIA_TREE_INVALID')
                        total += opened.st_size
                        if total > 8 * 1024 * 1024:
                            raise RuntimeError('MEDIA_TREE_TOO_LARGE')
                        data = stream.read(8 * 1024 * 1024 + 1)
                        if len(data) > 8 * 1024 * 1024:
                            raise RuntimeError('MEDIA_TREE_TOO_LARGE')
                    relative = str(Path(directory) / name)
                    fingerprints[relative] = sha(data)
    finally:
        os.close(fd)
    if not fingerprints:
        raise RuntimeError('MEDIA_TREE_INVALID')
    return sha(canonical(fingerprints))


def inspect(root=ROOT, execute=subprocess.run):
    root = Path(root)
    lock_path = root / 'operator/b714-cutover.lock'
    fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid() or opened.st_mode & 0o077:
            raise RuntimeError('MEDIA_LOCK_INVALID')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        named = os.lstat(lock_path)
        if not stat.S_ISREG(named.st_mode) or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError('MEDIA_LOCK_INVALID')
        if any(os.path.lexists(root / 'operator' / name) for name in
               ('uat-record-transaction', 'uat-rollback.pending', 'b714-reconciliation.pending')):
            raise RuntimeError('MEDIA_TRANSACTION_PENDING')
        record_path = root / 'deployments/current.json'
        raw = read_file(record_path, 8 * 1024 * 1024)
        record = json.loads(raw)
        if not isinstance(record, dict) or record.get('schema') != 'UatDeploymentReconciliationV1':
            raise RuntimeError('MEDIA_RECORD_INVALID')
        source = record.get('mediaSourceSha')
        expected = record.get('mediaSourceDigest')
        if not isinstance(source, str) or not re.fullmatch('[0-9a-f]{40}', source):
            raise RuntimeError('MEDIA_SOURCE_INVALID')
        if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
            raise RuntimeError('MEDIA_DIGEST_INVALID')
        tree = root / 'releases' / source / 'e1-freeswitch'

        def observe():
            result = execute(['docker', 'inspect', CONTAINER], check=True, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=20)
            rows = json.loads(result.stdout)
            if not isinstance(rows, list) or len(rows) != 1:
                raise RuntimeError('MEDIA_CONTAINER_INVALID')
            container = rows[0]
            labels = container.get('Config', {}).get('Labels') or {}
            if (container.get('Name') != '/' + CONTAINER or container.get('State', {}).get('Running') is not True
                    or labels.get('com.docker.compose.project') != 'dcontact-uat'
                    or not re.fullmatch('[0-9a-f]{64}', str(container.get('Id', '')))
                    or not re.fullmatch('sha256:[0-9a-f]{64}', str(container.get('Image', '')))):
                raise RuntimeError('MEDIA_CONTAINER_INVALID')
            mounts = [m for m in container.get('Mounts', []) if m.get('Destination') == '/e1-freeswitch']
            if len(mounts) != 1 or mounts[0].get('Source') != str(tree) or mounts[0].get('RW') is not False:
                raise RuntimeError('MEDIA_MOUNT_MISMATCH')
            if any(isinstance(m.get('Destination'), str) and m['Destination'].startswith('/e1-freeswitch/')
                   for m in container.get('Mounts', [])):
                raise RuntimeError('MEDIA_NESTED_MOUNT_UNSUPPORTED')
            host_info = os.stat(tree, follow_symlinks=False)
            if not stat.S_ISDIR(host_info.st_mode):
                raise RuntimeError('MEDIA_TREE_INVALID')
            inside = execute(['docker', 'exec', CONTAINER, 'stat', '-Lc', '%d:%i', '/e1-freeswitch'],
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
            if inside.stdout.strip().decode('ascii') != f'{host_info.st_dev}:{host_info.st_ino}':
                raise RuntimeError('MEDIA_MOUNT_IDENTITY_MISMATCH')
            config = {key: container[key] for key in ('Config', 'HostConfig', 'Mounts')}
            return {'containerId': container['Id'], 'imageId': container['Image'],
                    'configSha256': sha(canonical(config)), 'startedAt': container['State'].get('StartedAt'),
                    '_treeIdentity': (host_info.st_dev, host_info.st_ino)}

        first = observe()
        first_digest = tree_digest(tree, first['_treeIdentity'])
        second_digest = tree_digest(tree, first['_treeIdentity'])
        second = observe()
        if first != second or first_digest != second_digest or read_file(record_path, 8 * 1024 * 1024) != raw:
            raise RuntimeError('MEDIA_CHANGED_DURING_INSPECTION')
        if first_digest != expected:
            raise RuntimeError('MEDIA_DIGEST_MISMATCH')
        del first['_treeIdentity']
        return {'schema': 'UatMediaObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
                'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'currentRecordSha256': sha(raw), 'sourceSha': source, 'sourceDigest': first_digest,
                'sourceProvenance': 'RECORD_CLAIM_UNVERIFIED', **first, 'rollbackCertified': False}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(), sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit('MEDIA_INSPECTION_FAILED') from None
