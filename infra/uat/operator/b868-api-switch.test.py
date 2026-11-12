import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location('api_switch', Path(__file__).with_name('b868-api-switch.py'))
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)

CANDIDATE_SHA, TARGET_SHA = 'c' * 40, 'a' * 40
CANDIDATE_REF = 'ghcr.io/x/api@sha256:' + 'c' * 64
TARGET_REF = 'ghcr.io/x/api@sha256:' + 'a' * 64
TARGET_ID = 'sha256:' + '1' * 64
CANDIDATE_ID = 'sha256:' + '2' * 64


class FakeDeps:
    """จำลอง Docker/Compose/DB/proxy ของ VM2 ให้ทดสอบลำดับ mutation และ fail-closed"""

    def __init__(self):
        self.counter = 0
        self.api_container = self.container(CANDIDATE_REF, CANDIDATE_SHA, CANDIDATE_ID)
        self.calls = []
        self.fence = 'FENCE_ACTIVE'
        self.drain_status = 'DRAINED'
        self.identity_status = 'CONSISTENT'
        self.people = {'bindingsEmpty': True, 'invitationsEnabled': False, 'disableEnabled': False}
        self.ledger_value = {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                             'unresolved': 0, 'finished': 2, 'migrations': [{'name': 'm', 'checksum': 'x'}]}
        self.protected_value = {'/dcontact-uat-proxy-1': {'id': 'p'}}
        self.extra_config = {}
        self.fail_up = None
        self.smoke_profile = 'uat-workspace'
        self.target_image = {'Id': TARGET_ID, 'RepoDigests': [TARGET_REF],
                             'Config': {'Labels': {'org.opencontainers.image.revision': TARGET_SHA}}}
        self.sleep = lambda seconds: None

    def container(self, ref, sha, image):
        self.counter += 1
        return {'Id': f'{self.counter:064x}', 'Image': image,
                'Config': {'Image': ref, 'Labels': {'org.opencontainers.image.revision': sha}},
                'State': {'Running': True}}

    def config(self, target):
        image = target or CANDIDATE_REF
        services = {'api': {'image': image, 'environment': {'SECRET': 'value'}},
                    'proxy': {'image': 'proxy'}}
        if target:
            services['api'].update(self.extra_config)
        return {'name': 'dcontact-uat', 'services': services}

    def up(self, target):
        self.calls.append(('up', target))
        if self.fail_up == 'before':
            raise switch.SwitchError('SWITCH_COMPOSE_FAILED')
        self.api_container = (self.container(TARGET_REF, TARGET_SHA, TARGET_ID) if target
                              else self.container(CANDIDATE_REF, CANDIDATE_SHA, CANDIDATE_ID))
        if self.fail_up == 'after':
            raise switch.SwitchError('SWITCH_COMPOSE_TIMED_OUT')

    def inspect(self):
        api = self.api_container or {}
        source = (api.get('Config') or {}).get('Labels', {}).get('org.opencontainers.image.revision')
        mismatch = [] if source == CANDIDATE_SHA else ['api']
        components = {'api': {'containerId': api.get('Id')}}
        for name in ('e1-sandbox', 'proxy', 'keycloak'):
            components[name] = {'containerId': name, 'imageId': 'sha256:' + '9' * 64, 'startedAt': 't'}
        return {'schema': 'UatReleaseInspectionV1', 'components': components,
                'sourceMismatch': mismatch, 'imageDigestMismatch': mismatch}

    def api(self):
        return copy.deepcopy(self.api_container)

    def image(self, reference):
        return copy.deepcopy(self.target_image)

    def ledger(self):
        return copy.deepcopy(self.ledger_value)

    def protected(self):
        return copy.deepcopy(self.protected_value)

    def drain(self, settle):
        self.calls.append(('drain', settle))
        return {'status': self.drain_status}

    def identity(self):
        self.calls.append(('identity',))
        if self.identity_status == 'PEOPLE_NOT_CONFIGURED':
            return {'status': self.identity_status, 'apiContainerId': self.api_container['Id'], **self.people}
        return {'status': self.identity_status, 'runtime': {'api': {'containerId': self.api_container['Id']}}}

    def probe(self):
        return {'status': self.fence}

    def smoke(self):
        return {'httpStatus': 200, 'profile': self.smoke_profile, 'providerEgress': 'BLOCKED'}


class ApiSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'operator').mkdir(mode=0o700)
        (self.root / 'deployments').mkdir(mode=0o700)
        release = self.root / 'releases' / CANDIDATE_SHA
        release.mkdir(parents=True)
        (release / 'release.env').write_text(f'SOURCE_SHA={CANDIDATE_SHA}\nAPI_IMAGE={CANDIDATE_REF}\n')
        self.current = {'schema': 'UatDeploymentRecordV1', 'action': 'deploy', 'sourceSha': CANDIDATE_SHA,
                        'images': {'api': CANDIDATE_REF}}
        self.previous = {'schema': 'UatDeploymentReconciliationV1', 'action': 'reconciliation',
                         'rollbackEligible': False, 'sourceSha': 'b' * 40,
                         'components': {'api': {'sourceSha': TARGET_SHA, 'imageReference': TARGET_REF,
                                                'imageId': TARGET_ID}}}
        self.write_records()
        self.deps = FakeDeps()

    def write_records(self):
        for name, value in (('current', self.current), ('previous', self.previous)):
            path = self.root / 'deployments' / (name + '.json')
            path.write_text(json.dumps(value))
            path.chmod(0o600)

    def pending(self):
        return json.loads((self.root / 'operator' / switch.PENDING).read_text())

    def test_plan_is_read_only_and_reports_config_hashes(self):
        result = switch.plan(self.root, self.deps)
        self.assertEqual(result['status'], 'API_SWITCH_PLAN_READY')
        self.assertEqual(result['records']['target']['imageId'], TARGET_ID)
        self.assertNotIn('value', json.dumps(result))
        self.assertEqual(self.deps.calls, [])
        self.assertFalse((self.root / 'operator' / switch.PENDING).exists())

    def test_rollback_then_recover_writes_receipt_and_clears_pending(self):
        result = switch.rollback(self.root, self.deps, 180)
        self.assertEqual(result['status'], 'API_SWITCH_TARGET_SMOKE_PASSED')
        self.assertTrue(result['recoveryPending'])
        pending = self.pending()
        self.assertEqual(pending['phase'], 'TARGET_RUNNING')
        self.assertEqual(pending['rollbackApiId'], self.deps.api_container['Id'])
        self.assertEqual(self.deps.calls[:3], [('drain', 180), ('identity',), ('up', TARGET_REF)])
        self.assertEqual((self.root / 'operator' / switch.PENDING).stat().st_mode & 0o777, 0o600)
        override = json.loads((self.root / 'operator' / switch.OVERRIDE).read_text())
        self.assertEqual(override, {'services': {'api': {'image': TARGET_REF}}})

        recovered = switch.recover(self.root, self.deps)
        self.assertEqual(recovered['status'], 'API_SWITCH_RECOVERED')
        self.assertFalse((self.root / 'operator' / switch.PENDING).exists())
        self.assertFalse((self.root / 'operator' / switch.OVERRIDE).exists())
        receipt_path = self.root / 'operator' / switch.RECEIPTS / (pending['transactionId'] + '.json')
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(hashlib.sha256(receipt_path.read_bytes()).hexdigest(), recovered['receiptSha256'])
        self.assertEqual(receipt['phase'], 'RECOVERED')
        self.assertFalse(receipt['rollbackCertified'])
        self.assertEqual(self.deps.api_container['Config']['Image'], CANDIDATE_REF)

    def test_rollback_refuses_before_mutation_without_fence_drain_identity_or_clean_runtime(self):
        for name, change, error in (
            ('fence', lambda d: setattr(d, 'fence', 'FENCE_INACTIVE'), 'SWITCH_FENCE_NOT_ACTIVE'),
            ('drain', lambda d: setattr(d, 'drain_status', 'NOT_DRAINED'), 'SWITCH_PEOPLE_NOT_DRAINED'),
            ('identity', lambda d: setattr(d, 'identity_status', 'INCONSISTENT'), 'SWITCH_IDENTITY_NOT_CONSISTENT'),
            ('config', lambda d: d.extra_config.update(command=['other']), 'SWITCH_OVERRIDE_CHANGES_MORE_THAN_API_IMAGE'),
            ('image', lambda d: d.target_image.update(RepoDigests=[]), 'SWITCH_TARGET_IMAGE_NOT_LOCAL'),
            ('ledger', lambda d: d.ledger_value.update(unresolved=1), 'SWITCH_LEDGER_UNRESOLVED'),
        ):
            with self.subTest(name):
                deps = FakeDeps()
                change(deps)
                with self.assertRaisesRegex(switch.SwitchError, error):
                    switch.rollback(self.root, deps, 180)
                self.assertNotIn(('up', TARGET_REF), deps.calls)
                self.assertFalse((self.root / 'operator' / switch.PENDING).exists())

    def test_rollback_refuses_when_other_transaction_or_records_are_wrong(self):
        gate = self.root / 'operator' / 'uat-rollback.pending'
        gate.write_text('{}')
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_OTHER_TRANSACTION_PENDING'):
            switch.rollback(self.root, self.deps, 180)
        gate.unlink()
        self.current['action'] = 'reconciliation'
        self.write_records()
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_CURRENT_DEPLOY_RECORD_REQUIRED'):
            switch.plan(self.root, self.deps)
        self.current['action'] = 'deploy'
        self.current['images']['api'] = TARGET_REF
        self.write_records()
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_CANDIDATE_RELEASE_MISMATCH'):
            switch.plan(self.root, self.deps)

    def test_interrupted_rollback_keeps_pending_and_recover_returns_to_candidate(self):
        self.deps.fail_up = 'after'
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_COMPOSE_TIMED_OUT'):
            switch.rollback(self.root, self.deps, 180)
        self.assertEqual(self.pending()['phase'], 'ROLLBACK_STARTED')
        self.deps.fail_up = None
        result = switch.recover(self.root, self.deps)
        self.assertEqual(result['status'], 'API_SWITCH_RECOVERED')
        self.assertEqual(self.deps.calls[-3:], [('up', None), ('drain', None), ('identity',)])

    def test_recover_recreates_candidate_that_was_only_being_stopped(self):
        self.deps.fail_up = 'before'
        with self.assertRaises(switch.SwitchError):
            switch.rollback(self.root, self.deps, 180)
        before = self.deps.api_container['Id']
        self.assertEqual(self.pending()['stoppingApiId'], before)
        self.deps.fail_up = None
        switch.recover(self.root, self.deps)
        self.assertIn(('up', None), self.deps.calls)
        self.assertNotEqual(self.deps.api_container['Id'], before)

    def test_target_smoke_failure_keeps_pending_and_blocks_new_rollback(self):
        self.deps.smoke_profile = 'other'
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_PROXY_SMOKE_FAILED'):
            switch.rollback(self.root, self.deps, 180)
        self.assertEqual(self.pending()['phase'], 'ROLLBACK_STARTED')
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_OTHER_TRANSACTION_PENDING'):
            switch.rollback(self.root, self.deps, 180)
        self.deps.smoke_profile = 'uat-workspace'
        self.assertEqual(switch.recover(self.root, self.deps)['status'], 'API_SWITCH_RECOVERED')

    def test_recover_keeps_pending_when_state_changed_during_switch(self):
        switch.rollback(self.root, self.deps, 180)
        for name, change, error in (
            ('protected', lambda d: d.protected_value.update(extra={'id': 'x'}), 'SWITCH_PROTECTED_STATE_CHANGED'),
            ('ledger', lambda d: d.ledger_value.update(finished=3), 'SWITCH_LEDGER_CHANGED'),
            ('identity', lambda d: setattr(d, 'identity_status', 'INCONSISTENT'), 'SWITCH_IDENTITY_NOT_CONSISTENT'),
        ):
            with self.subTest(name):
                deps = copy.deepcopy(self.deps)
                deps.sleep = lambda seconds: None
                change(deps)
                with self.assertRaisesRegex(switch.SwitchError, error):
                    switch.recover(self.root, deps)
                self.assertTrue((self.root / 'operator' / switch.PENDING).exists())
        self.current['sourceSha'] = 'd' * 40
        self.write_records()
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_RECORDS_CHANGED|SWITCH_CANDIDATE_RELEASE'):
            switch.recover(self.root, self.deps)

    def test_recover_reuses_receipt_written_before_crash(self):
        switch.rollback(self.root, self.deps, 180)
        pending = self.pending()
        original_unlink = switch.os.unlink
        def crash(path, *args, **kwargs):
            if str(path).endswith(switch.OVERRIDE):
                raise OSError('crash after receipt')
            return original_unlink(path, *args, **kwargs)
        switch.os.unlink = crash
        try:
            with self.assertRaises(OSError):
                switch.recover(self.root, self.deps)
        finally:
            switch.os.unlink = original_unlink
        receipt = self.root / 'operator' / switch.RECEIPTS / (pending['transactionId'] + '.json')
        first = receipt.read_bytes()
        result = switch.recover(self.root, self.deps)
        self.assertEqual(result['status'], 'API_SWITCH_RECOVERED')
        self.assertEqual(receipt.read_bytes(), first)
        self.assertFalse((self.root / 'operator' / switch.PENDING).exists())

    def test_people_not_configured_is_accepted_only_when_everything_is_off(self):
        self.deps.identity_status = 'PEOPLE_NOT_CONFIGURED'
        switch.rollback(self.root, self.deps, 180)
        self.assertEqual(self.pending()['evidence']['identityStatus'], 'PEOPLE_NOT_CONFIGURED')
        result = switch.recover(self.root, self.deps)
        receipt = json.loads((self.root / 'operator' / switch.RECEIPTS / (result['transactionId'] + '.json')).read_text())
        self.assertEqual(receipt['recoveryIdentityStatus'], 'PEOPLE_NOT_CONFIGURED')
        for change in ({'bindingsEmpty': False}, {'invitationsEnabled': True}, {'disableEnabled': True}):
            with self.subTest(change=change):
                deps = FakeDeps()
                deps.identity_status = 'PEOPLE_NOT_CONFIGURED'
                deps.people.update(change)
                with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_IDENTITY_NOT_CONSISTENT'):
                    switch.rollback(self.root, deps, 180)
                self.assertNotIn(('up', TARGET_REF), deps.calls)
        deps = FakeDeps()
        deps.identity_status = 'NOT_CONFIGURED'
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_IDENTITY_NOT_CONSISTENT'):
            switch.rollback(self.root, deps, 180)

    def test_live_identity_maps_not_configured_without_copying_env_values(self):
        live = object.__new__(switch.LiveDeps)
        def unavailable(_inspect):
            raise RuntimeError('IDENTITY_EVIDENCE_UNAVAILABLE:NOT_CONFIGURED')
        live.identity_observer = type('O', (), {'observe': staticmethod(unavailable),
                                                'components': staticmethod(lambda value: value)})
        live.inspect = lambda: {}
        container = {'Id': 'f' * 64, 'Config': {'Env': ['TENANT_PEOPLE_BINDINGS_JSON=[{"secret":"s3cr3t"}]',
                                                       'TENANT_PEOPLE_INVITATIONS_ENABLED=false']}}
        live.api = lambda: container
        result = live.identity()
        self.assertEqual((result['status'], result['bindingsEmpty'], result['invitationsEnabled']),
                         ('PEOPLE_NOT_CONFIGURED', False, False))
        self.assertNotIn('s3cr3t', json.dumps(result))
        container['Config']['Env'] = ['TENANT_PEOPLE_BINDINGS_JSON=']
        self.assertTrue(live.identity()['bindingsEmpty'])
        for env, key, expected in ((['TENANT_PEOPLE_BINDINGS_JSON= '], 'bindingsEmpty', False),
                                   (['TENANT_PEOPLE_WORKER_DATABASE_URL=postgresql://x'], 'bindingsEmpty', False),
                                   (['TENANT_PEOPLE_INVITATIONS_ENABLED=TRUE'], 'invitationsEnabled', True),
                                   (['TENANT_PEOPLE_DISABLE_ENABLED=1'], 'disableEnabled', True)):
            with self.subTest(env=env):
                container['Config']['Env'] = env
                self.assertEqual(live.identity()[key], expected)
        containers = iter([container, {**container, 'Id': 'e' * 64}])
        live.api = lambda: next(containers)
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_IDENTITY_RUNTIME_CHANGED'):
            live.identity()
        live.api = lambda: container
        def other(_inspect):
            raise RuntimeError('IDENTITY_EVIDENCE_UNAVAILABLE:UNKNOWN')
        live.identity_observer.observe = staticmethod(other)
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN'):
            live.identity()

    def test_connect_host_pins_only_base_url_hostname(self):
        calls = []
        fake = type('R', (), {'getaddrinfo': staticmethod(lambda name, *a, **k: calls.append(name) or [name])})
        switch.pin_connect_host('https://dcontact-uat.example.test', '192.168.102.114', fake)
        self.assertEqual(fake.getaddrinfo('dcontact-uat.example.test', 443), ['192.168.102.114'])
        self.assertEqual(fake.getaddrinfo('other.example.test', 443), ['other.example.test'])
        for bad in ('vm1', '192.168.1', ''):
            with self.subTest(bad=bad), self.assertRaisesRegex(switch.SwitchError, 'SWITCH_CONNECT_HOST_INVALID'):
                switch.pin_connect_host('https://dcontact-uat.example.test', bad, fake)

    def test_recover_refuses_identity_status_change(self):
        switch.rollback(self.root, self.deps, 180)
        self.deps.identity_status = 'PEOPLE_NOT_CONFIGURED'
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_IDENTITY_STATUS_CHANGED'):
            switch.recover(self.root, self.deps)
        self.assertTrue((self.root / 'operator' / switch.PENDING).exists())

    def test_recover_refuses_unknown_api_image(self):
        switch.rollback(self.root, self.deps, 180)
        self.deps.api_container = self.deps.container('ghcr.io/x/api@sha256:' + 'e' * 64, 'e' * 40, 'sha256:' + '3' * 64)
        with self.assertRaisesRegex(switch.SwitchError, 'SWITCH_RECOVERY_API_CHANGED'):
            switch.recover(self.root, self.deps)


if __name__ == '__main__':
    unittest.main()
