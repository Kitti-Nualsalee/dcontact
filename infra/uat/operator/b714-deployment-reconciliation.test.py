import importlib.util
import copy
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
import stat
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('reconciliation', str(Path(__file__).with_name('b714-deployment-reconciliation.py')))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.operator = self.root / 'operator'
        self.operator.mkdir()
        (self.root / 'deployments').mkdir()
        self.now = datetime.now(timezone.utc)
        self.observed = self.now.isoformat().replace('+00:00', 'Z')
        self.media = self.root / 'media/state.json'
        self.write(self.media, {'enabled': True})
        self.media.chmod(0o644)
        self.addCleanup(patch.stopall)
        patch.object(MODULE, 'PUBLIC_MEDIA', self.media).start()
        real_fstat = os.fstat
        def metadata(descriptor):
            info = real_fstat(descriptor)
            if info.st_ino == self.media.stat().st_ino:
                return SimpleNamespace(st_mode=info.st_mode, st_size=info.st_size, st_uid=0)
            return info
        patch.object(MODULE.os, 'fstat', side_effect=metadata).start()
        real_stat = Path.stat
        def parent_metadata(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            if path in self.media.parents:
                return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755,
                                       st_size=info.st_size, st_ino=info.st_ino)
            return info
        patch.object(Path, 'stat', new=parent_metadata).start()
        historical = {'schema': 'UatDeploymentRecordV1', 'action': 'deploy', 'sourceSha': MODULE.HISTORICAL,
                      'realmConfigDigest': 'sha256:' + 'a' * 64}
        self.manifest = {'schema': 'B714ReconciliationInputV1', 'historical': self.reference('history.json', historical)}
        self.write(self.root / 'deployments/current.json', historical)
        self.write(self.root / 'deployments/previous.json', {'sourceSha': 'e' * 40})
        self.manifest['expectedCurrentSha256'] = MODULE.sha(MODULE.read(self.root / 'deployments/current.json'))
        self.manifest['expectedPreviousSha256'] = MODULE.sha(MODULE.read(self.root / 'deployments/previous.json'))
        images = {name: 'example.test/' + name + '@sha256:' + 'a' * 64 for name in ['api', 'console', 'ops', 'keycloak']}
        images.update(MODULE.APPROVED_REFS)
        release = 'SOURCE_SHA=' + MODULE.SOURCE + '\n' + ''.join(name.upper() + '_IMAGE=' + value + '\n' for name, value in images.items())
        self.manifest['release'] = self.reference(self.root / 'releases' / MODULE.SOURCE / 'release.env', release.encode())
        self.manifest['protectedFiles'] = [self.reference(path, b'unchanged') for path in [
            self.root / 'uat.env', self.root / 'platform/platform.env', self.root / 'platform/acceptance-current.json']]
        self.manifest['protectedFiles'].append({'path': str(self.media), 'sha256': MODULE.sha(self.media.read_bytes())})
        for filename in ['current.json', 'previous.json']:
            path = self.root / 'deployments' / filename
            self.manifest['protectedFiles'].append({'path': str(path), 'sha256': MODULE.sha(path.read_bytes())})
        containers = {name: {'id': 'b' * 64, 'imageId': 'sha256:' + 'c' * 64, 'sourceSha': 'd' * 40,
                            'project': 'dcontact-platform-uat', 'startedAt': '2026-10-27T08:38:00Z',
                            'configSha256': 'e' * 64} for name in MODULE.PROTECTED}
        runtime = {'schema': 'B714RuntimeObservationV1', 'sourceSha': MODULE.SOURCE, 'observedAt': self.observed,
                   'images': images, 'containers': containers, 'mediaSourceSha': MODULE.HISTORICAL,
                   'mediaSourceDigest': 'f' * 64}
        self.manifest['runtime'] = self.reference('runtime.json', runtime)
        cutover = {'status': 'CANDIDATE_STARTED_PLATFORM_ORIGINAL_TRIAL_NOT_EVALUATED',
                   'baseline': {name: {'id': value['id'], 'imageId': value['imageId'],
                                      'sourceConfigSha256': value['configSha256'], 'startedAt': value['startedAt']}
                                for name, value in containers.items()},
                   'preservedFileHashes': {ref['path']: ref['sha256'] for ref in self.manifest['protectedFiles']}}
        static = {}
        for name in MODULE.STATIC_PROOFS:
            self.manifest[name] = self.reference(name + '.json', cutover if name == 'cutover' else {'status': 'PASS'})
            static[name] = self.manifest[name]['sha256']
        patch.dict(MODULE.STATIC_PROOFS, static).start()
        backups = {}
        self.manifest['backups'] = {}
        for name, (filename, _) in MODULE.BACKUPS.items():
            ref = self.reference(filename, name.encode())
            self.manifest['backups'][name] = ref
            backups[name] = (filename, ref['sha256'])
        patch.dict(MODULE.BACKUPS, backups).start()
        rows = [{'id': str(number), 'name': 'migration_' + str(number), 'checksum': 'a' * 64,
                 'finished': True, 'rolledBack': False} for number in range(151)]
        rows[0].update(name='20261022130000_tenant_voice_skill_scope', checksum='5e281f7a38bace24cf114dde5a0484a41a0e01d2b317ea95293fce41a8f825c9')
        rows[1].update(name='20261020100000_tenant_people_worker', checksum='87029b11325efc503714e12ca59b4f7e15f718a444ec599e23b310017ebcec91')
        rows.append(dict(rows[1], id='historic', finished=False, rolledBack=True))
        self.manifest['ledger'] = self.reference('ledger.json', {
            'schema': 'B714ReadonlyLedgerV1', 'sourceSha': MODULE.SOURCE, 'observedAt': self.observed,
            'runtimeSha256': self.manifest['runtime']['sha256'], 'query': MODULE.LEDGER_QUERY,
            'result': {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readOnly': 'on', 'rows': rows}})
        self.manifest['smoke'] = self.reference('smoke.json', {
            'schema': 'B714SmokeObservationV1', 'sourceSha': MODULE.SOURCE, 'observedAt': self.observed,
            'runtimeSha256': self.manifest['runtime']['sha256'],
            'report': {'type': 'u1.uat.readiness', 'mode': 'live', 'status': 'PASS',
                       'checks': [{'id': 'UAT-L0' + str(number) + ' canonical', 'status': 'SKIPPED' if number == 6 else 'PASS'}
                                  for number in range(1, 9)]}})

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else MODULE.canonical(value))
        path.chmod(0o600)

    def reference(self, name, value):
        path = Path(name) if isinstance(name, Path) else self.operator / name
        self.write(path, value)
        return {'path': str(path), 'sha256': MODULE.sha(path.read_bytes())}

    def change(self, key, mutate):
        ref = self.manifest[key]
        document = json.loads(Path(ref['path']).read_bytes())
        mutate(document)
        self.manifest[key] = self.reference(Path(ref['path']), document)

    def test_reconciliation_module_has_no_runtime_side_effects(self):
        path = Path(__file__).with_name('b714-deployment-reconciliation.py')
        spec = importlib.util.spec_from_file_location('reconciliation', str(path))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(callable(module.prepare))
        self.assertTrue(callable(module.apply_record))

    def test_truthful_record_and_history(self):
        record = MODULE.prepare(self.manifest, self.now)
        self.assertIsNone(record['deployedAt'])
        self.assertIsNone(record['realmConfigDigest'])
        self.assertFalse(record['realmConfigProvenance']['realmReconciled'])
        self.assertFalse(record['historicalPrevious']['rollbackEligible'])
        self.assertEqual(record['migration']['finished'], 151)
        self.assertEqual(record['businessTrial'], 'NOT_EVALUATED')
        self.assertEqual(record['smoke']['checks'][5]['status'], 'SKIPPED')
        self.assertNotIn(str(self.root / 'deployments/current.json'), [ref['path'] for ref in record['unchangedProtectedFiles']])
        self.assertEqual(record['controlledRecordReplacement']['beforeSha256'], self.manifest['expectedCurrentSha256'])

    def test_stale_and_future_observations_refused(self):
        for offset in [301, -31]:
            with self.subTest(offset=offset), self.assertRaisesRegex(RuntimeError, 'OBSERVATION_STALE'):
                MODULE.prepare(self.manifest, self.now + timedelta(seconds=offset))

    def test_unresolved_or_fictional_rolled_back_history_refused(self):
        self.change('ledger', lambda value: value['result']['rows'][-1].update(name='other_history'))
        with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_WORKER'):
            MODULE.prepare(self.manifest, self.now)

    def test_smoke_counts_cannot_substitute_other_skipped_check(self):
        def mutate(value):
            value['report']['checks'][0]['status'] = 'SKIPPED'
            value['report']['checks'][5]['status'] = 'PASS'
        self.change('smoke', mutate)
        with self.assertRaisesRegex(RuntimeError, 'CANONICAL_SMOKE'):
            MODULE.prepare(self.manifest, self.now)

    def test_swapped_backup_dictionary_refused(self):
        self.manifest['backups']['application'], self.manifest['backups']['keycloak'] = self.manifest['backups']['keycloak'], self.manifest['backups']['application']
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_BINDING'):
            MODULE.prepare(self.manifest, self.now)

    def test_public_secret_not_allowed_by_basename(self):
        secret = self.root / 'other/state.json'
        self.write(secret, b'no-output')
        secret.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_OPERATOR_INPUT'):
            MODULE.read(secret)

    def test_public_media_group_write_and_symlink_refused(self):
        self.media.chmod(0o664)
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_MEDIA_ROOT'):
            MODULE.read(self.media)
        self.media.chmod(0o644)
        alias = self.root / 'alias'
        alias.symlink_to(self.media)
        with self.assertRaisesRegex(RuntimeError, 'SYMLINK'):
            MODULE.read(alias)

    def test_public_media_nonroot_owner_refused(self):
        original = MODULE.os.fstat
        def metadata(descriptor):
            info = original(descriptor)
            return SimpleNamespace(st_mode=info.st_mode, st_size=info.st_size, st_uid=1234)
        with patch.object(MODULE.os, 'fstat', side_effect=metadata):
            with self.assertRaisesRegex(RuntimeError, 'PUBLIC_MEDIA_ROOT'):
                MODULE.read(self.media)

    def test_public_media_writable_parent_refused(self):
        original = Path.stat
        def metadata(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.media.parent:
                return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o777)
            return info
        with patch.object(Path, 'stat', new=metadata):
            with self.assertRaisesRegex(RuntimeError, 'PUBLIC_MEDIA_PARENT'):
                MODULE.read(self.media)

    def test_apply_only_records_current_last_and_preserves_files(self):
        before = {ref['path']: Path(ref['path']).read_bytes() for ref in self.manifest['protectedFiles']
                  if Path(ref['path']).parent != self.root / 'deployments'}
        history = MODULE.read(self.root / 'deployments/current.json')
        with patch.object(MODULE, 'inspect_runtime') as inspect:
            result = MODULE.apply_record(self.manifest, self.root)
        self.assertEqual(result['status'], 'COMMITTED')
        self.assertEqual(inspect.call_count, 3)
        self.assertEqual(MODULE.read(self.root / 'deployments/previous.json'), history)
        for path, raw in before.items():
            self.assertEqual(Path(path).read_bytes(), raw)
        self.assertFalse((self.operator / 'b714-reconciliation.pending').exists())
        archives = list((self.root / 'deployments').glob('*-' + MODULE.SOURCE + '.json'))
        self.assertRegex(archives[0].name, r'^\d{8}T\d{6}Z-[0-9a-f]{32}-')

    def test_fake_repo_digest_refused_even_if_runtime_receipt_matches(self):
        ref = self.manifest['release']
        raw = Path(ref['path']).read_bytes().replace(MODULE.APPROVED_REFS['api'].encode(), b'example.test/fake@sha256:' + b'f' * 64)
        self.manifest['release'] = self.reference(Path(ref['path']), raw)
        with self.assertRaisesRegex(RuntimeError, 'APPROVED_CANDIDATE'):
            MODULE.prepare(self.manifest, self.now)

    def inspected_runtime(self, fake_image=False):
        runtime = json.loads(Path(self.manifest['runtime']['path']).read_bytes())
        containers = []
        names = MODULE.PROTECTED + ['dcontact-uat-' + service + '-1' for service in MODULE.IMAGES]
        runtime['containers'] = {}
        for name in names:
            service = name[len('dcontact-uat-'):-2] if name not in MODULE.PROTECTED else None
            image = MODULE.IMAGES[service] if service else 'sha256:' + 'c' * 64
            source = MODULE.SOURCE if service else 'd' * 40
            project = 'dcontact-platform-uat' if name.startswith('dcontact-platform-uat-') else 'dcontact-uat'
            image_key = {'proxy': 'console', 'e1-sandbox': 'api'}.get(service, service)
            config = {'Image': runtime['images'][image_key] if service else 'protected-image', 'Labels': {
                'org.opencontainers.image.revision': source, 'com.docker.compose.project': project}}
            if fake_image and service == 'api':
                config['Image'] = 'example.test/wrong@sha256:' + 'f' * 64
            mounts = [{'Source': str(MODULE.ROOT / 'releases' / MODULE.HISTORICAL / 'e1-freeswitch'),
                       'Destination': '/e1-freeswitch', 'RW': False}] if name == 'dcontact-uat-freeswitch-1' else []
            container = {'Name': '/' + name, 'Id': 'b' * 64, 'Image': image, 'Config': config,
                         'HostConfig': {}, 'Mounts': mounts,
                         'State': {'Running': True, 'StartedAt': self.observed, 'Health': {'Status': 'healthy'}}}
            runtime['containers'][name] = {'id': container['Id'], 'imageId': image, 'sourceSha': source,
                'project': project, 'startedAt': self.observed,
                'configSha256': MODULE.sha(MODULE.canonical({key: container[key] for key in ['Config', 'HostConfig', 'Mounts']}))}
            containers.append(container)
        self.manifest['runtime'] = self.reference('runtime.json', runtime)
        return containers

    def test_fresh_inspect_accepts_exact_pins_and_binds_repo_digest(self):
        for fake_image in [False, True]:
            with self.subTest(fake_image=fake_image):
                containers = self.inspected_runtime(fake_image)
                with patch.object(MODULE.subprocess, 'run', return_value=SimpleNamespace(stdout=MODULE.canonical(containers))) as run, \
                        patch.object(MODULE, 'media_digest', return_value='f' * 64):
                    if fake_image:
                        with self.assertRaisesRegex(RuntimeError, 'REPO_DIGEST_BINDING'):
                            MODULE.inspect_runtime(self.manifest)
                    else:
                        MODULE.inspect_runtime(self.manifest)
                    self.assertEqual(run.call_args[0][0][:2], ['docker', 'inspect'])

    def test_cas_conflict_and_runtime_drift_do_not_promote(self):
        current = self.root / 'deployments/current.json'
        original = current.read_bytes()
        with patch.object(MODULE, 'inspect_runtime', side_effect=RuntimeError('RUNTIME_DRIFT')):
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_DRIFT'):
                MODULE.apply_record(self.manifest, self.root)
        self.assertEqual(current.read_bytes(), original)
        self.manifest['expectedPreviousSha256'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'CAS_CONFLICT'):
            MODULE.apply_record(self.manifest, self.root)
        self.assertFalse((self.operator / 'b714-reconciliation.pending').exists())

    def test_locked_operation_refused(self):
        with (self.operator / 'b714-cutover.lock').open('w') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                MODULE.apply_record(self.manifest, self.root)

    def test_interruption_before_current_preserves_old_current_and_pending(self):
        original_replace = os.replace
        current = self.root / 'deployments/current.json'
        original = current.read_bytes()
        def replace(source, target):
            if Path(target) == current:
                raise OSError('injected-before-current')
            return original_replace(source, target)
        with patch.object(MODULE, 'inspect_runtime'), patch.object(MODULE.os, 'replace', side_effect=replace):
            with self.assertRaises(OSError):
                MODULE.apply_record(self.manifest, self.root)
        self.assertEqual(current.read_bytes(), original)
        self.assertTrue((self.operator / 'b714-reconciliation.pending').exists())
        with self.assertRaisesRegex(RuntimeError, 'PENDING_RECONCILIATION'):
            MODULE.apply_record(self.manifest, self.root)

    def test_after_current_failure_never_rolls_back_or_retries(self):
        original_create = MODULE.create
        def create(path, raw):
            if path.name == 'committed.json':
                raise OSError('injected-after-current')
            return original_create(path, raw)
        with patch.object(MODULE, 'inspect_runtime'), patch.object(MODULE, 'create', side_effect=create):
            with self.assertRaises(OSError):
                MODULE.apply_record(self.manifest, self.root)
        current = json.loads((self.root / 'deployments/current.json').read_bytes())
        self.assertEqual(current['action'], 'reconciliation')
        self.assertTrue((self.operator / 'b714-reconciliation.pending').exists())


class PublicComposeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.artifact = self.root / 'docker-compose.uat.yml'
        self.artifact.write_bytes(b'services: {}\n')
        self.artifact.chmod(0o644)
        self.cutover = self.root / 'state.json'
        self.cutover.write_bytes(MODULE.canonical({'preservedFileHashes': {
            str(self.artifact): MODULE.sha(self.artifact.read_bytes())}}))
        self.cutover.chmod(0o600)
        self.addCleanup(patch.stopall)
        patch.object(MODULE, 'PUBLIC_COMPOSE_PATHS', frozenset([self.artifact]), create=True).start()
        patch.object(MODULE, 'CUTOVER_PATH', self.cutover, create=True).start()
        patch.dict(MODULE.STATIC_PROOFS, {'cutover': MODULE.sha(self.cutover.read_bytes())}).start()
        self.owner = 1000
        original = os.fstat
        def metadata(descriptor):
            info = original(descriptor)
            if info.st_ino == self.artifact.stat().st_ino:
                return SimpleNamespace(st_mode=info.st_mode, st_size=info.st_size, st_uid=self.owner)
            return info
        patch.object(MODULE.os, 'fstat', side_effect=metadata).start()

    def test_actual_public_mode_is_read_without_chmod(self):
        self.assertEqual(MODULE.read(self.artifact), b'services: {}\n')
        self.assertEqual(stat.S_IMODE(self.artifact.stat().st_mode), 0o644)

    def test_public_content_drift_refused(self):
        self.artifact.write_bytes(b'services: changed\n')
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_COMPOSE_HASH'):
            MODULE.read(self.artifact)

    def test_unreviewed_cutover_hash_refused(self):
        self.cutover.write_bytes(MODULE.canonical({'preservedFileHashes': {str(self.artifact): 'f' * 64}}))
        with self.assertRaisesRegex(RuntimeError, 'CUTOVER_PROOF_HASH'):
            MODULE.read(self.artifact)

    def test_missing_cutover_entry_refused(self):
        self.cutover.write_bytes(MODULE.canonical({'preservedFileHashes': {}}))
        MODULE.STATIC_PROOFS['cutover'] = MODULE.sha(self.cutover.read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_COMPOSE_HASH'):
            MODULE.read(self.artifact)

    def test_alternate_path_and_public_secrets_still_refused(self):
        for name in ['elsewhere/docker-compose.uat.yml', 'uat.env', 'platform.env', 'people-identity.json']:
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b'not-for-output')
            path.chmod(0o644)
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'PRIVATE_OPERATOR_INPUT'):
                MODULE.read(path)

    def test_writable_public_compose_refused(self):
        for mode in [0o664, 0o646]:
            self.artifact.chmod(mode)
            with self.subTest(mode=mode), self.assertRaisesRegex(RuntimeError, 'PUBLIC_COMPOSE_METADATA'):
                MODULE.read(self.artifact)

    def test_wrong_public_owner_refused(self):
        self.owner = 1234
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_COMPOSE_METADATA'):
            MODULE.read(self.artifact)

    def test_allowlisted_symlink_refused(self):
        target = self.root / 'real.yml'
        self.artifact.rename(target)
        self.artifact.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'SYMLINK'):
            MODULE.read(self.artifact)


if __name__ == '__main__':
    unittest.main()
