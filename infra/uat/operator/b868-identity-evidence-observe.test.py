import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('identity', Path(__file__).with_name('b868-identity-evidence-observe.py'))
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


def runtime(api='sha256:' + 'a' * 64):
    component = lambda image: {'imageId': image, 'repositoryDigests': ['r@sha256:' + 'b' * 64],
                               'sourceSha': 'c' * 40, 'containerId': 'x', 'configSha256': 'd' * 64,
                               'running': True}
    return {'api': component(api), 'keycloak': component('sha256:' + 'e' * 64),
            'proxy': component('sha256:' + 'f' * 64)}


def evidence(status='CONSISTENT', **extra):
    value = {'schema': 'UatPeopleIdentityEvidenceV1', 'status': status, 'rollbackCertified': False,
             'evidenceSha256': '9' * 64, 'tenants': [{'tenantId': 't', 'mismatches': []}]}
    value.update(extra)
    return value


class IdentityObserveTests(unittest.TestCase):
    def run_observe(self, output, code=0, runtimes=None):
        runtimes = list(runtimes or [runtime(), runtime()])
        calls = []

        def execute(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=code, stdout=output.encode() if isinstance(output, str) else output,
                                   stderr=b'')
        return identity.observe(lambda: runtimes.pop(0), execute), calls

    def test_consistent_binds_api_and_keycloak_runtime(self):
        result, calls = self.run_observe(json.dumps(evidence()) + '\n')
        self.assertEqual(result['status'], 'CONSISTENT')
        self.assertEqual(calls, [identity.COMMAND])
        self.assertEqual(set(result['runtime']), {'api', 'keycloak'})
        self.assertEqual(result['runtime']['keycloak']['imageId'], 'sha256:' + 'e' * 64)
        self.assertFalse(result['rollbackCertified'])

    def test_inconsistent_is_reported_not_raised(self):
        result, _ = self.run_observe(json.dumps(evidence('INCONSISTENT')), code=2)
        self.assertEqual(result['status'], 'INCONSISTENT')

    def test_rejects_unavailable_invalid_or_mismatched_exit(self):
        for output, code, error in [
            ('', 1, 'IDENTITY_EVIDENCE_UNAVAILABLE'),
            ('{}', 0, 'IDENTITY_EVIDENCE_INVALID'),
            ('a\nb', 0, 'IDENTITY_EVIDENCE_INVALID'),
            (json.dumps(evidence('INCONSISTENT')), 0, 'IDENTITY_EVIDENCE_INVALID'),
            (json.dumps(evidence(rollbackCertified=True)), 0, 'IDENTITY_EVIDENCE_INVALID'),
            (json.dumps(evidence(tenants=[])), 0, 'IDENTITY_EVIDENCE_INVALID'),
            (json.dumps(evidence()), 137, 'IDENTITY_EVIDENCE_UNAVAILABLE'),
            ('', 1, 'IDENTITY_EVIDENCE_UNAVAILABLE:UNKNOWN'),
        ]:
            with self.subTest(output=output, code=code), self.assertRaisesRegex(RuntimeError, error):
                self.run_observe(output, code)

    def test_unavailable_reports_cli_error_code_only(self):
        def execute(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout=b'',
                                   stderr=b'{"status":"FAILED","error":"INVALID_PEOPLE_CONFIGURATION"}\n')
        with self.assertRaisesRegex(RuntimeError, 'IDENTITY_EVIDENCE_UNAVAILABLE:INVALID_PEOPLE_CONFIGURATION$'):
            identity.observe(lambda: runtime(), execute)

        def leaky(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout=b'', stderr=b'{"error":"secret value here"}')
        with self.assertRaisesRegex(RuntimeError, 'IDENTITY_EVIDENCE_UNAVAILABLE:UNKNOWN$'):
            identity.observe(lambda: runtime(), leaky)

    def test_rejects_runtime_change_or_missing_component(self):
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED_DURING_IDENTITY_READ'):
            self.run_observe(json.dumps(evidence()), runtimes=[runtime(), runtime('sha256:' + '0' * 64)])
        missing = runtime()
        del missing['keycloak']
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_COMPONENT_REQUIRED'):
            self.run_observe(json.dumps(evidence()), runtimes=[missing])


if __name__ == '__main__':
    unittest.main()
