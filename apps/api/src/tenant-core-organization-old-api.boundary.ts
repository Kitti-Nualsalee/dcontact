/** ภาพ API รุ่นก่อนรัน entrypoint จริงกับ schema ใหม่บน network sandbox เฉพาะงาน */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';
const image = process.env.CORE_COMPAT_OLD_API_IMAGE;
function docker(args: string[], env?: NodeJS.ProcessEnv) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ?? process.env,
  }).trim();
}
test(
  'องค์กร compatibility: old API image อ่าน CORE_ADMIN nullable provenance/locale และ rollback คง ledger',
  {
    skip: !image
      ? 'NOT_RUN: ต้องระบุ CORE_COMPAT_OLD_API_IMAGE และ owned DB/Keycloak containers'
      : false,
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(image);
    const pg = process.env.CORE_COMPAT_POSTGRES_CONTAINER,
      kc = process.env.CORE_COMPAT_KEYCLOAK_CONTAINER;
    assert.ok(pg && kc, 'ต้องระบุ containers ที่เป็น sandbox ของงานนี้');
    const source = docker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      image,
    ]);
    assert.match(source, /^[a-f0-9]{40}$/);
    if (process.env.CORE_COMPAT_EXPECTED_OLD_SHA)
      assert.equal(source, process.env.CORE_COMPAT_EXPECTED_OLD_SHA);
    execFileSync('git', ['merge-base', '--is-ancestor', source, 'HEAD']);
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    const { f, issuer, tokenFor } = await coreIdentitySandbox((cleanup) => t.after(cleanup));
    const token = await tokenFor('admin');
    const saved = await f.request(
      'tenant/core-settings/organization',
      token,
      {
        commandId: randomUUID(),
        expectedRevision: '0',
        patch: {
          displayName: 'Compatibility organization',
          defaults: { locale: 'en', timeZone: 'America/New_York' },
        },
      },
      'PATCH',
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.command.outcome, 'APPLIED');
    const before = await f.owner.tenantSettings.findUniqueOrThrow({
      where: { tenantId: f.tenantId },
    });
    assert.equal(before.initializationSource, 'CORE_ADMIN');
    assert.equal(before.bootstrapTemplateDigest, null);
    const { TenantBootstrapPort } = await import(
      pathToFileURL(resolve('../platform-control/src/tenant-bootstrap.ts')).href
    );
    const adoption = await new TenantBootstrapPort(f.owner, f.owner).find({
      tenantId: f.tenantId,
      requestId: saved.body.command.id,
    });
    assert.deepEqual(adoption, { status: 'MISMATCH', code: 'BOOTSTRAP_CORRELATION_MISMATCH' });
    const suffix = randomUUID(),
      network = `core726-compat-${suffix}`,
      container = `core726-old-api-${suffix}`;
    docker(['network', 'create', network]);
    t.after(() => {
      try {
        docker(['rm', '--force', container]);
      } catch {}
      for (const target of [pg, kc])
        try {
          docker(['network', 'disconnect', network, target]);
        } catch {}
      try {
        docker(['network', 'rm', network]);
      } catch {}
    });
    docker(['network', 'connect', '--alias', 'core-db', network, pg]);
    docker(['network', 'connect', '--alias', 'core-identity', network, kc]);
    const url = new URL(process.env.APPLICATION_DATABASE_URL!);
    url.hostname = 'core-db';
    url.port = '5432';
    const realm = new URL(issuer).pathname;
    const environment = {
      ...process.env,
      DATABASE_URL: url.toString(),
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_AUDIENCE: 'dcontact-api',
      KEYCLOAK_JWKS_URI: `http://core-identity:8080${realm}/protocol/openid-connect/certs`,
      DCONTACT_API_PROFILE: 'uat-workspace',
      E1_VOICE_COMMAND_SECRET: randomBytes(32).toString('hex'),
      E1_VOICE_TENANT_ID: f.tenantId,
      DPHONE_EMBED_SCRIPT_URL: 'https://core.invalid/workspace/embed/dphone-embed.js',
      OUTBOUND_VOICE_DELIVERY_ENABLED: 'false',
      PORT: '3000',
    };
    const keys = [
      'DATABASE_URL',
      'KEYCLOAK_ISSUER',
      'KEYCLOAK_AUDIENCE',
      'KEYCLOAK_JWKS_URI',
      'DCONTACT_API_PROFILE',
      'E1_VOICE_COMMAND_SECRET',
      'E1_VOICE_TENANT_ID',
      'DPHONE_EMBED_SCRIPT_URL',
      'OUTBOUND_VOICE_DELIVERY_ENABLED',
      'PORT',
    ];
    docker(
      [
        'run',
        '--detach',
        '--name',
        container,
        '--network',
        network,
        '-p',
        '127.0.0.1:15441:3000',
        ...keys.flatMap((k) => ['--env', k]),
        id,
        'node',
        'dist/workspace-uat-main.js',
      ],
      environment,
    );
    const base = 'http://127.0.0.1:15441';
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if (
          (await fetch(`${base}/api/v1/runtime-profile`, { signal: AbortSignal.timeout(1000) })).ok
        ) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(ready, 'old image ต้อง boot workspace entrypoint จริง');
    const response = await fetch(`${base}/api/v1/tenant/locale-defaults`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { locale: 'en', timeZone: 'America/New_York' });
    const navigation = await fetch(`${base}/api/v1/me/navigation`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(navigation.status, 200);
    const receipt = await fetch(
      `${base}/api/v1/tenant/core-settings/commands/${saved.body.command.id}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(receipt.status, 200);
    assert.deepEqual(((await receipt.json()) as { command: unknown }).command, saved.body.command);
    assert.deepEqual(
      await f.owner.tenantSettings.findUniqueOrThrow({ where: { tenantId: f.tenantId } }),
      before,
    );
    assert.equal(await f.owner.tenantCoreConfigAudit.count({ where: { tenantId: f.tenantId } }), 1);
    const directory = resolve('../../artifacts/core-settings');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'compatibility-config.json'),
      JSON.stringify(
        {
          oldSourceSha: source,
          oldImageId: id,
          profile: 'uat-workspace',
          databaseRole: 'dcontact_app',
          newProvisionerRejectsCoreOrigin: true,
          keycloakVersion: '26.7.5',
          vmUat: 'NOT_RUN',
        },
        null,
        2,
      ),
    );
  },
);
