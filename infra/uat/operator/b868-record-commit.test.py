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

SPEC = importlib.util.spec_from_file_location('commit', Path(__file__).with_name('b868-record-commit.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CommitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.operator = self.root / 'operator'
        self.journal = self.operator / 'uat-record-transaction'
        self.deployments = self.root / 'deployments'
        for directory in (self.operator, self.journal, self.deployments):
            directory.mkdir(mode=0o700)
        self.put(self.operator / 'b714-cutover.lock', b'')
        self.lock = (self.operator / 'b714-cutover.lock').open('r')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(self.lock.close)
        self.old, self.prev = b'old current', b'old previous'
        self.desired = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'deploy', 'sourceSha': 'a' * 40}).encode()
        self.archive = self.deployments / ('20261108T000000Z-' + 'a' * 40 + '.json')
        self.put(self.journal / 'current.json', self.old)
        self.put(self.journal / 'previous.json', self.prev)
        self.put(self.journal / 'desired.json', self.desired)
        self.put(self.deployments / 'current.json', self.old)
        self.put(self.deployments / 'previous.json', self.prev)
        self.intent = {'schema': 'UatRecordIntentV1', 'archive': self.archive.name,
                       'desiredSha256': self.sha(self.desired),
                       'snapshots': {'current.json': self.sha(self.old), 'previous.json': self.sha(self.prev)}}
        self.save_intent()

    @staticmethod
    def sha(data):
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def put(path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def save_intent(self):
        raw = json.dumps(self.intent).encode()
        self.put(self.journal / 'intent.json', raw)
        self.intent_sha = self.sha(raw)

    def complete(self):
        return MODULE.complete_locked(self.root, self.intent_sha)

    def test_archive_name_must_match_approved_desired_source(self):
        value = json.loads(self.desired)
        value['sourceSha'] = 'b' * 40
        changed = json.dumps(value).encode()
        self.put(self.journal / 'desired.json', changed)
        self.intent['desiredSha256'] = self.sha(changed)
        self.save_intent()
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_SOURCE_MISMATCH'):
            self.complete()
        self.assertFalse(self.archive.exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.old)

    def assert_complete(self):
        self.assertEqual(self.archive.read_bytes(), self.desired)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.desired)
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.old)
        self.assertEqual(Path(str(self.archive) + '.committed').read_bytes(), (self.sha(self.desired) + '\n').encode())
        self.assertTrue(self.journal.is_dir())

    def test_forward_and_retry_from_each_checkpoint(self):
        for checkpoint in range(4):
            with self.subTest(checkpoint=checkpoint):
                if checkpoint >= 1:
                    self.put(self.archive, self.desired)
                if checkpoint >= 2:
                    self.put(self.deployments / 'previous.json', self.old)
                if checkpoint >= 3:
                    self.put(self.deployments / 'current.json', self.desired)
                result = self.complete()
                self.assertFalse(result['rollbackCertified'])
                self.assert_complete()
                self.complete()
                self.assert_complete()
                Path(str(self.archive) + '.committed').unlink()
                self.archive.unlink()
                self.put(self.deployments / 'current.json', self.old)
                self.put(self.deployments / 'previous.json', self.prev)

    def test_missing_initial_pointers_and_existing_previous(self):
        for path in (self.journal / 'current.json', self.deployments / 'current.json'):
            path.unlink()
        self.intent['snapshots']['current.json'] = None
        self.save_intent()
        self.complete()
        self.assertEqual((self.deployments / 'previous.json').read_bytes(), self.prev)
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.desired)

    def test_archive_remains_unchanged_if_journal_desired_is_modified(self):
        self.complete()
        self.put(self.journal / 'desired.json', b'journal modified')
        self.assertEqual(self.archive.read_bytes(), self.desired)
        with self.assertRaises(MODULE.JOURNAL.InvalidJournal):
            MODULE.JOURNAL.inspect_locked(self.root)

    def test_wrong_intent_foreign_pointer_archive_and_marker_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'INTENT_CHANGED'):
            MODULE.complete_locked(self.root, '0' * 64)
        for path in (self.deployments / 'current.json', self.archive, Path(str(self.archive) + '.committed')):
            with self.subTest(path=path.name):
                old = path.read_bytes() if path.exists() else None
                self.put(path, b'foreign')
                with self.assertRaises((RuntimeError, MODULE.JOURNAL.InvalidJournal)):
                    self.complete()
                self.assertEqual(path.read_bytes(), b'foreign')
                if old is None:
                    path.unlink()
                else:
                    self.put(path, old)
        self.assertTrue(self.journal.exists())

    def test_rejects_other_pending_and_rollback_record(self):
        for name in ('uat-rollback.pending', 'b714-reconciliation.pending', 'uat-record-retirement.pending'):
            path = self.operator / name
            self.put(path, b'pending')
            with self.assertRaisesRegex(RuntimeError, 'OTHER_TRANSACTION_PENDING'):
                self.complete()
            path.unlink()
        self.desired = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'rollback'}).encode()
        self.put(self.journal / 'desired.json', self.desired)
        self.intent['desiredSha256'] = self.sha(self.desired)
        self.save_intent()
        with self.assertRaisesRegex(RuntimeError, 'DEPLOY_REQUIRED'):
            self.complete()
        self.assertFalse(self.archive.exists())

    def test_missing_both_initial_pointers(self):
        for name in ('current.json', 'previous.json'):
            (self.journal / name).unlink()
            (self.deployments / name).unlink()
            self.intent['snapshots'][name] = None
        self.save_intent()
        self.complete()
        self.assertFalse((self.deployments / 'previous.json').exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.desired)
        self.complete()

    def test_cas_detects_snapshot_change_before_write(self):
        actual = MODULE.os.link
        def changed(*args, **kwargs):
            self.put(self.journal / 'previous.json', b'changed')
            return actual(*args, **kwargs)
        with patch.object(MODULE.os, 'link', side_effect=changed):
            with self.assertRaises((RuntimeError, MODULE.JOURNAL.InvalidJournal)):
                self.complete()
        self.assertTrue(self.journal.exists())
        self.assertEqual((self.deployments / 'current.json').read_bytes(), self.old)

    def test_fsync_failure_preserves_journal_and_retry(self):
        with patch.object(MODULE.os, 'fsync', side_effect=OSError('failure')):
            with self.assertRaises(OSError):
                self.complete()
        self.assertTrue(self.journal.exists())
        self.complete()
        self.assert_complete()

    def test_process_exit_after_archive_retains_journal_and_retry(self):
        code = '''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('commit', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
real = m.os.link
def stop(*args, **kwargs):
    real(*args, **kwargs)
    os._exit(91)
m.os.link = stop
m.complete_locked(sys.argv[2], sys.argv[3])
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, MODULE.__file__, str(self.root), self.intent_sha],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 91, result.stderr)
        self.assertTrue(self.journal.exists())
        self.assertEqual(self.archive.stat().st_nlink, 2)
        self.assertTrue((self.journal / 'forward-archive-staging.json').exists())
        self.complete()
        self.assert_complete()
        self.assertEqual(self.archive.stat().st_nlink, 1)
        self.assertFalse((self.journal / 'forward-archive-staging.json').exists())
        spec = importlib.util.spec_from_file_location('crash_retire', Path(__file__).with_name('b868-record-journal-retire.py'))
        retire = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(retire)
        self.lock.close()
        result = retire.retire(self.root, self.sha(self.desired), self.intent_sha)
        self.assertEqual(result['status'], 'COMMITTED_JOURNAL_RETAINED')
        self.assertEqual(self.archive.stat().st_nlink, 1)

    def test_unknown_archive_alias_is_preserved_and_blocks_completion(self):
        self.complete()
        other = self.root / 'unknown-archive-link'
        os.link(self.archive, other)
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_ALIAS_REQUIRES_REVIEW'):
            self.complete()
        self.assertEqual(other.read_bytes(), self.desired)
        self.assertTrue(self.journal.exists())

    def test_foreign_owned_staging_is_not_overwritten_or_deleted(self):
        staging = self.journal / 'forward-archive-staging.json'
        self.put(staging, b'foreign')
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_STAGING_CHANGED'):
            self.complete()
        self.assertEqual(staging.read_bytes(), b'foreign')
        self.assertFalse(self.archive.exists())


if __name__ == '__main__':
    unittest.main()
