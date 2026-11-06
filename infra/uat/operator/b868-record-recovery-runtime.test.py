import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('recovery_runtime', Path(__file__).with_name('b868-record-recovery-runtime.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.operator = self.root / 'operator'
        self.deployments = self.root / 'deployments'
        self.journal = self.operator / 'uat-record-transaction'
        for directory in (self.operator, self.deployments, self.journal):
            directory.mkdir(mode=0o700)
        self.put(self.operator / 'b714-cutover.lock', b'')
        self.source = 'a' * 40
        self.images = {key: f'example.test/{key}@sha256:' + 'b' * 64 for key in ('api', 'console', 'ops', 'keycloak')}
        desired = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'deploy',
                              'sourceSha': self.source, 'images': self.images}).encode()
        self.current, self.previous = b'old-current', b'old-previous'
        for directory, name, data in ((self.deployments, 'current.json', self.current),
                                      (self.deployments, 'previous.json', self.previous),
                                      (self.journal, 'current.json', self.current),
                                      (self.journal, 'previous.json', self.previous),
                                      (self.journal, 'desired.json', desired)):
            self.put(directory / name, data)
        self.put(self.journal / 'intent.json', json.dumps({'schema': 'UatRecordIntentV1',
                 'archive': '20261106T000000Z-' + self.source + '.json', 'desiredSha256': self.sha(desired),
                 'snapshots': {'current.json': self.sha(self.current), 'previous.json': self.sha(self.previous)}}).encode())
        self.observed = {'records': {'current': {'sha256': self.sha(self.current)},
                                     'previous': {'sha256': self.sha(self.previous)}}, 'components': {}}
        for service, key in {'api': 'api', 'e1-sandbox': 'api', 'proxy': 'console', 'keycloak': 'keycloak'}.items():
            self.observed['components'][service] = {'running': True, 'sourceSha': self.source,
                'imageReference': self.images[key], 'repositoryDigests': [self.images[key]],
                'containerId': 'c' * 64, 'imageId': 'sha256:' + 'd' * 64, 'configSha256': 'e' * 64,
                'secret': 'DO_NOT_DISCLOSE'}

    @staticmethod
    def sha(raw):
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def put(path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def probe(self, _root):
        return copy.deepcopy(self.observed)

    def execute(self, *_args, **_kwargs):
        return SimpleNamespace(stdout=json.dumps([{'Id': 'sha256:' + 'f' * 64, 'RepoDigests': [self.images['ops']],
            'Config': {'Labels': {'org.opencontainers.image.revision': self.source}}}]).encode())

    def evidence(self, now):
        self.observed.update({'schema': 'UatReleaseInspectionV1',
                              'runtimeConsistency': 'TWO_MATCHING_OBSERVATIONS', 'rollbackCertified': False})
        protected = {name: {'id': 'c' * 64, 'image': 'sha256:' + 'd' * 64,
                            'configSha256': 'e' * 64, 'running': True}
                     for name in MODULE.CANDIDATE.PROTECTED}
        return {'schema': 'UatReleaseEvidenceObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
                'rollbackCertified': False, 'observedAt': now.isoformat().replace('+00:00', 'Z'),
                'runtime': copy.deepcopy(self.observed),
                'runtimeSha256': self.sha(MODULE.CANDIDATE.canonical(self.observed)),
                'protectedRuntime': protected, 'protectedRuntimeSha256': self.sha(MODULE.CANDIDATE.canonical(protected)),
                'ledger': {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                           'finished': 1, 'rolledBack': 0, 'unresolved': 0, 'authorityMatches': 1,
                           'migrations': [{'name': MODULE.CANDIDATE.AUTHORITY_MIGRATION,
                                           'checksum': MODULE.CANDIDATE.AUTHORITY_CHECKSUM}]}}

    def test_match_does_not_authorize_recovery(self):
        result = MODULE.assess(self.root, self.probe, self.execute)
        self.assertEqual(result['status'], 'RUNTIME_MATCH_OBSERVED_NOT_CERTIFIED')
        self.assertFalse(result['ledgerVerified'])
        self.assertFalse(result['protectedRuntimeVerified'])
        self.assertFalse(result['recoveryAuthorized'])
        self.assertNotIn('DO_NOT_DISCLOSE', json.dumps(result))

    def test_mixed_runtime_and_wrong_ops_fail(self):
        self.observed['components']['proxy']['sourceSha'] = 'f' * 40
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_MISMATCH'):
            MODULE.assess(self.root, self.probe, self.execute)
        self.observed['components']['proxy']['sourceSha'] = self.source
        with self.assertRaisesRegex(RuntimeError, 'OPS_MISMATCH'):
            MODULE.assess(self.root, self.probe, lambda *_a, **_k: SimpleNamespace(stdout=b'[{}]'))

    def test_journal_or_record_drift_fails(self):
        def changed(root):
            result = self.probe(root)
            self.put(self.deployments / 'current.json', b'changed')
            return result
        with self.assertRaises(MODULE.JOURNAL.InvalidJournal):
            MODULE.assess(self.root, changed, self.execute)

    def test_runtime_drift_after_ops_check_fails(self):
        calls = 0
        def changed(root):
            nonlocal calls
            calls += 1
            result = self.probe(root)
            if calls == 2:
                result['components']['api']['containerId'] = 'f' * 64
            return result
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED'):
            MODULE.assess(self.root, changed, self.execute)

    def test_ops_image_changes_during_assessment_fails(self):
        calls = 0
        def changed(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            image = json.loads(self.execute().stdout)
            if calls == 2:
                image[0]['Id'] = 'sha256:' + '1' * 64
            return SimpleNamespace(stdout=json.dumps(image).encode())
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED'):
            MODULE.assess(self.root, self.probe, changed)

    def test_actual_runtime_probe_allows_absent_initial_pointers(self):
        for name in ('current.json', 'previous.json'):
            (self.deployments / name).unlink()
            (self.journal / name).unlink()
        intent_path = self.journal / 'intent.json'
        intent = json.loads(intent_path.read_bytes())
        intent['snapshots'] = {'current.json': None, 'previous.json': None}
        self.put(intent_path, json.dumps(intent).encode())
        def docker(args, **_kwargs):
            if args[:2] == ['docker', 'inspect']:
                rows = []
                for service, key in {'api': 'api', 'e1-sandbox': 'api', 'proxy': 'console', 'keycloak': 'keycloak'}.items():
                    rows.append({'Name': '/dcontact-uat-' + service + '-1', 'Id': 'c' * 64,
                                 'Image': 'sha256:' + 'd' * 64,
                                 'Config': {'Image': self.images[key], 'Labels': {
                                     'com.docker.compose.project': 'dcontact-uat',
                                     'org.opencontainers.image.revision': self.source}},
                                 'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}})
                return SimpleNamespace(stdout=json.dumps(rows).encode())
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': ref if ref.startswith('sha256:') else 'sha256:' + 'f' * 64,
                    'RepoDigests': list(self.images.values()),
                    'Config': {'Labels': {'org.opencontainers.image.revision': self.source}}}
                    for ref in args[3:]]).encode())
            raise AssertionError('unexpected command')
        result = MODULE.assess(self.root, execute=docker)
        self.assertEqual(result['status'], 'RUNTIME_MATCH_OBSERVED_NOT_CERTIFIED')
        self.assertFalse(result['recoveryAuthorized'])

    def test_optional_ledger_and_protected_evidence_is_bound_but_not_authorized(self):
        now = datetime.now(timezone.utc)
        evidence = self.evidence(now)
        result = MODULE.assess(self.root, self.probe, self.execute, evidence, now)
        self.assertEqual(result['suppliedEvidenceStatus'], 'CONSISTENT_NOT_REVIEWED_OR_CERTIFIED')
        self.assertFalse(result['recoveryAuthorized'])
        self.assertFalse(result['ledgerVerified'])
        self.assertFalse(result['protectedRuntimeVerified'])
        self.assertNotIn('DO_NOT_DISCLOSE', json.dumps(result))
        evidence['ledger']['unresolved'] = 1
        with self.assertRaisesRegex(RuntimeError, 'LEDGER_INCOMPLETE'):
            MODULE.assess(self.root, self.probe, self.execute, evidence, now)

    def test_evidence_for_different_or_stale_runtime_fails(self):
        now = datetime.now(timezone.utc)
        evidence = self.evidence(now)
        evidence['runtime']['components']['api']['sourceSha'] = 'f' * 40
        evidence['runtimeSha256'] = self.sha(MODULE.CANDIDATE.canonical(evidence['runtime']))
        with self.assertRaisesRegex(RuntimeError, 'EVIDENCE_RUNTIME_MISMATCH'):
            MODULE.assess(self.root, self.probe, self.execute, evidence, now)
        evidence = self.evidence(now - timedelta(seconds=301))
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            MODULE.assess(self.root, self.probe, self.execute, evidence, now)

    def test_runtime_change_after_evidence_binding_fails(self):
        now = datetime.now(timezone.utc)
        evidence = self.evidence(now)
        calls = 0
        def changed(root):
            nonlocal calls
            calls += 1
            result = self.probe(root)
            if calls == 3:
                result['components']['api']['containerId'] = 'f' * 64
            return result
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED'):
            MODULE.assess(self.root, changed, self.execute, evidence, now)

    def test_evidence_expiring_during_runtime_recheck_fails(self):
        now = datetime.now(timezone.utc)
        evidence = self.evidence(now - timedelta(seconds=299))
        times = iter([now, now + timedelta(seconds=2)])
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            MODULE.assess(self.root, self.probe, self.execute, evidence, lambda: next(times))

    def test_optional_evidence_rejects_missing_pointer_without_relaxing_proof(self):
        (self.deployments / 'previous.json').unlink()
        (self.journal / 'previous.json').unlink()
        intent_path = self.journal / 'intent.json'
        intent = json.loads(intent_path.read_bytes())
        intent['snapshots']['previous.json'] = None
        self.put(intent_path, json.dumps(intent).encode())
        self.observed['records']['previous'] = None
        now = datetime.now(timezone.utc)
        evidence = self.evidence(now)
        with self.assertRaisesRegex(RuntimeError, 'EVIDENCE_POINTERS_REQUIRED'):
            MODULE.assess(self.root, self.probe, self.execute, evidence, now)


if __name__ == '__main__':
    unittest.main()
