import copy
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = load('forward_recovery', 'b868-record-forward-recovery.py')
FIXTURE = load('forward_runtime_fixture', 'b868-record-recovery-runtime.test.py')


class ForwardRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.fixture = FIXTURE.RecoveryRuntimeTest('test_match_does_not_authorize_recovery')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.journal = self.fixture.journal
        self.deployments = self.fixture.deployments
        self.now = datetime.now(timezone.utc)
        self.fixture.observed.update({'schema': 'UatReleaseInspectionV1',
            'runtimeConsistency': 'TWO_MATCHING_OBSERVATIONS', 'rollbackCertified': False,
            'sourceMismatch': [], 'imageDigestMismatch': []})

    def probe(self, root):
        result = copy.deepcopy(self.fixture.observed)
        for name in ('current', 'previous'):
            path = root / 'deployments' / (name + '.json')
            result['records'][name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} if path.exists() else None
        return result

    def observation(self):
        result = self.fixture.evidence(self.now)
        result['runtime'] = self.probe(self.root)
        result['runtimeSha256'] = hashlib.sha256(MODULE.CANDIDATE.canonical(result['runtime'])).hexdigest()
        return result

    def recover(self, *, evidence=None, observe_live=None, intent_sha=None, evidence_sha=None):
        evidence = evidence or self.observation()
        intent_sha = intent_sha or hashlib.sha256((self.journal / 'intent.json').read_bytes()).hexdigest()
        evidence_sha = evidence_sha or hashlib.sha256(MODULE.CANDIDATE.canonical(evidence)).hexdigest()
        return MODULE.recover(self.root, intent_sha, evidence, evidence_sha, 'operator:trial',
                              observe_live=observe_live or self.observation, probe=self.probe,
                              execute=self.fixture.execute, now=self.now)

    def assert_gate_retained(self):
        self.assertTrue(self.journal.exists())
        self.assertTrue((self.journal / 'intent.json').exists())

    def test_forward_commit_and_explicit_retirement_preserve_original_previous(self):
        result = self.recover()
        self.assertEqual(result['status'], 'RECORD_TRANSACTION_COMMITTED_PENDING_RETIREMENT')
        self.assertFalse(result['rollbackCertified'])
        self.assertFalse(result['applicationDataMutated'])
        self.assertFalse(result['applicationRuntimeMutated'])
        self.assertEqual((self.deployments / 'current.json').read_bytes(), (self.journal / 'desired.json').read_bytes())
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.fixture.current)
        self.assert_gate_retained()
        request = json.loads((self.journal / result['request']).read_bytes())
        self.assertEqual(request['decision'], 'FORWARD_COMPLETE_RECORD_ONLY')
        self.assertNotIn('DO_NOT_DISCLOSE', json.dumps(request))
        retire = load('forward_retire', 'b868-record-journal-retire.py')
        retired = retire.retire(self.root, result['desiredSha256'], result['intentSha256'])
        self.assertEqual(retired['status'], 'COMMITTED_JOURNAL_RETAINED')
        self.assertTrue((self.root / 'operator' / retired['retainedDirectory'] / result['request']).exists())

    def test_wrong_approval_or_expired_evidence_never_writes_pointer(self):
        original = (self.deployments / 'current.json').read_bytes()
        for kwargs in ({'intent_sha': '0' * 64}, {'evidence_sha': '0' * 64}):
            with self.assertRaises(RuntimeError):
                self.recover(**kwargs)
        evidence = self.observation()
        evidence['observedAt'] = (self.now - timedelta(seconds=301)).isoformat().replace('+00:00', 'Z')
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            self.recover(evidence=evidence)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), original)
        self.assertEqual(list(self.journal.glob('forward-request-*')), [])

    def test_changed_live_protected_runtime_is_not_authorized_by_approved_file(self):
        def changed():
            value = self.observation()
            key = '/dcontact-platform-uat-platform-api-1'
            value['protectedRuntime'][key]['id'] = '1' * 64
            value['protectedRuntimeSha256'] = hashlib.sha256(
                MODULE.CANDIDATE.canonical(value['protectedRuntime'])).hexdigest()
            return value
        with self.assertRaisesRegex(RuntimeError, 'LIVE_EVIDENCE_CHANGED'):
            self.recover(observe_live=changed)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.fixture.current)
        self.assert_gate_retained()

    def test_postcheck_failure_retains_committed_record_and_gate(self):
        calls = 0
        def changed():
            nonlocal calls
            calls += 1
            value = self.observation()
            if calls == 2:
                value['ledger']['unresolved'] = 1
            return value
        with self.assertRaises(RuntimeError):
            self.recover(observe_live=changed)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), (self.journal / 'desired.json').read_bytes())
        self.assert_gate_retained()
        self.assertTrue((self.journal / 'forward-postcheck.pending').exists())
        retire = load('failed_forward_retire', 'b868-record-journal-retire.py')
        intent_sha = hashlib.sha256((self.journal / 'intent.json').read_bytes()).hexdigest()
        desired_sha = hashlib.sha256((self.journal / 'desired.json').read_bytes()).hexdigest()
        with self.assertRaisesRegex(RuntimeError, 'FORWARD_POSTCHECK_REQUIRED'):
            retire.retire(self.root, desired_sha, intent_sha)
        self.assertTrue(self.recover()['retirementRequired'])
        self.assertFalse((self.journal / 'forward-postcheck.pending').exists())

    def test_partial_pointer_write_can_resume_with_fresh_reviewed_observation(self):
        original_replace, calls = os.replace, 0
        def replace(source, destination, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('injected pointer interruption')
            return original_replace(source, destination, *args, **kwargs)
        with patch.object(os, 'replace', side_effect=replace):
            with self.assertRaises(OSError):
                self.recover()
        self.assert_gate_retained()
        result = self.recover()
        self.assertTrue(result['retirementRequired'])
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.fixture.current)
        repeated = self.recover()
        self.assertEqual(repeated['desiredSha256'], result['desiredSha256'])
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.fixture.current)

    def test_recovery_refuses_other_lock_holders(self):
        with (self.root / 'operator/b714-cutover.lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.recover()
        self.assert_gate_retained()

    def test_retirement_requires_postcheck_receipt_bound_to_request(self):
        result = self.recover()
        retire = load('receipt_retire', 'b868-record-journal-retire.py')
        report_path = self.journal / 'forward-postcheck.json'
        report = report_path.read_bytes()
        report_path.unlink()
        with self.assertRaises(OSError):
            retire.retire(self.root, result['desiredSha256'], result['intentSha256'])
        self.fixture.put(report_path, report)
        request_path = self.journal / result['request']
        request = json.loads(request_path.read_bytes())
        request['actor'] = 'operator:changed'
        self.fixture.put(request_path, json.dumps(request).encode())
        with self.assertRaisesRegex(RuntimeError, 'FORWARD_EVIDENCE_INVALID'):
            retire.retire(self.root, result['desiredSha256'], result['intentSha256'])
        self.assert_gate_retained()

    def test_evidence_expiring_after_commit_keeps_postcheck_gate(self):
        evidence = self.observation()
        intent_sha = hashlib.sha256((self.journal / 'intent.json').read_bytes()).hexdigest()
        evidence_sha = hashlib.sha256(MODULE.CANDIDATE.canonical(evidence)).hexdigest()
        clock, calls = [self.now], 0
        def observe():
            nonlocal calls
            calls += 1
            value = self.observation()
            if calls == 2:
                clock[0] += timedelta(seconds=301)
            return value
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            MODULE.recover(self.root, intent_sha, evidence, evidence_sha, 'operator:trial',
                observe_live=observe, probe=self.probe, execute=self.fixture.execute, now=lambda: clock[0])
        self.assertTrue((self.journal / 'forward-postcheck.pending').exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), (self.journal / 'desired.json').read_bytes())

    def test_verified_loader_executes_original_bytes_if_path_changes(self):
        path = self.root / 'helper.py'
        raw = b'VALUE = 1\n'
        self.fixture.put(path, raw)
        original_compile = compile
        def compile_and_swap(*args, **kwargs):
            path.write_bytes(b'VALUE = 2\n')
            return original_compile(*args, **kwargs)
        with patch('builtins.compile', side_effect=compile_and_swap):
            helper = MODULE.load_verified_code('byte_checked_helper', path, hashlib.sha256(raw).hexdigest())
        self.assertEqual(helper.VALUE, 1)

    def test_live_adapter_reads_ledger_with_scoped_bounded_readonly_probe(self):
        self.fixture.put(self.root / 'uat.env', b'UAT_POSTGRES_USER=dcontact_uat_owner\nUAT_POSTGRES_PASSWORD=PRIVATE_DB_PASSWORD\n')
        protected = self.observation()['protectedRuntime']
        helper = SimpleNamespace(PG='postgres@sha256:' + '1' * 64,
            inspect=lambda _: {'NetworkSettings': {'Networks': {'dcontact-uat_internal': {'IPAddress': '172.21.0.5'}}}},
            runtime_snapshot=lambda: copy.deepcopy(protected))
        calls = []
        def run(command, name, **options):
            calls.append(name)
            self.assertIn('--pull=never', command)
            self.assertIn('--read-only', command)
            self.assertIn('--pids-limit', command)
            self.assertIn('default_transaction_read_only=on', options['env']['PGOPTIONS'])
            self.assertNotIn('PRIVATE_DB_PASSWORD', ' '.join(command))
            self.assertEqual(options['input'], MODULE.OBSERVER.QUERY.encode())
            self.assertEqual(options['timeout'], 30)
            self.assertIn('com.dcontact.rollback-probe=' + name, command)
            return json.dumps(self.observation()['ledger']).encode()
        collector = SimpleNamespace(probe_run=run)
        def loader(name, *_):
            return helper if name == 'b868_verified_routing' else collector
        with patch.object(MODULE, 'ROOT', self.root), patch.object(MODULE, 'load_verified_code', side_effect=loader), \
                patch.object(MODULE.ASSESSOR.RUNTIME, 'inspect', side_effect=lambda root: self.probe(root)):
            observed = MODULE.live_reader(self.root)()
        self.assertEqual(observed['ledger']['readonly'], 'on')
        self.assertEqual(len(calls), 1)

    def test_rollback_record_and_absent_pointer_remain_unsupported(self):
        original_desired = (self.journal / 'desired.json').read_bytes()
        original_intent = (self.journal / 'intent.json').read_bytes()
        desired = json.loads(original_desired)
        desired['action'] = 'rollback'
        raw = json.dumps(desired).encode()
        self.fixture.put(self.journal / 'desired.json', raw)
        intent = json.loads(original_intent)
        intent['desiredSha256'] = hashlib.sha256(raw).hexdigest()
        self.fixture.put(self.journal / 'intent.json', json.dumps(intent).encode())
        with self.assertRaisesRegex(RuntimeError, 'DEPLOY_RECORD_ONLY'):
            self.recover()
        self.fixture.put(self.journal / 'desired.json', original_desired)
        self.fixture.put(self.journal / 'intent.json', original_intent)
        evidence = self.observation()
        (self.deployments / 'previous.json').unlink()
        (self.journal / 'previous.json').unlink()
        intent = json.loads(original_intent)
        intent['snapshots']['previous.json'] = None
        self.fixture.put(self.journal / 'intent.json', json.dumps(intent).encode())
        with self.assertRaisesRegex(RuntimeError, 'EVIDENCE_POINTERS_REQUIRED'):
            self.recover(evidence=evidence)
        self.assert_gate_retained()


if __name__ == '__main__':
    unittest.main()
