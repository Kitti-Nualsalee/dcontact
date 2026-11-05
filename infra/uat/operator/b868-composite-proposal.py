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
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
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
    if (top.get('schema'), top.get('status')) != (
            'UatCompositeEvidenceManifestV2', 'NOT_REVIEWED_NOT_RECORDABLE') or top.get('rollbackCertified') is not False:
        raise RuntimeError('MANIFEST_SCOPE_INVALID')
    refs = top.get('references', {})
    if not isinstance(refs, dict) or set(refs) != {'baseManifest', 'mediaObservation'}:
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
    package = {}
    for line in data['package'].decode('utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key in package:
            raise RuntimeError('PACKAGE_INVALID')
        package[key] = value
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
    if not isinstance(top.get('limitations'), list) or set(top['limitations']) != {
            'NO_REALM_RECEIPT', 'NO_VM_ROLLBACK_CERTIFICATION', 'PACKAGE_BINDING_API_ONLY', 'FRESH_REVALIDATION_REQUIRED'}:
        raise RuntimeError('LIMITATIONS_REQUIRED')
    components = {}
    for name, component in runtime['components'].items():
        refs = sorted(component['repositoryDigests'])
        components[name] = {key: component[key] for key in ('containerId', 'imageId', 'sourceSha', 'configSha256', 'running')}
        components[name]['repositoryDigestsSha256'] = sha(CANDIDATE.canonical(refs))
        components[name]['imageDigests'] = sorted({ref.rsplit('@sha256:', 1)[1] for ref in refs})
        components[name]['configuredImageDigest'] = component['imageReference'].rsplit('@sha256:', 1)[1]
        components[name]['configuredReferenceSha256'] = sha(component['imageReference'].encode('utf-8'))
    return {'schema': 'UatCompositeReconciliationProposalV1', 'status': 'NOT_AUTHORIZED_NOT_RECORDABLE',
            'sourceSha': api['sourceSha'], 'components': components,
            'mediaObservation': {'sourceSha': media['sourceSha'], 'sourceDigest': media['sourceDigest'],
                                 'verification': 'UNVERIFIED_OUTSIDE_PROPOSAL'},
            'expectedCurrentSha256': runtime['records']['current']['sha256'],
            'expectedPreviousSha256': runtime['records']['previous']['sha256'],
            'manifestSha256': expected_sha256, 'rollbackCertified': False,
            'realmConfigDigest': None,
            'limitations': top['limitations'] + ['MEDIA_SOURCE_REVALIDATION_REQUIRED']}
