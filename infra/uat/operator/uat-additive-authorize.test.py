"""#901: authorization แบบเบาสำหรับ release ที่ migration เป็น additive ทับ deploy record ปกติ"""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

DIRECTORY = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


additive = load('additive_authorize', 'uat-additive-authorize.py')
forward_tests = load('forward_tests', 'b868-forward-authorize.test.py')


class AdditiveAuthorizeTests(unittest.TestCase):
    def setUp(self):
        # ใช้ release directory, stub ของ docker และ lock ชุดเดียวกับ test ของ #868
        self.base = forward_tests.ForwardAuthorizeTests('test_api_switch_pending_blocks_deploy_even_with_authorization')
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.root = self.base.root
        self.sha = self.base.sha
        self.current = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'deploy',
                                   'sourceSha': '1' * 40}).encode()
        (self.root / 'deployments' / 'current.json').write_bytes(self.current)
        package = self.base.api.package.replace(b'SOURCE_SHA=' + b'd' * 40, b'SOURCE_SHA=' + self.sha.encode())
        self.release = self.root / 'releases' / self.sha
        (self.release / 'release.env').write_bytes(package)
        self.guard = {'type': 'u1.uat.readiness', 'mode': 'migration-guard', 'status': 'PASS',
                      'base': '1' * 40, 'head': self.sha,
                      'checks': [{'id': 'UAT-M01 migration ใหม่เป็น additive', 'status': 'PASS',
                                  'added': ['packages/db/prisma/migrations/20261113100000_x/migration.sql']}]}
        self.write_guard(self.guard)

    def write_guard(self, guard):
        path = self.release / 'migration-guard.json'
        path.write_text(json.dumps(guard))
        path.chmod(0o644)

    def deploy(self, action='migrate'):
        return self.base.deploy(action)

    def test_authorization_lets_additive_release_deploy_until_current_changes(self):
        blocked = self.deploy()
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED', blocked.stderr)
        self.assertFalse((self.root / 'docker.log').exists())

        result = additive.authorize(self.root, self.sha, 'operator:kitti')
        self.assertEqual(result['status'], 'ADDITIVE_DEPLOY_AUTHORIZED')
        self.assertEqual(result['baseSha'], '1' * 40)
        self.assertFalse(result['rollbackCertified'])
        path = self.root / 'operator' / additive.AUTHORIZATION
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), result['authorizationSha256'])
        for action in ('migrate', 'keycloak', 'deploy'):
            allowed = self.deploy(action)
            self.assertEqual(allowed.returncode, 0, action + allowed.stderr)

        # current เปลี่ยน (record ของ candidate ถูกเขียน) → ใช้ซ้ำไม่ได้
        (self.root / 'deployments' / 'current.json').write_bytes(self.current + b' ')
        self.assertIn('UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED', self.deploy().stderr)

    def test_uat_deploy_rejects_tampered_authorization_or_release_files(self):
        additive.authorize(self.root, self.sha, 'operator:kitti')
        path = self.root / 'operator' / additive.AUTHORIZATION
        original = json.loads(path.read_bytes())
        for change in ({'targetSha': 'e' * 40}, {'baseSha': '2' * 40}, {'rollbackCertified': True},
                       {'migrationGuardSha256': '0' * 64}, {'releaseEnvSha256': '0' * 64},
                       {'expiresAt': '2020-01-01T00:00:00Z'}, {'actor': 'kitti'}):
            with self.subTest(change=change):
                path.write_text(json.dumps({**original, **change}))
                path.chmod(0o600)
                self.assertIn('UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED', self.deploy().stderr)
        path.write_text(json.dumps(original))
        path.chmod(0o600)
        self.assertEqual(self.deploy().returncode, 0)
        # guard ใน release directory ถูกแก้หลังออก authorization
        self.write_guard({**self.guard, 'status': 'FAIL'})
        self.assertIn('UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED', self.deploy().stderr)

    def test_rejects_non_additive_guard_reconciliation_current_or_pending(self):
        for guard, reason in (({**self.guard, 'status': 'FAIL'}, 'ADDITIVE_MIGRATION_GUARD_INVALID'),
                              ({**self.guard, 'base': '2' * 40}, 'ADDITIVE_MIGRATION_GUARD_INVALID'),
                              ({**self.guard, 'checks': []}, 'ADDITIVE_MIGRATION_GUARD_INVALID')):
            with self.subTest(reason=reason, guard=guard.get('status'), base=guard.get('base')):
                self.write_guard(guard)
                with self.assertRaisesRegex(RuntimeError, reason):
                    additive.authorize(self.root, self.sha, 'operator:kitti')
        self.write_guard(self.guard)
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_ACTOR_REQUIRED'):
            additive.authorize(self.root, self.sha, 'kitti')
        (self.root / 'deployments' / 'current.json').write_bytes(self.base.current)
        with self.assertRaisesRegex(RuntimeError, 'ADDITIVE_DEPLOY_RECORD_CURRENT_REQUIRED'):
            additive.authorize(self.root, self.sha, 'operator:kitti')
        (self.root / 'deployments' / 'current.json').write_bytes(self.current)
        gate = self.root / 'operator' / 'uat-api-switch.pending'
        gate.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_OTHER_TRANSACTION_PENDING'):
            additive.authorize(self.root, self.sha, 'operator:kitti')
        gate.unlink()
        (self.release / 'release.env').write_bytes(b'SOURCE_SHA=' + b'e' * 40 + b'\n')
        with self.assertRaisesRegex(RuntimeError, 'ADDITIVE_RELEASE_SHA_MISMATCH'):
            additive.authorize(self.root, self.sha, 'operator:kitti')


if __name__ == '__main__':
    unittest.main()
