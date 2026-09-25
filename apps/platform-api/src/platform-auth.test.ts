import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Controller, Get, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { PlatformRollout, type PlatformRolloutState } from '@d-contact/platform-control';
import { toVerifiedWorkspaceIdentity } from '@d-contact/workspace-session';
import {
  PlatformIdentityError,
  toVerifiedPlatformIdentity,
  type PlatformIdentityRejection,
} from './platform-identity.js';
import { RequirePlatformCapability, type PlatformAuthDiagnostic } from './platform-auth.js';
import { PlatformApiModule } from './platform-api.module.js';
import {
  TEST_NOW,
  createTestSigner,
  platformClaims,
  tenantClaims,
  type TestSigner,
} from './test-tokens.js';

function rejection(claims: Record<string, unknown>): PlatformIdentityRejection | 'ACCEPTED' {
  try {
    toVerifiedPlatformIdentity(claims, TEST_NOW);
    return 'ACCEPTED';
  } catch (error) {
    assert.ok(error instanceof PlatformIdentityError);
    return error.reason;
  }
}

describe('toVerifiedPlatformIdentity — token matrix (#387 invariants)', () => {
  test('operator ได้ read + mutate; auditor ได้ read เท่านั้น', () => {
    const operator = toVerifiedPlatformIdentity(platformClaims('platform_operator'), TEST_NOW);
    assert.deepEqual(operator.roles, ['platform_operator']);
    assert.deepEqual(operator.capabilities, ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE']);
    const auditor = toVerifiedPlatformIdentity(platformClaims('platform_auditor'), TEST_NOW);
    assert.deepEqual(auditor.roles, ['platform_auditor']);
    assert.deepEqual(auditor.capabilities, ['CONTROL_PLANE_READ']);
    assert.equal(auditor.subject, 'sub-platform_auditor');
    assert.equal(auditor.sessionId, 'sid-platform_auditor');
  });

  const cases: Array<[string, Record<string, unknown>, PlatformIdentityRejection]> = [
    ['tenant-only token', tenantClaims(), 'WRONG_CLIENT'],
    [
      'platform token ที่ปน tenant_id',
      platformClaims('platform_operator', { tenant_id: 't-1' }),
      'TENANT_CONTEXT_PRESENT',
    ],
    [
      'platform token ที่ปน tenant_slug',
      platformClaims('platform_operator', { tenant_slug: 'demo' }),
      'TENANT_CONTEXT_PRESENT',
    ],
    [
      'platform token ที่ปน organization',
      platformClaims('platform_operator', { organization: { demo: {} } }),
      'TENANT_CONTEXT_PRESENT',
    ],
    [
      'platform token ที่ปน dc_user_id',
      platformClaims('platform_operator', { dc_user_id: 'u-1' }),
      'TENANT_CONTEXT_PRESENT',
    ],
    [
      'platform token ที่มี tenant realm role',
      platformClaims('platform_operator', { realm_access: { roles: ['admin'] } }),
      'TENANT_ROLE_PRESENT',
    ],
    [
      'realm_access ผิดรูป',
      platformClaims('platform_operator', { realm_access: { roles: 'admin' } }),
      'TENANT_ROLE_PRESENT',
    ],
    [
      'azp ไม่ใช่ platform-console',
      platformClaims('platform_operator', { azp: 'dcontact-console' }),
      'WRONG_CLIENT',
    ],
    ['ID token (typ=ID)', platformClaims('platform_operator', { typ: 'ID' }), 'NOT_ACCESS_TOKEN'],
    ['refresh token', platformClaims('platform_operator', { typ: 'Refresh' }), 'NOT_ACCESS_TOKEN'],
    [
      'หมดอายุ',
      platformClaims('platform_operator', { exp: Math.floor(TEST_NOW.getTime() / 1000) }),
      'EXPIRED',
    ],
    ['ไม่มี exp', platformClaims('platform_operator', { exp: undefined }), 'MALFORMED'],
    ['ไม่มี sid', platformClaims('platform_operator', { sid: undefined }), 'MALFORMED'],
    ['ไม่มี sub', platformClaims('platform_operator', { sub: '' }), 'MALFORMED'],
    [
      'login ด้วยรหัสผ่านอย่างเดียว',
      platformClaims('platform_operator', { amr: ['pwd'] }),
      'MFA_REQUIRED',
    ],
    ['ไม่มี amr', platformClaims('platform_operator', { amr: undefined }), 'MFA_REQUIRED'],
    [
      'otp อย่างเดียวไม่มี pwd',
      platformClaims('platform_operator', { amr: ['otp'] }),
      'MFA_REQUIRED',
    ],
    [
      'ไม่มี platform role',
      platformClaims('platform_operator', { resource_access: {} }),
      'NO_PLATFORM_ROLE',
    ],
    ['role ที่ไม่รู้จัก', platformClaims('platform_superuser'), 'NO_PLATFORM_ROLE'],
    [
      'role ของ client อื่น',
      platformClaims('x', {
        resource_access: { 'dcontact-api': { roles: ['platform_operator'] } },
      }),
      'NO_PLATFORM_ROLE',
    ],
  ];
  for (const [name, claims, reason] of cases) {
    test(`ปฏิเสธ: ${name} → ${reason}`, () => assert.equal(rejection(claims), reason));
  }

  test('role ที่ไม่รู้จักปนกับ role จริงถูกตัดทิ้ง ไม่ได้ capability เพิ่ม', () => {
    const identity = toVerifiedPlatformIdentity(
      platformClaims('platform_auditor', {
        resource_access: { 'dcontact-platform-api': { roles: ['platform_auditor', 'root'] } },
      }),
      TEST_NOW,
    );
    assert.deepEqual(identity.roles, ['platform_auditor']);
    assert.deepEqual(identity.capabilities, ['CONTROL_PLANE_READ']);
  });

  test('platform token ใช้กับ tenant boundary ไม่ได้ (toVerifiedWorkspaceIdentity ปฏิเสธ)', () => {
    for (const role of ['platform_operator', 'platform_auditor']) {
      assert.throws(() => toVerifiedWorkspaceIdentity(platformClaims(role) as never, TEST_NOW));
    }
  });
});

describe('JosePlatformAccessTokenVerifier', () => {
  let signer: Awaited<ReturnType<typeof createTestSigner>>;
  before(async () => {
    signer = await createTestSigner();
  });

  test('รับ token ที่ลงนามด้วย key ของ realm และ audience ถูก', async () => {
    const claims = await signer.verifier.verifyAccessToken(
      await signer.sign(platformClaims('platform_operator')),
    );
    assert.equal(claims.azp, 'platform-console');
  });
  test('ปฏิเสธ key ปลอม, audience ของ tenant API, issuer อื่น และ header typ ผิด', async () => {
    const attempts = [
      signer.forger(platformClaims('platform_operator')),
      signer.sign(platformClaims('platform_operator', { aud: 'dcontact-api' })),
      signer.sign(tenantClaims()),
      signer.sign(platformClaims('platform_operator'), {
        issuer: 'http://keycloak.test/realms/master',
      }),
      signer.sign(platformClaims('platform_operator'), { typ: 'at+jwt' }),
    ];
    for (const token of await Promise.all(attempts)) {
      await assert.rejects(signer.verifier.verifyAccessToken(token));
    }
  });
});

@Controller('api/v1/probe')
class ProbeController {
  @Get()
  @RequirePlatformCapability('CONTROL_PLANE_READ')
  read() {
    return { ok: 'read' };
  }

  @Post()
  @RequirePlatformCapability('PROVISIONING_MUTATE')
  mutate() {
    return { ok: 'mutate' };
  }

  /** ลืมประกาศ capability — ต้องถูกปฏิเสธ (deny by default) */
  @Get('undeclared')
  undeclared() {
    return { ok: 'leak' };
  }
}

describe('PlatformAuthGuard ผ่าน HTTP จริง', () => {
  let app: INestApplication;
  let baseUrl: string;
  let signer: TestSigner & { forger: TestSigner['sign'] };
  const diagnostics: PlatformAuthDiagnostic[] = [];
  const tokens: Record<string, string> = {};
  const rollout: PlatformRolloutState = { enabled: true, allowlist: ['sub-platform_operator'] };

  before(async () => {
    signer = await createTestSigner();
    app = await NestFactory.create(
      PlatformApiModule.register({
        verifier: signer.verifier,
        diagnostics: { write: (diagnostic) => diagnostics.push(diagnostic) },
        clock: () => TEST_NOW,
        rollout: new PlatformRollout(() => rollout),
        controllers: [ProbeController],
      }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    tokens.operator = await signer.sign(platformClaims('platform_operator'));
    tokens.auditor = await signer.sign(platformClaims('platform_auditor'));
    tokens.tenant = await signer.sign(tenantClaims({ aud: 'dcontact-platform-api' }));
    tokens.mixed = await signer.sign(platformClaims('platform_operator', { tenant_id: 't-1' }));
    tokens.noOtp = await signer.sign(platformClaims('platform_operator', { amr: ['pwd'] }));
    tokens.forged = await signer.forger(platformClaims('platform_operator'));
    tokens.outsider = await signer.sign(
      platformClaims('platform_operator', { sub: 'sub-not-in-canary' }),
    );
  });
  after(async () => {
    await app.close();
  });

  async function call(path: string, token?: string, method = 'GET') {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-correlation-id': 'corr-probe-1',
      },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test('operator: read 200, mutate 201; auditor: read 200, mutate 403', async () => {
    assert.equal((await call('/api/v1/probe', tokens.operator)).status, 200);
    assert.equal((await call('/api/v1/probe', tokens.operator, 'POST')).status, 201);
    assert.equal((await call('/api/v1/probe', tokens.auditor)).status, 200);
    const denied = await call('/api/v1/probe', tokens.auditor, 'POST');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, {
      status: 403,
      code: 'FORBIDDEN',
      title: 'ไม่มีสิทธิ์ทำรายการนี้',
      correlationId: 'corr-probe-1',
      retryable: false,
    });
  });

  test('tenant, mixed, no-OTP, forged และไม่มี token → 401 envelope เดียวกันทุกกรณี', async () => {
    const expected = {
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'ต้องเข้าสู่ระบบ Platform Console ใหม่',
      correlationId: 'corr-probe-1',
      retryable: false,
    };
    for (const token of [tokens.tenant, tokens.mixed, tokens.noOtp, tokens.forged, undefined]) {
      for (const method of ['GET', 'POST']) {
        const result = await call('/api/v1/probe', token, method);
        assert.deepEqual(result, { status: 401, body: expected });
      }
    }
  });

  test('route ที่ไม่ประกาศ capability ถูกปฏิเสธแม้เป็น operator', async () => {
    const result = await call('/api/v1/probe/undeclared', tokens.operator);
    assert.equal(result.status, 403);
    assert.equal(JSON.stringify(result.body).includes('leak'), false);
  });

  test('GET /api/v1/session คืน roles/capabilities โดยไม่มี token หรือ claim ดิบ', async () => {
    const result = await call('/api/v1/session', tokens.auditor);
    assert.deepEqual(result, {
      status: 200,
      body: {
        subject: 'sub-platform_auditor',
        roles: ['platform_auditor'],
        capabilities: ['CONTROL_PLANE_READ'],
        mutations: 'NOT_GRANTED',
        expiresAt: new Date(TEST_NOW.getTime() + 300_000).toISOString(),
      },
    });
    assert.equal((await call('/health/live')).status, 200);
  });

  test('A1.8 canary: operator นอก allowlist mutate ไม่ได้ (403) แต่อ่านได้ และ session เป็นอ่านอย่างเดียว', async () => {
    assert.equal((await call('/api/v1/probe', tokens.outsider)).status, 200);
    const denied = await call('/api/v1/probe', tokens.outsider, 'POST');
    assert.deepEqual([denied.status, denied.body.code], [403, 'FORBIDDEN']);
    const session = await call('/api/v1/session', tokens.outsider);
    assert.deepEqual(
      [session.body.capabilities, session.body.mutations],
      [['CONTROL_PLANE_READ'], 'NOT_ALLOWLISTED'],
    );
    const allowed = await call('/api/v1/session', tokens.operator);
    assert.deepEqual(
      [allowed.body.capabilities, allowed.body.mutations],
      [['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE'], 'ALLOWED'],
    );
  });

  test('A1.8 rollback: flag ปิด = mutate 503 PROVISIONING_DISABLED (ไม่ retryable), อ่านได้ปกติ', async (t) => {
    rollout.enabled = false;
    t.after(() => {
      rollout.enabled = true;
    });
    const disabled = await call('/api/v1/probe', tokens.operator, 'POST');
    assert.deepEqual(disabled, {
      status: 503,
      body: {
        status: 503,
        code: 'PROVISIONING_DISABLED',
        title: 'ปิดการสร้างและแก้ไขชั่วคราว ดูสถานะได้ตามปกติ',
        correlationId: 'corr-probe-1',
        retryable: false,
      },
    });
    assert.equal((await call('/api/v1/probe', tokens.operator)).status, 200);
    // auditor ยังได้ 403 เหมือนเดิม — flag ไม่เปลี่ยนสิทธิ์ของ role
    assert.equal((await call('/api/v1/probe', tokens.auditor, 'POST')).status, 403);
    const session = await call('/api/v1/session', tokens.operator);
    assert.deepEqual(
      [session.body.capabilities, session.body.mutations],
      [['CONTROL_PLANE_READ'], 'DISABLED'],
    );
  });

  test('diagnostics มีเหตุผลเชิงลึกแต่ไม่มี token หรือ PII', async () => {
    const reasons = new Set(diagnostics.map((diagnostic) => diagnostic.reason));
    for (const reason of [
      'WRONG_CLIENT',
      'TENANT_CONTEXT_PRESENT',
      'MFA_REQUIRED',
      'TOKEN_INVALID',
      'MISSING_BEARER',
      'CAPABILITY_NOT_GRANTED',
      'ROUTE_UNDECLARED',
      'ROLLOUT_NOT_ALLOWLISTED',
      'PROVISIONING_DISABLED',
    ]) {
      assert.ok(reasons.has(reason as never), `ขาด diagnostic reason ${reason}`);
    }
    const serialized = JSON.stringify(diagnostics);
    for (const token of Object.values(tokens)) assert.equal(serialized.includes(token), false);
    for (const secret of ['@', 'demo', 'tenant-admin-sub', '1111']) {
      assert.equal(serialized.includes(secret), false, `diagnostics รั่ว ${secret}`);
    }
  });
});
