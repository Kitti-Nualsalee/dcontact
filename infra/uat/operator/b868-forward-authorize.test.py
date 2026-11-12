from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

DIRECTORY = Path(__file__).resolve().parent
DEPLOY = DIRECTORY.parent / 'bin' / 'uat-deploy.sh'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


authorize = load('forward_authorize', 'b868-forward-authorize.py')
fixtures = load('candidate_tests', 'release-candidate-validate.test.py')


class ForwardAuthorizeTests(unittest.TestCase):
    def setUp(self):
        api = fixtures.ApiRollbackTests()
        api.setUp()
        # release แบบ workspace ต้องมี E1 overlay และ host ตาม uat-deploy.sh
        api.package += b'UAT_WORKSPACE_HOST=workspace.example.test\n'
        api.rehearsal['candidateReleaseEnvSha256'] = api.raw_digest(api.package)
        self.api = api
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, mode in (('operator', 0o700), ('deployments', 0o700), ('bin', 0o700)):
            (self.root / name).mkdir(mode=mode)
        self.lock = self.root / 'operator' / 'b714-cutover.lock'
        self.lock.touch(mode=0o600)
        self.current = json.dumps({'schema': 'UatDeploymentReconciliationV1', 'action': 'reconciliation',
                                   'rollbackEligible': False, 'sourceSha': '1' * 40}).encode()
        self.previous = json.dumps({'schema': 'UatDeploymentRecordV1', 'action': 'deploy',
                                    'sourceSha': '2' * 40}).encode()
        for name, data in (('current.json', self.current), ('previous.json', self.previous)):
            path = self.root / 'deployments' / name
            path.write_bytes(data)
            path.chmod(0o600)
        records = api.observation['runtime']['records']
        records['current']['sha256'] = hashlib.sha256(self.current).hexdigest()
        records['previous']['sha256'] = hashlib.sha256(self.previous).hexdigest()
        self.sha = 'd' * 40
        release = self.root / 'releases' / self.sha
        release.mkdir(parents=True)
        (release / 'release.env').write_bytes(api.package)
        for name in ('docker-compose.uat.yml', 'docker-compose.uat.e1.yml', 'docker-compose.uat.workspace.yml',
                     'Caddyfile.3vm.e1'):
            (release / name).write_text('services: {}\n')
        (release / 'e1-freeswitch').mkdir()
        (release / 'e1-freeswitch' / 'entrypoint.sh').touch(mode=0o700)
        (self.root / 'e1-acceptance.enabled').touch()
        (self.root / 'uat.env').touch(mode=0o600)
        stub = self.root / 'bin' / 'docker'
        stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$STUB_LOG"\n')
        stub.chmod(0o700)

    def run_authorize(self, **overrides):
        api = self.api
        api.observation['runtimeSha256'] = api.digest(api.observation['runtime'])
        arguments = dict(root=self.root, observation=api.observation,
                         approved_observation_sha256=api.digest(api.observation),
                         rehearsal=api.rehearsal, approved_rehearsal_sha256=api.digest(api.rehearsal),
                         release_env=api.package, migration_guard=fixtures.candidate.canonical(api.guard),
                         actor='operator:kitti', now=api.now)
        arguments.update(overrides)
        return authorize.authorize(**arguments)

    def deploy(self, action='migrate'):
        environment = {**os.environ, 'UAT_ROOT': str(self.root), 'STUB_LOG': str(self.root / 'docker.log'),
                       'PATH': f"{self.root / 'bin'}:{os.environ['PATH']}"}
        return subprocess.run(['bash', str(DEPLOY), action, self.sha], env=environment, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)

    def test_authorization_lets_uat_deploy_migrate_candidate_once(self):
        blocked = self.deploy()
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('RECORD_RECONCILIATION_REQUIRES_REVIEW', blocked.stderr)
        self.assertFalse((self.root / 'docker.log').exists())

        result = self.run_authorize(now=None)
        self.assertEqual(result['status'], 'FORWARD_DEPLOY_AUTHORIZED')
        self.assertFalse(result['rollbackCertified'])
        path = self.root / 'operator' / authorize.AUTHORIZATION
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), result['authorizationSha256'])
        for action in ('migrate', 'keycloak', 'deploy'):
            allowed = self.deploy(action)
            self.assertEqual(allowed.returncode, 0, action + allowed.stderr)

        # current เปลี่ยน (เช่น record ของ candidate ถูกเขียน) → authorization ใช้ซ้ำไม่ได้
        current = self.root / 'deployments' / 'current.json'
        current.write_bytes(self.current + b' ')
        again = self.deploy()
        self.assertIn('RECORD_RECONCILIATION_REQUIRES_REVIEW', again.stderr)

    def test_uat_deploy_rejects_tampered_or_expired_authorization(self):
        self.run_authorize(now=None)
        path = self.root / 'operator' / authorize.AUTHORIZATION
        original = json.loads(path.read_bytes())
        for change in ({'targetSha': 'e' * 40}, {'releaseEnvSha256': '0' * 64},
                       {'previousRecordSha256': '0' * 64}, {'expiresAt': '2020-01-01T00:00:00Z'},
                       {'authorizedAt': '2999-01-01T00:00:00Z'}, {'rollbackCertified': True},
                       {'validation': {**original['validation'], 'status': 'OTHER'}}):
            with self.subTest(change=change):
                path.chmod(0o600)
                path.write_text(json.dumps({**original, **change}))
                self.assertIn('RECORD_RECONCILIATION_REQUIRES_REVIEW', self.deploy().stderr)
        path.write_text(json.dumps(original))
        path.chmod(0o640)
        self.assertIn('RECORD_RECONCILIATION_REQUIRES_REVIEW', self.deploy().stderr)
        path.chmod(0o600)
        self.assertEqual(self.deploy().returncode, 0)
        (self.root / 'releases' / self.sha / 'release.env').write_bytes(self.api.package + b'#\n')
        self.assertIn('RECORD_RECONCILIATION_REQUIRES_REVIEW', self.deploy().stderr)

    def test_api_switch_pending_blocks_deploy_even_with_authorization(self):
        self.run_authorize(now=None)
        pending = self.root / 'operator' / 'uat-api-switch.pending'
        pending.write_text('{}')
        pending.chmod(0o600)
        self.assertIn('UAT_API_SWITCH_PENDING', self.deploy().stderr)

    def test_rejects_changed_records_prepared_release_actor_window_or_pending(self):
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_ACTOR_REQUIRED'):
            self.run_authorize(actor='kitti')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_WINDOW_INVALID'):
            self.run_authorize(window_minutes=600)
        (self.root / 'releases' / self.sha / 'release.env').write_bytes(self.api.package + b'#\n')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_PREPARED_RELEASE_MISMATCH'):
            self.run_authorize()
        (self.root / 'releases' / self.sha / 'release.env').write_bytes(self.api.package)
        (self.root / 'deployments' / 'previous.json').write_bytes(self.previous + b' ')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_RECORDS_CHANGED'):
            self.run_authorize()
        (self.root / 'deployments' / 'previous.json').write_bytes(self.previous)
        gate = self.root / 'operator' / 'uat-rollback.pending'
        gate.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_OTHER_TRANSACTION_PENDING'):
            self.run_authorize()
        gate.unlink()
        with self.assertRaisesRegex(RuntimeError, 'OBSERVATION_STALE_OR_FUTURE'):
            self.run_authorize(now=self.api.now + timedelta(minutes=10))

    def test_active_authorization_is_not_replaced_but_stale_one_is_retired(self):
        self.run_authorize()
        with self.assertRaisesRegex(RuntimeError, 'AUTHORIZE_ACTIVE_AUTHORIZATION_EXISTS'):
            self.run_authorize()
        path = self.root / 'operator' / authorize.AUTHORIZATION
        stale = json.loads(path.read_bytes())
        path.write_text(json.dumps({**stale, 'currentRecordSha256': '0' * 64}))
        self.run_authorize()
        retired = sorted((self.root / 'operator').glob('uat-forward-deploy-retired-*.json'))
        self.assertEqual(len(retired), 1)
        self.assertEqual(json.loads(path.read_bytes())['currentRecordSha256'],
                         hashlib.sha256(self.current).hexdigest())

    def test_expired_or_other_candidate_authorization_can_be_replaced(self):
        self.run_authorize()
        path = self.root / 'operator' / authorize.AUTHORIZATION
        original = json.loads(path.read_bytes())
        for change in ({'expiresAt': '2020-01-01T00:00:00Z'}, {'targetSha': 'e' * 40}):
            with self.subTest(change=change):
                path.write_text(json.dumps({**json.loads(path.read_bytes()), **change}))
                path.chmod(0o600)
                self.assertEqual(self.run_authorize()['status'], 'FORWARD_DEPLOY_AUTHORIZED')
                self.assertEqual(json.loads(path.read_bytes())['targetSha'], original['targetSha'])
                # ชื่อ retired ผูกเวลาเป็นวินาที ย้ายออกเพื่อให้รอบถัดไปในวินาทีเดียวกันเก็บได้
                for retired in (self.root / 'operator').glob('uat-forward-deploy-retired-*.json'):
                    retired.rename(retired.with_name('kept-' + list(change)[0]))


if __name__ == '__main__':
    unittest.main()
