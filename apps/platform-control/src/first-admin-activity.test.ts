import assert from 'node:assert/strict';
import test from 'node:test';
import { firstAdminActivityOf } from './first-admin-activity.js';

test('แปลง Keycloak 26 event เป็นเหตุการณ์ timeline ตามที่เห็นจริงใน execute-actions flow', () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ type: 'VERIFY_EMAIL' }, 'FIRST_ADMIN_EMAIL_VERIFIED'],
    // ยืนยันอีเมลผ่านลิงก์ execute-actions มาเป็น custom required action
    [
      { type: 'CUSTOM_REQUIRED_ACTION', details: { custom_required_action: 'VERIFY_EMAIL' } },
      'FIRST_ADMIN_EMAIL_VERIFIED',
    ],
    [{ type: 'CUSTOM_REQUIRED_ACTION', details: { custom_required_action: 'TERMS' } }, null],
    [{ type: 'UPDATE_PASSWORD' }, 'FIRST_ADMIN_PASSWORD_SET'],
    [
      { type: 'UPDATE_CREDENTIAL', details: { credential_type: 'password' } },
      'FIRST_ADMIN_PASSWORD_SET',
    ],
    [{ type: 'UPDATE_TOTP' }, 'FIRST_ADMIN_TOTP_ENROLLED'],
    [
      { type: 'UPDATE_CREDENTIAL', details: { credential_type: 'otp' } },
      'FIRST_ADMIN_TOTP_ENROLLED',
    ],
    [{ type: 'UPDATE_CREDENTIAL', details: { credential_type: 'webauthn' } }, null],
    [{ type: 'LOGIN', details: { username: 'owner@example.test' } }, null],
  ];
  for (const [event, expected] of cases) {
    assert.equal(firstAdminActivityOf(event), expected, JSON.stringify(event));
  }
});
