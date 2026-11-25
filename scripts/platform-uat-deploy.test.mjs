import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sha = 'a'.repeat(40);
const tenantSha = 'b'.repeat(40);
const image = `example.test/tenant-console@sha256:${'c'.repeat(64)}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'platform-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['bin', 'deployments', `platform/releases/${sha}`, `releases/${tenantSha}`])
    mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'deployments/current.json'), JSON.stringify({ sourceSha: tenantSha }));
  writeFileSync(join(root, 'platform/platform.env'), 'PLATFORM_PROVISIONING_ENABLED=false\n', {
    mode: 0o600,
  });
  writeFileSync(join(root, `releases/${tenantSha}/docker-compose.uat.3vm.yml`), 'services: {}\n');
  writeFileSync(join(root, `releases/${tenantSha}/release.env`), `CONSOLE_IMAGE=${image}\n`);
  for (const name of [
    'docker-compose.platform.3vm.yml',
    'docker-compose.platform-keycloak.3vm.yml',
  ])
    writeFileSync(join(root, `platform/releases/${sha}/${name}`), 'services: {}\n');
  writeFileSync(
    join(root, `platform/releases/${sha}/platform-release.env`),
    `SOURCE_SHA=${sha}\n` +
      ['PLATFORM_API_IMAGE', 'PLATFORM_CONSOLE_IMAGE', 'PLATFORM_KEYCLOAK_IMAGE']
        .map((k) => `${k}=${image}\n`)
        .join(''),
  );
  const source = readFileSync('infra/uat/operator/vm2-platform-deploy.sh', 'utf8');
  const script = join(root, 'deploy.sh');
  writeFileSync(script, source.replaceAll('/opt/dcontact-uat', root));
  const stub = String.raw`
import json, os, sys
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT']);args=sys.argv[1:];command=Path(sys.argv[0]).name
with (root/'commands').open('a') as out:out.write(json.dumps([command]+args)+'\n')
if command=='id':print('osdadmin')
elif command=='ip':print('inet 192.168.102.112/24')
elif command=='stat':print('600')
elif command=='docker':
 if args[0]=='inspect':print('example.test/other@sha256:'+'d'*64 if os.environ.get('WRONG_IMAGE') else os.environ['PROXY_IMAGE'])
 elif args[0]=='start':
  if os.environ.get('START_FAIL'):sys.exit(1)
  (root/'proxy-running').write_text('yes')
 else:sys.exit(99)
elif command=='docker-compose':
 if 'up' in args and args[-1]=='keycloak':
  # Reproduces Compose stopping the dependent proxy during Keycloak recreation.
  (root/'proxy-running').unlink(missing_ok=True)
  if os.environ.get('COMPOSE_FAIL'):sys.exit(1)
elif command=='curl':
 if not (root/'proxy-running').exists():sys.exit(7)
 if os.environ.get('HTTP_FAIL'):print('502')
 else:
  p=root/'http-count';count=int(p.read_text()) if p.exists() else 0
  p.write_text(str(count+1));print('502' if os.environ.get('HTTP_RETRY') and count<2 else '200')
elif command!='sleep':sys.exit(99)
`;
  for (const name of ['id', 'ip', 'stat', 'docker', 'docker-compose', 'curl', 'sleep']) {
    const file = join(root, 'bin', name);
    writeFileSync(file, `#!/usr/bin/env python3\n${stub}`);
    chmodSync(file, 0o700);
  }
  const marker = join(root, `platform/drill-${sha}.ok`);
  const run = (action, env = {}) =>
    spawnSync('bash', [script, action, sha], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        FIXTURE_ROOT: root,
        PROXY_IMAGE: image,
        ...env,
      },
    });
  const commands = () =>
    readFileSync(join(root, 'commands'), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, marker, run, commands };
}

for (const action of ['keycloak', 'rollback']) {
  test(`${action}: restores the dependent proxy and waits for real HTTP/OIDC before reporting a pass`, (t) => {
    const f = fixture(t);
    const r = f.run(action, { HTTP_RETRY: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(f.root, 'proxy-running')));
    const commands = f.commands();
    assert.ok(
      commands.some(
        (c) => c[0] === 'docker' && c[1] === 'start' && c[2] === 'dcontact-uat-proxy-1',
      ),
    );
    assert.ok(!commands.some((c) => c[0] === 'docker-compose' && c.includes('proxy')));
    const probes = commands.filter((c) => c[0] === 'curl');
    assert.ok(probes.length >= 4);
    assert.ok(
      probes.every(
        (c) => c.includes('--resolve') && !c.includes('--insecure') && !c.includes('-k'),
      ),
    );
    assert.ok(probes.some((c) => c.at(-1).endsWith('/api/v1/runtime-profile')));
    assert.ok(probes.some((c) => c.at(-1).endsWith('/.well-known/openid-configuration')));
    assert.equal(existsSync(f.marker), action === 'rollback');
  });

  test(`${action}: a proxy digest mismatch must stop before switching Keycloak, with rollback still keeping the rollout closed first`, (t) => {
    const f = fixture(t);
    writeFileSync(f.marker, 'old');
    if (action === 'rollback')
      writeFileSync(join(f.root, 'platform/platform.env'), 'PLATFORM_PROVISIONING_ENABLED=true\n');
    const r = f.run(action, { WRONG_IMAGE: '1' });
    assert.notEqual(r.status, 0);
    assert.ok(!f.commands().some((c) => c[0] === 'docker-compose' && c.at(-1) === 'keycloak'));
    if (action === 'rollback') {
      assert.equal(existsSync(f.marker), false);
      assert.match(
        readFileSync(join(f.root, 'platform/platform.env'), 'utf8'),
        /^PLATFORM_PROVISIONING_ENABLED=false$/m,
      );
      assert.ok(f.commands().some((c) => c[0] === 'docker-compose' && c.includes('stop')));
    }
  });

  test(`${action}: when Compose fails the proxy is still restored but the failure is not turned into a success`, (t) => {
    const f = fixture(t);
    writeFileSync(f.marker, 'old');
    const r = f.run(action, { COMPOSE_FAIL: '1' });
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(f.root, 'proxy-running')));
    if (action === 'rollback') assert.equal(existsSync(f.marker), false);
  });
}

for (const env of [{ START_FAIL: '1' }, { HTTP_FAIL: '1' }]) {
  test(`rollback: ${Object.keys(env)[0]} must not leave an old marker that could open the canary`, (t) => {
    const f = fixture(t);
    writeFileSync(f.marker, 'old');
    const r = f.run('rollback', env);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(f.marker), false);
    assert.match(
      readFileSync(join(f.root, 'platform/platform.env'), 'utf8'),
      /^PLATFORM_PROVISIONING_ENABLED=false$/m,
    );
  });
}

test('update: recreates the Platform API/worker/Console from this release keeping the rollout and not touching Keycloak', (t) => {
  const f = fixture(t);
  const env = 'PLATFORM_PROVISIONING_ENABLED=true\nPLATFORM_OPERATOR_ALLOWLIST=subject\n';
  writeFileSync(join(f.root, 'platform/platform.env'), env, { mode: 0o600 });
  const r = f.run('update');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /UPDATE ผ่าน/); // allow-thai: matches the Thai output of infra/uat/bin/uat-deploy.sh
  const compose = f.commands().filter((c) => c[0] === 'docker-compose');
  assert.ok(compose.every((c) => c.includes('dcontact-platform-uat')));
  assert.ok(
    compose.every((c) => c.includes(join(f.root, `platform/releases/${sha}/platform-release.env`))),
  );
  const up = compose.find((c) => c.includes('up'));
  assert.deepEqual(up?.slice(up.indexOf('up')), [
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    '--wait',
    'platform-api',
    'platform-worker',
    'platform-console',
  ]);
  assert.ok(!compose.some((c) => c.includes('keycloak') || c.includes('platform-keycloak-config')));
  assert.ok(!f.commands().some((c) => c[0] === 'docker'));
  assert.equal(readFileSync(join(f.root, 'platform/platform.env'), 'utf8'), env);
});

test('update: a release with incomplete files or a mismatched SHA must stop before calling Compose', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, `platform/releases/${sha}/platform-release.env`),
    `SOURCE_SHA=${'e'.repeat(40)}\n`,
  );
  const r = f.run('update');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /release SHA ไม่ตรง/); // allow-thai: matches the Thai output of infra/uat/bin/uat-deploy.sh
  assert.ok(
    !existsSync(join(f.root, 'commands')) || !f.commands().some((c) => c[0] === 'docker-compose'),
  );
});
