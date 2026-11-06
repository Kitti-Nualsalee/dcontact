import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('journal_retire', Path(__file__).with_name('b868-record-journal-retire.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class JournalRetireTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.operator = self.root / 'operator'
        self.deployments = self.root / 'deployments'
        self.journal = self.operator / 'uat-record-transaction'
        for path in (self.operator, self.deployments, self.journal):
            path.mkdir(mode=0o700)
        self.old, self.previous, self.desired = b'old', b'previous', b'new'
        self.sha = hashlib.sha256(self.desired).hexdigest()
        self.archive = '20261106T120000Z-' + 'a' * 40 + '.json'
        self.put(self.operator / 'b714-cutover.lock', b'')
        for name, raw in (('current.json', self.old), ('previous.json', self.previous),
                          ('desired.json', self.desired)):
            self.put(self.journal / name, raw)
        self.put(self.journal / 'intent.json', json.dumps({
            'schema': 'UatRecordIntentV1', 'archive': self.archive, 'desiredSha256': self.sha,
            'snapshots': {name: hashlib.sha256(raw).hexdigest()
                          for name, raw in (('current.json', self.old), ('previous.json', self.previous))},
        }).encode())
        for name, raw in (('current.json', self.desired), ('previous.json', self.old),
                          (self.archive, self.desired), (self.archive + '.committed', (self.sha + '\n').encode())):
            self.put(self.deployments / name, raw)

    @staticmethod
    def put(path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    @staticmethod
    def contents(directory):
        return {p.name: p.read_bytes() for p in directory.iterdir()}

    def test_retains_entire_committed_journal_without_changing_pointers(self):
        journal = self.contents(self.journal)
        pointers = self.contents(self.deployments)
        result = MODULE.retire(self.root, self.sha)
        self.assertEqual(result['status'], 'COMMITTED_JOURNAL_RETAINED')
        self.assertFalse(result['pointersChanged'])
        self.assertFalse(result['runtimeVerified'])
        self.assertFalse(result['rollbackCertified'])
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.contents(self.operator / result['retainedDirectory']), journal)
        self.assertEqual(self.contents(self.deployments), pointers)

    def test_incomplete_transaction_is_not_retired(self):
        (self.deployments / (self.archive + '.committed')).unlink()
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_TRANSACTION_REQUIRED'):
            MODULE.retire(self.root, self.sha)
        self.assertTrue(self.journal.exists())
        self.assertEqual(list(self.operator.glob('uat-record-completed-*')), [])

    def test_wrong_expected_hash_or_other_pending_transaction_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'DESIRED_CHANGED'):
            MODULE.retire(self.root, '0' * 64)
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending'):
            self.put(self.operator / name, b'pending')
            with self.assertRaisesRegex(RuntimeError, 'OTHER_TRANSACTION_PENDING'):
                MODULE.retire(self.root, self.sha)
            (self.operator / name).unlink()
        self.assertTrue(self.journal.exists())

    def test_retire_refuses_active_reader_or_writer(self):
        for mode in (fcntl.LOCK_SH, fcntl.LOCK_EX):
            with (self.operator / 'b714-cutover.lock').open('r') as lock:
                fcntl.flock(lock, mode | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    MODULE.retire(self.root, self.sha)
        self.assertTrue(self.journal.exists())

    def test_sync_failure_after_rename_preserves_journal_and_pointers(self):
        journal, pointers = self.contents(self.journal), self.contents(self.deployments)
        with patch.object(MODULE.os, 'fsync', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                MODULE.retire(self.root, self.sha)
        retained = list(self.operator.glob('uat-record-completed-*'))
        self.assertEqual(len(retained), 1)
        self.assertEqual(self.contents(retained[0]), journal)
        self.assertEqual(self.contents(self.deployments), pointers)

    def test_changed_pointer_is_rejected_and_evidence_is_preserved(self):
        self.put(self.deployments / 'current.json', b'foreign')
        with self.assertRaises(MODULE.JOURNAL.InvalidJournal):
            MODULE.retire(self.root, self.sha)
        self.assertTrue(self.journal.exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), b'foreign')


if __name__ == '__main__':
    unittest.main()
