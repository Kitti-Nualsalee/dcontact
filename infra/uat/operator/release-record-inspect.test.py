import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('inspection', Path(__file__).with_name('release-record-inspect.py'))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        records = self.root / 'deployments'
        records.mkdir()
        images = {name: 'example/image@sha256:' + 'a' * 64 for name in ('api', 'console', 'keycloak')}
        (records / 'current.json').write_text(json.dumps({'sourceSha': 'a' * 40, 'images': images}))
        (records / 'previous.json').write_text(json.dumps({'sourceSha': 'b' * 40}))
        self.containers = []
        for name in inspection.SERVICES:
            self.containers.append({'Name': '/dcontact-uat-' + name + '-1', 'Id': name,
                'Image': 'sha256:' + 'a' * 64, 'Config': {'Image': 'example/image',
                'Env': ['PASSWORD=must-not-appear'], 'Labels': {'com.docker.compose.project': 'dcontact-uat',
                'org.opencontainers.image.revision': ('c' if name == 'api' else 'a') * 40}},
                'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}})

    def run_inspection(self):
        def execute(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64]} for image_id in args[3:]]).encode())
            self.assertEqual(args[:2], ['docker', 'inspect'])
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        return inspection.inspect(self.root, execute)

    def test_detects_mixed_runtime_without_disclosing_environment(self):
        result = self.run_inspection()
        self.assertEqual(result['sourceMismatch'], ['api'])
        self.assertEqual(result['imageDigestMismatch'], [])
        self.assertFalse(result['rollbackCertified'])
        self.assertNotIn('must-not-appear', json.dumps(result))

    def test_recorded_digest_mismatch_is_reported_per_component(self):
        path = self.root / 'deployments' / 'current.json'
        record = json.loads(path.read_text())
        record['images']['api'] = 'example/image@sha256:' + 'b' * 64
        path.write_text(json.dumps(record))
        self.assertEqual(self.run_inspection()['imageDigestMismatch'], ['api', 'e1-sandbox'])

    def test_missing_container_fails_closed(self):
        self.containers.pop()
        with self.assertRaisesRegex(RuntimeError, 'INVENTORY_CHANGED'):
            self.run_inspection()

    def test_record_change_during_observation_is_rejected(self):
        def execute(args, **kwargs):
            (self.root / 'deployments' / 'current.json').write_text(json.dumps({'sourceSha': 'd' * 40}))
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64]} for image_id in args[3:]]).encode())
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        with self.assertRaisesRegex(RuntimeError, 'RECORD_CHANGED_DURING_INSPECTION'):
            inspection.inspect(self.root, execute)

    def test_container_recreation_during_observation_is_rejected(self):
        calls = 0
        def execute(args, **kwargs):
            nonlocal calls
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64]} for image_id in args[3:]]).encode())
            calls += 1
            if calls == 2:
                self.containers[0]['Id'] = 'replacement'
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED_DURING_INSPECTION'):
            inspection.inspect(self.root, execute)

    def test_missing_immutable_repository_digest_is_rejected(self):
        def execute(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id, 'RepoDigests': []}
                                                          for image_id in args[3:]]).encode())
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_REPOSITORY_DIGEST_REQUIRED'):
            inspection.inspect(self.root, execute)

    def test_unknown_source_and_image_are_rejected(self):
        labels = self.containers[0]['Config']['Labels']
        labels['org.opencontainers.image.revision'] = 'unknown'
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_SOURCE_REQUIRED'):
            self.run_inspection()
        labels['org.opencontainers.image.revision'] = 'a' * 40
        self.containers[0]['Image'] = 'mutable-tag'
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_IMAGE_ID_REQUIRED'):
            self.run_inspection()

    def test_wrong_project_or_stopped_container_fails_closed(self):
        self.containers[0]['Config']['Labels']['com.docker.compose.project'] = 'other'
        with self.assertRaisesRegex(RuntimeError, 'PROJECT_MISMATCH'):
            self.run_inspection()
        self.containers[0]['Config']['Labels']['com.docker.compose.project'] = 'dcontact-uat'
        self.containers[0]['State']['Running'] = False
        with self.assertRaisesRegex(RuntimeError, 'NOT_RUNNING'):
            self.run_inspection()


if __name__ == '__main__':
    unittest.main()
