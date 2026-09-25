/**
 * D1.13 (#452): เปิด/ปิด `ui.shell.v2` ด้วย role `dcontact_platform` จริง (NOBYPASSRLS)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { setTenantUiFlag, TenantUiFlagError } from './tenant-ui-flags.js';

const PLATFORM_DATABASE_URL =
  process.env.PLATFORM_DATABASE_URL ??
  'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public';

test('platform operator เปิด/ปิด ui.shell.v2 พร้อม audit และต้องยืนยัน gate #77 ก่อนเปิด', async (t) => {
  const owner = new PrismaClient();
  const platform = new PrismaClient({ datasources: { db: { url: PLATFORM_DATABASE_URL } } });
  const tenantId = randomUUID();
  const slug = `d1-13-flag-${tenantId.slice(0, 8)}`;
  await owner.tenant.create({
    data: { id: tenantId, name: slug, slug, sipDomain: `${slug}.test` },
  });
  t.after(async () => {
    await owner.tenantUiFlagAuditEvent.deleteMany({ where: { tenantId } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), platform.$disconnect()]);
  });

  const base = {
    tenantSlug: slug,
    flagKey: 'ui.shell.v2',
    reason: 'UAT ของ D1',
    actor: 'ops@test',
  };
  const code = (error: unknown) => (error as TenantUiFlagError).code;

  await assert.rejects(
    setTenantUiFlag(platform, { ...base, enabled: true }),
    (error) => code(error) === 'VOICE_PILOT_ACK_REQUIRED',
  );
  await assert.rejects(
    setTenantUiFlag(platform, {
      ...base,
      enabled: true,
      voicePilotAcknowledged: true,
      reason: ' ',
    }),
    (error) => code(error) === 'REASON_REQUIRED',
  );
  await assert.rejects(
    setTenantUiFlag(platform, {
      ...base,
      enabled: true,
      voicePilotAcknowledged: true,
      flagKey: 'x',
    }),
    (error) => code(error) === 'UNKNOWN_FLAG',
  );
  await assert.rejects(
    setTenantUiFlag(platform, { ...base, tenantSlug: 'no-such-tenant', enabled: false }),
    (error) => code(error) === 'TENANT_NOT_FOUND',
  );

  assert.deepEqual(
    await setTenantUiFlag(platform, { ...base, enabled: true, voicePilotAcknowledged: true }),
    { tenantId, flagKey: 'ui.shell.v2', enabled: true, previous: false },
  );
  // ปิดได้ทันทีโดยไม่ต้อง ack — เป็นทาง rollback
  assert.deepEqual(
    await setTenantUiFlag(platform, { ...base, enabled: false, reason: 'rollback' }),
    { tenantId, flagKey: 'ui.shell.v2', enabled: false, previous: true },
  );

  const audit = await owner.tenantUiFlagAuditEvent.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: { enabled: true, reason: true, actor: true },
  });
  assert.deepEqual(audit, [
    { enabled: true, reason: 'UAT ของ D1', actor: 'ops@test' },
    { enabled: false, reason: 'rollback', actor: 'ops@test' },
  ]);
});
