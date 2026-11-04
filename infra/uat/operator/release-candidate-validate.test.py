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
        self.observation = {'schema': 'UatReleaseEvidenceObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
            'rollbackCertified': False, 'observedAt': self.now.isoformat().replace('+00:00', 'Z'),
            'runtime': runtime, 'runtimeSha256': hashlib.sha256(candidate.canonical(runtime)).hexdigest(),
            'protectedRuntimeSha256': 'a' * 64,
            'ledger': {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                       'finished': 154, 'rolledBack': 1, 'unresolved': 0, 'authorityMatches': 1}}

    def check(self, observation=None):
        observation = observation or self.observation
        sha = hashlib.sha256(candidate.canonical(observation)).hexdigest()
        return candidate.validate(observation, sha, self.now)

    def test_valid_observation_does_not_certify_or_authorize_record(self):
        result = self.check()
        self.assertEqual(result['status'], 'OBSERVATION_VALIDATED_NOT_RECORDABLE')
        self.assertFalse(result['rollbackCertified'])
        self.assertEqual(result['expectedCurrentSha256'], 'f' * 64)

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


if __name__ == '__main__':
    unittest.main()
