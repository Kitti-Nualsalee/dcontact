import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('media_inspect', Path(__file__).with_name('b868-media-source-inspect.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MediaInspectTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for folder in ('operator', 'deployments'):
            (self.root / folder).mkdir(mode=0o700)
        self.put(self.root / 'operator/b714-cutover.lock', b'')
        self.source = 'a' * 40
        self.tree = self.root / 'releases' / self.source / 'e1-freeswitch'
        self.tree.mkdir(parents=True)
        self.put(self.tree / 'config.xml', b'<config/>')
        self.record = {'schema': 'UatDeploymentReconciliationV1', 'mediaSourceSha': self.source,
                       'mediaSourceDigest': MODULE.tree_digest(self.tree)}
        self.put(self.root / 'deployments/current.json', json.dumps(self.record).encode())
        self.container = {'Name': '/' + MODULE.CONTAINER, 'Id': 'b' * 64, 'Image': 'sha256:' + 'c' * 64,
                          'Config': {'Labels': {'com.docker.compose.project': 'dcontact-uat'},
                                     'Env': ['PASSWORD=DO_NOT_PRINT']},
                          'HostConfig': {}, 'Mounts': [{'Destination': '/e1-freeswitch',
                                                       'Source': str(self.tree), 'RW': False}],
                          'State': {'Running': True, 'StartedAt': 'test'}}

    def put(self, path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def execute(self, args, **_kwargs):
        if args[:2] == ['docker', 'exec']:
            info = self.tree.stat()
            return SimpleNamespace(stdout=f'{info.st_dev}:{info.st_ino}\n'.encode())
        return SimpleNamespace(stdout=json.dumps([self.container]).encode())

    def test_observes_matching_mount_and_tree_without_secrets(self):
        result = MODULE.inspect(self.root, self.execute)
        self.assertEqual(result['sourceDigest'], self.record['mediaSourceDigest'])
        self.assertEqual(result['status'], 'OBSERVED_NOT_CERTIFIED')
        self.assertEqual(result['sourceProvenance'], 'RECORD_CLAIM_UNVERIFIED')
        self.assertFalse(result['rollbackCertified'])
        self.assertNotIn('DO_NOT_PRINT', json.dumps(result))

    def test_rejects_changed_tree_and_writable_mount(self):
        self.put(self.tree / 'config.xml', b'changed')
        with self.assertRaisesRegex(RuntimeError, 'DIGEST_MISMATCH'):
            MODULE.inspect(self.root, self.execute)
        self.container['Mounts'][0]['RW'] = True
        with self.assertRaisesRegex(RuntimeError, 'MOUNT_MISMATCH'):
            MODULE.inspect(self.root, self.execute)

    def test_rejects_symlinks_pending_and_busy_lock(self):
        (self.tree / 'bad').symlink_to(self.tree / 'config.xml')
        with self.assertRaisesRegex(RuntimeError, 'TREE_INVALID'):
            MODULE.inspect(self.root, self.execute)
        (self.tree / 'bad').unlink()
        (self.root / 'operator/uat-record-transaction').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'TRANSACTION_PENDING'):
            MODULE.inspect(self.root, self.execute)
        (self.root / 'operator/uat-record-transaction').rmdir()
        with (self.root / 'operator/b714-cutover.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                MODULE.inspect(self.root, self.execute)

    def test_rejects_recreated_container(self):
        calls = 0
        def changing(*_args, **_kwargs):
            nonlocal calls
            if _args[0][:2] == ['docker', 'inspect']:
                calls += 1
                if calls == 2:
                    self.container['Id'] = 'd' * 64
            return self.execute(*_args, **_kwargs)
        with self.assertRaisesRegex(RuntimeError, 'CHANGED_DURING_INSPECTION'):
            MODULE.inspect(self.root, changing)

    def test_rejects_bind_mount_with_different_inode(self):
        def mismatch(args, **kwargs):
            if args[:2] == ['docker', 'exec']:
                return SimpleNamespace(stdout=b'1:2\n')
            return self.execute(args, **kwargs)
        with self.assertRaisesRegex(RuntimeError, 'MOUNT_IDENTITY_MISMATCH'):
            MODULE.inspect(self.root, mismatch)

    def test_rejects_nested_mount_overriding_media_tree(self):
        self.container['Mounts'].append({'Destination': '/e1-freeswitch/conf', 'Source': '/other', 'RW': False})
        with self.assertRaisesRegex(RuntimeError, 'NESTED_MOUNT_UNSUPPORTED'):
            MODULE.inspect(self.root, self.execute)

    def test_directory_swap_cannot_make_file_read_escape_tree(self):
        nested = self.tree / 'nested'
        nested.mkdir()
        self.put(nested / 'target', b'inside')
        outside = self.root / 'outside'
        outside.mkdir()
        self.put(outside / 'target', b'outside')
        before = MODULE.tree_digest(self.tree)
        real_open = MODULE.os.open
        switched = False
        def replacing(path, flags, *args, **kwargs):
            nonlocal switched
            if path == 'target' and kwargs.get('dir_fd') is not None and not switched:
                switched = True
                nested.rename(self.tree / 'nested-old')
                nested.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)
        with patch.object(MODULE.os, 'open', side_effect=replacing):
            self.assertEqual(MODULE.tree_digest(self.tree), before)
        self.assertTrue(switched)
        with self.assertRaisesRegex(RuntimeError, 'TREE_INVALID'):
            MODULE.tree_digest(self.tree)

    def test_directory_walk_error_is_not_ignored(self):
        def broken_walk(*_args, **kwargs):
            kwargs['onerror'](PermissionError('denied'))
            yield
        with patch.object(MODULE.os, 'fwalk', side_effect=broken_walk):
            with self.assertRaises(PermissionError):
                MODULE.tree_digest(self.tree)

    def test_file_swapped_for_fifo_fails_without_blocking(self):
        real_open = MODULE.os.open
        switched = False
        def replacing(path, flags, *args, **kwargs):
            nonlocal switched
            if path == 'config.xml' and kwargs.get('dir_fd') is not None and not switched:
                switched = True
                (self.tree / 'config.xml').unlink()
                os.mkfifo(self.tree / 'config.xml')
            return real_open(path, flags, *args, **kwargs)
        with patch.object(MODULE.os, 'open', side_effect=replacing):
            with self.assertRaisesRegex(RuntimeError, 'TREE_INVALID'):
                MODULE.tree_digest(self.tree)
        self.assertTrue(switched)


if __name__ == '__main__':
    unittest.main()
