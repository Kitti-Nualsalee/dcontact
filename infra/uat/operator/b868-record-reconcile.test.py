import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = load('record_reconcile', 'b868-record-reconcile.py')
FIXTURE = load('reconcile_proposal_fixture', 'b868-composite-proposal.test.py')


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FIXTURE.ProposalTests('test_proposal_does_not_authorize_record_or_rollback')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        operator = self.root / 'operator'
        operator.mkdir(mode=0o700)
        self.fixture.root = operator
        self.deployments = self.root / 'deployments'
        self.deployments.mkdir(mode=0o700)
        self.old_record, self.current, self.previous = self.fixture.observed_record_inputs()
        MODULE.TRANSACTION.create(self.deployments / 'current.json', self.current)
        MODULE.TRANSACTION.create(self.deployments / 'previous.json', self.previous)
        self.ref = self.fixture.assemble_component_bound()
        self.actor = 'operator:trial'
        self.now = self.fixture.now

    def prepare(self, actor=None):
        return MODULE.prepare(self.ref['path'], self.ref['sha256'], actor or self.actor, self.root, self.now)

    def apply(self, approved=None, actor=None, reader=None):
        return MODULE.apply(self.ref['path'], self.ref['sha256'], approved or MODULE.stable_sha(self.prepare()),
            actor or self.actor, root=self.root, observe_live=reader or (lambda: copy.deepcopy(self.fixture.obs)), now=self.now)

    def test_observation_commit_preserves_previous_and_platform_layout_anchor(self):
        record = self.prepare()
        result = self.apply()
        self.assertEqual(result['status'], 'COMMITTED')
        self.assertTrue(result['previousPreserved'])
        self.assertFalse(result['rollbackCertified'])
        current = json.loads((self.deployments / 'current.json').read_bytes())
        self.assertEqual(MODULE.stable_sha(current), MODULE.stable_sha(record))
        self.assertEqual(current['sourceSha'], self.old_record['sourceSha'])
        self.assertEqual(current['images'], self.old_record['images'])
        self.assertEqual(current['realmConfigProvenance'], self.old_record['realmConfigProvenance'])
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.previous)
        snapshots = list((self.root / 'operator').glob('b714-reconciliation-*/current-before.json'))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].read_bytes(), self.current)
        self.assertFalse((self.root / 'operator/b714-reconciliation.pending').exists())

    def test_wrong_record_approval_or_actor_never_commits(self):
        approved = MODULE.stable_sha(self.prepare())
        for options in ({'approved': '0' * 64}, {'approved': approved, 'actor': 'operator:changed'}):
            with self.assertRaisesRegex(RuntimeError, 'RECORD_APPROVAL_MISMATCH'):
                self.apply(**options)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.current)
        self.assertFalse((self.root / 'operator/b714-reconciliation.pending').exists())

    def test_live_drift_stops_before_metadata_transaction(self):
        def changed():
            live = copy.deepcopy(self.fixture.obs)
            live['ledger']['unresolved'] = 1
            return live
        with self.assertRaises(RuntimeError):
            self.apply(reader=changed)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.current)
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.previous)
        self.assertFalse((self.root / 'operator/b714-reconciliation.pending').exists())

    def test_previous_drift_in_last_live_check_is_not_overwritten(self):
        calls = 0
        def changed():
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.deployments / 'previous.json').write_bytes(b'concurrent')
            return copy.deepcopy(self.fixture.obs)
        with self.assertRaises(RuntimeError):
            self.apply(reader=changed)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.current)
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), b'concurrent')
        self.assertTrue((self.root / 'operator/b714-reconciliation.pending').exists())


if __name__ == '__main__':
    unittest.main()
