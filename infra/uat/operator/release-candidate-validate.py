#!/usr/bin/env python3
"""ตรวจ observation สำหรับ candidate; ยังไม่อนุญาตเขียน deployment record."""
from datetime import datetime, timezone
import hashlib
import json
import re

SERVICES = {'api', 'e1-sandbox', 'proxy', 'keycloak'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def valid(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validate(observation, approved_sha256, now=None):
    """ค่า approved_sha256 ต้องมาจากช่องทาง review ที่เชื่อถือได้ ไม่ใช่ observation เอง."""
    if not valid('[0-9a-f]{64}', approved_sha256) or hashlib.sha256(canonical(observation)).hexdigest() != approved_sha256:
        raise RuntimeError('APPROVED_OBSERVATION_MISMATCH')
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
    if not valid('[0-9a-f]{64}', observation.get('protectedRuntimeSha256')):
        raise RuntimeError('PROTECTED_RUNTIME_REQUIRED')
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
    return {'status': 'OBSERVATION_VALIDATED_NOT_RECORDABLE', 'observationSha256': approved_sha256,
            'expectedCurrentSha256': records['current']['sha256'],
            'expectedPreviousSha256': records['previous']['sha256'],
            'rollbackCertified': False}
