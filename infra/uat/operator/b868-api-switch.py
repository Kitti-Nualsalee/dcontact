#!/usr/bin/env python3
"""#868: สลับเฉพาะ image ของ Compose service `api` บน VM2 ระหว่าง candidate (current record) กับ target (previous record)

- `plan` อ่านอย่างเดียว: ตรวจ records, runtime, effective config และ target image ในเครื่อง
- `rollback` candidate → target: ต้องได้ fence ผ่าน proxy, People DRAINED หลัง settle, identity CONSISTENT,
  ledger และ protected state สด แล้วเขียน `operator/uat-api-switch.pending` ก่อนแตะ container
- `recover` target → candidate: อ่าน pending, กลับ config เดิมของ release, ตรวจ runtime ตรง current record,
  smoke ผ่าน proxy, fence/drain/identity/ledger/protected แล้วเขียน receipt ก่อนถอน pending

ใช้ Compose project และไฟล์เดียวกับ uat-deploy.sh (`compose-argv`) และ override เฉพาะ `services.api.image`
ถือ lock เดียวกับ deploy ตลอดคำสั่ง pending ทำให้ uat-deploy.sh ปฏิเสธ deploy/record จน recover
ไม่ migrate, ไม่ restore DB, ไม่เขียน deployment record และไม่รับรอง rollback
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

DIRECTORY = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('UAT_ROOT', '/opt/dcontact-uat'))
API_CONTAINER = 'dcontact-uat-api-1'
PENDING = 'uat-api-switch.pending'
OVERRIDE = 'uat-api-switch.override.json'
RECEIPTS = 'uat-api-switch-receipts'
GATES = ('uat-rollback.pending', 'b714-reconciliation.pending', 'uat-record-transaction',
         'uat-record-retirement.pending')
DIGEST_REF = re.compile(r'[^\s@]+@sha256:[0-9a-f]{64}')
SOURCE = re.compile(r'[0-9a-f]{40}')
SMOKE_PATH = '/api/v1/runtime-profile'
SMOKE_ATTEMPTS = 30


class SwitchError(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise SwitchError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


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
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077
                and info.st_size <= limit, 'SWITCH_FILE_INVALID')
        return stream.read(limit)


def write_private(path, data, *, replace=False):
    descriptor, staging = tempfile.mkstemp(prefix='.uat-api-switch-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(staging, path)
        else:
            os.link(staging, path, follow_symlinks=False)
    finally:
        if os.path.lexists(staging):
            os.unlink(staging)
    sync_directory(path.parent)
    require(read_private(path) == data, 'SWITCH_READBACK_MISMATCH')


def api_identity(record, release_api):
    """target อาจเป็น reconciliation record แบบราย component หรือ deploy record ปกติ"""
    components = record.get('components')
    if isinstance(components, dict):
        api = components.get('api') or {}
        identity = {'sha': api.get('sourceSha'), 'imageReference': api.get('imageReference'),
                    'imageId': api.get('imageId')}
    else:
        identity = {'sha': record.get('sourceSha'), 'imageReference': (record.get('images') or {}).get('api'),
                    'imageId': None}
    require(isinstance(identity['sha'], str) and SOURCE.fullmatch(identity['sha'])
            and isinstance(identity['imageReference'], str) and DIGEST_REF.fullmatch(identity['imageReference']),
            'SWITCH_RECORD_API_INVALID')
    if release_api is not None:
        require(identity['imageReference'] == release_api, 'SWITCH_CANDIDATE_RELEASE_MISMATCH')
    return identity


def read_records(root):
    raw = {name: read_private(root / 'deployments' / (name + '.json')) for name in ('current', 'previous')}
    current, previous = json.loads(raw['current']), json.loads(raw['previous'])
    require((current.get('schema'), current.get('action')) == ('UatDeploymentRecordV1', 'deploy'),
            'SWITCH_CURRENT_DEPLOY_RECORD_REQUIRED')
    sha = current.get('sourceSha')
    require(isinstance(sha, str) and SOURCE.fullmatch(sha), 'SWITCH_CURRENT_DEPLOY_RECORD_REQUIRED')
    release = root / 'releases' / sha / 'release.env'
    values = {}
    try:
        lines = release.read_text().splitlines()
    except FileNotFoundError:
        raise SwitchError('SWITCH_CANDIDATE_RELEASE_MISMATCH') from None
    for line in lines:
        key, separator, value = line.partition('=')
        if separator:
            values[key] = value
    require(values.get('SOURCE_SHA') == sha, 'SWITCH_CANDIDATE_RELEASE_MISMATCH')
    candidate = api_identity(current, values.get('API_IMAGE'))
    target = api_identity(previous, None)
    require(candidate['sha'] != target['sha']
            and candidate['imageReference'].rsplit('@', 1)[1] != target['imageReference'].rsplit('@', 1)[1],
            'SWITCH_REQUIRES_TWO_RELEASES')
    return {'candidate': candidate, 'target': target,
            'currentRecordSha256': hashlib.sha256(raw['current']).hexdigest(),
            'previousRecordSha256': hashlib.sha256(raw['previous']).hexdigest()}


def effective_config(deps, records):
    """override ต้องเปลี่ยนเฉพาะ services.api.image; hash เท่านั้นที่ออกจาก process เพราะ config มีค่า secret"""
    base = deps.config(None)
    switched = deps.config(records['target']['imageReference'])
    require(base['services']['api'].get('image') == records['candidate']['imageReference'],
            'SWITCH_BASE_CONFIG_NOT_CANDIDATE')
    require(switched['services']['api'].get('image') == records['target']['imageReference'],
            'SWITCH_OVERRIDE_NOT_APPLIED')
    stripped = json.loads(canonical(switched))
    stripped['services']['api']['image'] = base['services']['api']['image']
    require(stripped == base, 'SWITCH_OVERRIDE_CHANGES_MORE_THAN_API_IMAGE')
    return {'baseSha256': digest(base), 'overrideSha256': digest(switched)}


def runtime_matches_current(inspection):
    return inspection.get('sourceMismatch') == [] and inspection.get('imageDigestMismatch') == []


def api_state(container, identity):
    if container is None:
        return 'ABSENT'
    image = container.get('Image')
    expected = identity.get('imageId')
    labels = (container.get('Config') or {}).get('Labels') or {}
    if (container['Config'].get('Image') != identity['imageReference']
            or labels.get('org.opencontainers.image.revision') != identity['sha']
            or (expected is not None and image != expected)):
        return 'OTHER'
    state = container.get('State') or {}
    if not state.get('Running') or (state.get('Health') or {}).get('Status', 'healthy') != 'healthy':
        return 'NOT_READY'
    return 'RUNNING'


def protected_without_api(inspection, protected):
    components = {name: {key: item.get(key) for key in ('containerId', 'imageId', 'startedAt')}
                  for name, item in inspection['components'].items() if name != 'api'}
    return {'components': components, 'protected': protected}


def ledger_fingerprint(ledger):
    require((ledger.get('database'), ledger.get('principal'), ledger.get('readonly')) == (
        'dcontact_uat', 'dcontact_uat_owner', 'on'), 'SWITCH_LEDGER_SCOPE_REQUIRED')
    require(ledger.get('unresolved') == 0 and isinstance(ledger.get('migrations'), list), 'SWITCH_LEDGER_UNRESOLVED')
    return digest({'finished': ledger.get('finished'), 'migrations': ledger['migrations']})


def gates_clear(root, allow_switch=False):
    operator = root / 'operator'
    for name in GATES + (() if allow_switch else (PENDING,)):
        require(not os.path.lexists(operator / name), 'SWITCH_OTHER_TRANSACTION_PENDING')


def smoke_through_proxy(deps):
    """proxy ต้องส่ง runtime-profile ของ workspace และ fence ต้องยังปฏิเสธ People mutations"""
    for attempt in range(SMOKE_ATTEMPTS):
        result = deps.smoke()
        fence = deps.probe()
        if (result.get('httpStatus') == 200 and result.get('profile') == 'uat-workspace'
                and result.get('providerEgress') == 'BLOCKED' and fence.get('status') == 'FENCE_ACTIVE'):
            return {'smoke': result, 'fence': fence}
        if attempt < SMOKE_ATTEMPTS - 1:
            deps.sleep(2)
    raise SwitchError('SWITCH_PROXY_SMOKE_FAILED')


def wait_for_api(deps, identity, previous_id):
    for attempt in range(SMOKE_ATTEMPTS):
        container = deps.api()
        if api_state(container, identity) == 'RUNNING' and container['Id'] != previous_id:
            return container
        if attempt < SMOKE_ATTEMPTS - 1:
            deps.sleep(2)
    raise SwitchError('SWITCH_API_NOT_READY')


def plan(root, deps):
    gates_clear(root)
    records = read_records(root)
    inspection = deps.inspect()
    require(runtime_matches_current(inspection), 'SWITCH_RUNTIME_NOT_CURRENT_RECORD')
    require(api_state(deps.api(), records['candidate']) == 'RUNNING', 'SWITCH_CANDIDATE_NOT_RUNNING')
    target = deps.image(records['target']['imageReference'])
    require(records['target']['imageReference'] in (target.get('RepoDigests') or [])
            and ((target.get('Config') or {}).get('Labels') or {}).get('org.opencontainers.image.revision')
            == records['target']['sha']
            and (records['target']['imageId'] in (None, target.get('Id'))), 'SWITCH_TARGET_IMAGE_NOT_LOCAL')
    records['target'] = {**records['target'], 'imageId': target['Id']}
    config = effective_config(deps, records)
    return {'status': 'API_SWITCH_PLAN_READY', 'records': records, 'effectiveConfig': config,
            'rollbackCertified': False}


def rollback(root, deps, settle):
    prepared = plan(root, deps)
    records = prepared['records']
    fence = deps.probe()
    require(fence.get('status') == 'FENCE_ACTIVE', 'SWITCH_FENCE_NOT_ACTIVE')
    drain = deps.drain(settle)
    require(drain.get('status') == 'DRAINED', 'SWITCH_PEOPLE_NOT_DRAINED')
    identity = deps.identity()
    require(identity.get('status') == 'CONSISTENT', 'SWITCH_IDENTITY_NOT_CONSISTENT')
    inspection = deps.inspect()
    require(runtime_matches_current(inspection), 'SWITCH_RUNTIME_NOT_CURRENT_RECORD')
    candidate_api = deps.api()
    require(api_state(candidate_api, records['candidate']) == 'RUNNING', 'SWITCH_CANDIDATE_NOT_RUNNING')
    require(identity['runtime']['api']['containerId'] == candidate_api['Id'], 'SWITCH_IDENTITY_RUNTIME_CHANGED')
    require(read_records(root)['currentRecordSha256'] == records['currentRecordSha256'], 'SWITCH_RECORDS_CHANGED')
    pending = {
        'schema': 'UatApiSwitchPendingV1', 'transactionId': uuid.uuid4().hex, 'phase': 'ROLLBACK_STARTED',
        'startedAt': utc_now(), **records, 'effectiveConfig': prepared['effectiveConfig'],
        'ledgerSha256': ledger_fingerprint(deps.ledger()),
        'protectedSha256': digest(protected_without_api(inspection, deps.protected())),
        'candidateApiId': candidate_api['Id'], 'stoppingApiId': candidate_api['Id'], 'rollbackApiId': None,
        'evidence': {'fence': fence, 'drainSha256': digest(drain),
                     'identitySha256': digest(identity), 'identityStatus': identity['status']},
        'rollbackCertified': False,
    }
    operator = root / 'operator'
    write_private(operator / PENDING, canonical(pending))
    write_private(operator / OVERRIDE, canonical({'services': {'api': {'image': records['target']['imageReference']}}}),
                  replace=True)
    deps.up(records['target']['imageReference'])
    target_api = wait_for_api(deps, records['target'], candidate_api['Id'])
    proxy = smoke_through_proxy(deps)
    after = deps.inspect()
    require(digest(protected_without_api(after, deps.protected())) == pending['protectedSha256'],
            'SWITCH_PROTECTED_STATE_CHANGED')
    require(ledger_fingerprint(deps.ledger()) == pending['ledgerSha256'], 'SWITCH_LEDGER_CHANGED')
    held = deps.drain(None)
    require(held.get('status') == 'DRAINED', 'SWITCH_PEOPLE_NOT_DRAINED')
    pending = {**pending, 'phase': 'TARGET_RUNNING', 'rollbackApiId': target_api['Id'],
               'targetSmoke': proxy, 'targetDrainSha256': digest(held)}
    write_private(operator / PENDING, canonical(pending), replace=True)
    return {'status': 'API_SWITCH_TARGET_SMOKE_PASSED', 'transactionId': pending['transactionId'],
            'sourceSha': records['target']['sha'], 'recoveryPending': True, 'rollbackCertified': False}


def recover(root, deps):
    gates_clear(root, allow_switch=True)
    operator = root / 'operator'
    pending = json.loads(read_private(operator / PENDING))
    require(pending.get('schema') == 'UatApiSwitchPendingV1'
            and re.fullmatch('[0-9a-f]{32}', str(pending.get('transactionId', '')))
            and pending.get('phase') in ('ROLLBACK_STARTED', 'TARGET_RUNNING', 'RECOVERY_STARTED'),
            'SWITCH_PENDING_INVALID')
    records = read_records(root)
    for key in ('currentRecordSha256', 'previousRecordSha256'):
        require(records[key] == pending[key], 'SWITCH_RECORDS_CHANGED')
    candidate = pending['candidate']
    require(records['candidate'] == {**candidate, 'imageId': records['candidate']['imageId']}, 'SWITCH_RECORDS_CHANGED')
    container = deps.api()
    state = api_state(container, candidate)
    require(state != 'OTHER' or api_state(container, pending['target']) != 'OTHER', 'SWITCH_RECOVERY_API_CHANGED')
    # container candidate เดิมที่ถูกสั่ง stop อาจยังตอบอยู่ระหว่าง Docker หยุด จึงต้องสร้างใหม่ทุกครั้งที่ ID ตรง stopping
    needs_switch = state != 'RUNNING' or container['Id'] == pending['stoppingApiId']
    previous_id = container['Id'] if container is not None else None
    if needs_switch:
        pending = {**pending, 'phase': 'RECOVERY_STARTED', 'stoppingApiId': previous_id or pending['stoppingApiId']}
        write_private(operator / PENDING, canonical(pending), replace=True)
        deps.up(None)
    recovered = wait_for_api(deps, candidate, pending['stoppingApiId'] if needs_switch else None)
    inspection = deps.inspect()
    require(runtime_matches_current(inspection), 'SWITCH_RUNTIME_NOT_CURRENT_RECORD')
    require(effective_config(deps, {**records, 'target': pending['target']}) == pending['effectiveConfig'],
            'SWITCH_EFFECTIVE_CONFIG_CHANGED')
    require(digest(protected_without_api(inspection, deps.protected())) == pending['protectedSha256'],
            'SWITCH_PROTECTED_STATE_CHANGED')
    require(ledger_fingerprint(deps.ledger()) == pending['ledgerSha256'], 'SWITCH_LEDGER_CHANGED')
    proxy = smoke_through_proxy(deps)
    drain = deps.drain(None)
    require(drain.get('status') == 'DRAINED', 'SWITCH_PEOPLE_NOT_DRAINED')
    identity = deps.identity()
    require(identity.get('status') == 'CONSISTENT', 'SWITCH_IDENTITY_NOT_CONSISTENT')
    require(identity['runtime']['api']['containerId'] == recovered['Id'], 'SWITCH_IDENTITY_RUNTIME_CHANGED')
    receipt = {**pending, 'schema': 'UatApiSwitchReceiptV1', 'phase': 'RECOVERED', 'recoveredAt': utc_now(),
               'recoveredApiId': recovered['Id'], 'recoverySmoke': proxy, 'recoveryDrainSha256': digest(drain),
               'recoveryIdentitySha256': digest(identity), 'rollbackCertified': False}
    directory = operator / RECEIPTS
    if not directory.exists():
        directory.mkdir(mode=0o700)
        sync_directory(operator)
    info = os.lstat(directory)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
            'SWITCH_FILE_INVALID')
    data = canonical(receipt)
    write_private(directory / (pending['transactionId'] + '.json'), data)
    if os.path.lexists(operator / OVERRIDE):
        os.unlink(operator / OVERRIDE)
    os.unlink(operator / PENDING)
    sync_directory(operator)
    return {'status': 'API_SWITCH_RECOVERED', 'transactionId': pending['transactionId'],
            'sourceSha': candidate['sha'], 'receiptSha256': hashlib.sha256(data).hexdigest(),
            'recoveryPending': False, 'rollbackCertified': False}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def docker_environment():
    return {name: value for name, value in os.environ.items() if not name.startswith('COMPOSE_')}


class LiveDeps:
    """ผูกกับ VM2 จริง; ทุก mutation ส่ง lock fd ให้ Docker CLI ถือต่อแม้ Python ถูกขัดจังหวะ"""

    def __init__(self, root, base_url, lock):
        require(re.fullmatch(r'https://[A-Za-z0-9.-]+(:[0-9]{1,5})?', base_url or ''), 'SWITCH_BASE_URL_INVALID')
        self.root, self.base_url, self.lock = root, base_url, lock
        self.inspector = load_module('release_inspector', DIRECTORY / 'release-record-inspect.py')
        self.drainer = load_module('people_drain', DIRECTORY / 'b868-people-drain-observe.py')
        self.identity_observer = load_module('identity_observe', DIRECTORY / 'b868-identity-evidence-observe.py')
        evidence = load_module('release_evidence', DIRECTORY / 'release-evidence-observe.py')
        require(hashlib.sha256(evidence.HELPER.read_bytes()).hexdigest() == evidence.HELPER_SHA,
                'REVIEWED_HELPER_CHANGED')
        self.evidence = evidence
        self.helper = load_module('reviewed_helper', evidence.HELPER)
        self.read = self.helper.database()
        self.sha = read_records(root)['candidate']['sha']
        script = root / 'releases' / self.sha / 'bin' / 'uat-deploy.sh'
        output = subprocess.run(['bash', str(script), 'compose-argv', self.sha], check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
        self.prefix = json.loads(output.stdout)
        require(isinstance(self.prefix, list) and all(isinstance(item, str) for item in self.prefix),
                'SWITCH_COMPOSE_ARGV_INVALID')
        self.sleep = time.sleep

    def compose_files(self, target):
        return self.prefix + (['-f', str(self.root / 'operator' / OVERRIDE)] if target else [])

    def config(self, target):
        if target:
            # config อ่าน override ชั่วคราวในไฟล์แยกเพื่อไม่แตะไฟล์ที่ recovery ใช้
            with tempfile.NamedTemporaryFile(dir=self.root / 'operator', prefix='.uat-api-switch-plan-',
                                             suffix='.json') as stream:
                stream.write(canonical({'services': {'api': {'image': target}}}))
                stream.flush()
                command = self.prefix + ['-f', stream.name, 'config', '--format', 'json']
                output = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        timeout=60, env=docker_environment())
        else:
            output = subprocess.run(self.prefix + ['config', '--format', 'json'], check=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=60, env=docker_environment())
        return json.loads(output.stdout)

    def up(self, target):
        # recover ใช้ --force-recreate เพราะ container candidate ที่ถูก stop ค้างมี config เดียวกับ release
        command = self.compose_files(target) + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                                                '--force-recreate', 'api']
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=docker_environment(), pass_fds=(self.lock,),
                                   start_new_session=True)
        try:
            process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise SwitchError('SWITCH_COMPOSE_TIMED_OUT') from None
        require(process.returncode == 0, 'SWITCH_COMPOSE_FAILED')

    def inspect(self):
        return self.inspector.inspect(self.root)

    def api(self):
        result = subprocess.run(['docker', 'inspect', API_CONTAINER], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=20)
        if result.returncode:
            return None
        [container] = json.loads(result.stdout)
        return container

    def image(self, reference):
        output = subprocess.run(['docker', 'image', 'inspect', reference], check=True, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=20)
        [image] = json.loads(output.stdout)
        return image

    def ledger(self):
        return json.loads(self.read(self.evidence.QUERY))

    def protected(self):
        return self.helper.runtime_snapshot()

    def drain(self, settle):
        if settle is None:
            return self.drainer.observe_drain(self.read, self.drainer.FENCE_FILE.is_file())
        return self.drainer.observe_settled(self.read, self.drainer.FENCE_FILE.is_file, settle)

    def identity(self):
        return self.identity_observer.observe(lambda: self.identity_observer.components(self.inspect()))

    def probe(self):
        return self.drainer.probe(self.base_url)

    def smoke(self):
        try:
            response = urllib.request.urlopen(self.base_url + SMOKE_PATH, timeout=10)
            status, body = response.status, response.read(16384)
        except urllib.error.HTTPError as error:
            status, body = error.code, b''
        except (urllib.error.URLError, OSError):
            return {'httpStatus': None}
        try:
            payload = json.loads(body)
        except ValueError:
            payload = {}
        return {'httpStatus': status, 'profile': payload.get('profile'),
                'providerEgress': payload.get('providerEgress')}


def with_lock(root, action):
    operator = root / 'operator'
    info = os.lstat(operator)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
            'SWITCH_LOCK_INVALID')
    lock = operator / 'b714-cutover.lock'
    descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode) and opened.st_uid == os.geteuid() and not opened.st_mode & 0o077,
                'SWITCH_LOCK_INVALID')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SwitchError('UAT_MUTATION_LOCK_BUSY') from None
        named = os.lstat(lock)
        require((opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino), 'SWITCH_LOCK_INVALID')
        return action(descriptor)
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description='สลับ image ของ API บน VM2 ระหว่าง candidate กับ target (#868)')
    parser.add_argument('action', choices=('plan', 'rollback', 'recover'))
    parser.add_argument('--base-url', required=True, help='https://<uat-host> ผ่าน proxy')
    parser.add_argument('--settle', type=int, default=180)
    args = parser.parse_args()

    def run(lock):
        deps = LiveDeps(ROOT, args.base_url, lock)
        if args.action == 'plan':
            return plan(ROOT, deps)
        if args.action == 'rollback':
            return rollback(ROOT, deps, args.settle)
        return recover(ROOT, deps)
    try:
        result = with_lock(ROOT, run)
    except SwitchError as error:
        print(json.dumps({'status': 'API_SWITCH_REJECTED', 'reason': str(error), 'rollbackCertified': False}))
        return 1
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError, RuntimeError):
        print(json.dumps({'status': 'API_SWITCH_FAILED', 'reason': 'SWITCH_UNEXPECTED_FAILURE',
                          'rollbackCertified': False}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
