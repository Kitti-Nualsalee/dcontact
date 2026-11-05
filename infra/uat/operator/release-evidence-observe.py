#!/usr/bin/env python3
"""ผูก observation ของ runtime กับ migration ledger โดยไม่รับรอง rollback."""
import hashlib
import importlib.util
import json
import re
from datetime import datetime, timezone
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
HELPER = Path('/opt/dcontact-uat/operator/b714-candidate-80395853-package/routing-1714-tmpfs-20261103.py')
HELPER_SHA = 'e96b06a16e5f7722b4fa1908805ec2a247e1fcf760ea2a08152e0fb21edcf10a'
AUTHORITY_CHECKSUM = 'f5feda4f26297ed4bc98aa85c1e298e43e7292e44d66791b0f708fa6d53c8c47'
AUTHORITY_MIGRATION = '20261103120000_tenant_provisioned_configuration_authority'
QUERY = """SELECT json_build_object('database',current_database(),'principal',current_user,
'readonly',current_setting('transaction_read_only'),
'finished',count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
'rolledBack',count(*) FILTER (WHERE rolled_back_at IS NOT NULL AND finished_at IS NULL),
'unresolved',count(*) FILTER (WHERE (finished_at IS NULL) = (rolled_back_at IS NULL)),
'authorityMatches',count(*) FILTER (WHERE migration_name='%s' AND checksum='%s' AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
'migrations',COALESCE(json_agg(json_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name)
  FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),'[]'::json))
FROM public._prisma_migrations;""" % (AUTHORITY_MIGRATION, AUTHORITY_CHECKSUM)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def observe(inspect_runtime, protected_snapshot, read_ledger):
    protected = protected_snapshot()
    runtime = inspect_runtime()
    ledger = json.loads(read_ledger(QUERY))
    if (ledger.get('database'), ledger.get('principal'), ledger.get('readonly')) != (
            'dcontact_uat', 'dcontact_uat_owner', 'on'):
        raise RuntimeError('LEDGER_SCOPE_REQUIRED')
    if any(type(ledger.get(key)) is not int or ledger[key] < 0
           for key in ('finished', 'rolledBack', 'unresolved', 'authorityMatches')):
        raise RuntimeError('LEDGER_COUNTS_INVALID')
    if ledger.get('unresolved') != 0 or ledger.get('authorityMatches') != 1:
        raise RuntimeError('LEDGER_INCOMPLETE')
    if ledger['finished'] < ledger['authorityMatches']:
        raise RuntimeError('LEDGER_COUNTS_INVALID')
    migrations = ledger.get('migrations')
    if (not isinstance(migrations, list) or len(migrations) != ledger['finished'] or len(migrations) > 5000
            or any(not isinstance(item, dict) or set(item) != {'name', 'checksum'}
                   or not isinstance(item['name'], str) or not item['name']
                   or not isinstance(item['checksum'], str) or not re.fullmatch('[0-9a-f]{64}', item['checksum'])
                   for item in migrations)
            or len({item['name'] for item in migrations}) != len(migrations)):
        raise RuntimeError('LEDGER_MIGRATIONS_INVALID')
    if {'name': AUTHORITY_MIGRATION, 'checksum': AUTHORITY_CHECKSUM} not in migrations:
        raise RuntimeError('LEDGER_AUTHORITY_MISMATCH')
    if inspect_runtime() != runtime:
        raise RuntimeError('RUNTIME_CHANGED_DURING_LEDGER_READ')
    if protected_snapshot() != protected:
        raise RuntimeError('PROTECTED_RUNTIME_CHANGED')
    return {'schema': 'UatReleaseEvidenceObservationV1', 'runtimeSha256': digest(runtime),
            'runtime': runtime,
            'protectedRuntimeSha256': digest(protected), 'protectedRuntime': protected, 'ledger': ledger,
            'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'status': 'OBSERVED_NOT_CERTIFIED', 'rollbackCertified': False}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    if hashlib.sha256(HELPER.read_bytes()).hexdigest() != HELPER_SHA:
        raise RuntimeError('REVIEWED_HELPER_CHANGED')
    helper = load_module('reviewed_helper', HELPER)
    inspector = load_module('release_inspector', DIRECTORY / 'release-record-inspect.py')
    print(json.dumps(observe(inspector.inspect, helper.runtime_snapshot, helper.database()), sort_keys=True))
