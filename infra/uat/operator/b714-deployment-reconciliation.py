#!/usr/bin/env python3
"""#714: ตรวจหลักฐานและ reconcile record เท่านั้น ไม่ deploy หรือแก้ฐานข้อมูล."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import uuid

ROOT = Path('/opt/dcontact-uat')
SOURCE = 'a4e41ff8dbec5a78bbe9d4a7164a5e8f2bba7f64'
HISTORICAL = '158c8ccec29e37bd51ac1fe26676b8cf3123d7be'
PUBLIC_MEDIA = Path('/var/lib/dcontact-uat-e1-media/state.json')
BACKUPS = {'application': ('dcontact_uat.dump', 'f928bcb6a7dea52e8267fda9bfa9aa87108f5f9b2c5abc4be673137879c3d565'),
           'keycloak': ('keycloak_uat.dump', 'e7734993c847d05b4f02672b26e517629f15d2d33cfe01fd42b3db180c5b6e23')}
STATIC_PROOFS = {'cutover': 'cf586f2af8636c15a9bbbb889129467d68332e0d74f04062925fffcc7635e563',
                 'applicationCopy': 'a57ef38c805b214395dce2f01f2cb431aefef941d5e0745282eeadeb2bf08943',
                 'keycloakCopy': '3dc37389915ae01505ecf116114ccefb994de8d6b03c21c27c2817818b70e2e1',
                 'rollbackGuard': '46ed0521ff53573c19b4f55a513dbba07f1759a136bc6b44f13183be562b3a1f'}
APPROVED_REFS = {
    'api': 'ghcr.io/kitti-nualsalee/dcontact-uat-operator-api@sha256:414e2041609b34d0b6edc070cf8059d0c4c5409d486e3cdb3a51a43e707551d3',
    'ops': 'ghcr.io/kitti-nualsalee/dcontact-uat-operator-ops@sha256:a305e37d6763370cfae2ee752febcab34821d42c85c760cae0937f10192a9bfa',
    'keycloak': 'ghcr.io/kitti-nualsalee/dcontact-uat-operator-keycloak@sha256:fe32867078123e786370564725b3f8d09a48d7d5bc80113600bb1507dcba2aa5',
}
IMAGES = {
    'api': 'sha256:f7630180919287bd566ca9be6ad5c2d8da3ae70d016f2543333d5680a6a03e00',
    'e1-sandbox': 'sha256:f7630180919287bd566ca9be6ad5c2d8da3ae70d016f2543333d5680a6a03e00',
    'proxy': 'sha256:624a0721cf08ad7b107742ede8ac9f5adc5c39f0686c5411976a262d1d79ada3',
    'keycloak': 'sha256:30ab47ab0529843c83912765aa8ceebde550c9f24f89ad9de9bb1c22cf383290',
}
PROTECTED = ['dcontact-platform-uat-platform-api-1', 'dcontact-platform-uat-platform-worker-1',
             'dcontact-platform-uat-platform-console-1', 'dcontact-uat-freeswitch-1',
             'dcontact-platform-uat-mailpit-1']
LEDGER_QUERY = """SELECT json_build_object('database',current_database(),'principal',current_user,
'readOnly',current_setting('transaction_read_only'),
'rows',(SELECT json_agg(json_build_object('id',id,'name',migration_name,'checksum',checksum,
'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY id)
FROM public._prisma_migrations));"""


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def read(path, private=True):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'SYMLINK_OR_RELATIVE_PATH')
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 8388608, 'INPUT_FILE_REQUIRED')
        public_media = path == PUBLIC_MEDIA
        require(not public_media or (info.st_uid == 0 and info.st_mode & 0o022 == 0), 'PUBLIC_MEDIA_ROOT_OWNERSHIP')
        if public_media:
            for parent in path.parents:
                metadata = parent.stat()
                require(metadata.st_uid == 0 and metadata.st_mode & 0o022 == 0,
                        'PUBLIC_MEDIA_PARENT_OWNERSHIP')
        if not private:
            require(info.st_uid in [0, os.geteuid()] and info.st_mode & 0o022 == 0, 'MEDIA_SOURCE_FILE_OWNERSHIP')
        require(not private or public_media or (info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) & 0o077 == 0),
                'PRIVATE_OPERATOR_INPUT_REQUIRED')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            return stream.read(8388609)
    finally:
        os.close(descriptor)


def evidence(reference, parse=True):
    require(isinstance(reference, dict) and set(reference) == {'path', 'sha256'}, 'EVIDENCE_REFERENCE')
    require(re.fullmatch('[0-9a-f]{64}', reference['sha256']), 'EVIDENCE_HASH')
    raw = read(reference['path'])
    require(sha(raw) == reference['sha256'], 'EVIDENCE_CHANGED')
    return json.loads(raw) if parse else raw


def media_digest(path):
    require(path.is_absolute() and path.resolve() == path and path.is_dir(), 'MEDIA_DIRECTORY_REQUIRED')
    require(path.name == 'e1-freeswitch' and path.parent.name in [HISTORICAL, SOURCE] and
            path.parent.parent.name == 'releases', 'EXACT_MEDIA_RELEASE_SUBTREE')
    files = sorted(path.rglob('*'))
    require(0 < len(files) <= 128 and not any(item.is_symlink() for item in files), 'MEDIA_SOURCE_INVENTORY')
    return sha(canonical({str(item.relative_to(path)): sha(read(item, False)) for item in files if item.is_file()}))


def instant(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC_TIMESTAMP_REQUIRED')
    return datetime.fromisoformat(value[:-1] + '+00:00')


def fresh(value, now):
    require(-30 <= (now - instant(value)).total_seconds() <= 300, 'OBSERVATION_STALE_OR_FUTURE')


def prepare(manifest, now=None):
    now = now or datetime.now(timezone.utc)
    require(manifest.get('schema') == 'B714ReconciliationInputV1', 'INPUT_SCHEMA')
    for kind, expected in STATIC_PROOFS.items():
        require(manifest[kind]['sha256'] == expected, 'EXACT_REVIEWED_PROOF_REQUIRED')
        evidence(manifest[kind])
    historical = evidence(manifest['historical'])
    require(Path(manifest['historical']['path']).name not in ['current.json', 'previous.json'],
            'IMMUTABLE_HISTORY_INPUT_REQUIRED')
    require(historical.get('schema') == 'UatDeploymentRecordV1' and
            historical.get('sourceSha') == HISTORICAL and historical.get('action') in ['deploy', 'rollback'],
            'HISTORICAL_158_RECORD_REQUIRED')
    require(re.fullmatch('sha256:[0-9a-f]{64}', historical.get('realmConfigDigest', '')),
            'HISTORICAL_REALM_PROVENANCE_REQUIRED')
    require(manifest['expectedCurrentSha256'] == manifest['historical']['sha256'], 'CURRENT_HISTORY_BINDING')
    release_raw = evidence(manifest['release'], False).decode()
    release = {}
    for line in release_raw.splitlines():
        if '=' in line and not line.startswith('#'):
            name, value = line.split('=', 1)
            require(name not in release, 'DUPLICATE_RELEASE_KEY')
            release[name] = value
    require(release.get('SOURCE_SHA') == SOURCE, 'CANDIDATE_RELEASE_SOURCE')
    images = {name: release.get(key) for name, key in [
        ('api', 'API_IMAGE'), ('console', 'CONSOLE_IMAGE'), ('ops', 'OPS_IMAGE'), ('keycloak', 'KEYCLOAK_IMAGE')]}
    require(all(isinstance(value, str) and re.fullmatch('[a-z0-9./:_-]+@sha256:[0-9a-f]{64}', value)
                for value in images.values()), 'RELEASE_DIGESTS_REQUIRED')
    require(all(images[key] == reference for key, reference in APPROVED_REFS.items()), 'APPROVED_CANDIDATE_DIGESTS')
    runtime, ledger, smoke = [evidence(manifest[key]) for key in ['runtime', 'ledger', 'smoke']]
    cutover = evidence(manifest['cutover'])
    require(cutover.get('status') == 'CANDIDATE_STARTED_PLATFORM_ORIGINAL_TRIAL_NOT_EVALUATED',
            'CUTOVER_COMPLETED_RECEIPT_REQUIRED')
    for document, schema in [(runtime, 'B714RuntimeObservationV1'),
                             (ledger, 'B714ReadonlyLedgerV1'), (smoke, 'B714SmokeObservationV1')]:
        require(document.get('schema') == schema and document.get('sourceSha') == SOURCE, 'OBSERVATION_SCHEMA_SOURCE')
        fresh(document.get('observedAt'), now)
    require(runtime.get('images') == images, 'RUNTIME_RELEASE_DIGEST_BINDING')
    require(runtime.get('mediaSourceSha') in [HISTORICAL, SOURCE], 'OBSERVED_MEDIA_SOURCE_REQUIRED')
    require(re.fullmatch('[0-9a-f]{64}', runtime.get('mediaSourceDigest', '')), 'MEDIA_SOURCE_DIGEST_REQUIRED')
    for name in PROTECTED:
        before = cutover['baseline'][name]
        after = runtime['containers'][name]
        require(after['id'] == before['id'] and after['imageId'] == before['imageId'] and
                after['configSha256'] == before['sourceConfigSha256'], 'PROTECTED_RUNTIME_RECEIPT_DRIFT')
        if name in ['dcontact-uat-freeswitch-1', 'dcontact-platform-uat-mailpit-1']:
            require(after['startedAt'] == before['startedAt'], 'PROTECTED_RUNTIME_RESTARTED')
    require(ledger.get('runtimeSha256') == manifest['runtime']['sha256'] and
            smoke.get('runtimeSha256') == manifest['runtime']['sha256'], 'OBSERVATION_RUNTIME_BINDING')
    require(ledger.get('query') == LEDGER_QUERY and ledger.get('result', {}).get('database') == 'dcontact_uat'
            and ledger['result'].get('principal') == 'dcontact_uat_owner'
            and ledger['result'].get('readOnly') == 'on', 'READONLY_LEDGER_RECEIPT_REQUIRED')
    rows = ledger['result'].get('rows', [])
    require(len(rows) == 152 and len({row['id'] for row in rows}) == 152, 'LEDGER_ROW_HISTORY')
    require(all(type(row.get('finished')) is bool and type(row.get('rolledBack')) is bool and
                row['finished'] != row['rolledBack'] and re.fullmatch('[0-9a-f]{64}', row.get('checksum', ''))
                for row in rows), 'LEDGER_UNRESOLVED_OR_INCONSISTENT')
    require(sum(row['finished'] for row in rows) == 151 and sum(row['rolledBack'] for row in rows) == 1,
            'LEDGER_COUNTS')
    worker = [row for row in rows if row['name'] == '20261020100000_tenant_people_worker']
    require(len(worker) == 2 and sum(row['finished'] for row in worker) == 1 and
            sum(row['rolledBack'] for row in worker) == 1 and
            all(row['checksum'] == '87029b11325efc503714e12ca59b4f7e15f718a444ec599e23b310017ebcec91'
                for row in worker), 'HISTORICAL_WORKER_ATTEMPT_REQUIRED')
    successful = [row['name'] for row in rows if row['finished']]
    require(len(set(successful)) == 151, 'LEDGER_DUPLICATE_SUCCESS')
    skill = [row for row in rows if row['name'] == '20261022130000_tenant_voice_skill_scope']
    require(len(skill) == 1 and skill[0]['finished'] and skill[0]['checksum'] ==
            '5e281f7a38bace24cf114dde5a0484a41a0e01d2b317ea95293fce41a8f825c9', 'SKILL_SCOPE_LEDGER')
    report = smoke.get('report', {})
    checks = report.get('checks', [])
    require(report.get('status') == 'PASS' and len(checks) == 8 and
            [entry.get('status') for entry in checks].count('PASS') == 7 and
            [entry.get('status') for entry in checks].count('SKIPPED') == 1 and
            len({entry['id'] for entry in checks}) == 8, 'SMOKE_7_PASS_1_SKIPPED_REQUIRED')
    require(report.get('type') == 'u1.uat.readiness' and report.get('mode') == 'live' and
            {entry['id'].split(' ')[0] for entry in checks} == {'UAT-L0' + str(number) for number in range(1, 9)}
            and all(entry['status'] == ('SKIPPED' if entry['id'].startswith('UAT-L06 ') else 'PASS')
                    for entry in checks), 'CANONICAL_SMOKE_SCOPE_REQUIRED')
    require(set(manifest['backups']) == {'application', 'keycloak'}, 'TWO_BACKUPS_REQUIRED')
    for kind, reference in manifest['backups'].items():
        filename, expected = BACKUPS[kind]
        path = Path(reference['path'])
        require(reference['sha256'] == expected and path.name == filename and
                path.parent == Path(manifest['cutover']['path']).parent, 'FINAL_CUTOVER_BACKUP_BINDING')
        require(path.resolve() == path and path.stat().st_size <= 2147483648, 'BACKUP_SCOPE_SIZE')
        hasher = hashlib.sha256()
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                    'PRIVATE_BACKUP_REQUIRED')
            for chunk in iter(lambda: stream.read(1048576), b''):
                hasher.update(chunk)
        require(hasher.hexdigest() == expected, 'BACKUP_CHANGED')
    protected_names = {Path(reference['path']).name for reference in manifest.get('protectedFiles', [])}
    require({'uat.env', 'platform.env', 'acceptance-current.json', 'state.json'} <= protected_names,
            'PROTECTED_FILE_REFS_REQUIRED')
    root = Path(manifest['release']['path']).parents[2]
    controlled_paths = {str(root / 'deployments/current.json'), str(root / 'deployments/previous.json')}
    for reference in manifest['protectedFiles']:
        if reference['path'] not in controlled_paths:
            evidence(reference, False)
    supplied_hashes = {reference['path']: reference['sha256'] for reference in manifest['protectedFiles']}
    require(Path(manifest['release']['path']) == root / 'releases' / SOURCE / 'release.env', 'RELEASE_PATH')
    require({str(root / 'uat.env'), str(root / 'platform/platform.env'),
             str(root / 'platform/acceptance-current.json'), str(PUBLIC_MEDIA)} <= set(supplied_hashes),
            'EXACT_PROTECTED_FILE_PATHS_REQUIRED')
    require(all(supplied_hashes.get(path) == expected for path, expected in cutover['preservedFileHashes'].items()),
            'CUTOVER_PRESERVED_FILE_BINDING')
    return {
        'schema': 'UatDeploymentReconciliationV1', 'action': 'reconciliation', 'environment': 'uat',
        'sourceSha': SOURCE, 'images': images, 'deployedAt': None,
        'mediaSourceSha': runtime['mediaSourceSha'],
        'mediaSourceDigest': runtime['mediaSourceDigest'],
        'deploymentTimeReason': 'UNKNOWN_SEPARATE_OBSERVATION', 'observedAt': runtime['observedAt'],
        'recordedAt': now.isoformat().replace('+00:00', 'Z'), 'realmConfigDigest': None,
        'realmConfigProvenance': {'kind': 'HISTORICAL_RENDERED_TEMPLATE_ONLY', 'sourceSha': HISTORICAL,
                                  'sourceRecord': manifest['historical'],
                                  'realmConfigDigest': historical['realmConfigDigest'], 'realmReconciled': False},
        'historicalPrevious': {'sourceSha': HISTORICAL, 'record': manifest['historical'],
                               'rollbackEligible': False, 'reason': 'SKILL_SCOPE_INCOMPATIBLE'},
        'rollbackEligible': False, 'businessTrial': 'NOT_EVALUATED', 'fixturePackVersion': None,
        'migration': {'applied': False, 'finished': 151, 'rolledBack': 1, 'unresolved': 0,
                      'receipt': manifest['ledger']}, 'backup': None, 'backups': manifest['backups'],
        'smoke': {'status': 'PASS', 'checks': [{'id': entry['id'], 'status': entry['status']} for entry in checks]},
        'runtimeProof': manifest['runtime'], 'smokeProof': manifest['smoke'],
        'reviewedProofs': {kind: manifest[kind] for kind in STATIC_PROOFS},
        'unchangedProtectedFiles': [reference for reference in manifest['protectedFiles']
                                   if reference['path'] not in controlled_paths],
        'controlledRecordReplacement': {'path': str(root / 'deployments/current.json'),
            'beforeSha256': manifest['expectedCurrentSha256'], 'afterSourceSha': SOURCE,
            'afterHashLocation': 'committed.json.recordSha256'},
        'controlledPreviousReplacement': {'path': str(root / 'deployments/previous.json'),
            'beforeSha256': manifest['expectedPreviousSha256'],
            'afterSha256': manifest['expectedCurrentSha256']},
        'rollbackOf': None, 'runUrl': None,
    }


def inspect_runtime(manifest):
    runtime = evidence(manifest['runtime'])
    containers = runtime.get('containers', {})
    expected_names = set(PROTECTED + ['dcontact-uat-' + service + '-1' for service in IMAGES])
    require(set(containers) == expected_names, 'EXACT_RUNTIME_INVENTORY_REQUIRED')
    result = subprocess.run(['docker', 'inspect'] + sorted(expected_names), check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    current = json.loads(result.stdout)
    require(len(current) == len(expected_names) and
            {container['Name'].lstrip('/') for container in current} == expected_names, 'RUNTIME_INVENTORY_CHANGED')
    for container in current:
        name = container['Name'].lstrip('/')
        expected = containers[name]
        labels = container['Config'].get('Labels') or {}
        observed = {'id': container['Id'], 'imageId': container['Image'],
                    'sourceSha': labels.get('org.opencontainers.image.revision'),
                    'project': labels.get('com.docker.compose.project'),
                    'startedAt': container['State']['StartedAt'],
                    'configSha256': sha(canonical({key: container[key] for key in ['Config', 'HostConfig', 'Mounts']}))}
        require(observed == expected and container['State']['Running'] and
                container['State'].get('Health', {}).get('Status', 'healthy') == 'healthy', 'RUNTIME_DRIFT')
        if name.startswith('dcontact-uat-') and name not in PROTECTED:
            service = name[len('dcontact-uat-'):-2]
            require(observed['imageId'] == IMAGES[service] and observed['sourceSha'] == SOURCE and
                    observed['project'] == 'dcontact-uat', 'CANDIDATE_CONTAINER_PIN')
            image_key = {'e1-sandbox': 'api', 'proxy': 'console'}.get(service, service)
            require(container['Config'].get('Image') == runtime['images'][image_key], 'RUNTIME_REPO_DIGEST_BINDING')
        else:
            require(observed['project'] == ('dcontact-platform-uat' if name.startswith('dcontact-platform-uat-')
                                            else 'dcontact-uat'), 'PROTECTED_CONTAINER_PROJECT')
        if name == 'dcontact-uat-freeswitch-1':
            source = str(ROOT / 'releases' / runtime['mediaSourceSha'] / 'e1-freeswitch')
            require(any(mount.get('Source') == source and mount.get('Destination') == '/e1-freeswitch'
                        and mount.get('RW') is False for mount in container['Mounts']), 'MEDIA_SOURCE_MOUNT_DRIFT')
            require(media_digest(Path(source)) == runtime['mediaSourceDigest'], 'MEDIA_SOURCE_FILES_DRIFT')


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create(path, raw):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def current_hash(path):
    return sha(read(path)) if path.exists() else None


def apply_record(manifest, root=ROOT):
    deployments = root / 'deployments'
    operator = root / 'operator'
    pending = operator / 'b714-reconciliation.pending'
    lock = os.open(str(operator / 'b714-cutover.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not pending.exists(), 'PENDING_RECONCILIATION_REQUIRES_MANUAL_REVIEW')
        current, previous = deployments / 'current.json', deployments / 'previous.json'
        def verify(expected_previous):
            require(current_hash(current) == manifest['expectedCurrentSha256'] and
                    current_hash(previous) == expected_previous, 'RECORD_CAS_CONFLICT')
            prepare(manifest)
            inspect_runtime(manifest)
        verify(manifest['expectedPreviousSha256'])
        record = prepare(manifest)
        raw = canonical(record) + b'\n'
        name = 'b714-reconciliation-' + uuid.uuid4().hex
        transaction = operator / name
        create(pending, canonical({'status': 'PENDING', 'transaction': str(transaction)}))
        transaction.mkdir(mode=0o700)
        sync_directory(operator)
        create(transaction / 'current-before.json', read(current))
        if previous.exists():
            create(transaction / 'previous-before.json', read(previous))
        create(transaction / 'intent.json', canonical({'status': 'PENDING', 'recordSha256': sha(raw),
               'expectedCurrentSha256': manifest['expectedCurrentSha256'],
               'expectedPreviousSha256': manifest['expectedPreviousSha256']}))
        target = deployments / (instant(record['recordedAt']).strftime('%Y%m%dT%H%M%SZ') + '-' +
                                uuid.uuid4().hex + '-' + SOURCE + '.json')
        create(target, raw)
        staged_previous = deployments / (name + '-previous.tmp')
        staged_current = deployments / (name + '-current.tmp')
        create(staged_previous, read(current))
        create(staged_current, raw)
        verify(manifest['expectedPreviousSha256'])
        os.replace(str(staged_previous), str(previous))
        sync_directory(deployments)
        verify(manifest['expectedCurrentSha256'])
        os.replace(str(staged_current), str(current))
        sync_directory(deployments)
        require(read(current) == raw, 'CURRENT_COMMIT_READBACK_FAILED')
        create(transaction / 'committed.json', canonical({'status': 'COMMITTED', 'recordSha256': sha(raw)}))
        pending.unlink()
        sync_directory(operator)
        return {'status': 'COMMITTED', 'recordSha256': sha(raw), 'businessTrial': 'NOT_EVALUATED'}
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--ledger-query', action='store_true')
    parser.add_argument('--apply-owner-approved', action='store_true')
    args = parser.parse_args()
    if args.ledger_query:
        print(LEDGER_QUERY)
        return
    manifest = json.loads(read(args.manifest))
    require(not (args.build and args.apply_owner_approved), 'MODE_CONFLICT')
    if args.build:
        print(json.dumps(prepare(manifest)))
        return
    require(socket.gethostname() == 'plsa-docker', 'VM2_ONLY')
    references = [manifest[key] for key in ['historical', 'release', 'runtime', 'ledger', 'smoke'] + list(STATIC_PROOFS)]
    references += list(manifest['backups'].values()) + manifest['protectedFiles']
    for reference in references:
        path = Path(reference['path'])
        require(ROOT in path.parents or path == Path('/var/lib/dcontact-uat-e1-media/state.json'), 'VM_INPUT_SCOPE')
    if args.apply_owner_approved:
        print(json.dumps(apply_record(manifest)))
    else:
        record = prepare(manifest)
        inspect_runtime(manifest)
        print(json.dumps({'status': 'CHECK_PASS', 'recordSha256': sha(canonical(record)),
                          'businessTrial': 'NOT_EVALUATED'}))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(json.dumps({'status': 'RECONCILIATION_REQUIRED', 'automaticRetry': False}))
        raise SystemExit(1)
