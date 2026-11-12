#!/usr/bin/env python3
"""กู้การเขียน record ไปข้างหน้าจาก intent/evidence ที่อนุมัติ; ไม่เปลี่ยน runtime."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
import types
import uuid

DIRECTORY = Path(__file__).resolve().parent
ROOT = Path('/opt/dcontact-uat')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ASSESSOR = load('b868_forward_assessor', 'b868-record-recovery-runtime.py')
OBSERVER = load('b868_forward_observer', 'release-evidence-observe.py')
JOURNAL, CANDIDATE = ASSESSOR.JOURNAL, ASSESSOR.CANDIDATE


def load_verified_code(name, path, expected_sha256):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o022 or info.st_size > 1048576):
            raise RuntimeError('FORWARD_HELPER_PERMISSIONS_INVALID')
        raw = stream.read(1048577)
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise RuntimeError('FORWARD_REVIEWED_HELPER_CHANGED')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    # execute bytes ที่ตรวจแล้ว ไม่เปิด path เดิมซ้ำหลังตรวจ hash
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def live_reader(root):
    if root != ROOT:
        raise RuntimeError('FORWARD_LIVE_ROOT_UNSUPPORTED')
    helper = load_verified_code('b868_verified_routing', OBSERVER.HELPER, OBSERVER.HELPER_SHA)
    collector = load_verified_code('b868_verified_collector', root / (
        'operator/b714-reconciliation-code-99af2e8c52b258bdcb41f608722f002a3ccea227/collector.py'),
        'e4cfb435cd13b4e3da75b56aed8c83e800d5a9f644c33201262a2b1608b622f6')
    values = {}
    for line in JOURNAL.read_private(root / 'uat.env').decode().splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('UAT_POSTGRES_USER', 'UAT_POSTGRES_PASSWORD'):
            values[key] = shlex.split(value, comments=True)[0]
    if values.get('UAT_POSTGRES_USER') != 'dcontact_uat_owner':
        raise RuntimeError('FORWARD_OWNER_SCOPE_REQUIRED')

    def read_ledger(query):
        relay = helper.inspect('dcontact-uat-db-relay-1')['NetworkSettings']['Networks']['dcontact-uat_internal']['IPAddress']
        name = 'b868-forward-ledger-' + uuid.uuid4().hex
        settings = dict(os.environ, PGPASSWORD=values['UAT_POSTGRES_PASSWORD'], PGCONNECT_TIMEOUT='5',
                        PGOPTIONS='-c statement_timeout=15000 -c lock_timeout=3000 -c default_transaction_read_only=on')
        settings.pop('PGSERVICE', None)
        settings.pop('PGSERVICEFILE', None)
        command = ['docker', 'run', '--rm', '--pull=never', '-i', '--name', name,
                   '--label', 'com.dcontact.rollback-probe=' + name, '--network', 'dcontact-uat_internal',
                   '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', '-e', 'PGCONNECT_TIMEOUT',
                   '--entrypoint', 'psql', helper.PG, '-h', relay, '-U', values['UAT_POSTGRES_USER'],
                   '-d', 'dcontact_uat', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
        return collector.probe_run(command, name, input=query.encode(), env=settings, timeout=30)

    def observe():
        return OBSERVER.observe(lambda: ASSESSOR.RUNTIME.inspect(root), helper.runtime_snapshot, read_ledger)
    return observe


def recover(root, approved_intent_sha256, evidence, approved_evidence_sha256, actor,
            *, observe_live=None, probe=None, execute=subprocess.run, now=None):
    root = Path(root)
    if not isinstance(actor, str) or not re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', actor):
        raise RuntimeError('FORWARD_ACTOR_REQUIRED')
    # hash ที่อนุมัติต้องมาจากการ review อิสระ ไม่อนุมาน approval จากไฟล์ evidence เอง
    evidence = json.loads(CANDIDATE.canonical(evidence))
    def check_time():
        return now() if callable(now) else now or datetime.now(timezone.utc)
    operator = root / 'operator'
    lock = operator / 'b714-cutover.lock'
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('FORWARD_LOCK_INVALID')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        named = os.lstat(lock)
        if not stat.S_ISREG(named.st_mode) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError('FORWARD_LOCK_INVALID')
        for name in ('uat-rollback.pending', 'uat-api-switch.pending', 'b714-reconciliation.pending',
                     'uat-record-retirement.pending'):
            if os.path.lexists(operator / name):
                raise RuntimeError('FORWARD_OTHER_TRANSACTION_PENDING')
        journal = operator / 'uat-record-transaction'
        state = JOURNAL.inspect_locked(root)
        intent_raw = JOURNAL.read_private(journal / 'intent.json')
        if JOURNAL.digest(intent_raw) != approved_intent_sha256:
            raise RuntimeError('FORWARD_APPROVED_INTENT_MISMATCH')
        desired = json.loads(JOURNAL.read_private(journal / 'desired.json'))
        if desired.get('action') != 'deploy':
            raise RuntimeError('FORWARD_DEPLOY_RECORD_ONLY')
        CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())
        assessment = ASSESSOR._assess_locked(root, probe, execute, evidence, check_time)
        uses_builtin_reader = observe_live is None
        observe_live = observe_live or live_reader(root)

        def check_live(after_commit=False):
            CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())
            live = observe_live()
            CANDIDATE.validate_unreviewed(live, check_time())
            if (live['ledger'] != evidence['ledger'] or live['protectedRuntime'] != evidence['protectedRuntime']
                    or live['runtime']['components'] != evidence['runtime']['components']):
                raise RuntimeError('FORWARD_LIVE_EVIDENCE_CHANGED')
            if not after_commit and live['runtime'] != evidence['runtime']:
                raise RuntimeError('FORWARD_LIVE_RECORDS_CHANGED')
            if after_commit and (live['runtime'].get('sourceMismatch') != []
                                 or live['runtime'].get('imageDigestMismatch') != []):
                raise RuntimeError('FORWARD_FINAL_RECORD_RUNTIME_MISMATCH')
            for name, item in live['runtime']['records'].items():
                if JOURNAL.optional_digest(root / 'deployments' / (name + '.json')) != item['sha256']:
                    raise RuntimeError('FORWARD_LIVE_RECORDS_CHANGED')
            CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())

        check_live()
        if (JOURNAL.inspect_locked(root) != state or JOURNAL.read_private(journal / 'intent.json') != intent_raw):
            raise RuntimeError('FORWARD_JOURNAL_CHANGED')
        request = CANDIDATE.canonical({'schema': 'UatForwardRecordRequestV1', 'actor': actor,
                    'decision': 'FORWARD_COMPLETE_RECORD_ONLY', 'intentSha256': approved_intent_sha256,
                    'evidenceSha256': approved_evidence_sha256, 'desiredSha256': state['desiredSha256'],
                    'requestedAt': check_time().isoformat()})
        request_fd, request_path = tempfile.mkstemp(prefix='forward-request-', suffix='.json', dir=journal)
        with os.fdopen(request_fd, 'wb') as stream:
            stream.write(request)
            stream.flush()
            os.fsync(stream.fileno())
        postcheck_pending = journal / 'forward-postcheck.pending'
        pending_raw = CANDIDATE.canonical({'schema': 'UatForwardPostcheckPendingV1',
                         'intentSha256': approved_intent_sha256, 'desiredSha256': state['desiredSha256']})
        if os.path.lexists(postcheck_pending):
            if JOURNAL.read_private(postcheck_pending) != pending_raw:
                raise RuntimeError('FORWARD_POSTCHECK_GATE_CHANGED')
        else:
            pending_fd = os.open(postcheck_pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(pending_fd, 'wb') as stream:
                stream.write(pending_raw)
                stream.flush()
                os.fsync(stream.fileno())
        journal_fd = os.open(journal, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(journal_fd)
        finally:
            os.close(journal_fd)
        CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())
        commit = load('b868_forward_commit', 'b868-record-commit.py')
        commit.complete_locked(root, approved_intent_sha256)
        check_live(after_commit=True)
        after = ASSESSOR._assess_locked(root, probe, execute)
        if after['opsObservationSha256'] != assessment['opsObservationSha256']:
            raise RuntimeError('FORWARD_OPS_CHANGED_AFTER_COMMIT')
        final = JOURNAL.inspect_locked(root)
        if final['current'] != 'desired' or not final['markerPresent']:
            raise RuntimeError('FORWARD_COMMIT_READBACK_FAILED')
        CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())
        postcheck = CANDIDATE.canonical({'schema': 'UatForwardPostcheckV1',
                    'status': 'MATCHED_LIVE_RECORD_EVIDENCE', 'intentSha256': approved_intent_sha256,
                    'desiredSha256': state['desiredSha256'], 'evidenceSha256': approved_evidence_sha256,
                    'request': Path(request_path).name, 'requestSha256': JOURNAL.digest(request),
                    'opsObservationSha256': after['opsObservationSha256'],
                    'ledgerSha256': JOURNAL.digest(CANDIDATE.canonical(evidence['ledger'])),
                    'protectedRuntimeSha256': evidence['protectedRuntimeSha256'],
                    'verifiedAt': check_time().isoformat(), 'rollbackCertified': False})
        postcheck_fd, postcheck_path = tempfile.mkstemp(prefix='.forward-postcheck-', dir=journal)
        with os.fdopen(postcheck_fd, 'wb') as stream:
            stream.write(postcheck)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(postcheck_path, journal / 'forward-postcheck.json')
        journal_fd = os.open(journal, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(journal_fd)
        finally:
            os.close(journal_fd)
        if JOURNAL.read_private(journal / 'forward-postcheck.json') != postcheck:
            raise RuntimeError('FORWARD_POSTCHECK_READBACK_FAILED')
        CANDIDATE.validate(evidence, approved_evidence_sha256, check_time())
        if JOURNAL.read_private(postcheck_pending) != pending_raw:
            raise RuntimeError('FORWARD_POSTCHECK_GATE_CHANGED')
        os.unlink(postcheck_pending)
        postcheck_cleanup_durable = True
        journal_fd = os.open(journal, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.fsync(journal_fd)
            except OSError:
                postcheck_cleanup_durable = False
        finally:
            os.close(journal_fd)
        return {'status': 'RECORD_TRANSACTION_COMMITTED_PENDING_RETIREMENT',
                'intentSha256': approved_intent_sha256, 'desiredSha256': state['desiredSha256'],
                'request': Path(request_path).name, 'retirementRequired': True,
                'postcheckGateCleanupDurable': postcheck_cleanup_durable,
                'applicationRuntimeMutated': False, 'applicationDataMutated': False,
                'transientReadOnlyProbeUsed': uses_builtin_reader,
                'probeCleanup': 'VERIFIED_BY_OWNED_COLLECTOR' if uses_builtin_reader else 'CALLER_LIVE_READER',
                'rollbackCertified': False}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--approved-evidence-sha256', required=True)
    parser.add_argument('--approved-intent-sha256', required=True)
    parser.add_argument('--actor', required=True)
    args = parser.parse_args()
    try:
        if (not args.evidence.is_absolute() or args.evidence.resolve() != args.evidence
                or ROOT / 'operator' not in args.evidence.parents):
            raise RuntimeError('FORWARD_EVIDENCE_PATH_INVALID')
        evidence = json.loads(JOURNAL.read_private(args.evidence))
        print(json.dumps(recover(ROOT, args.approved_intent_sha256, evidence,
                                 args.approved_evidence_sha256, args.actor), separators=(',', ':')))
        return 0
    except Exception:
        # อาจ commit ไปบางส่วนแล้ว: คง journal/gate และห้ามแสดง DB/helper stderr
        print(json.dumps({'status': 'FORWARD_RECOVERY_STOPPED_INSPECT_JOURNAL',
                          'mayHaveCommitted': True, 'rollbackCertified': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
