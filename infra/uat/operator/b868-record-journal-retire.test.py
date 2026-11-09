import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
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
        self.intent_sha = hashlib.sha256((self.journal / 'intent.json').read_bytes()).hexdigest()
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

    def retire(self, desired_sha=None, intent_sha=None):
        return MODULE.retire(self.root, desired_sha or self.sha, intent_sha or self.intent_sha)

    def test_retains_entire_committed_journal_without_changing_pointers(self):
        journal = self.contents(self.journal)
        pointers = self.contents(self.deployments)
        result = self.retire()
        self.assertEqual(result['status'], 'COMMITTED_JOURNAL_RETAINED')
        self.assertFalse(result['pointersChanged'])
        self.assertFalse(result['runtimeVerified'])
        self.assertFalse(result['rollbackCertified'])
        self.assertTrue(result['cleanupDurable'])
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.contents(self.operator / result['retainedDirectory']), journal)
        self.assertEqual(self.contents(self.deployments), pointers)

    def test_incomplete_transaction_is_not_retired(self):
        (self.deployments / (self.archive + '.committed')).unlink()
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_TRANSACTION_REQUIRED'):
            self.retire()
        self.assertTrue(self.journal.exists())
        self.assertEqual(list(self.operator.glob('uat-record-completed-*')), [])

    def test_wrong_expected_hash_or_other_pending_transaction_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'DESIRED_CHANGED'):
            self.retire(desired_sha='0' * 64)
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending', 'uat-record-retirement.pending'):
            self.put(self.operator / name, b'pending')
            with self.assertRaisesRegex(RuntimeError, 'OTHER_TRANSACTION_PENDING'):
                self.retire()
            (self.operator / name).unlink()
        self.assertTrue(self.journal.exists())

    def test_retire_refuses_active_reader_or_writer(self):
        for mode in (fcntl.LOCK_SH, fcntl.LOCK_EX):
            with (self.operator / 'b714-cutover.lock').open('r') as lock:
                fcntl.flock(lock, mode | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    self.retire()
        self.assertTrue(self.journal.exists())

    def test_sync_failure_keeps_gate_before_or_after_rename(self):
        journal, pointers = self.contents(self.journal), self.contents(self.deployments)
        actual_sync = os.fsync
        for failure_at in range(1, 14):
            with self.subTest(failure_at=failure_at):
                calls = 0
                def sync(fd):
                    nonlocal calls
                    calls += 1
                    if calls == failure_at:
                        raise OSError('disk error')
                    actual_sync(fd)
                with patch.object(MODULE.os, 'fsync', side_effect=sync):
                    with self.assertRaises(OSError):
                        self.retire()
                self.assertTrue((self.operator / 'uat-record-retirement.pending').exists())
                with self.assertRaisesRegex(RuntimeError, 'OTHER_TRANSACTION_PENDING'):
                    self.retire()
                self.assertEqual(self.contents(self.deployments), pointers)
                retained = list(self.operator.glob('uat-record-completed-*'))
                if self.journal.exists():
                    self.assertEqual(self.contents(self.journal), journal)
                else:
                    self.assertEqual(self.contents(retained[0]), journal)
                    retained[0].rename(self.journal)
                for path in self.operator.glob('uat-record-completed-*'):
                    path.rmdir()
                (self.operator / 'uat-record-retirement.pending').unlink()

    def test_final_cleanup_sync_failure_reports_committed_data_with_warning(self):
        journal, pointers = self.contents(self.journal), self.contents(self.deployments)
        actual_sync, calls = os.fsync, 0
        def sync(fd):
            nonlocal calls
            calls += 1
            if calls == 14:
                raise OSError('cleanup directory sync failed')
            actual_sync(fd)
        with patch.object(MODULE.os, 'fsync', side_effect=sync):
            result = self.retire()
        self.assertEqual(result['status'], 'COMMITTED_JOURNAL_RETAINED')
        self.assertFalse(result['cleanupDurable'])
        self.assertEqual(result['warning'], 'RETIRE_GATE_REMOVAL_DURABILITY_UNKNOWN')
        self.assertEqual(self.contents(self.operator / result['retainedDirectory']), journal)
        self.assertEqual(self.contents(self.deployments), pointers)

    def test_process_exit_after_gate_removal_preserves_all_committed_evidence(self):
        # process exit ตรวจขอบเขต cleanup เท่านั้น ไม่จำลอง power loss ของ filesystem
        journal, pointers = self.contents(self.journal), self.contents(self.deployments)
        code = '''
import importlib.util, os, sys
from pathlib import Path
s = importlib.util.spec_from_file_location('retire_crash', sys.argv[1])
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
real_sync, calls = os.fsync, 0
def sync(fd):
    global calls
    calls += 1
    if calls == 14:
        os._exit(91)
    real_sync(fd)
m.os.fsync = sync
m.retire(Path(sys.argv[2]), sys.argv[3], sys.argv[4])
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(Path(MODULE.__file__)),
                                 str(self.root), self.sha, self.intent_sha], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 91, result.stderr)
        retained = list(self.operator.glob('uat-record-completed-*'))
        self.assertEqual(len(retained), 1)
        self.assertEqual(self.contents(retained[0]), journal)
        self.assertEqual(self.contents(self.deployments), pointers)
        self.assertFalse((self.operator / 'uat-record-retirement.pending').exists())

    def test_changed_pointer_is_rejected_and_evidence_is_preserved(self):
        self.put(self.deployments / 'current.json', b'foreign')
        with self.assertRaises(MODULE.JOURNAL.InvalidJournal):
            self.retire()
        self.assertTrue(self.journal.exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), b'foreign')

    def test_retirement_refuses_unknown_archive_hard_link(self):
        other = self.root / 'unknown-archive-link'
        os.link(self.deployments / self.archive, other)
        with self.assertRaisesRegex(RuntimeError, 'RETIRE_ARCHIVE_ALIAS_REQUIRES_REVIEW'):
            self.retire()
        self.assertEqual(other.read_bytes(), self.desired)
        self.assertTrue(self.journal.exists())

    def test_same_desired_bytes_do_not_allow_different_intent(self):
        intent = json.loads((self.journal / 'intent.json').read_bytes())
        intent['archive'] = '20261106T120001Z-' + 'a' * 40 + '.json'
        (self.deployments / self.archive).rename(self.deployments / intent['archive'])
        (self.deployments / (self.archive + '.committed')).rename(self.deployments / (intent['archive'] + '.committed'))
        self.put(self.journal / 'intent.json', json.dumps(intent).encode())
        with self.assertRaisesRegex(RuntimeError, 'RETIRE_INTENT_CHANGED'):
            self.retire()
        self.assertTrue(self.journal.exists())

    def test_equal_original_and_desired_require_committed_previous_pointer(self):
        self.put(self.journal / 'current.json', self.desired)
        intent = json.loads((self.journal / 'intent.json').read_bytes())
        intent['snapshots']['current.json'] = self.sha
        self.put(self.journal / 'intent.json', json.dumps(intent).encode())
        self.intent_sha = hashlib.sha256((self.journal / 'intent.json').read_bytes()).hexdigest()
        self.put(self.deployments / 'previous.json', self.previous)
        with self.assertRaisesRegex(RuntimeError, 'RETIRE_PREVIOUS_NOT_COMMITTED'):
            self.retire()
        self.assertTrue(self.journal.exists())

    def test_readback_failure_keeps_gate_and_retained_evidence(self):
        original_read = MODULE.JOURNAL.read_private
        def read(path, *args):
            if path.parent.name.startswith('uat-record-completed-') and path.name == 'desired.json':
                return b'wrong'
            return original_read(path, *args)
        with patch.object(MODULE.JOURNAL, 'read_private', side_effect=read):
            with self.assertRaisesRegex(RuntimeError, 'READBACK_MISMATCH'):
                self.retire()
        self.assertTrue((self.operator / 'uat-record-retirement.pending').exists())
        self.assertEqual(len(list(self.operator.glob('uat-record-completed-*'))), 1)


if __name__ == '__main__':
    unittest.main()
