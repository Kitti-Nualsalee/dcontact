#!/usr/bin/env python3
"""เติม observation ลง record เดิมแบบรักษา layout/previous; ไม่รับรอง rollback."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import re

DIRECTORY = Path(__file__).resolve().parent
ROOT = Path('/opt/dcontact-uat')


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROPOSAL = load('b868_observation_proposal', 'b868-composite-proposal.py')
TRANSACTION = load('b868_observation_transaction', 'b714-deployment-reconciliation.py')
LIVE = load('b868_observation_live_reader', 'b868-record-forward-recovery.py')


def stable_sha(record):
    return PROPOSAL.sha(PROPOSAL.CANDIDATE.canonical({key: value for key, value in record.items() if key != 'recordedAt'}))


def prepare(manifest_path, approved_manifest_sha256, actor, root=ROOT, now=None):
    if not isinstance(actor, str) or not re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', actor):
        raise RuntimeError('RECONCILE_ACTOR_REQUIRED')
    root = Path(root)
    current = TRANSACTION.read(root / 'deployments/current.json')
    previous = TRANSACTION.read(root / 'deployments/previous.json')
    record = PROPOSAL.build_observed_record(manifest_path, approved_manifest_sha256, current, previous,
                                            root / 'operator', now)
    record['observationProof']['actor'] = actor
    return record


def apply(manifest_path, approved_manifest_sha256, approved_stable_record_sha256, actor,
          *, root=ROOT, observe_live=None, now=None):
    root = Path(root)
    def check_time():
        return now() if callable(now) else now or datetime.now(timezone.utc)
    record = prepare(manifest_path, approved_manifest_sha256, actor, root, check_time())
    if stable_sha(record) != approved_stable_record_sha256:
        raise RuntimeError('RECONCILE_RECORD_APPROVAL_MISMATCH')
    parent = record['observationProof']['parentRecordSha256']
    previous = record['observationProof']['previousRecordSha256']
    envelope = {'expectedCurrentSha256': parent, 'expectedPreviousSha256': previous}
    reader = observe_live or LIVE.live_reader(root)

    def candidate(_manifest):
        value = prepare(manifest_path, approved_manifest_sha256, actor, root, check_time())
        if stable_sha(value) != approved_stable_record_sha256:
            raise RuntimeError('RECONCILE_RECORD_APPROVAL_MISMATCH')
        return value

    def inspect(_manifest):
        value = candidate(_manifest)
        raw = PROPOSAL.reference(value['observationProof']['reference'], root / 'operator')
        approved = json.loads(raw)
        PROPOSAL.CANDIDATE.validate_unreviewed(approved, check_time())
        live = reader()
        PROPOSAL.CANDIDATE.validate_unreviewed(live, check_time())
        if (live['runtime'] != approved['runtime'] or live['ledger'] != approved['ledger']
                or live['protectedRuntime'] != approved['protectedRuntime']):
            raise RuntimeError('RECONCILE_LIVE_EVIDENCE_CHANGED')
        PROPOSAL.CANDIDATE.validate_unreviewed(approved, check_time())

    def postcheck(committed_record):
        PROPOSAL.build(manifest_path, approved_manifest_sha256, root / 'operator', check_time())
        approved = json.loads(PROPOSAL.reference(record['observationProof']['reference'], root / 'operator'))
        PROPOSAL.CANDIDATE.validate_unreviewed(approved, check_time())
        live = reader()
        PROPOSAL.CANDIDATE.validate_unreviewed(live, check_time())
        if (live['runtime']['components'] != approved['runtime']['components']
                or live['ledger'] != approved['ledger'] or live['protectedRuntime'] != approved['protectedRuntime']):
            raise RuntimeError('RECONCILE_POSTCHECK_EVIDENCE_CHANGED')
        current_raw = TRANSACTION.read(root / 'deployments/current.json')
        expected_raw = TRANSACTION.canonical(committed_record) + b'\n'
        if (current_raw != expected_raw
                or live['runtime']['records']['current']['sha256'] != PROPOSAL.sha(expected_raw)
                or live['runtime']['records']['previous']['sha256'] != previous
                or any(live['runtime'].get(key) != [] for key in
                       ('sourceMismatch', 'imageDigestMismatch', 'componentConfigMismatch', 'componentIdentityMismatch'))
                or live['runtime'].get('referenceKind') != 'PER_COMPONENT_OBSERVATION'):
            raise RuntimeError('RECONCILE_POSTCHECK_RECORD_MISMATCH')
        PROPOSAL.build(manifest_path, approved_manifest_sha256, root / 'operator', check_time())

    result = TRANSACTION._apply_record(envelope, root, candidate, inspect, preserve_previous=True,
                                       post_commit_check=postcheck)
    return {**result, 'scope': 'COMPONENT_OBSERVATION_RECORD_ONLY', 'rollbackCertified': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--approved-manifest-sha256', required=True)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--approved-stable-record-sha256')
    args = parser.parse_args()
    try:
        if args.apply:
            if args.approved_stable_record_sha256 is None:
                raise RuntimeError('RECONCILE_RECORD_APPROVAL_REQUIRED')
            result = apply(args.manifest, args.approved_manifest_sha256, args.approved_stable_record_sha256, args.actor)
        else:
            record = prepare(args.manifest, args.approved_manifest_sha256, args.actor)
            result = {'status': 'OBSERVATION_RECORD_PROPOSAL', 'stableRecordSha256': stable_sha(record),
                      'legacySourceSha': record['sourceSha'],
                      'componentSources': {key: value['sourceSha'] for key, value in record['components'].items()},
                      'previousPreserved': True, 'rollbackCertified': False}
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception:
        print(json.dumps({'status': 'OBSERVATION_RECONCILIATION_STOPPED_INSPECT_PENDING',
                          'automaticRetry': False, 'rollbackCertified': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
