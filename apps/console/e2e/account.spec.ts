import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * AC5 (#598): Console › My account / Account policy — the API is mocked with page.route
 * (real permissions and rules are checked in AC4's API boundary test with a real Keycloak)
 */
test.use({ locale: 'th-TH' });

test('a profile that does not enable Account shows a not-ready state with no form or retry in both TH/EN', async ({
  page,
}) => {
  const state = initialState();
  await mockApi(page, state);
  await page.route('**/api/v1/me/account', (route) => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ status: 404, json: { code: 'ROUTE_NOT_AVAILABLE_IN_PROFILE' } });
  });
  await page.goto('/?tenant=demo&view=account');
  await expect(page.getByRole('status')).toContainText(
    'การจัดการบัญชียังไม่พร้อมใช้งานในสภาพแวดล้อมนี้',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ลองอีกครั้ง' })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('main.account')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Account management is not available in this environment',
  );
  expect(state.writes).toEqual([]);
});

for (const failure of [
  { status: 404, code: 'NOT_FOUND' },
  { status: 401, code: 'AUTHORIZATION_CONTEXT_UNAVAILABLE' },
  { status: 500, code: 'ROUTE_NOT_AVAILABLE_IN_PROFILE' },
]) {
  test(`Account error ${failure.status}/${failure.code} still shows the error and retry is not masked as unavailable`, async ({
    page,
  }) => {
    const state = initialState();
    await mockApi(page, state);
    let requests = 0;
    await page.route('**/api/v1/me/account', (route) => {
      expect(route.request().method()).toBe('GET');
      requests++;
      return route.fulfill({ status: failure.status, json: { code: failure.code } });
    });
    await page.goto('/?tenant=demo&view=account');
    await expect(page.getByRole('alert')).toContainText('โหลดข้อมูลบัญชีไม่สำเร็จ');
    await expect(page.getByText('การจัดการบัญชียังไม่พร้อมใช้งานในสภาพแวดล้อมนี้')).toHaveCount(0);
    await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
    await expect.poll(() => requests).toBe(2);
    expect(state.writes).toEqual([]);
  });
}

type Device = { id: string; label: string; createdAt: string | null };
type State = {
  account: {
    firstName: string;
    lastName: string;
    email: string;
    pendingEmail: string | null;
    mfa: { enrolled: boolean; required: boolean; devices: Device[] };
    policy: { emailChange: 'VERIFY' | 'IMMEDIATE' | 'ADMIN_ONLY' };
  };
  policy: {
    emailChange: 'VERIFY' | 'IMMEDIATE' | 'ADMIN_ONLY';
    mfaRequired: boolean;
    revision: number;
    updatedAt: string | null;
  };
  writes: Array<{ method: string; path: string; body: unknown }>;
  failNext?: { status: number; json: unknown; headers?: Record<string, string> };
};

const OTPAUTH =
  'otpauth://totp/D-Contact:somchai%40demo.example?secret=JBSWY3DPEHPK3PXP&issuer=D-Contact&algorithm=SHA1&digits=6&period=30';

function initialState(overrides: Partial<State['account']> = {}): State {
  return {
    account: {
      firstName: 'สมชาย',
      lastName: 'ใจดี',
      email: 'somchai@demo.example',
      pendingEmail: null,
      mfa: { enrolled: false, required: false, devices: [] },
      policy: { emailChange: 'VERIFY' },
      ...overrides,
    },
    policy: { emailChange: 'VERIFY', mfaRequired: false, revision: 0, updatedAt: null },
    writes: [],
  };
}

async function mockApi(page: Page, state: State) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
        apps: [
          {
            id: 'agent-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.agentWorkspace',
            hostApp: 'workspace',
            path: '/',
          },
        ],
        pins: { appIds: [], source: 'SYSTEM', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: true },
      },
    }),
  );
  await page.route('**/api/v1/me/account**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace('/api/v1/me/account', '') || '/';
    if (method === 'GET') return route.fulfill({ status: 200, json: state.account });
    const body = request.postDataJSON?.() ?? null;
    state.writes.push({ method, path, body });
    if (state.failNext) {
      const failure = state.failNext;
      state.failNext = undefined;
      return route.fulfill({
        status: failure.status,
        json: failure.json,
        headers: failure.headers,
      });
    }
    if (path === '/profile') {
      Object.assign(state.account, body);
      return route.fulfill({ status: 200, json: body });
    }
    if (path === '/password') return route.fulfill({ status: 204, body: '' });
    if (path === '/email-change' && method === 'POST') {
      state.account.pendingEmail = (body as { newEmail: string }).newEmail;
      return route.fulfill({
        status: 202,
        json: {
          status: 'PENDING',
          pendingEmail: state.account.pendingEmail,
          expiresAt: '2026-10-07T00:00:00.000Z',
        },
      });
    }
    if (path === '/email-change' && method === 'DELETE') {
      state.account.pendingEmail = null;
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === '/email-change/confirm') {
      state.account.email = state.account.pendingEmail ?? state.account.email;
      state.account.pendingEmail = null;
      return route.fulfill({ status: 200, json: { email: state.account.email } });
    }
    if (path === '/mfa/totp/enrolments') {
      return route.fulfill({
        status: 201,
        json: {
          enrolmentId: '00000000-0000-4000-8000-0000000000e1',
          otpauthUri: OTPAUTH,
          secret: 'JBSWY3DPEHPK3PXP',
          expiresAt: '2026-10-06T12:10:00.000Z',
        },
      });
    }
    if (path.endsWith('/confirm')) {
      const { label } = body as { label: string };
      state.account.mfa.devices.push({
        id: `dev-${state.account.mfa.devices.length + 1}`,
        label,
        createdAt: '2026-10-06T12:00:00.000Z',
      });
      state.account.mfa.enrolled = true;
      return route.fulfill({ status: 201, json: { credentialId: 'dev' } });
    }
    if (path.startsWith('/mfa/totp/') && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop()!);
      state.account.mfa.devices = state.account.mfa.devices.filter((device) => device.id !== id);
      state.account.mfa.enrolled = state.account.mfa.devices.length > 0;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await page.route('**/api/v1/tenant/account-policy', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ status: 200, json: state.policy });
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push({ method: 'PUT', path: 'account-policy', body });
    if (state.failNext) {
      const failure = state.failNext;
      state.failNext = undefined;
      return route.fulfill({ status: failure.status, json: failure.json });
    }
    state.policy = {
      emailChange: body.emailChange as State['policy']['emailChange'],
      mfaRequired: body.mfaRequired as boolean,
      revision: state.policy.revision + 1,
      updatedAt: '2026-10-06T12:00:00.000Z',
    };
    return route.fulfill({ status: 200, json: state.policy });
  });
}

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    );
}

const twoDevices = (): Device[] => [
  { id: 'dev-1', label: 'โทรศัพท์', createdAt: '2026-10-01T03:00:00.000Z' },
  { id: 'dev-2', label: 'แท็บเล็ต', createdAt: '2026-10-02T03:00:00.000Z' },
];

for (const [locale, lang, title] of [
  ['th-TH', 'TH', 'บัญชีของฉัน'],
  ['en-US', 'EN', 'My account'],
] as const) {
  test.describe(`axe (${lang})`, () => {
    test.use({ locale });
    test(`My account/Account policy/add-device dialog: 0 serious/critical and no word Keycloak (${lang})`, async ({
      page,
    }) => {
      const state = initialState({
        pendingEmail: 'new@demo.example',
        mfa: { enrolled: true, required: true, devices: twoDevices() },
      });
      await mockApi(page, state);
      await page.goto('/?view=account&tenant=demo');
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('keycloak');

      await page
        .getByRole('button', { name: lang === 'TH' ? 'เพิ่มอุปกรณ์' : 'Add device' })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');

      await page.goto('/?view=account-policy&tenant=demo');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('switch')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('keycloak');
    });
  });
}

test('the Console user menu has "My account" opening in the same tab, and the submenu has account policy for admin only', async ({
  page,
}) => {
  await mockApi(page, initialState());
  await page.goto('/?view=account&tenant=demo');
  await page.getByRole('button', { name: /เมนูผู้ใช้/ }).click();
  const item = page.getByRole('menuitem', { name: 'บัญชีของฉัน' });
  await expect(item).toHaveAttribute('href', '/?view=account&tenant=demo');
  await expect(item).not.toHaveAttribute('target', '_blank');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'นโยบายบัญชี' })).toBeVisible();

  await page.goto('/?view=account&tenant=demo&viewer=AGENT');
  await expect(page.getByRole('heading', { level: 1, name: 'บัญชีของฉัน' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'นโยบายบัญชี' })).toHaveCount(0);
  await page.goto('/?view=account-policy&tenant=demo&viewer=AGENT');
  await expect(page.getByText('เฉพาะผู้ดูแลระบบขององค์กรเท่านั้น')).toBeVisible();
});

test('personal data: edit the name with the keyboard and save', async ({ page }) => {
  const state = initialState();
  await mockApi(page, state);
  await page.goto('/?view=account&tenant=demo');
  const firstName = page.getByRole('textbox', { name: 'ชื่อ', exact: true });
  await firstName.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('สมหญิง');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'นามสกุล' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'บันทึกชื่อ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('บันทึกชื่อแล้ว')).toBeVisible();
  expect(state.writes).toEqual([
    { method: 'PATCH', path: '/profile', body: { firstName: 'สมหญิง', lastName: 'ใจดี' } },
  ]);
});

test('password: a mismatch warns before sending, the organization rules show from rules[], and success clears the fields', async ({
  page,
}) => {
  const state = initialState();
  await mockApi(page, state);
  await page.goto('/?view=account&tenant=demo');
  const password = page.getByLabel('รหัสผ่านใหม่', { exact: true });
  const confirm = page.getByLabel('ยืนยันรหัสผ่านใหม่');
  await password.fill('Abc');
  await confirm.fill('Abd');
  await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);

  state.failNext = {
    status: 400,
    json: { code: 'PASSWORD_POLICY_VIOLATION', rules: [{ rule: 'MIN_LENGTH', value: 12 }] },
  };
  await confirm.fill('Abc');
  await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'ยาวอย่างน้อย 12 ตัวอักษร' }),
  ).toBeVisible();

  await password.fill('Strong-Password-2026');
  await confirm.fill('Strong-Password-2026');
  await page.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }).click();
  await expect(page.getByText('เปลี่ยนรหัสผ่านแล้ว')).toBeVisible();
  await expect(password).toHaveValue('');
  expect(state.writes.at(-1)).toEqual({
    method: 'POST',
    path: '/password',
    body: { newPassword: 'Strong-Password-2026' },
  });
});

test('email: requesting a change (needs verification) shows the pending request and can be cancelled; ADMIN_ONLY has no form', async ({
  page,
}) => {
  const state = initialState();
  await mockApi(page, state);
  await page.goto('/?view=account&tenant=demo');
  await expect(page.getByText('ระบบจะส่งลิงก์ยืนยันไปที่อีเมลใหม่')).toBeVisible();
  await page.getByLabel('อีเมลใหม่').fill('new@demo.example');
  await page.getByRole('button', { name: 'เปลี่ยนอีเมล' }).click();
  await expect(page.getByText('รอยืนยันอีเมล new@demo.example')).toBeVisible();
  await page.getByRole('button', { name: 'ยกเลิกคำขอ' }).click();
  await expect(page.getByText('รอยืนยันอีเมล')).toHaveCount(0);
  expect(state.writes.map((write) => [write.method, write.path])).toEqual([
    ['POST', '/email-change'],
    ['DELETE', '/email-change'],
  ]);

  state.failNext = { status: 409, json: { code: 'EMAIL_IN_USE' } };
  await page.getByLabel('อีเมลใหม่').fill('taken@demo.example');
  await page.getByRole('button', { name: 'เปลี่ยนอีเมล' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว' }),
  ).toBeVisible();

  state.account.policy.emailChange = 'ADMIN_ONLY';
  await page.reload();
  await expect(page.getByText('ให้ผู้ดูแลระบบเป็นผู้เปลี่ยนอีเมลเท่านั้น')).toBeVisible();
  await expect(page.getByLabel('อีเมลใหม่')).toHaveCount(0);
});

test('email verification link: the token disappears from the URL immediately, is not in history/storage, and verifies once', async ({
  page,
}) => {
  const state = initialState({ pendingEmail: 'new@demo.example' });
  await mockApi(page, state);
  await page.goto('/?tenant=demo&view=account&verify=tok-secret-123');
  await expect(page.getByText('ยืนยันอีเมลใหม่แล้ว: new@demo.example')).toBeVisible();
  expect(page.url()).not.toContain('tok-secret-123');
  expect(page.url()).toContain('view=account');
  expect(state.writes).toEqual([
    { method: 'POST', path: '/email-change/confirm', body: { token: 'tok-secret-123' } },
  ]);
  const leftovers = await page.evaluate(() => ({
    href: window.location.href,
    session: JSON.stringify({ ...window.sessionStorage }),
    local: JSON.stringify({ ...window.localStorage }),
  }));
  expect(leftovers.href).not.toContain('verify');
  expect(leftovers.session).not.toContain('tok-secret-123');
  expect(leftovers.local).not.toContain('tok-secret-123');
  await expect(page.locator('dd').filter({ hasText: 'new@demo.example' })).toBeVisible();
  // replaceState, not pushState: going back finds no URL with the token and going forward returns to a URL without a token
  await page.goBack();
  expect(page.url()).not.toContain('tok-secret-123');
  await page.goForward();
  expect(page.url()).not.toContain('tok-secret-123');

  // reload does not verify again
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'บัญชีของฉัน' })).toBeVisible();
  expect(state.writes).toHaveLength(1);

  // expired token → the translated message
  state.failNext = { status: 410, json: { code: 'EMAIL_CHANGE_EXPIRED' } };
  await page.goto('/?tenant=demo&view=account&verify=old-token');
  await expect(page.getByText('ลิงก์ยืนยันหมดอายุหรือถูกใช้แล้ว')).toBeVisible();
  expect(page.url()).not.toContain('old-token');
});

test('2FA: add a device with a QR + typed code, a wrong code warns, the last device cannot be removed when enforced, removal uses a confirm dialog', async ({
  page,
}) => {
  const state = initialState();
  await mockApi(page, state);
  await page.goto('/?view=account&tenant=demo');
  await expect(page.getByText('ยังไม่ได้ตั้งค่า 2FA')).toBeVisible();
  await page.getByRole('button', { name: 'เพิ่มอุปกรณ์' }).click();
  const dialog = page.getByRole('dialog', { name: 'เพิ่มอุปกรณ์ 2FA' });
  await expect(dialog.getByRole('img', { name: /QR สำหรับเพิ่มบัญชี D-Contact/ })).toBeVisible();
  await expect(dialog.locator('code')).toHaveText('JBSW Y3DP EHPK 3PXP');

  state.failNext = { status: 400, json: { code: 'INVALID_OTP_CODE' } };
  await dialog.getByLabel('รหัส 6 หลัก').fill('12a3456');
  await expect(dialog.getByLabel('รหัส 6 หลัก')).toHaveValue('123456');
  await dialog.getByLabel('ชื่ออุปกรณ์').fill('โทรศัพท์');
  await dialog.getByRole('button', { name: 'ยืนยันและเพิ่มอุปกรณ์' }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: 'รหัสไม่ถูกต้อง' })).toBeVisible();
  await dialog.getByLabel('รหัส 6 หลัก').fill('654321');
  await dialog.getByLabel('รหัส 6 หลัก').press('Enter');
  await expect(page.getByText('เพิ่มอุปกรณ์ 2FA แล้ว')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(state.writes.at(-1)).toEqual({
    method: 'POST',
    path: '/mfa/totp/enrolments/00000000-0000-4000-8000-0000000000e1/confirm',
    body: { code: '654321', label: 'โทรศัพท์' },
  });
  await expect(page.getByText('โทรศัพท์', { exact: true })).toBeVisible();

  // 2FA enforced + one device left: the delete button is disabled with an explanation
  state.account.mfa.required = true;
  await page.reload();
  await expect(page.getByText('องค์กรของคุณบังคับใช้ 2FA')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ลบอุปกรณ์ โทรศัพท์' })).toBeDisabled();
  await expect(page.getByText('ลบอุปกรณ์เครื่องสุดท้ายไม่ได้')).toBeVisible();

  // two devices: can delete after confirming (Esc cancels, then focus returns)
  state.account.mfa.devices = twoDevices();
  await page.reload();
  const remove = page.getByRole('button', { name: 'ลบอุปกรณ์ แท็บเล็ต' });
  await remove.click();
  const confirm = page.getByRole('alertdialog', { name: 'ลบอุปกรณ์ แท็บเล็ต?' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(state.writes.filter((write) => write.method === 'DELETE')).toEqual([]);
  await remove.click();
  await confirm.getByRole('button', { name: 'ลบอุปกรณ์' }).click();
  await expect(page.getByText('ลบอุปกรณ์แล้ว')).toBeVisible();
  expect(state.writes.at(-1)).toEqual({ method: 'DELETE', path: '/mfa/totp/dev-2', body: null });
});

test('account policy (admin): a reason is required, sends the original revision, a clash with another admin loads the latest values', async ({
  page,
}) => {
  const state = initialState();
  await mockApi(page, state);
  await page.goto('/?view=account-policy&tenant=demo');
  await expect(page.getByText('ใช้ค่าเริ่มต้น (ยังไม่เคยแก้ไข)')).toBeVisible();
  const save = page.getByRole('button', { name: 'บันทึกนโยบาย' });
  await expect(save).toBeDisabled();

  await page.getByRole('switch', { name: 'บังคับใช้ 2FA กับผู้ใช้ทุกคน' }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: /การเปลี่ยนอีเมลของผู้ใช้/ }).click();
  await page.getByRole('option', { name: 'ผู้ดูแลระบบเปลี่ยนให้เท่านั้น' }).click();
  await save.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'เหตุผลต้องยาว 3–500 ตัวอักษร' }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);

  await page.getByLabel('เหตุผลของการเปลี่ยน').fill('บังคับ 2FA ตามนโยบายความปลอดภัย');
  await save.click();
  await expect(page.getByText('บันทึกนโยบายแล้ว')).toBeVisible();
  expect(state.writes.at(-1)).toEqual({
    method: 'PUT',
    path: 'account-policy',
    body: {
      emailChange: 'ADMIN_ONLY',
      mfaRequired: true,
      reason: 'บังคับ 2FA ตามนโยบายความปลอดภัย',
      expectedRevision: 0,
    },
  });
  await expect(page.getByText(/แก้ไขล่าสุด/)).toBeVisible();

  // another admin edited first → 409, then load the latest values
  state.policy = { ...state.policy, emailChange: 'IMMEDIATE', revision: 5 };
  state.failNext = { status: 409, json: { code: 'REVISION_CONFLICT' } };
  await page.getByRole('switch', { name: 'บังคับใช้ 2FA กับผู้ใช้ทุกคน' }).focus();
  await page.keyboard.press('Space');
  await page.getByLabel('เหตุผลของการเปลี่ยน').fill('ปิดชั่วคราว');
  await save.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'มีผู้ดูแลระบบคนอื่นแก้นโยบายก่อนหน้านี้' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /การเปลี่ยนอีเมลของผู้ใช้/ })).toContainText(
    'เปลี่ยนได้ทันที',
  );
});
