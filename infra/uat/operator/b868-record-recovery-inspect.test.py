import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name('b868-record-recovery-inspect.py')
SPEC = importlib.util.spec_from_file_location('b868_record_inspect', MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryInspectTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.operator = self.root / 'operator'
        self.deployments = self.root / 'deployments'
        self.journal = self.operator / 'uat-record-transaction'
        for path in (self.operator, self.deployments, self.journal):
            path.mkdir(mode=0o700)
        self.put(self.operator / 'b714-cutover.lock', b'')
        self.old, self.previous, self.desired = b'old', b'previous', b'new'
        self.archive = '20261105T120000Z-' + 'a' * 40 + '.json'
        for directory, name, data in ((self.deployments, 'current.json', self.old),
                                      (self.deployments, 'previous.json', self.previous),
                                      (self.journal, 'current.json', self.old),
                                      (self.journal, 'previous.json', self.previous),
                                      (self.journal, 'desired.json', self.desired)):
            self.put(directory / name, data)
        h = lambda data: hashlib.sha256(data).hexdigest()
        self.put(self.journal / 'intent.json', json.dumps({
            'schema': 'UatRecordIntentV1', 'archive': self.archive,
            'desiredSha256': h(self.desired),
            'snapshots': {'current.json': h(self.old), 'previous.json': h(self.previous)},
        }).encode())

    def put(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def test_prepared_and_committed_pointer_observations(self):
        result = MODULE.inspect(self.root)
        self.assertEqual(result['current'], 'original')
        self.assertFalse(result['runtimeVerified'])
        self.assertFalse(result['recoveryAuthorized'])
        self.put(self.deployments / 'previous.json', self.old)
        self.put(self.deployments / 'current.json', self.desired)
        self.put(self.deployments / self.archive, self.desired)
        self.put(self.deployments / (self.archive + '.committed'),
                 (hashlib.sha256(self.desired).hexdigest() + '\n').encode())
        result = MODULE.inspect(self.root)
        self.assertEqual((result['current'], result['previous']), ('desired', 'current-before'))
        self.assertTrue(result['markerPresent'])

    def test_incomplete_or_changed_journal_fails(self):
        (self.journal / 'intent.json').unlink()
        with self.assertRaises(OSError):
            MODULE.inspect(self.root)

    def test_foreign_pointer_and_symlink_fail(self):
        self.put(self.deployments / 'current.json', b'changed')
        with self.assertRaises(MODULE.InvalidJournal):
            MODULE.inspect(self.root)
        (self.journal / 'desired.json').unlink()
        os.symlink(self.deployments / 'current.json', self.journal / 'desired.json')
        with self.assertRaises(OSError):
            MODULE.inspect(self.root)

    def test_inspect_refuses_held_writer_lock(self):
        with (self.operator / 'b714-cutover.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                MODULE.inspect(self.root)

    def test_impossible_marker_without_archive_fails(self):
        self.put(self.deployments / (self.archive + '.committed'),
                 (hashlib.sha256(self.desired).hexdigest() + '\n').encode())
        with self.assertRaises(MODULE.InvalidJournal):
            MODULE.inspect(self.root)

    def test_current_cannot_commit_before_previous_pointer(self):
        self.put(self.deployments / self.archive, self.desired)
        self.put(self.deployments / 'current.json', self.desired)
        with self.assertRaises(MODULE.InvalidJournal):
            MODULE.inspect(self.root)


if __name__ == '__main__':
    unittest.main()
