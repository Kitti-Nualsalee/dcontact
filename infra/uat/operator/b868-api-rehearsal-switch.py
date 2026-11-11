#!/usr/bin/env python3
"""ซ้อมสลับ API และ recovery ใน Docker sandbox ของ #868."""

import argparse
import fcntl
import hashlib
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
import uuid


PROJECT = re.compile(r'dcontact-868-rehearsal-[a-f0-9]{8,32}')
IMAGE = re.compile(r'ghcr\.io/kitti-nualsalee/dcontact-uat-operator-api@sha256:[a-f0-9]{64}')
OWNER = 'com.dcontact.rehearsal'
COMPOSE_PROJECT = 'com.docker.compose.project'
STATE_ROOT = Path.home() / '.local/state/dcontact-868-rehearsal'
SMOKE = '''fetch('http://127.0.0.1:3000/api/v1/runtime-profile', {signal: AbortSignal.timeout(1500)})
  .then(async response => {
    const profile = await response.json();
    if (!response.ok || profile.profile !== 'uat-workspace' || profile.providerEgress !== 'BLOCKED')
      process.exitCode = 1;
  }).catch(() => { process.exitCode = 1; });'''


class RehearsalError(RuntimeError):
    pass


def docker_environment():
    return {name: value for name, value in os.environ.items() if not name.startswith('COMPOSE_')}


def docker(*args, timeout=20):
    result = subprocess.run(['docker', *args], text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, env=docker_environment())
    if result.returncode:
        raise RehearsalError('DOCKER_COMMAND_FAILED')
    return result.stdout


def docker_mutate(lock, *args, input=None, timeout=25):
    # ให้ Docker CLI ถือ lock ต่อหาก Python process ถูกขัดจังหวะระหว่าง mutation
    process = subprocess.Popen(['docker', *args], text=True, stdin=subprocess.PIPE if input else subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=docker_environment(),
                               pass_fds=(lock,), start_new_session=True)
    try:
        process.communicate(input, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise RehearsalError('DOCKER_MUTATION_TIMED_OUT') from None
    if process.returncode:
        raise RehearsalError('DOCKER_MUTATION_FAILED')


def inspect(command, identifier):
    [item] = json.loads(docker(command, 'inspect', identifier))
    return item


def image_info(reference):
    image = inspect('image', reference)
    source = (image['Config'].get('Labels') or {}).get('org.opencontainers.image.revision', '')
    if reference not in (image.get('RepoDigests') or []) or not re.fullmatch('[a-f0-9]{40}', source):
        raise RehearsalError('IMAGE_PROVENANCE_MISMATCH')
    return {'reference': reference, 'id': image['Id'], 'source': source}


def snapshot(project):
    api_name = project + '-api-1'
    database_name = project + '-db'
    network = inspect('network', project)
    if (network['Name'] != project or network['Driver'] != 'bridge' or not network['Internal']
            or (network.get('Labels') or {}).get(OWNER) != project):
        raise RehearsalError('SANDBOX_NETWORK_REQUIRED')

    database = inspect('container', database_name)
    networks = database['NetworkSettings']['Networks']
    if (database['Name'] != '/' + database_name or not database['State']['Running']
            or (database['Config'].get('Labels') or {}).get(OWNER) != project
            or set(networks) != {project} or networks[project]['NetworkID'] != network['Id']
            or 'rehearsal-db' not in (networks[project].get('Aliases') or [])
            or database['HostConfig'].get('PortBindings')):
        raise RehearsalError('SANDBOX_DATABASE_REQUIRED')

    containers = docker('container', 'ls', '-aq', '--no-trunc', '--filter',
                        f'label={COMPOSE_PROJECT}={project}').splitlines()
    by_name = docker('container', 'ls', '-aq', '--no-trunc', '--filter', f'name=^/{api_name}$').splitlines()
    if containers != by_name or len(containers) > 1:
        raise RehearsalError('SANDBOX_API_OWNERSHIP_MISMATCH')
    api = inspect('container', containers[0]) if containers else None
    if api:
        labels = api['Config'].get('Labels') or {}
        api_networks = api['NetworkSettings']['Networks']
        # Compose อาจทิ้ง container ที่ยังไม่ start ไว้หากคำสั่งถูกขัดจังหวะ
        if (api['Id'] != containers[0] or api['Name'] != '/' + api_name
                or labels.get(COMPOSE_PROJECT) != project or labels.get('com.docker.compose.service') != 'api'
                or labels.get(OWNER) != project or api['Mounts'] or api['HostConfig'].get('PortBindings')
                or api['HostConfig'].get('NetworkMode') != project or set(api_networks) - {project}
                or api['State']['Running'] and (project not in api_networks
                    or api_networks[project]['NetworkID'] != network['Id'])):
            raise RehearsalError('SANDBOX_API_OWNERSHIP_MISMATCH')
    allowed = {database['Id']} | set(containers)
    if set(network.get('Containers') or {}) - allowed:
        raise RehearsalError('SANDBOX_NETWORK_HAS_OTHER_CONTAINERS')
    protected = {'networkId': network['Id'], 'databaseId': database['Id'],
                 'databaseStartedAt': database['State']['StartedAt']}
    return protected, api


def compose_api(project, image, lock):
    secret = hashlib.sha256(project.encode()).hexdigest()
    compose = {'services': {'api': {
        'image': image['reference'], 'platform': 'linux/amd64', 'read_only': True,
        'command': ['node', 'dist/workspace-uat-main.js'], 'labels': {OWNER: project},
        'environment': {
            'DATABASE_URL': 'postgresql://dcontact_app:dcontact_app@rehearsal-db:5432/dcontact_868',
            'DCONTACT_API_PROFILE': 'uat-workspace', 'E1_VOICE_COMMAND_SECRET': secret,
            'E1_VOICE_TENANT_ID': '11111111-1111-4111-8111-111111111111',
            'KEYCLOAK_ISSUER': 'https://identity.invalid/auth/realms/rehearsal',
            'KEYCLOAK_AUDIENCE': 'dcontact-api',
            'KEYCLOAK_JWKS_URI': 'http://127.0.0.1:3100/certs',
            'DPHONE_EMBED_SCRIPT_URL': 'https://workspace.invalid/workspace/embed/dphone-embed.js',
            'OUTBOUND_VOICE_DELIVERY_ENABLED': 'false',
        },
    }}, 'networks': {'default': {'name': project, 'external': True}}}
    docker_mutate(lock, 'compose', '--project-name', project, '--env-file', '/dev/null', '-f', '-',
                  'up', '-d', '--no-deps', '--no-build', '--no-recreate', '--pull', 'never', 'api',
                  input=json.dumps(compose), timeout=60)


def replace_api(project, protected, api, image, lock):
    if snapshot(project) != (protected, api):
        raise RehearsalError('SANDBOX_CHANGED_BEFORE_SWITCH')
    # ลบเฉพาะ ID เดิมที่หยุดแล้ว ก่อน Compose สร้าง container ชื่อเดิม
    # recovery จึงอ่านสถานะได้แม้ขัดจังหวะระหว่าง stop, remove และ start
    if api is not None:
        identifier = api['Id']
        if api['State']['Running']:
            docker_mutate(lock, 'stop', '--time', '15', identifier)
        live_protected, stopped = snapshot(project)
        if (live_protected != protected or stopped is None or stopped['Id'] != identifier
                or stopped['State']['Status'] not in ('exited', 'created') or stopped['State']['Running']):
            raise RehearsalError('SANDBOX_API_STOP_NOT_CONFIRMED')
        docker_mutate(lock, 'container', 'rm', identifier)
    if snapshot(project) != (protected, None):
        raise RehearsalError('SANDBOX_API_REMOVAL_NOT_CONFIRMED')
    compose_api(project, image, lock)


def matches(api, image):
    return (api is not None and api['Config']['Image'] == image['reference'] and api['Image'] == image['id']
            and (api['Config'].get('Labels') or {}).get('org.opencontainers.image.revision') == image['source'])


def healthy(api, image):
    if not matches(api, image) or not api['State']['Running']:
        return False
    try:
        docker('exec', api['Id'], 'node', '-e', SMOKE, timeout=4)
    except (RehearsalError, subprocess.TimeoutExpired):
        return False
    return True


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def require_private(info, kind):
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise RehearsalError('UNSAFE_STATE_PATH')


def read_pending(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'rb') as stream:
        require_private(os.fstat(stream.fileno()), stat.S_ISREG)
        data = stream.read(16385)
    if len(data) > 16384:
        raise RehearsalError('INVALID_PENDING')
    pending = json.loads(data)
    if not isinstance(pending, dict):
        raise RehearsalError('INVALID_PENDING')
    return pending


def write_state(path, data, *, replace=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.api-switch-', delete=False) as stream:
        staging = Path(stream.name)
        try:
            stream.write(json.dumps(data, sort_keys=True).encode())
            stream.flush()
            os.fsync(stream.fileno())
            if replace:
                os.replace(staging, path)
            else:
                os.link(staging, path)
            sync_directory(path.parent)
        finally:
            if staging.exists():
                staging.unlink()


def switch(project, action, candidate_ref, target_ref, state_root=STATE_ROOT):
    if (not PROJECT.fullmatch(project) or not IMAGE.fullmatch(candidate_ref)
            or not IMAGE.fullmatch(target_ref) or candidate_ref == target_ref):
        raise RehearsalError('SANDBOX_PROJECT_AND_DISTINCT_PINNED_IMAGES_REQUIRED')
    directory = state_root / project
    state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require_private(state_root.lstat(), stat.S_ISDIR)
    directory.mkdir(mode=0o700, exist_ok=True)
    require_private(directory.lstat(), stat.S_ISDIR)
    sync_directory(state_root)
    lock = os.open(directory / 'lock', os.O_CREAT | os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock, 'rb') as stream:
        require_private(os.fstat(lock), stat.S_ISREG)
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not os.path.samestat(os.fstat(lock), (directory / 'lock').lstat()):
            raise RehearsalError('UNSAFE_STATE_PATH')
        return switch_locked(project, action, candidate_ref, target_ref, directory / 'pending.json', lock)


def switch_locked(project, action, candidate_ref, target_ref, pending_path, lock):
    candidate, target = image_info(candidate_ref), image_info(target_ref)
    if candidate['source'] == target['source'] or candidate['id'] == target['id']:
        raise RehearsalError('SANDBOX_REHEARSAL_REQUIRES_TWO_RELEASES')
    protected, api = snapshot(project)
    pending = read_pending(pending_path)
    intent = {'schema': 'UatSandboxApiSwitchPendingV1', 'project': project,
              'protected': protected, 'candidate': candidate, 'target': target}

    if action == 'recover':
        transaction = (pending or {}).get('transactionId', '')
        rollback_api_id = (pending or {}).get('rollbackApiId')
        stopping_api_id = (pending or {}).get('stoppingApiId', '')
        if (not isinstance(transaction, str) or not re.fullmatch('[a-f0-9]{32}', transaction)
                or not isinstance(stopping_api_id, str) or not re.fullmatch('[a-f0-9]{64}', stopping_api_id)
                or rollback_api_id is not None and (not isinstance(rollback_api_id, str)
                                                    or not re.fullmatch('[a-f0-9]{64}', rollback_api_id))
                or pending != {**intent, 'transactionId': transaction, 'rollbackApiId': rollback_api_id,
                               'stoppingApiId': stopping_api_id}):
            raise RehearsalError('RECOVERY_INTENT_MISSING_OR_SANDBOX_CHANGED')
        intent = pending
        if api is not None and not (matches(api, candidate) or matches(api, target)):
            raise RehearsalError('RECOVERY_API_CHANGED')
    else:
        if pending is not None:
            raise RehearsalError('RECOVERY_PENDING')
        if action == 'start' and api is not None and not matches(api, candidate):
            raise RehearsalError('START_API_CHANGED')
        if action == 'rollback':
            if not healthy(api, candidate):
                raise RehearsalError('ROLLBACK_CANDIDATE_NOT_HEALTHY')
            intent = {**intent, 'transactionId': uuid.uuid4().hex, 'rollbackApiId': None,
                      'stoppingApiId': api['Id']}
            write_state(pending_path, intent)

    wanted = target if action == 'rollback' else candidate
    if action == 'start':
        should_switch = api is None
    else:
        # Docker Engine อาจยังทำ stop ต่อหลัง CLI timeout แม้ container จะยังตอบ smoke
        stop_may_be_pending = action == 'recover' and api is not None and api['Id'] == intent['stoppingApiId']
        should_switch = stop_may_be_pending or not healthy(api, wanted)
    if should_switch:
        if action == 'recover' and api is not None:
            intent = {**intent, 'stoppingApiId': api['Id']}
            write_state(pending_path, intent, replace=True)
        replace_api(project, protected, api, wanted, lock)
    for attempt in range(20):
        live_protected, live_api = snapshot(project)
        if live_protected != protected:
            raise RehearsalError('SANDBOX_DATABASE_OR_NETWORK_CHANGED')
        if (healthy(live_api, wanted)
                and (action == 'start' or live_api['Id'] != intent['stoppingApiId'])):
            if snapshot(project) != (protected, live_api):
                raise RehearsalError('SANDBOX_CHANGED_AFTER_SMOKE')
            if action == 'rollback':
                write_state(pending_path, {**intent, 'rollbackApiId': live_api['Id']}, replace=True)
            elif action == 'recover':
                write_state(pending_path.with_name('recovery.json'),
                            {**intent, 'schema': 'UatSandboxApiRecoveryV1', 'recoveredApiId': live_api['Id'], 'smoke': 'uat-workspace',
                             'rollbackCertified': False}, replace=True)
                pending_path.unlink()
                sync_directory(pending_path.parent)
            return {'status': 'SANDBOX_API_SMOKE_PASSED', 'action': action, 'sourceSha': wanted['source'],
                    'recoveryPending': action == 'rollback', 'rollbackCertified': False}
        if attempt < 19:
            time.sleep(1)
    raise RehearsalError('SANDBOX_API_SMOKE_FAILED')


def main():
    parser = argparse.ArgumentParser(description='สลับ API รุ่นเดิมและ recovery ใน Docker sandbox ของ #868')
    parser.add_argument('action', choices=('start', 'rollback', 'recover'))
    parser.add_argument('--project', required=True)
    parser.add_argument('--candidate-image', required=True)
    parser.add_argument('--target-image', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(switch(args.project, args.action, args.candidate_image, args.target_image)))
    except BlockingIOError:
        sys.exit('SANDBOX_REHEARSAL_BUSY')
    except RehearsalError as error:
        sys.exit(str(error))
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        sys.exit('SANDBOX_REHEARSAL_FAILED')


if __name__ == '__main__':
    main()
