#!/usr/bin/env python3
"""เทียบ runtime กับ desired record ใน journal แบบอ่านอย่างเดียว ไม่อนุญาต recovery."""
from datetime import datetime, timezone
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path('/opt/dcontact-uat')
DIRECTORY = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


JOURNAL = load('b868_journal_inspect', 'b868-record-recovery-inspect.py')
RUNTIME = load('b868_runtime_inspect', 'release-record-inspect.py')
CANDIDATE = load('b868_candidate_validate', 'release-candidate-validate.py')


def assess(root=ROOT, probe=None, execute=subprocess.run, evidence=None, now=None):
    root = Path(root)
    lock_path = root / 'operator/b714-cutover.lock'
    fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('RECOVERY_LOCK_INVALID')
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        named = os.lstat(lock_path)
        if not stat.S_ISREG(named.st_mode) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError('RECOVERY_LOCK_INVALID')
        return _assess_locked(root, probe, execute, evidence, now)
    finally:
        os.close(fd)


def _assess_locked(root, probe=None, execute=subprocess.run, evidence=None, now=None):
    """ใช้ภายในขณะ caller ถือ lock เดียวกันตลอด shared/exclusive transaction."""
    root = Path(root)
    before = JOURNAL.inspect_locked(root)
    journal = root / 'operator/uat-record-transaction'
    raw = JOURNAL.read_private(journal / 'desired.json')
    desired = json.loads(raw)
    if (not isinstance(desired, dict) or desired.get('schema') != 'UatDeploymentRecordV1'
            or desired.get('action') not in ('deploy', 'rollback')
            or not re.fullmatch('[0-9a-f]{40}', str(desired.get('sourceSha', '')))):
        raise RuntimeError('RECOVERY_DESIRED_INVALID')
    images = desired.get('images')
    if (not isinstance(images, dict) or set(images) != {'api', 'console', 'ops', 'keycloak'}
            or any(not isinstance(ref, str) or not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', ref)
                   for ref in images.values())):
        raise RuntimeError('RECOVERY_IMAGES_INVALID')
    def observe():
        if probe is not None:
            return probe(root)
        return RUNTIME.inspect(root, execute=execute, allow_missing=True, fallback_current=desired)
    observed = observe()
    if not isinstance(observed, dict):
        raise RuntimeError('RECOVERY_RUNTIME_INVALID')
    components = observed.get('components')
    mapping = {'api': 'api', 'e1-sandbox': 'api', 'proxy': 'console', 'keycloak': 'keycloak'}
    if not isinstance(components, dict) or set(components) != set(mapping):
        raise RuntimeError('RECOVERY_COMPONENTS_INVALID')
    for name, key in mapping.items():
        item = components[name]
        if (not isinstance(item, dict) or item.get('running') is not True
                or item.get('sourceSha') != desired['sourceSha'] or item.get('imageReference') != images[key]
                or not isinstance(item.get('repositoryDigests'), list)
                or images[key] not in item.get('repositoryDigests', [])
                or not re.fullmatch('[0-9a-f]{64}', str(item.get('containerId', '')))
                or not re.fullmatch('sha256:[0-9a-f]{64}', str(item.get('imageId', '')))
                or not re.fullmatch('[0-9a-f]{64}', str(item.get('configSha256', '')))):
            raise RuntimeError('RECOVERY_RUNTIME_MISMATCH')
    def observe_ops():
        result = execute(['docker', 'image', 'inspect', images['ops']], check=True,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        rows = json.loads(result.stdout)
        if (not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)
                or not isinstance(rows[0].get('Config'), dict)
                or not isinstance(rows[0].get('RepoDigests'), list)
                or images['ops'] not in rows[0]['RepoDigests']
                or not isinstance(rows[0]['Config'].get('Labels'), dict)
                or rows[0]['Config']['Labels'].get('org.opencontainers.image.revision') != desired['sourceSha']
                or not re.fullmatch('sha256:[0-9a-f]{64}', str(rows[0].get('Id', '')))):
            raise RuntimeError('RECOVERY_OPS_MISMATCH')
        return {'id': rows[0]['Id'], 'reference': images['ops'], 'sourceSha': desired['sourceSha']}
    ops = observe_ops()
    after = JOURNAL.inspect_locked(root)
    if before != after or JOURNAL.read_private(journal / 'desired.json') != raw:
        raise RuntimeError('RECOVERY_JOURNAL_CHANGED')
    records = observed.get('records')
    if not isinstance(records, dict):
        raise RuntimeError('RECOVERY_RECORDS_INVALID')
    for name in ('current', 'previous'):
        item = records.get(name)
        path = root / 'deployments' / (name + '.json')
        actual = JOURNAL.optional_digest(path)
        if (actual is None and item is not None) or (actual is not None and
                (not isinstance(item, dict) or item.get('sha256') != actual)):
            raise RuntimeError('RECOVERY_RECORDS_CHANGED')
    if observe() != observed or JOURNAL.inspect_locked(root) != before or observe_ops() != ops:
        raise RuntimeError('RECOVERY_RUNTIME_CHANGED')
    evidence_status = 'NOT_SUPPLIED'
    evidence_sha = None
    if evidence is not None:
        if not isinstance(evidence, dict):
            raise RuntimeError('RECOVERY_EVIDENCE_INVALID')
        if any(records.get(name) is None for name in ('current', 'previous')):
            raise RuntimeError('RECOVERY_EVIDENCE_POINTERS_REQUIRED')
        def check_time():
            return now() if callable(now) else now or datetime.now(timezone.utc)
        CANDIDATE.validate_unreviewed(evidence, check_time())
        if evidence.get('runtime') != observed:
            raise RuntimeError('RECOVERY_EVIDENCE_RUNTIME_MISMATCH')
        if observe() != observed or JOURNAL.inspect_locked(root) != before or observe_ops() != ops:
            raise RuntimeError('RECOVERY_RUNTIME_CHANGED')
        CANDIDATE.validate_unreviewed(evidence, check_time())
        evidence_sha = hashlib.sha256(CANDIDATE.canonical(evidence)).hexdigest()
        evidence_status = 'CONSISTENT_NOT_REVIEWED_OR_CERTIFIED'
    digest = hashlib.sha256(json.dumps(observed, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'status': 'RUNTIME_MATCH_OBSERVED_NOT_CERTIFIED', 'desiredRecordSha256': before['desiredSha256'],
            'journalState': before, 'runtimeObservationSha256': digest,
            'opsObservationSha256': hashlib.sha256(CANDIDATE.canonical(ops)).hexdigest(),
            'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'suppliedEvidenceStatus': evidence_status, 'suppliedEvidenceSha256': evidence_sha,
            'ledgerVerified': False, 'protectedRuntimeVerified': False,
            'recoveryAuthorized': False, 'rollbackCertified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    try:
        evidence = None
        if args.evidence is not None:
            operator = ROOT / 'operator'
            if (not args.evidence.is_absolute() or args.evidence.resolve() != args.evidence
                    or operator not in args.evidence.parents):
                raise RuntimeError('RECOVERY_EVIDENCE_PATH_INVALID')
            evidence = json.loads(JOURNAL.read_private(args.evidence))
        print(json.dumps(assess(evidence=evidence), separators=(',', ':')))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, JOURNAL.InvalidJournal, subprocess.SubprocessError):
        print(json.dumps({'status': 'INSPECTION_FAILED', 'recoveryAuthorized': False, 'rollbackCertified': False}))
        sys.exit(1)
