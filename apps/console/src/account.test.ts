import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountApiError, createAccountApi, createAccountPolicyApi } from './account/api.js';
import {
  VERIFY_TOKEN_KEY,
  accountErrorKey,
  accountHref,
  passwordRuleKey,
  stashVerifyToken,
  takeVerifyToken,
} from './account/model.js';
import accountTh from './i18n/locales/th/account.json' with { type: 'json' };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test('ลิงก์ยืนยัน: token ถูกย้ายออกจาก URL ทันที (replaceState) แล้วอ่านได้ครั้งเดียว', () => {
  const storage = memoryStorage();
  const replaced: string[] = [];
  const history = {
    replaceState: (_: unknown, __: string, url?: string | URL | null) =>
      void replaced.push(String(url)),
  };
  const clean = stashVerifyToken(
    new URL('https://console.test/?tenant=demo&view=account&verify=tok-123#x'),
    storage,
    history,
  );
  assert.equal(clean.href, 'https://console.test/?tenant=demo&view=account#x');
  assert.deepEqual(replaced, ['/?tenant=demo&view=account#x']);
  assert.equal(storage.values.get(VERIFY_TOKEN_KEY), 'tok-123');
  assert.equal(takeVerifyToken(storage), 'tok-123');
  assert.equal(takeVerifyToken(storage), null, 'ใช้ได้ครั้งเดียว');

  // ไม่มี verify = ไม่แตะ history; verify ว่าง = ลบออกจาก URL แต่ไม่เก็บ
  const untouched = new URL('https://console.test/?view=account');
  assert.equal(stashVerifyToken(untouched, storage, history), untouched);
  assert.equal(replaced.length, 1);
  stashVerifyToken(new URL('https://console.test/?view=account&verify='), storage, history);
  assert.equal(replaced.at(-1), '/?view=account');
  assert.equal(storage.values.has(VERIFY_TOKEN_KEY), false);

  // storage ใช้ไม่ได้ก็ยังลบ token ออกจาก URL
  const broken = {
    setItem: () => {
      throw new Error('blocked');
    },
  };
  stashVerifyToken(new URL('https://console.test/?view=account&verify=t'), broken, history);
  assert.equal(replaced.at(-1), '/?view=account');
});

test('error ของ API → ข้อความที่มีอยู่จริงใน catalog และไม่แสดง code ดิบ', () => {
  const resolve = (key: string) =>
    key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], accountTh);
  const cases: Array<[AccountApiError | Error, string]> = [
    [new AccountApiError(400, 'PASSWORD_POLICY_VIOLATION'), 'errors.passwordPolicy'],
    [new AccountApiError(409, 'EMAIL_IN_USE'), 'errors.emailInUse'],
    [new AccountApiError(403, 'EMAIL_CHANGE_NOT_ALLOWED'), 'errors.emailChangeNotAllowed'],
    [new AccountApiError(410, 'EMAIL_CHANGE_EXPIRED'), 'errors.emailChangeExpired'],
    [new AccountApiError(400, 'INVALID_OTP_CODE'), 'errors.invalidOtp'],
    [new AccountApiError(410, 'ENROLMENT_EXPIRED'), 'errors.enrolmentExpired'],
    [new AccountApiError(409, 'MFA_REQUIRED_LAST_DEVICE'), 'errors.lastDevice'],
    [new AccountApiError(404, 'DEVICE_NOT_FOUND'), 'errors.deviceNotFound'],
    [new AccountApiError(429, 'RATE_LIMITED'), 'errors.rateLimited'],
    [new AccountApiError(503, 'IDENTITY_UNAVAILABLE'), 'errors.unavailable'],
    [new AccountApiError(409, 'MFA_ENFORCEMENT_UNAVAILABLE'), 'errors.unavailable'],
    [new AccountApiError(409, 'REVISION_CONFLICT'), 'errors.revisionConflict'],
    [new AccountApiError(400, 'VALIDATION_FAILED', { reason: 'SAME' }), 'errors.sameEmail'],
    [new AccountApiError(400, 'VALIDATION_FAILED', { reason: 'DUPLICATE' }), 'errors.labelInUse'],
    [new AccountApiError(400, 'VALIDATION_FAILED', { reason: 'INVALID' }), 'errors.invalid'],
    [new AccountApiError(403, undefined), 'errors.forbidden'],
    [new Error('boom'), 'errors.generic'],
  ];
  for (const [error, key] of cases) {
    assert.equal(accountErrorKey(error), key);
    assert.equal(typeof resolve(key), 'string', key);
  }
  for (const rule of ['MIN_LENGTH', 'UPPER_CASE', 'HISTORY', 'SOMETHING_NEW']) {
    assert.equal(typeof resolve(passwordRuleKey(rule)), 'string', rule);
  }
  assert.equal(passwordRuleKey('SOMETHING_NEW'), 'password.rules.other');
  assert.doesNotMatch(JSON.stringify(accountTh), /keycloak/i);
});

test('API client: path/method ตาม contract, error มี code/rules/retry-after, 204 = undefined', async () => {
  const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
  const responses: Response[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      ...(init.body ? { body: String(init.body) } : {}),
      auth: (init.headers as Record<string, string>).authorization,
    });
    return responses.shift()!;
  }) as typeof globalThis.fetch;
  const api = createAccountApi({ baseUrl: 'https://api.test/', accessToken: () => 'tok', fetch });

  responses.push(new Response(null, { status: 204 }));
  assert.equal(await api.changePassword('Secret-1'), undefined);
  assert.deepEqual(calls.at(-1), {
    url: 'https://api.test/api/v1/me/account/password',
    method: 'POST',
    body: '{"newPassword":"Secret-1"}',
    auth: 'Bearer tok',
  });

  responses.push(
    Response.json(
      { code: 'PASSWORD_POLICY_VIOLATION', rules: [{ rule: 'MIN_LENGTH', value: 12 }] },
      { status: 400 },
    ),
  );
  await assert.rejects(api.changePassword('x'), (error: unknown) => {
    assert.ok(error instanceof AccountApiError);
    assert.deepEqual(
      [error.status, error.code, error.details.rules],
      [400, 'PASSWORD_POLICY_VIOLATION', [{ rule: 'MIN_LENGTH', value: 12 }]],
    );
    return true;
  });
  responses.push(
    Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'retry-after': '120' } }),
  );
  await assert.rejects(api.requestEmailChange('a@b.test'), {
    code: 'RATE_LIMITED',
    details: { retryAfterSeconds: 120 },
  });

  responses.push(new Response(null, { status: 204 }));
  await api.removeTotp('id/with slash');
  assert.equal(calls.at(-1)!.url, 'https://api.test/api/v1/me/account/mfa/totp/id%2Fwith%20slash');
  assert.equal(calls.at(-1)!.method, 'DELETE');

  const policy = createAccountPolicyApi({
    baseUrl: 'https://api.test',
    accessToken: () => 'tok',
    fetch,
  });
  responses.push(
    Response.json({ emailChange: 'VERIFY', mfaRequired: true, revision: 2, updatedAt: null }),
  );
  await policy.update({
    emailChange: 'VERIFY',
    mfaRequired: true,
    reason: 'บังคับ',
    expectedRevision: 1,
  });
  assert.deepEqual(
    [calls.at(-1)!.url, calls.at(-1)!.method],
    ['https://api.test/api/v1/tenant/account-policy', 'PUT'],
  );

  const anonymous = createAccountApi({ baseUrl: '', accessToken: () => undefined, fetch });
  await assert.rejects(anonymous.get(), { status: 401 });
});

test('ลิงก์หน้าบัญชีของ Console พร้อม tenant', () => {
  assert.equal(
    accountHref('https://console.test', 'demo'),
    'https://console.test/?tenant=demo&view=account',
  );
  assert.equal(
    accountHref('https://console.test/x/y', undefined),
    'https://console.test/?view=account',
  );
});
