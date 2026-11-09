import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('b868_inventory', Path(__file__).with_name('b868-legacy-inventory.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LegacyInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.operator = self.root / 'operator'
        self.deployments = self.root / 'deployments'
        self.operator.mkdir(mode=0o700)
        self.deployments.mkdir(mode=0o700)
        self.put(self.operator / 'b714-cutover.lock', b'')
        self.record = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'deploy',
                                  'sourceSha': 'a' * 40, 'secret': 'MUST_NOT_APPEAR'}).encode()
        self.archive = self.deployments / ('20261105T120000Z-' + 'a' * 40 + '.json')
        self.put(self.archive, self.record)
        self.put(self.deployments / 'previous.json', self.record)

    def put(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def test_unmarked_matching_pointer_never_certifies(self):
        result = MODULE.inspect(self.root)
        self.assertEqual(result['archives'][0]['marker'], 'UNMARKED')
        self.assertTrue(result['archives'][0]['matchesPrevious'])
        self.assertFalse(result['rollbackCertified'])
        self.assertNotIn('MUST_NOT_APPEAR', json.dumps(result))
        self.assertFalse(Path(str(self.archive) + '.committed').exists())

    def test_marker_is_integrity_only_and_mismatch_detected(self):
        marker = Path(str(self.archive) + '.committed')
        self.put(marker, (hashlib.sha256(self.record).hexdigest() + '\n').encode())
        result = MODULE.inspect(self.root)
        self.assertEqual(result['archives'][0]['marker'], 'MATCH')
        self.assertEqual(result['archives'][0]['provenance'], 'UNVERIFIED')
        self.put(marker, b'bad\n')
        self.assertEqual(MODULE.inspect(self.root)['archives'][0]['marker'], 'MISMATCH')

    def test_pending_lock_and_symlink_fail_closed(self):
        (self.operator / 'uat-record-transaction').mkdir(mode=0o700)
        with self.assertRaises(MODULE.InventoryError):
            MODULE.inspect(self.root)
        (self.operator / 'uat-record-transaction').rmdir()
        with (self.operator / 'b714-cutover.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                MODULE.inspect(self.root)
        self.archive.unlink()
        os.symlink(self.deployments / 'previous.json', self.archive)
        with self.assertRaises(OSError):
            MODULE.inspect(self.root)


if __name__ == '__main__':
    unittest.main()
