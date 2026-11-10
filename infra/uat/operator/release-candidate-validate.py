#!/usr/bin/env python3
"""ตรวจ observation สำหรับ candidate; ยังไม่อนุญาตเขียน deployment record."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

SERVICES = {'api', 'e1-sandbox', 'proxy', 'keycloak'}
PROTECTED = {'/dcontact-uat-freeswitch-1', '/dcontact-uat-proxy-1', '/dcontact-uat-keycloak-1',
             '/dcontact-uat-e1-sandbox-1', '/dcontact-platform-uat-mailpit-1',
             '/dcontact-platform-uat-platform-api-1', '/dcontact-platform-uat-platform-worker-1',
             '/dcontact-platform-uat-platform-console-1'}
AUTHORITY_MIGRATION = '20261103120000_tenant_provisioned_configuration_authority'
AUTHORITY_CHECKSUM = 'f5feda4f26297ed4bc98aa85c1e298e43e7292e44d66791b0f708fa6d53c8c47'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def valid(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def parse_package(raw):
    package = {}
    for line in raw.decode('utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in package:
            raise RuntimeError('PACKAGE_INVALID')
        package[key] = value
    return package


def validate(observation, approved_sha256, now=None):
    """ค่า approved_sha256 ต้องมาจากช่องทาง review ที่เชื่อถือได้ ไม่ใช่ observation เอง."""
    if not valid('[0-9a-f]{64}', approved_sha256) or hashlib.sha256(canonical(observation)).hexdigest() != approved_sha256:
        raise RuntimeError('APPROVED_OBSERVATION_MISMATCH')
    result = validate_unreviewed(observation, now)
    return {**result, 'status': 'OBSERVATION_VALIDATED_NOT_RECORDABLE', 'observationSha256': approved_sha256}


def validate_unreviewed(observation, now=None):
    """ตรวจรูปแบบและความสอดคล้องเท่านั้น ไม่ยืนยันที่มาหรือการ review."""
    if (observation.get('schema'), observation.get('status')) != (
            'UatReleaseEvidenceObservationV1', 'OBSERVED_NOT_CERTIFIED') or observation.get('rollbackCertified') is not False:
        raise RuntimeError('OBSERVATION_NOT_ELIGIBLE')
    timestamp = observation.get('observedAt')
    try:
        if not isinstance(timestamp, str) or not timestamp.endswith('Z'):
            raise ValueError('UTC required')
        observed = datetime.fromisoformat(timestamp[:-1] + '+00:00')
        age = ((now or datetime.now(timezone.utc)) - observed).total_seconds()
    except (ValueError, TypeError, OverflowError):
        raise RuntimeError('OBSERVATION_TIME_INVALID') from None
    if age < -30 or age > 300:
        raise RuntimeError('OBSERVATION_STALE_OR_FUTURE')
    runtime = observation.get('runtime')
    if not isinstance(runtime, dict) or hashlib.sha256(canonical(runtime)).hexdigest() != observation.get('runtimeSha256'):
        raise RuntimeError('RUNTIME_BINDING_MISMATCH')
    if runtime.get('schema') != 'UatReleaseInspectionV1' or runtime.get('runtimeConsistency') != 'TWO_MATCHING_OBSERVATIONS' or runtime.get('rollbackCertified') is not False:
        raise RuntimeError('RUNTIME_NOT_ELIGIBLE')
    protected = observation.get('protectedRuntime')
    if (not isinstance(protected, dict) or set(protected) != PROTECTED
            or hashlib.sha256(canonical(protected)).hexdigest() != observation.get('protectedRuntimeSha256')):
        raise RuntimeError('PROTECTED_RUNTIME_REQUIRED')
    for item in protected.values():
        if (not isinstance(item, dict) or item.get('running') is not True
                or not valid('[0-9a-f]{64}', item.get('id'))
                or not valid('sha256:[0-9a-f]{64}', item.get('image'))
                or not valid('[0-9a-f]{64}', item.get('configSha256'))):
            raise RuntimeError('PROTECTED_IDENTITY_REQUIRED')
    components = runtime.get('components')
    if not isinstance(components, dict) or set(components) != SERVICES:
        raise RuntimeError('COMPONENT_INVENTORY_REQUIRED')
    for component in components.values():
        if (not isinstance(component, dict) or component.get('running') is not True
                or not valid('[0-9a-f]{64}', component.get('containerId'))
                or not valid('sha256:[0-9a-f]{64}', component.get('imageId'))
                or not valid('[0-9a-f]{40}', component.get('sourceSha'))
                or not valid('[0-9a-f]{64}', component.get('configSha256'))):
            raise RuntimeError('COMPONENT_IDENTITY_REQUIRED')
        refs = component.get('repositoryDigests')
        if not isinstance(refs, list) or not refs or any(not valid(r'[^\s@]+@sha256:[0-9a-f]{64}', ref) for ref in refs):
            raise RuntimeError('COMPONENT_DIGEST_REQUIRED')
        reference = component.get('imageReference')
        if not valid(r'[^\s@]+@sha256:[0-9a-f]{64}', reference) or reference not in refs:
            raise RuntimeError('COMPONENT_REFERENCE_MISMATCH')
    for service in ('e1-sandbox', 'proxy', 'keycloak'):
        item = protected['/dcontact-uat-' + service + '-1']
        component = components[service]
        if (item['id'] != component['containerId'] or item['image'] != component['imageId']
                or item['configSha256'] != component['configSha256']
                or item.get('startedAt') != component.get('startedAt')):
            raise RuntimeError('PROTECTED_COMPONENT_MISMATCH')
    records = runtime.get('records')
    if not isinstance(records, dict) or set(records) != {'current', 'previous'} or any(
            not isinstance(item, dict) or not valid('[0-9a-f]{64}', item.get('sha256')) for item in records.values()):
        raise RuntimeError('RECORD_HASHES_REQUIRED')
    ledger = observation.get('ledger')
    if not isinstance(ledger, dict) or (ledger.get('database'), ledger.get('principal'), ledger.get('readonly')) != (
            'dcontact_uat', 'dcontact_uat_owner', 'on'):
        raise RuntimeError('LEDGER_SCOPE_REQUIRED')
    if any(type(ledger.get(key)) is not int or ledger[key] < 0 for key in ('finished', 'rolledBack', 'unresolved', 'authorityMatches')):
        raise RuntimeError('LEDGER_COUNTS_INVALID')
    if ledger['unresolved'] != 0 or ledger['authorityMatches'] != 1 or ledger['finished'] < 1:
        raise RuntimeError('LEDGER_INCOMPLETE')
    migrations = ledger.get('migrations')
    if (not isinstance(migrations, list) or len(migrations) != ledger['finished'] or len(migrations) > 5000
            or any(not isinstance(item, dict) or set(item) != {'name', 'checksum'}
                   or not isinstance(item['name'], str) or not item['name']
                   or not valid('[0-9a-f]{64}', item['checksum']) for item in migrations)
            or len({item['name'] for item in migrations}) != len(migrations)):
        raise RuntimeError('LEDGER_MIGRATIONS_INVALID')
    if {'name': AUTHORITY_MIGRATION, 'checksum': AUTHORITY_CHECKSUM} not in migrations:
        raise RuntimeError('LEDGER_AUTHORITY_MISMATCH')
    return {'status': 'OBSERVATION_CONSISTENT_NOT_REVIEWED',
            'expectedCurrentSha256': records['current']['sha256'],
            'expectedPreviousSha256': records['previous']['sha256'],
            'rollbackCertified': False}


def validate_rehearsal(observation, approved_observation_sha256, proof, approved_proof_sha256, now=None):
    """ตรวจหลักฐาน copy ที่ผ่าน review; ไม่อ้างว่าเป็น rollback บน VM."""
    validate(observation, approved_observation_sha256, now)
    if not valid('[0-9a-f]{64}', approved_proof_sha256) or hashlib.sha256(canonical(proof)).hexdigest() != approved_proof_sha256:
        raise RuntimeError('APPROVED_REHEARSAL_MISMATCH')
    result = validate_rehearsal_unreviewed(observation, proof, now)
    return {**result, 'status': 'COPY_REHEARSAL_VALIDATED_NOT_VM_ROLLBACK',
            'rehearsalSha256': approved_proof_sha256}


def validate_rehearsal_unreviewed(observation, proof, now=None):
    """ตรวจความสอดคล้องของ copy เท่านั้น ไม่อ้างว่า evidence ได้รับ review."""
    validate_unreviewed(observation, now)
    if (proof.get('status'), proof.get('scope')) != (
            'COPY_OWNER_ACL_STANDARD_MIGRATIONS_GENERATED_WRITER_PASS', 'B714_VM2_APP_PERMISSION_COPY_ONLY'):
        raise RuntimeError('REHEARSAL_SCOPE_REQUIRED')
    runtime = observation.get('runtime', {})
    api = runtime.get('components', {}).get('api', {})
    if not valid('[0-9a-f]{40}', api.get('sourceSha')) or proof.get('sourceSha') != api['sourceSha']:
        raise RuntimeError('REHEARSAL_SOURCE_MISMATCH')
    images = proof.get('images')
    if not isinstance(images, dict) or images.get('api') != api.get('imageId'):
        raise RuntimeError('REHEARSAL_API_IMAGE_MISMATCH')
    copied = proof.get('ledger')
    live = observation.get('ledger')
    if not isinstance(copied, dict) or not isinstance(live, dict):
        raise RuntimeError('REHEARSAL_LEDGER_REQUIRED')
    if (type(copied.get('afterFinished')) is not int or copied['afterFinished'] != live.get('finished')
            or type(copied.get('rolledBackPreserved')) is not int
            or copied['rolledBackPreserved'] != live.get('rolledBack')
            or copied.get('historicalRowsByteValuesPreserved') is not True
            or copied.get('secondDeploy') != 'NOOP' or live.get('unresolved') != 0):
        raise RuntimeError('REHEARSAL_LEDGER_MISMATCH')
    manifest = proof.get('migrationManifest')
    migrations = manifest.get('migrations') if isinstance(manifest, dict) else None
    if (not isinstance(migrations, list) or len(migrations) != len(live['migrations'])
            or any(not isinstance(item, dict) or set(item) != {'name', 'checksum'}
                   or not isinstance(item['name'], str) or not valid('[0-9a-f]{64}', item['checksum'])
                   for item in migrations)
            or sorted(migrations, key=lambda item: item['name']) != sorted(live['migrations'], key=lambda item: item['name'])):
        raise RuntimeError('REHEARSAL_MIGRATION_CHECKSUM_MISMATCH')
    limitations = proof.get('limitations')
    if not isinstance(limitations, list) or 'OLD_API_803_DATA_COMPATIBILITY_NOT_NEW_B2_AUTHORITY_OR_VM_ROLLBACK' not in limitations:
        raise RuntimeError('REHEARSAL_LIMITATIONS_REQUIRED')
    return {'status': 'COPY_REHEARSAL_CONSISTENT_NOT_REVIEWED', 'rollbackCertified': False}


def migration_checksums(migrations):
    if (not isinstance(migrations, list) or not 0 < len(migrations) <= 5000
            or any(not isinstance(item, dict) or set(item) != {'name', 'checksum'}
                   or not valid(r'[0-9]{14}_[a-z0-9_]+', item['name'])
                   or not valid('[0-9a-f]{64}', item['checksum']) for item in migrations)):
        raise RuntimeError('API_ROLLBACK_MIGRATIONS_INVALID')
    checksums = {item['name']: item['checksum'] for item in migrations}
    if len(checksums) != len(migrations):
        raise RuntimeError('API_ROLLBACK_MIGRATIONS_INVALID')
    return checksums


def validate_api_rollback_rehearsal(observation, approved_observation_sha256, rehearsal,
                                    approved_rehearsal_sha256, release_env, migration_guard, now=None):
    """เทียบ rehearsal API-only กับ baseline ปัจจุบันก่อนเริ่ม maintenance บน UAT."""
    validate(observation, approved_observation_sha256, now)
    if (not valid('[0-9a-f]{64}', approved_rehearsal_sha256)
            or hashlib.sha256(canonical(rehearsal)).hexdigest() != approved_rehearsal_sha256):
        raise RuntimeError('APPROVED_API_ROLLBACK_REHEARSAL_MISMATCH')
    if (not isinstance(rehearsal, dict) or rehearsal.get('schema') != 'UatApiRollbackRehearsalV1'
            or rehearsal.get('scope') != 'ISOLATED_POSTGRES_SYNTHETIC_IDENTITY'
            or rehearsal.get('protectedFixtureAndLedgerPreserved') is not True):
        raise RuntimeError('API_ROLLBACK_REHEARSAL_SCOPE_INVALID')

    runtime = observation['runtime']
    current = runtime['records']['current']
    previous = runtime['records']['previous']
    components = runtime['components']
    anchor = current.get('sourceSha')
    if (runtime.get('referenceKind') != 'PER_COMPONENT_OBSERVATION'
            or (current.get('schema'), current.get('action')) != ('UatDeploymentReconciliationV1', 'reconciliation')
            or current.get('rollbackEligible') is not False or not valid('[0-9a-f]{40}', anchor)
            or current.get('legacyAnchor') != {'kind': 'HISTORICAL_RELEASE_LAYOUT_NOT_CURRENT_RUNTIME', 'sourceSha': anchor}
            or components['api']['sourceSha'] == anchor
            or current.get('components') != components
            or any(runtime.get(key) != [] for key in (
                'sourceMismatch', 'imageDigestMismatch', 'componentConfigMismatch', 'componentIdentityMismatch'))):
        raise RuntimeError('API_ROLLBACK_BASELINE_RUNTIME_DRIFT')

    baseline = migration_checksums(observation['ledger']['migrations'])
    if migration_checksums(rehearsal.get('baselineMigrations')) != baseline:
        raise RuntimeError('API_ROLLBACK_BASELINE_LEDGER_MISMATCH')
    migrated = migration_checksums(rehearsal.get('candidateMigrations'))
    if any(migrated.get(name) != checksum for name, checksum in baseline.items()):
        raise RuntimeError('API_ROLLBACK_CANDIDATE_LEDGER_NOT_ADDITIVE')

    package_sha = hashlib.sha256(release_env).hexdigest()
    if package_sha != rehearsal.get('candidateReleaseEnvSha256'):
        raise RuntimeError('API_ROLLBACK_PACKAGE_HASH_MISMATCH')
    package = parse_package(release_env)
    api = components['api']
    target_sha, target_image = api['sourceSha'], api['imageReference']
    candidate_sha, candidate_image = package.get('SOURCE_SHA'), package.get('API_IMAGE')
    ops_image = package.get('OPS_IMAGE')
    if (package.get('UAT_WORKSPACE_ENABLED') != 'true'
            or not valid('[0-9a-f]{40}', candidate_sha)
            or not valid(r'[^\s@]+@sha256:[0-9a-f]{64}', candidate_image)
            or not valid(r'[^\s@]+@sha256:[0-9a-f]{64}', ops_image)
            or candidate_sha in (target_sha, anchor, previous.get('sourceSha'))
            or candidate_image.rsplit('@', 1)[1] == target_image.rsplit('@', 1)[1]):
        raise RuntimeError('API_ROLLBACK_PACKAGE_INVALID')
    if rehearsal.get('candidateOpsImage') != ops_image:
        raise RuntimeError('API_ROLLBACK_OPS_IMAGE_MISMATCH')
    if hashlib.sha256(migration_guard).hexdigest() != rehearsal.get('candidateMigrationGuardSha256'):
        raise RuntimeError('API_ROLLBACK_MIGRATION_GUARD_HASH_MISMATCH')
    guard = json.loads(migration_guard)
    if (not isinstance(guard, dict) or (guard.get('type'), guard.get('mode'), guard.get('status'),
            guard.get('base'), guard.get('head')) != ('u1.uat.readiness', 'migration-guard', 'PASS',
                                                      anchor, candidate_sha)):
        raise RuntimeError('API_ROLLBACK_MIGRATION_GUARD_INVALID')
    checks = guard.get('checks')
    if (not isinstance(checks, list) or len(checks) != 1 or not isinstance(checks[0], dict)
            or not str(checks[0].get('id', '')).startswith('UAT-M01 ') or checks[0].get('status') != 'PASS'
            or not isinstance(checks[0].get('added'), list)):
        raise RuntimeError('API_ROLLBACK_MIGRATION_GUARD_INVALID')
    reviewed_paths = checks[0]['added']
    new_paths = {f'packages/db/prisma/migrations/{name}/migration.sql' for name in migrated.keys() - baseline.keys()}
    candidate_paths = {f'packages/db/prisma/migrations/{name}/migration.sql' for name in migrated}
    if (any(not isinstance(path, str) or path not in candidate_paths for path in reviewed_paths)
            or not new_paths.issubset(reviewed_paths)):
        raise RuntimeError('API_ROLLBACK_MIGRATION_GUARD_LEDGER_MISMATCH')

    expected = []
    for name, source, image, ledger in (
        ('baseline', target_sha, target_image, baseline),
        ('candidate', candidate_sha, candidate_image, migrated),
        ('rollback', target_sha, target_image, migrated),
        ('recovery', candidate_sha, candidate_image, migrated),
    ):
        expected.append({'phase': name, 'sourceSha': source, 'apiImage': image, 'profile': 'uat-workspace',
                         'migrationChecksumsSha256': hashlib.sha256(canonical(ledger)).hexdigest(),
                         'agentSnapshot': 200, 'mismatchedTenant': 401, 'providerEgress': 'BLOCKED'})
    if rehearsal.get('phases') != expected:
        raise RuntimeError('API_ROLLBACK_PHASE_MISMATCH')
    return {'status': 'ISOLATED_API_ROLLBACK_REHEARSAL_MATCHES_BASELINE',
            'observationSha256': approved_observation_sha256, 'rehearsalSha256': approved_rehearsal_sha256,
            'candidateReleaseEnvSha256': package_sha, 'candidateSourceSha': candidate_sha, 'targetSourceSha': target_sha,
            'rollbackEligible': False, 'rollbackCertified': False}


def read_api_rollback_input(path):
    limit = 8388608
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise RuntimeError('API_ROLLBACK_INPUT_FILE_INVALID')
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise RuntimeError('API_ROLLBACK_INPUT_FILE_INVALID')
        return raw


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ตรวจหลักฐาน API-only rollback rehearsal ก่อน maintenance')
    parser.add_argument('--observation', required=True, type=Path)
    parser.add_argument('--approved-observation-sha256', required=True)
    parser.add_argument('--api-rehearsal', required=True, type=Path)
    parser.add_argument('--approved-rehearsal-sha256', required=True)
    parser.add_argument('--release-env', required=True, type=Path)
    parser.add_argument('--migration-guard', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = validate_api_rollback_rehearsal(
            json.loads(read_api_rollback_input(args.observation)), args.approved_observation_sha256,
            json.loads(read_api_rollback_input(args.api_rehearsal)), args.approved_rehearsal_sha256,
            read_api_rollback_input(args.release_env), read_api_rollback_input(args.migration_guard))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError) as error:
        reason = str(error) if type(error) is RuntimeError else 'API_ROLLBACK_INPUT_INVALID'
        print(json.dumps({'status': 'API_ROLLBACK_REHEARSAL_REJECTED', 'reason': reason,
                          'rollbackEligible': False, 'rollbackCertified': False}))
        sys.exit(1)
    print(json.dumps(result))
