#!/usr/bin/env python3
"""ประกอบข้อเสนอ record จากหลักฐานส่วนตัว; ไม่มีคำสั่งเขียน deployment pointer."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

ROOT = Path('/opt/dcontact-uat/operator')
SPEC = importlib.util.spec_from_file_location('b868_candidate', Path(__file__).with_name('release-candidate-validate.py'))
CANDIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CANDIDATE)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_private(path, root):
    path = Path(path)
    root = Path(root)
    if not path.is_absolute() or path.resolve() != path or root not in path.parents:
        raise RuntimeError('EVIDENCE_PATH_INVALID')
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 8388608:
            raise RuntimeError('EVIDENCE_PERMISSIONS_INVALID')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(8388609)
        if len(raw) > 8388608:
            raise RuntimeError('EVIDENCE_TOO_LARGE')
        return raw
    finally:
        os.close(descriptor)


def reference(ref, root):
    if not isinstance(ref, dict) or set(ref) != {'path', 'sha256'} or not re.fullmatch('[0-9a-f]{64}', str(ref.get('sha256', ''))):
        raise RuntimeError('EVIDENCE_REFERENCE_INVALID')
    raw = read_private(ref['path'], root)
    if sha(raw) != ref['sha256']:
        raise RuntimeError('EVIDENCE_HASH_MISMATCH')
    return raw


def build(manifest_path, expected_sha256, root=ROOT, now=None):
    """ผลลัพธ์เป็น proposal เท่านั้น; expected hash ไม่ใช่หลักฐานอนุมัติ."""
    now = now or datetime.now(timezone.utc)
    raw = read_private(manifest_path, root)
    if not re.fullmatch('[0-9a-f]{64}', str(expected_sha256)) or sha(raw) != expected_sha256:
        raise RuntimeError('MANIFEST_HASH_MISMATCH')
    top = json.loads(raw)
    version = top.get('schema')
    if (version not in ('UatCompositeEvidenceManifestV2', 'UatCompositeEvidenceManifestV3')
            or top.get('status') != 'NOT_REVIEWED_NOT_RECORDABLE' or top.get('rollbackCertified') is not False):
        raise RuntimeError('MANIFEST_SCOPE_INVALID')
    refs = top.get('references', {})
    component_bound = version == 'UatCompositeEvidenceManifestV3'
    expected_refs = {'baseManifest', 'mediaObservation'} | ({'componentPackages'} if component_bound else set())
    if not isinstance(refs, dict) or set(refs) != expected_refs:
        raise RuntimeError('MANIFEST_REFERENCES_INVALID')
    base = json.loads(reference(refs['baseManifest'], root))
    media = json.loads(reference(refs['mediaObservation'], root))
    if (base.get('schema'), base.get('status')) != (
            'UatCompositeEvidenceManifestV1', 'NOT_REVIEWED_NOT_RECORDABLE') or base.get('rollbackCertified') is not False:
        raise RuntimeError('BASE_MANIFEST_SCOPE_INVALID')
    sources = base.get('references', {})
    if not isinstance(sources, dict) or set(sources) != {'observation', 'package', 'migrationGuard', 'githubEvidence', 'copyRehearsal'}:
        raise RuntimeError('BASE_REFERENCES_INVALID')
    data = {name: reference(ref, root) for name, ref in sources.items()}
    observation = json.loads(data['observation'])
    proof = json.loads(data['copyRehearsal'])
    CANDIDATE.validate_rehearsal_unreviewed(observation, proof, now)
    runtime = observation['runtime']
    api = runtime['components']['api']
    package = CANDIDATE.parse_package(data['package'])
    if package.get('SOURCE_SHA') != api['sourceSha'] or package.get('API_IMAGE') not in api['repositoryDigests']:
        raise RuntimeError('PACKAGE_API_MISMATCH')
    guard = json.loads(data['migrationGuard'])
    if (guard.get('type'), guard.get('mode'), guard.get('status'), guard.get('base'), guard.get('head')) != (
            'u1.uat.readiness', 'migration-guard', 'PASS', runtime['records']['current']['sourceSha'], api['sourceSha']):
        raise RuntimeError('MIGRATION_GUARD_MISMATCH')
    checks = guard.get('checks')
    if not isinstance(checks, list) or len(checks) != 1 or not isinstance(checks[0], dict) or not str(checks[0].get('id', '')).startswith('UAT-M01 ') or checks[0].get('status') != 'PASS':
        raise RuntimeError('MIGRATION_GUARD_CHECK_INVALID')
    ci = json.loads(data['githubEvidence'])
    if (ci.get('schema') != 'UatGithubEvidenceObservationV1' or ci.get('status') != 'OBSERVED_NOT_CERTIFIED'
            or ci.get('sourceSha') != api['sourceSha'] or any(ci.get(key) != 'success' for key in
                ('ciConclusion', 'authorityConclusion', 'tenantBoundaryConclusion', 'packageConclusion'))):
        raise RuntimeError('GITHUB_OBSERVATION_MISMATCH')
    protected = observation['protectedRuntime']['/dcontact-uat-freeswitch-1']
    if (media.get('schema') != 'UatMediaObservationV1' or media.get('status') != 'OBSERVED_NOT_CERTIFIED'
            or media.get('rollbackCertified') is not False or media.get('currentRecordSha256') != runtime['records']['current']['sha256']
            or media.get('containerId') != protected['id'] or media.get('imageId') != protected['image']
            or media.get('configSha256') != protected['configSha256']
            or not CANDIDATE.valid('[0-9a-f]{40}', media.get('sourceSha'))
            or not CANDIDATE.valid('[0-9a-f]{64}', media.get('sourceDigest'))):
        raise RuntimeError('MEDIA_OBSERVATION_MISMATCH')
    try:
        if not isinstance(media.get('observedAt'), str) or not media['observedAt'].endswith('Z'):
            raise ValueError('UTC required')
        observed = datetime.fromisoformat(media['observedAt'][:-1] + '+00:00')
        age = (now - observed).total_seconds()
    except (KeyError, TypeError, ValueError):
        raise RuntimeError('MEDIA_TIME_INVALID') from None
    if age < -30 or age > 300:
        raise RuntimeError('MEDIA_OBSERVATION_STALE')
    expected_limits = {'NO_REALM_RECEIPT', 'NO_VM_ROLLBACK_CERTIFICATION', 'FRESH_REVALIDATION_REQUIRED',
                       'NO_BUILD_ATTESTATION' if component_bound else 'PACKAGE_BINDING_API_ONLY'}
    if not isinstance(top.get('limitations'), list) or set(top['limitations']) != expected_limits:
        raise RuntimeError('LIMITATIONS_REQUIRED')
    bindings = {}
    if component_bound:
        package_refs = refs['componentPackages']
        keys = {'api': 'API_IMAGE', 'e1-sandbox': 'API_IMAGE', 'proxy': 'CONSOLE_IMAGE', 'keycloak': 'KEYCLOAK_IMAGE'}
        if not isinstance(package_refs, dict) or set(package_refs) != set(keys):
            raise RuntimeError('COMPONENT_PACKAGES_REQUIRED')
        for name, key in keys.items():
            package_raw = reference(package_refs[name], root)
            component_package = CANDIDATE.parse_package(package_raw)
            if any(not CANDIDATE.valid(r'[^\s@]+@sha256:[0-9a-f]{64}', component_package.get(field))
                   for field in ('API_IMAGE', 'OPS_IMAGE', 'CONSOLE_IMAGE', 'KEYCLOAK_IMAGE')):
                raise RuntimeError('COMPONENT_PACKAGE_INVALID')
            component = runtime['components'][name]
            image = component_package.get(key)
            if (component_package.get('SOURCE_SHA') != component['sourceSha']
                    or image != component['imageReference'] or image not in component['repositoryDigests']):
                raise RuntimeError('COMPONENT_PACKAGE_MISMATCH')
            bindings[name] = {'sourceSha': component['sourceSha'], 'packageSha256': sha(package_raw),
                              'imageReferenceSha256': sha(image.encode()),
                              'imageDigest': image.rsplit('@sha256:', 1)[1]}
    components = {}
    for name, component in runtime['components'].items():
        refs = sorted(component['repositoryDigests'])
        components[name] = {key: component[key] for key in ('containerId', 'imageId', 'sourceSha', 'configSha256', 'running')}
        components[name]['repositoryDigestsSha256'] = sha(CANDIDATE.canonical(refs))
        components[name]['imageDigests'] = sorted({ref.rsplit('@sha256:', 1)[1] for ref in refs})
        components[name]['configuredImageDigest'] = component['imageReference'].rsplit('@sha256:', 1)[1]
        components[name]['configuredReferenceSha256'] = sha(component['imageReference'].encode('utf-8'))
        if component_bound:
            components[name]['imageReference'] = component['imageReference']
            components[name]['repositoryDigests'] = list(component['repositoryDigests'])
            components[name]['startedAt'] = component.get('startedAt')
    result = {'schema': 'UatCompositeReconciliationProposalV2' if component_bound else 'UatCompositeReconciliationProposalV1',
            'status': 'NOT_AUTHORIZED_NOT_RECORDABLE',
            'sourceSha': api['sourceSha'], 'components': components,
            'mediaObservation': {'sourceSha': media['sourceSha'], 'sourceDigest': media['sourceDigest'],
                                 'verification': 'UNVERIFIED_OUTSIDE_PROPOSAL'},
            'expectedCurrentSha256': runtime['records']['current']['sha256'],
            'expectedPreviousSha256': runtime['records']['previous']['sha256'],
            'manifestSha256': expected_sha256, 'rollbackCertified': False,
            'realmConfigDigest': None,
            'limitations': top['limitations'] + ['MEDIA_SOURCE_REVALIDATION_REQUIRED']}
    if component_bound:
        result['componentPackageBindings'] = bindings
        result['runtimeObservedAt'] = observation['observedAt']
        result['observationReference'] = sources['observation']
        result['ledgerSha256'] = sha(CANDIDATE.canonical(observation['ledger']))
        result['ledgerSummary'] = {key: observation['ledger'][key] for key in
                                  ('database', 'readonly', 'finished', 'rolledBack', 'unresolved', 'authorityMatches')}
    return result


def build_observed_record(manifest_path, expected_sha256, current_raw, previous_raw, root=ROOT, now=None):
    """เติม observation ราย component โดยรักษา legacy layout และประวัติเดิม."""
    now = now or datetime.now(timezone.utc)
    proposal = build(manifest_path, expected_sha256, root, now)
    if proposal['schema'] != 'UatCompositeReconciliationProposalV2':
        raise RuntimeError('ALL_COMPONENT_PACKAGES_REQUIRED')
    if (sha(current_raw) != proposal['expectedCurrentSha256']
            or sha(previous_raw) != proposal['expectedPreviousSha256']):
        raise RuntimeError('OBSERVATION_RECORD_CAS_MISMATCH')
    record = json.loads(current_raw)
    if (not isinstance(record, dict) or record.get('schema') != 'UatDeploymentReconciliationV1'
            or record.get('action') != 'reconciliation' or record.get('rollbackEligible') is not False
            or not CANDIDATE.valid('[0-9a-f]{40}', record.get('sourceSha'))
            or record.get('realmConfigDigest') is not None):
        raise RuntimeError('OBSERVATION_LEGACY_RECORD_REQUIRED')
    if (not isinstance(record.get('images'), dict) or set(record['images']) != {'api', 'console', 'ops', 'keycloak'}
            or any(not CANDIDATE.valid(r'[^\s@]+@sha256:[0-9a-f]{64}', image) for image in record['images'].values())):
        raise RuntimeError('OBSERVATION_LEGACY_IMAGES_REQUIRED')
    if (record.get('mediaSourceSha') != proposal['mediaObservation']['sourceSha']
            or record.get('mediaSourceDigest') != proposal['mediaObservation']['sourceDigest']):
        raise RuntimeError('OBSERVATION_MEDIA_ANCHOR_MISMATCH')
    anchor = {'kind': 'HISTORICAL_RELEASE_LAYOUT_NOT_CURRENT_RUNTIME',
              'sourceSha': record['sourceSha'],
              'fields': sorted(key for key in record if key not in {
                  'schema', 'action', 'rollbackEligible', 'recordedAt', 'legacyAnchor',
                  'components', 'componentPackageBindings', 'observationProof'}),
              'firstSourceRecordSha256': sha(current_raw)}
    if 'legacyAnchor' in record:
        old = record['legacyAnchor']
        if (not isinstance(old, dict) or old.get('kind') != anchor['kind'] or old.get('sourceSha') != anchor['sourceSha']
                or old.get('fields') != anchor['fields']
                or not CANDIDATE.valid('[0-9a-f]{64}', old.get('firstSourceRecordSha256'))):
            raise RuntimeError('OBSERVATION_LEGACY_ANCHOR_CHANGED')
        anchor = old
    record['legacyAnchor'] = anchor
    record['components'] = proposal['components']
    record['componentPackageBindings'] = proposal['componentPackageBindings']
    record['observationProof'] = {'schema': 'UatComponentObservationReferenceV1',
        'scope': 'CURRENT_COMPONENTS_PACKAGE_BOUND_NOT_RELEASE_CERTIFIED',
        'observedAt': proposal['runtimeObservedAt'], 'reference': proposal['observationReference'],
        'manifestSha256': expected_sha256, 'ledgerSha256': proposal['ledgerSha256'],
        'ledgerSummary': proposal['ledgerSummary'],
        'parentRecordSha256': sha(current_raw), 'previousRecordSha256': sha(previous_raw),
        'previousPreserved': True, 'rollbackCertified': False,
        'limitations': proposal['limitations']}
    record['recordedAt'] = now.isoformat().replace('+00:00', 'Z')
    return record
