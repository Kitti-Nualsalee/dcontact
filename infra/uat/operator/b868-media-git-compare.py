#!/usr/bin/env python3
"""เทียบ observation กับ Git tree แบบอ่านอย่างเดียว ไม่รับรอง provenance หรือ rollback."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

PREFIX = b'infra/uat/e1-freeswitch/'
MAX_BYTES = 8 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    command = ['git', '--no-replace-objects', '-C', str(repo), *args]
    deadline = time.monotonic() + 15
    with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as process:
        output = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise subprocess.TimeoutExpired(command, 15)
                    chunk = os.read(process.stdout.fileno(), min(65536, MAX_BYTES + 1 - len(output)))
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > MAX_BYTES:
                        raise ValueError('GIT_OUTPUT_TOO_LARGE')
            remaining = max(0, deadline - time.monotonic())
            code = process.wait(timeout=remaining)
            if code:
                raise subprocess.CalledProcessError(code, command)
            return bytes(output)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def compare(observation, repo, now=None):
    if (not isinstance(observation, dict) or observation.get('schema') != 'UatMediaObservationV1'
            or observation.get('status') != 'OBSERVED_NOT_CERTIFIED'
            or observation.get('rollbackCertified') is not False
            or observation.get('sourceProvenance') != 'RECORD_CLAIM_UNVERIFIED'):
        raise ValueError('OBSERVATION_INVALID')
    source, actual = observation.get('sourceSha'), observation.get('sourceDigest')
    if (not isinstance(source, str) or not re.fullmatch('[0-9a-f]{40}', source)
            or not isinstance(actual, str) or not re.fullmatch('[0-9a-f]{64}', actual)):
        raise ValueError('OBSERVATION_INVALID')
    timestamp = observation.get('observedAt')
    if not isinstance(timestamp, str) or not timestamp.endswith('Z'):
        raise ValueError('OBSERVATION_TIME_INVALID')
    observed_at = datetime.fromisoformat(timestamp[:-1] + '+00:00')
    age = ((now or datetime.now(timezone.utc)) - observed_at).total_seconds()
    if age < -30 or age > 300:
        raise ValueError('OBSERVATION_STALE')
    if git(repo, 'cat-file', '-t', source).strip() != b'commit':
        raise ValueError('COMMIT_REQUIRED')
    entries = [entry for entry in git(repo, 'ls-tree', '-rz', '--full-tree', source,
                                      '--', PREFIX.decode()).split(b'\0') if entry]
    if not 0 < len(entries) <= 128:
        raise ValueError('TREE_INVENTORY_INVALID')
    fingerprints = {}
    total = 0
    for entry in entries:
        metadata, path = entry.split(b'\t', 1)
        mode, kind, oid = metadata.split(b' ')
        if (mode not in (b'100644', b'100755') or kind != b'blob' or not path.startswith(PREFIX)
                or not re.fullmatch(b'[0-9a-f]{40}', oid)):
            raise ValueError('TREE_ENTRY_INVALID')
        name = path[len(PREFIX):].decode('utf-8')
        if not name or name in fingerprints:
            raise ValueError('TREE_ENTRY_INVALID')
        size = int(git(repo, 'cat-file', '-s', oid.decode()).strip())
        total += size
        if size < 0 or total > MAX_BYTES:
            raise ValueError('TREE_TOO_LARGE')
        blob = git(repo, 'cat-file', 'blob', oid.decode())
        if len(blob) != size:
            raise ValueError('GIT_BLOB_SIZE_MISMATCH')
        fingerprints[name] = sha(blob)
    expected = sha(json.dumps(fingerprints, sort_keys=True, separators=(',', ':')).encode())
    return {'schema': 'UatMediaGitComparisonV1', 'status': 'OBSERVED_NOT_CERTIFIED',
            'sourceSha': source, 'trackedFileCount': len(fingerprints),
            'gitTreeDigest': expected, 'observedTreeDigest': actual, 'treeMatchesGit': expected == actual,
            'observationSha256': sha(json.dumps(observation, sort_keys=True, separators=(',', ':')).encode()),
            'sourceProvenance': ('GIT_CONTENT_MATCH_ONLY_NOT_DEPLOYMENT_PROOF' if expected == actual
                                 else 'GIT_CONTENT_MISMATCH'), 'rollbackCertified': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError('OBSERVATION_TOO_LARGE')
        result = compare(json.loads(raw), args.repo)
    except (OSError, ValueError, TypeError, UnicodeError, subprocess.SubprocessError):
        print(json.dumps({'status': 'COMPARISON_FAILED', 'rollbackCertified': False}))
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
