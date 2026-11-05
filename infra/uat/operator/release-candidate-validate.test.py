import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('release-candidate-validate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        component = {'containerId': 'a' * 64, 'imageId': 'sha256:' + 'b' * 64,
                     'sourceSha': 'c' * 40, 'configSha256': 'd' * 64, 'running': True,
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
        proof['migrationManifest']['migrations'][0]['checksum'] = 'a' * 64
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


if __name__ == '__main__':
    unittest.main()
