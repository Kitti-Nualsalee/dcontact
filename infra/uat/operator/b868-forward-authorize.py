#!/usr/bin/env python3
"""#868: ออก authorization ใช้ครั้งเดียวให้ uat-deploy.sh deploy candidate ทับ current แบบ reconciliation

ตรวจหลักฐานด้วย `validate_api_rollback_rehearsal` เดียวกับ release-candidate-validate.py แล้วผูกกับ
current/previous record bytes, release.env ของ candidate ที่ prepare แล้ว และอายุ window ภายใต้ lock เดียวกับ deploy
เมื่อ record ของ candidate ถูกเขียน current hash เปลี่ยน authorization จึงใช้ซ้ำไม่ได้โดยโครงสร้าง
ไม่เปลี่ยน runtime, DB หรือ deployment record และไม่รับรอง rollback
"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

DIRECTORY = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('UAT_ROOT', '/opt/dcontact-uat'))
AUTHORIZATION = 'uat-forward-deploy.authorization'
SCHEMA = 'UatForwardDeployAuthorizationV1'
GATES = ('uat-rollback.pending', 'uat-api-switch.pending', 'b714-reconciliation.pending',
         'uat-record-transaction', 'uat-record-retirement.pending')
WINDOW_MIN, WINDOW_MAX, WINDOW_DEFAULT = 30, 480, 240

spec = importlib.util.spec_from_file_location('release_candidate_validate',
                                              DIRECTORY / 'release-candidate-validate.py')
CANDIDATE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CANDIDATE)


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_private(path, limit=8388608):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > limit):
            raise RuntimeError('AUTHORIZE_FILE_INVALID')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('AUTHORIZE_FILE_INVALID')
    return data


def read_release_env(path):
    # release.env ใน release directory เป็นไฟล์ที่ deploy อ่านจริง (ไม่ใช่ secret จึงไม่บังคับ 0600)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise RuntimeError('AUTHORIZE_RELEASE_ENV_INVALID')
        return stream.read(1048577)


def authorize(root, observation, approved_observation_sha256, rehearsal, approved_rehearsal_sha256,
              release_env, migration_guard, actor, window_minutes=WINDOW_DEFAULT, now=None):
    root = Path(root)
    if not isinstance(actor, str) or not re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', actor):
        raise RuntimeError('AUTHORIZE_ACTOR_REQUIRED')
    if type(window_minutes) is not int or not WINDOW_MIN <= window_minutes <= WINDOW_MAX:
        raise RuntimeError('AUTHORIZE_WINDOW_INVALID')
    clock = now or datetime.now(timezone.utc)
    validation = CANDIDATE.validate_api_rollback_rehearsal(
        observation, approved_observation_sha256, rehearsal, approved_rehearsal_sha256,
        release_env, migration_guard, clock)
    sha = validation['candidateSourceSha']
    prepared = read_release_env(root / 'releases' / sha / 'release.env')
    if prepared != release_env:
        raise RuntimeError('AUTHORIZE_PREPARED_RELEASE_MISMATCH')

    operator = root / 'operator'
    lock = operator / 'b714-cutover.lock'
    operator_info = os.lstat(operator)
    if (not stat.S_ISDIR(operator_info.st_mode) or operator_info.st_uid != os.geteuid()
            or operator_info.st_mode & 0o077):
        raise RuntimeError('AUTHORIZE_LOCK_INVALID')
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('AUTHORIZE_LOCK_INVALID')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('UAT_MUTATION_LOCK_BUSY') from None
        named = os.lstat(lock)
        if not stat.S_ISREG(named.st_mode) or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError('AUTHORIZE_LOCK_INVALID')
        for name in GATES:
            if os.path.lexists(operator / name):
                raise RuntimeError('AUTHORIZE_OTHER_TRANSACTION_PENDING')
        records = observation['runtime']['records']
        current = read_private(root / 'deployments' / 'current.json')
        previous = read_private(root / 'deployments' / 'previous.json')
        current_sha256 = hashlib.sha256(current).hexdigest()
        previous_sha256 = hashlib.sha256(previous).hexdigest()
        if (current_sha256, previous_sha256) != (records['current']['sha256'], records['previous']['sha256']):
            raise RuntimeError('AUTHORIZE_RECORDS_CHANGED')
        record = json.loads(current)
        if (record.get('schema'), record.get('action'), record.get('rollbackEligible')) != (
                'UatDeploymentReconciliationV1', 'reconciliation', False):
            raise RuntimeError('AUTHORIZE_RECONCILIATION_CURRENT_REQUIRED')

        path = operator / AUTHORIZATION
        if os.path.lexists(path):
            # authorization เดิมใช้ไม่ได้แล้วถ้า current เปลี่ยน; เก็บไว้เป็นประวัติแทนการลบ
            existing = json.loads(read_private(path))
            if existing.get('currentRecordSha256') == current_sha256:
                raise RuntimeError('AUTHORIZE_ACTIVE_AUTHORIZATION_EXISTS')
            retired = operator / ('uat-forward-deploy-retired-' + clock.strftime('%Y%m%dT%H%M%SZ') + '.json')
            if os.path.lexists(retired):
                raise RuntimeError('AUTHORIZE_RETIRED_NAME_EXISTS')
            os.rename(path, retired)
            sync_directory(operator)

        authorization = {
            'schema': SCHEMA, 'targetSha': sha,
            'releaseEnvSha256': hashlib.sha256(release_env).hexdigest(),
            'currentRecordSha256': current_sha256, 'previousRecordSha256': previous_sha256,
            'validation': validation, 'actor': actor,
            'authorizedAt': utc(clock), 'expiresAt': utc(clock + timedelta(minutes=window_minutes)),
            'rollbackCertified': False,
        }
        data = json.dumps(authorization, sort_keys=True, separators=(',', ':')).encode()
        staging_fd, staging = tempfile.mkstemp(prefix='.uat-forward-', dir=operator)
        try:
            with os.fdopen(staging_fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(staging, path, follow_symlinks=False)
        finally:
            os.unlink(staging)
        sync_directory(operator)
        if read_private(path) != data:
            raise RuntimeError('AUTHORIZE_READBACK_MISMATCH')
        return {'status': 'FORWARD_DEPLOY_AUTHORIZED', 'targetSha': sha,
                'authorizationSha256': hashlib.sha256(data).hexdigest(),
                'currentRecordSha256': current_sha256, 'expiresAt': authorization['expiresAt'],
                'rollbackEligible': False, 'rollbackCertified': False}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description='ออก authorization ให้ deploy candidate ทับ current แบบ reconciliation')
    parser.add_argument('--observation', required=True, type=Path)
    parser.add_argument('--approved-observation-sha256', required=True)
    parser.add_argument('--api-rehearsal', required=True, type=Path)
    parser.add_argument('--approved-rehearsal-sha256', required=True)
    parser.add_argument('--release-env', required=True, type=Path)
    parser.add_argument('--migration-guard', required=True, type=Path)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--window-minutes', type=int, default=WINDOW_DEFAULT)
    args = parser.parse_args()
    read = CANDIDATE.read_api_rollback_input
    try:
        result = authorize(ROOT, json.loads(read(args.observation)), args.approved_observation_sha256,
                           json.loads(read(args.api_rehearsal)), args.approved_rehearsal_sha256,
                           read(args.release_env), read(args.migration_guard), args.actor, args.window_minutes)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError) as error:
        reason = str(error) if type(error) is RuntimeError else 'AUTHORIZE_INPUT_INVALID'
        print(json.dumps({'status': 'FORWARD_DEPLOY_REJECTED', 'reason': reason,
                          'rollbackEligible': False, 'rollbackCertified': False}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
