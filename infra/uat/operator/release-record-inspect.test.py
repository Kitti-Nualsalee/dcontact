import importlib.util
import json
import os
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
                'Image': 'sha256:' + ('c' if name == 'api' else 'a') * 64, 'Config': {'Image': 'example/image',
                'Env': ['PASSWORD=must-not-appear'], 'Labels': {'com.docker.compose.project': 'dcontact-uat',
                'org.opencontainers.image.revision': ('c' if name == 'api' else 'a') * 40}},
                'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}})

    def run_inspection(self):
        def execute(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64],
                    'Config': {'Labels': {'org.opencontainers.image.revision':
                        ('c' if image_id.endswith('c' * 64) else 'a') * 40}}} for image_id in args[3:]]).encode())
            self.assertEqual(args[:2], ['docker', 'inspect'])
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        return inspection.inspect(self.root, execute)

    def test_mount_order_does_not_change_configuration_hash(self):
        proxy = next(c for c in self.containers if c['Name'] == '/dcontact-uat-proxy-1')
        mounts = [{'Type': 'bind', 'Source': '/a', 'Destination': '/etc/caddy/Caddyfile'},
                  {'Type': 'bind', 'Source': '/b', 'Destination': '/run/dcontact-admission-fence'}]
        orders = iter([mounts, list(reversed(mounts))] * 4)
        def execute(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64],
                    'Config': {'Labels': {'org.opencontainers.image.revision':
                        ('c' if image_id.endswith('c' * 64) else 'a') * 40}}} for image_id in args[3:]]).encode())
            proxy['Mounts'] = next(orders)
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        result = inspection.inspect(self.root, execute)
        single = dict(self.containers[0], Mounts=[mounts[0]])
        config = {key: single[key] for key in ('Config', 'HostConfig', 'Mounts')}
        expected = inspection.hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.containers[0]['Mounts'] = [mounts[0]]
        self.assertEqual(self.run_inspection()['components'][inspection.SERVICES[0]]['configSha256'], expected)
        self.assertIn('proxy', result['components'])

    def test_detects_mixed_runtime_without_disclosing_environment(self):
        result = self.run_inspection()
        self.assertEqual(result['sourceMismatch'], ['api'])
        self.assertEqual(result['imageDigestMismatch'], [])
        self.assertFalse(result['rollbackCertified'])
        self.assertNotIn('must-not-appear', json.dumps(result))

    def component_reference(self):
        for index, container in enumerate(self.containers, 1):
            container['Id'] = str(index) * 64
            container['Config']['Image'] = 'example/image@sha256:' + 'a' * 64
        observed = self.run_inspection()
        path = self.root / 'deployments/current.json'
        record = json.loads(path.read_text())
        record.update(schema='UatDeploymentReconciliationV1', action='reconciliation', rollbackEligible=False,
            legacyAnchor={'kind': 'HISTORICAL_RELEASE_LAYOUT_NOT_CURRENT_RUNTIME', 'sourceSha': record['sourceSha']},
            components=observed['components'])
        path.write_text(json.dumps(record))
        return path, record

    def test_explicit_component_observation_uses_truth_instead_of_legacy_anchor(self):
        self.component_reference()
        result = self.run_inspection()
        self.assertEqual(result['sourceMismatch'], [])
        self.assertEqual(result['imageDigestMismatch'], [])
        self.assertEqual(result['componentConfigMismatch'], [])
        self.assertEqual(result['componentIdentityMismatch'], [])
        self.assertEqual(result['referenceKind'], 'PER_COMPONENT_OBSERVATION')
        self.assertFalse(result['rollbackCertified'])
        self.assertNotIn('must-not-appear', json.dumps(result))

    def test_component_record_reports_configuration_and_identity_drift(self):
        self.component_reference()
        self.containers[0]['Config']['Env'].append('FEATURE_FLAG=changed')
        self.containers[1]['State']['StartedAt'] = '2026-11-08T00:00:00Z'
        result = self.run_inspection()
        self.assertEqual(result['componentConfigMismatch'], ['api'])
        self.assertEqual(result['componentIdentityMismatch'], ['e1-sandbox'])

    def test_component_summary_does_not_copy_unrecognized_record_details(self):
        path, record = self.component_reference()
        record['components']['api']['unrecognizedDetails'] = 'DO_NOT_COPY_RECORD_EXTRA'
        record['legacyAnchor']['unrecognizedDetails'] = 'DO_NOT_COPY_ANCHOR_EXTRA'
        path.write_text(json.dumps(record))
        result = self.run_inspection()
        self.assertNotIn('DO_NOT_COPY_RECORD_EXTRA', json.dumps(result))
        self.assertNotIn('DO_NOT_COPY_ANCHOR_EXTRA', json.dumps(result))

    def test_component_reference_requires_quarantine_and_complete_inventory(self):
        path, record = self.component_reference()
        record['rollbackEligible'] = True
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, 'RECORD_COMPONENT_REFERENCE_INVALID'):
            self.run_inspection()
        record['rollbackEligible'] = False
        del record['components']['keycloak']
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, 'RECORD_COMPONENT_REFERENCE_INVALID'):
            self.run_inspection()

    def test_missing_previous_requires_explicit_opt_in(self):
        (self.root / 'deployments/previous.json').unlink()
        with self.assertRaises(FileNotFoundError):
            inspection.read_records(self.root)
        self.assertIsNone(inspection.read_records(self.root, allow_missing=True)['previous'])

    def test_pointer_fifo_and_symlink_fail_without_reading_target(self):
        path = self.root / 'deployments/current.json'
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(RuntimeError, 'RECORD_FILE_INVALID'):
            inspection.read_records(self.root)
        path.unlink()
        path.symlink_to(self.root / 'deployments/previous.json')
        with self.assertRaises(OSError):
            inspection.read_records(self.root)

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
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64],
                    'Config': {'Labels': {'org.opencontainers.image.revision':
                        ('c' if image_id.endswith('c' * 64) else 'a') * 40}}} for image_id in args[3:]]).encode())
            return SimpleNamespace(stdout=json.dumps(self.containers).encode())
        with self.assertRaisesRegex(RuntimeError, 'RECORD_CHANGED_DURING_INSPECTION'):
            inspection.inspect(self.root, execute)

    def test_container_recreation_during_observation_is_rejected(self):
        calls = 0
        def execute(args, **kwargs):
            nonlocal calls
            if args[:3] == ['docker', 'image', 'inspect']:
                return SimpleNamespace(stdout=json.dumps([{'Id': image_id,
                    'RepoDigests': ['example/image@sha256:' + 'a' * 64],
                    'Config': {'Labels': {'org.opencontainers.image.revision':
                        ('c' if image_id.endswith('c' * 64) else 'a') * 40}}} for image_id in args[3:]]).encode())
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

    def test_container_source_must_match_image_source(self):
        self.containers[0]['Config']['Labels']['org.opencontainers.image.revision'] = 'b' * 40
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_SOURCE_LABEL_MISMATCH'):
            self.run_inspection()

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
