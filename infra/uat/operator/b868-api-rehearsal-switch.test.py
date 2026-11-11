import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('api_switch', Path(__file__).with_name('b868-api-rehearsal-switch.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

PROJECT = 'dcontact-868-rehearsal-01234567'
PREFIX = 'ghcr.io/kitti-nualsalee/dcontact-uat-operator-api@sha256:'
CANDIDATE = {'reference': PREFIX + 'c' * 64, 'source': 'c' * 40, 'id': 'sha256:' + '1' * 64}
TARGET = {'reference': PREFIX + 'a' * 64, 'source': 'a' * 40, 'id': 'sha256:' + '2' * 64}


class SwitchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / PROJECT
        self.pending = self.state / 'pending.json'
        self.receipt = self.state / 'recovery.json'
        self.protected = {'networkId': 'sandbox-network', 'databaseId': 'sandbox-db', 'databaseStartedAt': '1'}
        self.api = None
        self.calls = []
        self.fail_after_switch = False
        self.mock('image_info', side_effect=lambda ref: {CANDIDATE['reference']: CANDIDATE, TARGET['reference']: TARGET}[ref])
        self.mock('snapshot', side_effect=lambda project: (copy.deepcopy(self.protected), copy.deepcopy(self.api)))
        self.mock('replace_api', side_effect=self.compose)
        self.docker = self.mock('docker', return_value='')

    def mock(self, name, **kwargs):
        patcher = patch.object(runner, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def compose(self, project, protected, api, image, lock):
        if image == TARGET:
            self.assertTrue(self.pending.is_file())
        self.calls.append(image['source'])
        self.api = {'Id': f'{len(self.calls):064x}', 'Image': image['id'], 'State': {'Running': True},
                    'Config': {'Image': image['reference'], 'Labels': {'org.opencontainers.image.revision': image['source']}}}
        if self.fail_after_switch:
            raise runner.RehearsalError('COMPOSE_INTERRUPTED_AFTER_MUTATION')

    def run_action(self, action):
        return runner.switch(PROJECT, action, CANDIDATE['reference'], TARGET['reference'], self.root)

    def test_switch_and_recover_preserve_pending_until_smoke(self):
        self.run_action('start')
        self.assertTrue(self.run_action('rollback')['recoveryPending'])
        with self.assertRaisesRegex(runner.RehearsalError, 'RECOVERY_PENDING'):
            self.run_action('rollback')
        self.api['State']['Running'] = False
        result = self.run_action('recover')
        self.assertFalse(result['rollbackCertified'])
        self.assertFalse(self.pending.exists())
        evidence = json.loads(self.receipt.read_bytes())
        self.assertEqual(evidence['rollbackApiId'], f'{2:064x}')
        self.assertEqual(evidence['recoveredApiId'], f'{3:064x}')
        self.assertEqual(self.calls, [CANDIDATE['source'], TARGET['source'], CANDIDATE['source']])

    def test_interrupted_rollback_keeps_intent_and_recovery_reads_runtime(self):
        self.run_action('start')
        self.fail_after_switch = True
        with self.assertRaisesRegex(runner.RehearsalError, 'COMPOSE_INTERRUPTED'):
            self.run_action('rollback')
        self.assertTrue(self.pending.exists())
        # การกู้ครั้งแรกสลับกลับสำเร็จ แต่ Compose ส่งผลกลับไม่ครบ
        with self.assertRaisesRegex(runner.RehearsalError, 'COMPOSE_INTERRUPTED'):
            self.run_action('recover')
        self.assertTrue(self.pending.exists())
        self.fail_after_switch = False
        self.run_action('recover')
        self.assertEqual(len(self.calls), 3)
        self.assertFalse(self.pending.exists())
        self.assertIsNone(json.loads(self.receipt.read_bytes())['rollbackApiId'])

    def test_recovery_when_interrupted_between_removal_and_start(self):
        self.run_action('start')
        self.run_action('rollback')
        self.api = None
        self.run_action('recover')
        self.assertEqual(len(self.calls), 3)
        self.assertFalse(self.pending.exists())

    def test_recovery_replaces_candidate_when_its_stop_may_still_be_running(self):
        self.run_action('start')
        original = copy.deepcopy(self.api)
        self.fail_after_switch = True
        with self.assertRaisesRegex(runner.RehearsalError, 'COMPOSE_INTERRUPTED'):
            self.run_action('rollback')
        self.api = original
        self.fail_after_switch = False
        self.run_action('recover')
        self.assertNotEqual(self.api['Id'], original['Id'])
        self.assertEqual(len(self.calls), 3)

    def test_recovery_rejects_database_drift_or_unknown_api(self):
        self.run_action('start')
        self.run_action('rollback')
        self.protected['databaseStartedAt'] = '2'
        with self.assertRaisesRegex(runner.RehearsalError, 'SANDBOX_CHANGED'):
            self.run_action('recover')
        self.protected['databaseStartedAt'] = '1'
        self.api['Image'] = 'unexpected'
        with self.assertRaisesRegex(runner.RehearsalError, 'RECOVERY_API_CHANGED'):
            self.run_action('recover')
        self.assertTrue(self.pending.exists())
        self.assertEqual(len(self.calls), 2)

    def test_rejects_uat_project_and_invalid_pending(self):
        with self.assertRaisesRegex(runner.RehearsalError, 'SANDBOX_PROJECT'):
            runner.switch('dcontact-uat', 'start', CANDIDATE['reference'], TARGET['reference'], self.root)
        self.run_action('start')
        self.pending.write_text('null')
        self.pending.chmod(0o600)
        with self.assertRaisesRegex(runner.RehearsalError, 'INVALID_PENDING'):
            self.run_action('rollback')
        self.assertEqual(len(self.calls), 1)

    def test_start_does_not_replace_existing_unhealthy_api_without_intent(self):
        self.run_action('start')
        self.docker.side_effect = runner.RehearsalError('SMOKE_FAILED')
        with patch.object(runner.time, 'sleep'), self.assertRaisesRegex(runner.RehearsalError, 'API_SMOKE_FAILED'):
            self.run_action('start')
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.pending.exists())


class ComposeTests(unittest.TestCase):
    def test_compose_targets_only_the_api_and_the_owned_network(self):
        with patch.object(runner, 'docker_mutate') as docker:
            runner.compose_api(PROJECT, TARGET, 9)
        args, kwargs = docker.call_args
        self.assertEqual(args[0], 9)
        self.assertEqual(args[-8:], ('up', '-d', '--no-deps', '--no-build', '--no-recreate', '--pull', 'never', 'api'))
        config = json.loads(kwargs['input'])
        self.assertEqual(set(config['services']), {'api'})
        self.assertEqual(config['services']['api']['image'], TARGET['reference'])
        self.assertEqual(config['networks'], {'default': {'name': PROJECT, 'external': True}})

    def test_stops_and_removes_only_the_observed_id_before_compose(self):
        protected = {'networkId': 'id'}
        running = {'Id': 'owned', 'State': {'Running': True}}
        stopped = {'Id': 'owned', 'State': {'Running': False, 'Status': 'exited'}}
        with patch.object(runner, 'snapshot', side_effect=[(protected, running), (protected, stopped), (protected, None)]), \
                patch.object(runner, 'docker_mutate') as mutate, patch.object(runner, 'compose_api') as compose:
            runner.replace_api(PROJECT, protected, running, TARGET, 9)
        self.assertEqual([call.args for call in mutate.call_args_list], [
            (9, 'stop', '--time', '15', 'owned'), (9, 'container', 'rm', 'owned')])
        compose.assert_called_once_with(PROJECT, TARGET, 9)

    def test_mutation_subprocess_inherits_lock(self):
        with patch.object(runner.subprocess, 'Popen') as popen:
            popen.return_value.returncode = 0
            runner.docker_mutate(9, 'container', 'rm', 'owned')
        self.assertEqual(popen.call_args.kwargs['pass_fds'], (9,))
        self.assertTrue(popen.call_args.kwargs['start_new_session'])


if __name__ == '__main__':
    unittest.main()
