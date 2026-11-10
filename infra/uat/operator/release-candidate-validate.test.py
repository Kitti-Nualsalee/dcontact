import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('release-candidate-validate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        component = {'containerId': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64,
                     'sourceSha': 'c' * 40, 'configSha256': 'd' * 64, 'running': True,
                     'imageReference': 'example/image@sha256:' + 'e' * 64,
                     'repositoryDigests': ['example/image@sha256:' + 'e' * 64]}
        runtime = {'schema': 'UatReleaseInspectionV1', 'runtimeConsistency': 'TWO_MATCHING_OBSERVATIONS',
                   'rollbackCertified': False, 'components': {name: copy.deepcopy(component) for name in candidate.SERVICES},
                   'records': {'current': {'sha256': 'f' * 64}, 'previous': {'sha256': 'e' * 64}}}
        protected = {name: {'id': 'a' * 64, 'image': 'sha256:' + 'b' * 64,
                            'configSha256': 'd' * 64, 'running': True} for name in candidate.PROTECTED}
        self.observation = {'schema': 'UatReleaseEvidenceObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
            'rollbackCertified': False, 'observedAt': self.now.isoformat().replace('+00:00', 'Z'),
            'runtime': runtime, 'runtimeSha256': hashlib.sha256(candidate.canonical(runtime)).hexdigest(),
            'protectedRuntime': protected,
            'protectedRuntimeSha256': hashlib.sha256(candidate.canonical(protected)).hexdigest(),
            'ledger': {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                       'finished': 154, 'rolledBack': 1, 'unresolved': 0, 'authorityMatches': 1,
                       'migrations': [{'name': f'migration-{i:03d}', 'checksum': 'a' * 64} for i in range(154)]}}
        self.observation['ledger']['migrations'][0] = {'name': candidate.AUTHORITY_MIGRATION, 'checksum': candidate.AUTHORITY_CHECKSUM}

    def test_authority_identity_matches_repository_migration(self):
        name = '20261103120000_tenant_provisioned_configuration_authority'
        migration = Path(__file__).resolve().parents[3] / 'packages/db/prisma/migrations' / name / 'migration.sql'
        self.assertEqual(candidate.AUTHORITY_MIGRATION, name)
        self.assertEqual(candidate.AUTHORITY_CHECKSUM, hashlib.sha256(migration.read_bytes()).hexdigest())

    def test_rejects_authority_count_without_exact_migration(self):
        migration = self.observation['ledger']['migrations'][0]
        for key, value in [('name', 'different_migration'), ('checksum', '0' * 64)]:
            with self.subTest(key=key):
                original = migration[key]
                migration[key] = value
                with self.assertRaisesRegex(RuntimeError, 'LEDGER_AUTHORITY_MISMATCH'):
                    candidate.validate_unreviewed(self.observation, self.now)
                migration[key] = original

    def check(self, observation=None):
        observation = observation or self.observation
        sha = hashlib.sha256(candidate.canonical(observation)).hexdigest()
        return candidate.validate(observation, sha, self.now)

    def test_valid_observation_does_not_certify_or_authorize_record(self):
        result = self.check()
        self.assertEqual(result['status'], 'OBSERVATION_VALIDATED_NOT_RECORDABLE')
        self.assertFalse(result['rollbackCertified'])
        self.assertEqual(result['expectedCurrentSha256'], 'f' * 64)
        unreviewed = candidate.validate_unreviewed(self.observation, self.now)
        self.assertEqual(unreviewed['status'], 'OBSERVATION_CONSISTENT_NOT_REVIEWED')
        self.assertNotIn('observationSha256', unreviewed)

    def test_unapproved_or_stale_observation_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'APPROVED_OBSERVATION'):
            candidate.validate(self.observation, '0' * 64, self.now)
        self.observation['observedAt'] = (self.now - timedelta(seconds=301)).isoformat().replace('+00:00', 'Z')
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            self.check()

    def test_runtime_tamper_or_unknown_component_is_rejected(self):
        self.observation['runtime']['components']['api']['sourceSha'] = 'tampered'
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_BINDING'):
            self.check()
        self.observation['runtimeSha256'] = hashlib.sha256(candidate.canonical(self.observation['runtime'])).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'COMPONENT_IDENTITY'):
            self.check()

    def test_rejects_unpinned_or_mismatched_component_reference(self):
        component = self.observation['runtime']['components']['proxy']
        for reference in ('example/image:latest', 'example/image@sha256:' + 'f' * 64,
                          'other/image@sha256:' + 'e' * 64):
            with self.subTest(reference=reference):
                component['imageReference'] = reference
                self.observation['runtimeSha256'] = hashlib.sha256(candidate.canonical(self.observation['runtime'])).hexdigest()
                with self.assertRaisesRegex(RuntimeError, 'COMPONENT_REFERENCE_MISMATCH'):
                    candidate.validate_unreviewed(self.observation, self.now)

    def test_unresolved_migration_and_false_certification_are_rejected(self):
        self.observation['ledger']['unresolved'] = 1
        with self.assertRaisesRegex(RuntimeError, 'LEDGER_INCOMPLETE'):
            self.check()
        self.observation['ledger']['unresolved'] = 0
        self.observation['rollbackCertified'] = True
        with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_NOT_ELIGIBLE'):
            self.check()

    def test_protected_component_must_match_runtime_observation(self):
        protected = self.observation['protectedRuntime']
        protected['/dcontact-uat-keycloak-1']['id'] = 'f' * 64
        self.observation['protectedRuntimeSha256'] = hashlib.sha256(candidate.canonical(protected)).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'PROTECTED_COMPONENT_MISMATCH'):
            self.check()

    def test_copy_rehearsal_does_not_certify_vm_rollback(self):
        proof = {'status': 'COPY_OWNER_ACL_STANDARD_MIGRATIONS_GENERATED_WRITER_PASS',
                 'scope': 'B714_VM2_APP_PERMISSION_COPY_ONLY', 'sourceSha': 'c' * 40,
                 'images': {'api': 'sha256:' + 'b' * 64},
                 'migrationManifest': {'migrations': copy.deepcopy(self.observation['ledger']['migrations'])},
                 'ledger': {'afterFinished': 154, 'rolledBackPreserved': 1,
                            'historicalRowsByteValuesPreserved': True, 'secondDeploy': 'NOOP'},
                 'limitations': ['OLD_API_803_DATA_COMPATIBILITY_NOT_NEW_B2_AUTHORITY_OR_VM_ROLLBACK']}
        def check():
            sha = hashlib.sha256(candidate.canonical(proof)).hexdigest()
            observation_sha = hashlib.sha256(candidate.canonical(self.observation)).hexdigest()
            return candidate.validate_rehearsal(self.observation, observation_sha, proof, sha, self.now)
        self.assertFalse(check()['rollbackCertified'])
        proof['migrationManifest']['migrations'][0]['checksum'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_CHECKSUM_MISMATCH'):
            check()
        proof['migrationManifest']['migrations'][0]['checksum'] = candidate.AUTHORITY_CHECKSUM
        proof['ledger']['secondDeploy'] = 'APPLIED'
        with self.assertRaisesRegex(RuntimeError, 'LEDGER_MISMATCH'):
            check()
        proof['ledger']['secondDeploy'] = 'NOOP'
        proof['sourceSha'] = 'd' * 40
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_MISMATCH'):
            check()
        proof['sourceSha'] = 'c' * 40
        proof['images']['api'] = 'sha256:' + 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'API_IMAGE_MISMATCH'):
            check()


class ApiRollbackTests(unittest.TestCase):
    def setUp(self):
        fixture = CandidateTests()
        fixture.setUp()
        self.now, self.observation = fixture.now, fixture.observation
        runtime = self.observation['runtime']
        runtime['records']['current'].update(schema='UatDeploymentReconciliationV1', action='reconciliation',
            rollbackEligible=False, sourceSha='1' * 40, components=copy.deepcopy(runtime['components']),
            legacyAnchor={'kind': 'HISTORICAL_RELEASE_LAYOUT_NOT_CURRENT_RUNTIME', 'sourceSha': '1' * 40})
        runtime['records']['previous']['sourceSha'] = '2' * 40
        runtime.update(referenceKind='PER_COMPONENT_OBSERVATION', sourceMismatch=[], imageDigestMismatch=[],
                       componentConfigMismatch=[], componentIdentityMismatch=[])
        migrations = self.observation['ledger']['migrations']
        for i, item in enumerate(migrations[1:], 1):
            item['name'] = f'20260101000000_migration_{i:03d}'
        baseline = copy.deepcopy(migrations)
        migrated = baseline + [{'name': '20261103130000_m3_service_principals', 'checksum': 'b' * 64}]
        target = runtime['components']['api']
        new_image = 'example/image@sha256:' + 'f' * 64
        ops_image = 'example/ops@sha256:' + '9' * 64
        new_source = 'd' * 40
        self.package = (f'SOURCE_SHA={new_source}\nAPI_IMAGE={new_image}\nOPS_IMAGE={ops_image}\nUAT_WORKSPACE_ENABLED=true\n').encode()
        self.guard = {'type': 'u1.uat.readiness', 'mode': 'migration-guard', 'status': 'PASS',
                      'base': '1' * 40, 'head': new_source,
                      'checks': [{'id': 'UAT-M01 migration', 'status': 'PASS',
                                  'added': ['packages/db/prisma/migrations/20261103130000_m3_service_principals/migration.sql']}]}
        self.rehearsal = {'schema': 'UatApiRollbackRehearsalV1', 'scope': 'ISOLATED_POSTGRES_SYNTHETIC_IDENTITY',
                          'protectedFixtureAndLedgerPreserved': True, 'candidateReleaseEnvSha256': self.raw_digest(self.package),
                          'candidateOpsImage': ops_image, 'candidateMigrationGuardSha256': self.digest(self.guard),
                          'baselineMigrations': baseline, 'candidateMigrations': copy.deepcopy(migrated), 'phases': []}
        for phase, source, image, ledger in (
            ('baseline', target['sourceSha'], target['imageReference'], baseline),
            ('candidate', new_source, new_image, migrated),
            ('rollback', target['sourceSha'], target['imageReference'], migrated),
            ('recovery', new_source, new_image, migrated),
        ):
            self.rehearsal['phases'].append({'phase': phase, 'sourceSha': source, 'apiImage': image,
                'profile': 'uat-workspace', 'migrationChecksumsSha256': self.digest({m['name']: m['checksum'] for m in ledger}),
                'agentSnapshot': 200, 'mismatchedTenant': 401, 'providerEgress': 'BLOCKED'})

    @staticmethod
    def raw_digest(raw):
        return hashlib.sha256(raw).hexdigest()

    def digest(self, document):
        return self.raw_digest(candidate.canonical(document))

    def check(self, reviewed=None, now=None):
        self.observation['runtimeSha256'] = self.digest(self.observation['runtime'])
        return candidate.validate_api_rollback_rehearsal(self.observation, self.digest(self.observation),
            self.rehearsal, reviewed or self.digest(self.rehearsal), self.package, candidate.canonical(self.guard), now or self.now)

    def test_matches_mixed_runtime_and_additive_schema_without_authorization(self):
        result = self.check()
        self.assertEqual(result['status'], 'ISOLATED_API_ROLLBACK_REHEARSAL_MATCHES_BASELINE')
        self.assertEqual(result['targetSourceSha'], 'c' * 40)
        self.assertFalse(result['rollbackEligible'])
        self.assertFalse(result['rollbackCertified'])

    def test_rejects_changed_approval_or_stale_observation(self):
        with self.assertRaisesRegex(RuntimeError, 'APPROVED_API_ROLLBACK_REHEARSAL_MISMATCH'):
            self.check(reviewed='0' * 64)
        with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_STALE_OR_FUTURE'):
            self.check(now=self.now + timedelta(seconds=301))

    def test_rejects_current_runtime_or_identity_component_drift(self):
        for name in ('api', 'keycloak'):
            with self.subTest(name=name):
                current = self.observation['runtime']['records']['current']
                original = current['components'][name]['configSha256']
                current['components'][name]['configSha256'] = '0' * 64
                with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_BASELINE_RUNTIME_DRIFT'):
                    self.check()
                current['components'][name]['configSha256'] = original

    def test_rejects_changed_live_schema_and_non_additive_candidate(self):
        live = self.observation['ledger']['migrations'][1]
        original = live['checksum']
        live['checksum'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_BASELINE_LEDGER_MISMATCH'):
            self.check()
        live['checksum'] = original
        self.rehearsal['candidateMigrations'].pop(1)
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_CANDIDATE_LEDGER_NOT_ADDITIVE'):
            self.check()

    def test_rejects_modified_package_and_historical_anchor(self):
        self.package += b'# modified\n'
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_PACKAGE_HASH_MISMATCH'):
            self.check()
        self.package = self.package.replace(b'd' * 40, b'1' * 40)
        self.rehearsal['candidateReleaseEnvSha256'] = self.raw_digest(self.package)
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_PACKAGE_INVALID'):
            self.check()

    def test_rejects_same_image_under_another_repository(self):
        self.package = self.package.replace(b'example/image@sha256:' + b'f' * 64, b'other/image@sha256:' + b'e' * 64)
        self.rehearsal['candidateReleaseEnvSha256'] = self.raw_digest(self.package)
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_PACKAGE_INVALID'):
            self.check()

    def test_rejects_mismatched_ops_image_or_migration_guard(self):
        self.guard['head'] = '7' * 40
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_MIGRATION_GUARD_HASH_MISMATCH'):
            self.check()
        self.rehearsal['candidateMigrationGuardSha256'] = self.digest(self.guard)
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_MIGRATION_GUARD_INVALID'):
            self.check()
        self.guard['head'] = 'd' * 40
        self.guard['checks'][0]['added'] = []
        self.rehearsal['candidateMigrationGuardSha256'] = self.digest(self.guard)
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_MIGRATION_GUARD_LEDGER_MISMATCH'):
            self.check()
        self.rehearsal['candidateOpsImage'] = 'example/ops@sha256:' + '7' * 64
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_OPS_IMAGE_MISMATCH'):
            self.check()

    def test_rejects_wrong_api_image_schema_or_missing_recovery(self):
        phases = self.rehearsal['phases']
        rollback = phases[2]
        for key, value in [('apiImage', phases[1]['apiImage']),
                           ('migrationChecksumsSha256', phases[0]['migrationChecksumsSha256']),
                           ('mismatchedTenant', 200)]:
            with self.subTest(key=key):
                original = rollback[key]
                rollback[key] = value
                with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_PHASE_MISMATCH'):
                    self.check()
                rollback[key] = original
        phases.pop()
        with self.assertRaisesRegex(RuntimeError, 'API_ROLLBACK_PHASE_MISMATCH'):
            self.check()

    def test_cli_reports_receipt_and_exits_nonzero_for_changed_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            observation, rehearsal, release_env, guard = (root / name for name in (
                'observation.json', 'rehearsal.json', 'release.env', 'migration-guard.json'))
            self.check()
            observation.write_bytes(candidate.canonical(self.observation))
            rehearsal.write_bytes(candidate.canonical(self.rehearsal))
            release_env.write_bytes(self.package)
            guard.write_bytes(candidate.canonical(self.guard))
            command = [sys.executable, '-B', candidate.__file__, '--observation', str(observation),
                       '--approved-observation-sha256', self.digest(self.observation), '--api-rehearsal', str(rehearsal),
                       '--approved-rehearsal-sha256', self.digest(self.rehearsal), '--release-env', str(release_env),
                       '--migration-guard', str(guard)]
            result = subprocess.run(command, capture_output=True, check=True)
            self.assertFalse(json.loads(result.stdout)['rollbackCertified'])
            release_env.write_bytes(self.package + b'\n')
            result = subprocess.run(command, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['reason'], 'API_ROLLBACK_PACKAGE_HASH_MISMATCH')
            release_env.unlink()
            os.mkfifo(release_env)
            result = subprocess.run(command, capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['reason'], 'API_ROLLBACK_INPUT_FILE_INVALID')


if __name__ == '__main__':
    unittest.main()
