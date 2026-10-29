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
  test(`${action}: คืน dependent proxy เดิมและรอ HTTP/OIDC จริงก่อนรายงานผ่าน`, (t) => {
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

  test(`${action}: proxy digest ไม่ตรงต้องหยุดก่อนสลับ Keycloak โดย rollback ยังปิด rollout ก่อน`, (t) => {
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

  test(`${action}: Compose ล้มยังคืน proxy แต่ไม่เปลี่ยน failure เป็น success`, (t) => {
    const f = fixture(t);
    writeFileSync(f.marker, 'old');
    const r = f.run(action, { COMPOSE_FAIL: '1' });
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(f.root, 'proxy-running')));
    if (action === 'rollback') assert.equal(existsSync(f.marker), false);
  });
}

for (const env of [{ START_FAIL: '1' }, { HTTP_FAIL: '1' }]) {
  test(`rollback: ${Object.keys(env)[0]} ต้องไม่เหลือ marker เก่าที่เปิด canary ได้`, (t) => {
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
