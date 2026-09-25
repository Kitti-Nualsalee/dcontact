import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformRollout } from './platform-rollout.js';

const OPERATOR = '6f1c2b1e-8e0a-4d6b-9a57-0d6f3c1b2a90';
const OTHER = '0b8e7f5d-3c2a-4e19-8d76-5a4b3c2d1e0f';

test('default ปิด: ไม่ตั้ง env หรือค่าไม่ใช่ "true" = ปิดทั้ง mutation และ worker claim', () => {
  for (const env of [
    {},
    { PLATFORM_PROVISIONING_ENABLED: '1' },
    { PLATFORM_PROVISIONING_ENABLED: 'TRUE' },
  ]) {
    const rollout = PlatformRollout.fromEnv({ ...env, PLATFORM_OPERATOR_ALLOWLIST: OPERATOR });
    assert.equal(rollout.mutationFor(OPERATOR), 'DISABLED');
    assert.equal(rollout.claimsEnabled(), false);
  }
});

test('เปิด: mutation เฉพาะ subject ใน allowlist, worker claim ได้', () => {
  const rollout = PlatformRollout.fromEnv({
    PLATFORM_PROVISIONING_ENABLED: 'true',
    PLATFORM_OPERATOR_ALLOWLIST: ` ${OPERATOR} ,`,
  });
  assert.equal(rollout.mutationFor(OPERATOR), 'ALLOWED');
  assert.equal(rollout.mutationFor(OTHER), 'NOT_ALLOWLISTED');
  assert.equal(rollout.claimsEnabled(), true);
  // allowlist ว่าง = ไม่มีใคร mutate ได้ (canary ต้องระบุคนชัดเจน)
  const empty = PlatformRollout.fromEnv({ PLATFORM_PROVISIONING_ENABLED: 'true' });
  assert.equal(empty.mutationFor(OPERATOR), 'NOT_ALLOWLISTED');
});

test('allowlist ที่มีค่าไม่ใช่ subject UUID (เช่น email) ทำให้ start ไม่ขึ้น และ error ไม่มีค่านั้น', () => {
  assert.throws(
    () =>
      PlatformRollout.fromEnv({
        PLATFORM_PROVISIONING_ENABLED: 'true',
        PLATFORM_OPERATOR_ALLOWLIST: `${OPERATOR},ops@example.test`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('ops@example.test'), false);
      return true;
    },
  );
});

test('fixed() ไม่ถูกแก้จากภายนอกหลังสร้าง', () => {
  const allowlist = [OPERATOR];
  const rollout = PlatformRollout.fixed({ enabled: true, allowlist });
  allowlist.push(OTHER);
  assert.equal(rollout.mutationFor(OTHER), 'NOT_ALLOWLISTED');
});
