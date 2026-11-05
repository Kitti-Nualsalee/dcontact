from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('media_git', Path(__file__).with_name('b868-media-git-compare.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MediaGitCompareTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        self.tree = self.root / 'infra/uat/e1-freeswitch'
        self.tree.mkdir(parents=True)
        (self.tree / 'config.xml').write_bytes(b'<config/>')
        self.commit()
        self.now = datetime.now(timezone.utc)
        file_hash = hashlib.sha256(b'<config/>').hexdigest()
        tree_hash = hashlib.sha256(json.dumps({'config.xml': file_hash}, sort_keys=True,
                                              separators=(',', ':')).encode()).hexdigest()
        self.observation = {'schema': 'UatMediaObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
                            'rollbackCertified': False, 'sourceProvenance': 'RECORD_CLAIM_UNVERIFIED',
                            'sourceSha': self.git('rev-parse', 'HEAD').decode().strip(),
                            'sourceDigest': tree_hash, 'observedAt': self.now.isoformat().replace('+00:00', 'Z'),
                            'secret': 'DO_NOT_DISCLOSE'}

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def test_exact_tree_match_never_certifies_or_exposes_payload(self):
        result = MODULE.compare(self.observation, self.root, self.now)
        self.assertTrue(result['treeMatchesGit'])
        self.assertFalse(result['rollbackCertified'])
        self.assertEqual(result['sourceProvenance'], 'GIT_CONTENT_MATCH_ONLY_NOT_DEPLOYMENT_PROOF')
        self.assertNotIn('DO_NOT_DISCLOSE', json.dumps(result))

    def test_different_tree_is_reported_without_certification(self):
        self.observation['sourceDigest'] = '0' * 64
        result = MODULE.compare(self.observation, self.root, self.now)
        self.assertFalse(result['treeMatchesGit'])
        self.assertEqual(result['sourceProvenance'], 'GIT_CONTENT_MISMATCH')
        self.assertFalse(result['rollbackCertified'])

    def test_stale_or_false_scope_fails(self):
        with self.assertRaisesRegex(ValueError, 'STALE'):
            MODULE.compare(self.observation, self.root, self.now + timedelta(seconds=301))
        self.observation['rollbackCertified'] = True
        with self.assertRaisesRegex(ValueError, 'OBSERVATION_INVALID'):
            MODULE.compare(self.observation, self.root, self.now)

    def test_git_symlink_is_rejected(self):
        (self.tree / 'link').symlink_to('config.xml')
        self.commit()
        self.observation['sourceSha'] = self.git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(ValueError, 'TREE_ENTRY_INVALID'):
            MODULE.compare(self.observation, self.root, self.now)

    def test_git_output_is_stopped_at_limit(self):
        (self.tree / 'large').write_bytes(b'x' * 128)
        self.commit()
        original = MODULE.MAX_BYTES
        try:
            MODULE.MAX_BYTES = 64
            with self.assertRaisesRegex(ValueError, 'GIT_OUTPUT_TOO_LARGE'):
                MODULE.git(self.root, 'show', 'HEAD:infra/uat/e1-freeswitch/large')
        finally:
            MODULE.MAX_BYTES = original


if __name__ == '__main__':
    unittest.main()
