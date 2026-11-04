import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('release-evidence-observe.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.runtime = {'api': {'imageId': 'a'}}
        self.protected = {'platform': {'id': 'b'}}
        self.ledger = {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                       'finished': 154, 'rolledBack': 1, 'unresolved': 0, 'authorityMatches': 1}

    def capture(self, runtime=None, protected=None):
        return evidence.observe(runtime or (lambda: self.runtime), protected or (lambda: self.protected),
                                lambda _: json.dumps(self.ledger).encode())

    def test_observation_binds_inputs_without_certifying_rollback(self):
        result = self.capture()
        self.assertEqual(result['runtimeSha256'], evidence.digest(self.runtime))
        self.assertEqual(result['protectedRuntimeSha256'], evidence.digest(self.protected))
        self.assertFalse(result['rollbackCertified'])

    def test_rejects_wrong_scope_or_incomplete_ledger(self):
        for key, value, reason in [('readonly', 'off', 'SCOPE'), ('database', 'other', 'SCOPE'),
                                   ('unresolved', 1, 'INCOMPLETE'), ('authorityMatches', 0, 'INCOMPLETE')]:
            with self.subTest(key=key):
                original = self.ledger[key]
                self.ledger[key] = value
                with self.assertRaisesRegex(RuntimeError, reason):
                    self.capture()
                self.ledger[key] = original

    def test_rejects_runtime_or_protected_drift(self):
        for keyword in ('runtime', 'protected'):
            with self.subTest(keyword=keyword):
                values = iter([{'before': True}, {'after': True}])
                with self.assertRaisesRegex(RuntimeError, 'CHANGED'):
                    self.capture(**{keyword: lambda: next(values)})


if __name__ == '__main__':
    unittest.main()
