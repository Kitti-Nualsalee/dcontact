#!/usr/bin/env python3
"""#901: authorization ใช้ครั้งเดียวให้ uat-deploy.sh deploy release ที่ migration เป็น additive ทับ deploy record ปกติ

ข้อยุติ owner วันที่ 13 พ.ย. 2569: release ที่ migration guard (UAT-M01) ผ่าน และ current เป็น deploy/rollback record
ปกติ ไม่ต้องซ้อม isolated API rollback แบบ #868 ทางย้อนกลับคือ deploy SHA เดิม เพราะ schema ที่เพิ่มแบบ additive
ไม่ทำให้ API เดิมพัง authorization ผูก candidate SHA, release.env, migration guard ของ release directory,
current/previous record bytes และอายุ window ภายใต้ lock เดียวกับ deploy เมื่อ record ของ candidate ถูกเขียน
current hash เปลี่ยน authorization จึงใช้ซ้ำไม่ได้ ไม่เปลี่ยน runtime, DB หรือ record และไม่รับรอง rollback
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
SCHEMA = 'UatAdditiveDeployAuthorizationV1'

spec = importlib.util.spec_from_file_location('forward_authorize', DIRECTORY / 'b868-forward-authorize.py')
FORWARD = importlib.util.module_from_spec(spec)
spec.loader.exec_module(FORWARD)
AUTHORIZATION = FORWARD.AUTHORIZATION
GATES = FORWARD.GATES
SHA = re.compile(r'[0-9a-f]{40}')


def read_release_file(path, limit=1048576):
    # ไฟล์ใน release directory ที่ deploy อ่านจริง (ไม่ใช่ secret จึงไม่บังคับ 0600 แต่ห้ามคนอื่นเขียน)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022
                or info.st_size > limit):
            raise RuntimeError('ADDITIVE_RELEASE_FILE_INVALID')
        return stream.read(limit + 1)


def validate_guard(raw, base, sha):
    guard = json.loads(raw)
    if (not isinstance(guard, dict) or (guard.get('type'), guard.get('mode'), guard.get('status'),
            guard.get('base'), guard.get('head')) != ('u1.uat.readiness', 'migration-guard', 'PASS', base, sha)):
        raise RuntimeError('ADDITIVE_MIGRATION_GUARD_INVALID')
    checks = guard.get('checks')
    if (not isinstance(checks, list) or len(checks) != 1 or not isinstance(checks[0], dict)
            or not str(checks[0].get('id', '')).startswith('UAT-M01 ') or checks[0].get('status') != 'PASS'
            or not isinstance(checks[0].get('added'), list)
            or not all(isinstance(path, str) and path.startswith('packages/db/prisma/migrations/')
                       for path in checks[0]['added'])):
        raise RuntimeError('ADDITIVE_MIGRATION_GUARD_INVALID')
    return checks[0]['added']


def authorize(root, sha, actor, window_minutes=FORWARD.WINDOW_DEFAULT, now=None):
    root = Path(root)
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise RuntimeError('ADDITIVE_TARGET_INVALID')
    if not isinstance(actor, str) or not re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', actor):
        raise RuntimeError('AUTHORIZE_ACTOR_REQUIRED')
    if type(window_minutes) is not int or not FORWARD.WINDOW_MIN <= window_minutes <= FORWARD.WINDOW_MAX:
        raise RuntimeError('AUTHORIZE_WINDOW_INVALID')
    clock = now or datetime.now(timezone.utc)
    release = root / 'releases' / sha
    release_env = read_release_file(release / 'release.env')
    package = FORWARD.CANDIDATE.parse_package(release_env)
    if package.get('SOURCE_SHA') != sha:
        raise RuntimeError('ADDITIVE_RELEASE_SHA_MISMATCH')
    guard_raw = read_release_file(release / 'migration-guard.json')

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
        current = FORWARD.read_private(root / 'deployments' / 'current.json')
        previous = FORWARD.read_private(root / 'deployments' / 'previous.json')
        record = json.loads(current)
        base = record.get('sourceSha')
        if (record.get('schema') != 'UatDeploymentRecordV1' or record.get('action') not in ('deploy', 'rollback')
                or not isinstance(base, str) or not SHA.fullmatch(base)):
            raise RuntimeError('ADDITIVE_DEPLOY_RECORD_CURRENT_REQUIRED')
        if base == sha:
            raise RuntimeError('ADDITIVE_TARGET_IS_CURRENT')
        added = validate_guard(guard_raw, base, sha)
        current_sha256 = hashlib.sha256(current).hexdigest()

        path = operator / AUTHORIZATION
        if os.path.lexists(path):
            existing = json.loads(FORWARD.read_private(path))
            try:
                expires = datetime.fromisoformat(str(existing.get('expiresAt', ''))[:-1] + '+00:00')
            except ValueError:
                expires = None
            if (existing.get('currentRecordSha256') == current_sha256 and existing.get('targetSha') == sha
                    and expires is not None and clock < expires):
                raise RuntimeError('AUTHORIZE_ACTIVE_AUTHORIZATION_EXISTS')
            retired = operator / ('uat-forward-deploy-retired-' + clock.strftime('%Y%m%dT%H%M%SZ') + '.json')
            if os.path.lexists(retired):
                raise RuntimeError('AUTHORIZE_RETIRED_NAME_EXISTS')
            os.rename(path, retired)
            FORWARD.sync_directory(operator)

        authorization = {
            'schema': SCHEMA, 'targetSha': sha, 'baseSha': base,
            'releaseEnvSha256': hashlib.sha256(release_env).hexdigest(),
            'migrationGuardSha256': hashlib.sha256(guard_raw).hexdigest(),
            'addedMigrations': added,
            'currentRecordSha256': current_sha256,
            'previousRecordSha256': hashlib.sha256(previous).hexdigest(),
            'actor': actor, 'authorizedAt': FORWARD.utc(clock),
            'expiresAt': FORWARD.utc(clock + timedelta(minutes=window_minutes)),
            'rollbackCertified': False,
        }
        data = json.dumps(authorization, sort_keys=True, separators=(',', ':')).encode()
        staging_fd, staging = tempfile.mkstemp(prefix='.uat-additive-', dir=operator)
        try:
            with os.fdopen(staging_fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(staging, path, follow_symlinks=False)
        finally:
            os.unlink(staging)
        FORWARD.sync_directory(operator)
        if FORWARD.read_private(path) != data:
            raise RuntimeError('AUTHORIZE_READBACK_MISMATCH')
        return {'status': 'ADDITIVE_DEPLOY_AUTHORIZED', 'targetSha': sha, 'baseSha': base,
                'addedMigrations': added, 'authorizationSha256': hashlib.sha256(data).hexdigest(),
                'currentRecordSha256': current_sha256, 'expiresAt': authorization['expiresAt'],
                'rollbackCertified': False}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(
        description='ออก authorization ให้ deploy release ที่ migration เป็น additive ทับ deploy record ปกติ')
    parser.add_argument('sha')
    parser.add_argument('--actor', required=True)
    parser.add_argument('--window-minutes', type=int, default=FORWARD.WINDOW_DEFAULT)
    args = parser.parse_args()
    try:
        result = authorize(ROOT, args.sha, args.actor, args.window_minutes)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError) as error:
        reason = str(error) if type(error) is RuntimeError else 'AUTHORIZE_INPUT_INVALID'
        print(json.dumps({'status': 'ADDITIVE_DEPLOY_REJECTED', 'reason': reason, 'rollbackCertified': False}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
