import copy
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
        return SimpleNamespace(stdout=json.dumps([{'RepoDigests': [self.images['ops']],
            'Config': {'Labels': {'org.opencontainers.image.revision': self.source}}}]).encode())

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
                return SimpleNamespace(stdout=json.dumps([{'Id': ref, 'RepoDigests': list(self.images.values()),
                    'Config': {'Labels': {'org.opencontainers.image.revision': self.source}}}
                    for ref in args[3:]]).encode())
            raise AssertionError('unexpected command')
        result = MODULE.assess(self.root, execute=docker)
        self.assertEqual(result['status'], 'RUNTIME_MATCH_OBSERVED_NOT_CERTIFIED')
        self.assertFalse(result['recoveryAuthorized'])


if __name__ == '__main__':
    unittest.main()
