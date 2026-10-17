import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const originalId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const nextId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';

function voiceSnapshot(interactionId = originalId, state = 'WRAPUP') {
  return {
    capabilities: { voiceWrapupV1: 1 },
    agent: { id: 'agent-one', displayName: 'Agent', extension: '1000', state: 'ACW' },
    interaction: {
      id: interactionId,
      state,
      direction: 'INBOUND',
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
      version: '1',
      caller: null,
      queue: null,
      offerExpiresAt: null,
      answeredAt: null,
      endedAt: null,
    },
  };
}

for (const fixture of ['Wrong tenant fixture', 'Missing claim fixture', 'Wrong issuer fixture']) {
  test(`${fixture}: authenticated identity ที่ตรวจไม่ผ่านต้องซ่อนและล้างร่างคนเดิม`, async ({
    page,
  }) => {
    await recoveryPage(page);
    await page.getByRole('button', { name: fixture, exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).not.toBeVisible();
    await expect(page.locator('textarea')).toHaveValue('');
    await expect(page.getByRole('status').filter({ hasText: 'บัญชีเปลี่ยน' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('');
  });
}

async function recoveryPage(page: Page, current: () => string = () => originalId) {
  await page.route('**/api/v1/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/me/work-session', (route) =>
    route.fulfill({ json: { holder: null } }),
  );
  await page.route('**/api/v1/me/work-session/acquire', (route) =>
    route.fulfill({ status: 409, json: { code: 'WORK_SESSION_HELD' } }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: voiceSnapshot(current()),
    }),
  );
  await page.goto('/?authHarness=1&tenant=demo');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  await page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ', exact: true }).click();
  await page.getByRole('textbox', { name: 'โน้ตสรุป' }).fill('ร่างสังเคราะห์');
}

test('คำตอบ POST ของ identity เก่าไม่คืนร่างหรือ saved summary หลังเปลี่ยนบัญชี', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  let received = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/wrapup-v1', async (route) => {
    received = true;
    await held;
    await route.fulfill({
      json: {
        interactionId: originalId,
        policyVersion: 1,
        state: 'COMPLETED',
        disposition: 'CUSTOMER_ASSISTED',
        note: 'ร่างสังเคราะห์',
        recordedAt: '2026-10-17T07:00:00.000Z',
        legacy: false,
      },
    });
  });
  await recoveryPage(page);
  await page.getByRole('button', { name: 'ส่ง disposition', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await page.getByRole('button', { name: 'Other fixture', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).not.toBeVisible();
  release?.();
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toHaveCount(0);
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }),
  );
  expect(stored).not.toContain('ร่างสังเคราะห์');
});

test('refresh/expire/locale ระหว่างสายใช้ SIP session และ lease เดิม แล้วจึงกรอก wrapup', async ({
  page,
}) => {
  let state = 'ASSIGNED';
  let acquired = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/me/work-session')) acquired += 1;
  });
  await page.route('**/api/v1/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        capabilities: { voiceWrapupV1: 1 },
        agent: { id: 'agent-one', displayName: 'Agent', extension: '1000', state: 'ACW' },
        interaction: {
          id: originalId,
          state,
          voiceWrapupPolicy: 'VOICE_NOTE_V1',
          version: '1',
          caller: null,
          queue: null,
          offerExpiresAt: null,
          answeredAt: null,
          endedAt: null,
        },
      },
    }),
  );
  await page.route('**/sip-credentials', (route) =>
    route.fulfill({
      json: {
        leaseId: route.request().headers()['x-work-session-lease-id'],
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'synthetic-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'synthetic',
        iceServers: [],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    }),
  );
  await page.goto('/?authHarness=1&tenant=demo');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง', exact: true }).click();
  await page.getByRole('button', { name: 'รับสาย', exact: true }).click();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText('กำลังสนทนา');
  state = 'ACTIVE';
  const original = await page.evaluate(() => ({
    sip: window.__dcontactDphone?.sipSessionId(),
    lease: window.__dcontactDphone?.workSessionLeaseId(),
    time: performance.timeOrigin,
  }));
  expect(original.sip).toBeTruthy();
  expect(original.lease).toBeTruthy();
  const before = acquired;
  await page.getByRole('button', { name: 'Refresh fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Expire fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Locale fixture', exact: true }).click();
  await expect(page.getByRole('status', { name: 'dphone status' })).toHaveText('On a call');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  const after = await page.evaluate(() => ({
    sip: window.__dcontactDphone?.sipSessionId(),
    lease: window.__dcontactDphone?.workSessionLeaseId(),
    time: performance.timeOrigin,
  }));
  expect(after).toEqual(original);
  expect(acquired).toBe(before);
  state = 'WRAPUP';
  await page.getByRole('button', { name: 'Hang up', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Summary note' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Summary note' }).fill('synthetic draft');
  await page.getByRole('button', { name: 'Locale fixture', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('synthetic draft');
});

test('unknown หลัง refresh/reconnect ใช้ intent เดิมและไม่ยกร่างให้งานใหม่', async ({ page }) => {
  let currentId = originalId;
  const attempts: Record<string, unknown>[] = [];
  const tokens: string[] = [];
  await page.route('**/wrapup-v1', async (route) => {
    attempts.push(route.request().postDataJSON());
    tokens.push(route.request().headers().authorization ?? '');
    if (attempts.length === 1) return route.abort('connectionreset');
    return route.fulfill({
      json: {
        interactionId: originalId,
        policyVersion: 1,
        state: 'COMPLETED',
        disposition: 'CUSTOMER_ASSISTED',
        note: 'ร่างสังเคราะห์',
        recordedAt: '2026-10-17T07:00:00.000Z',
        legacy: false,
      },
    });
  });
  await page.route('**/wrapup-commands/*', (route) =>
    route.fulfill({ status: 404, json: { code: 'COMMAND_NOT_FOUND' } }),
  );
  await page.route('**/wrapup-result', (route) =>
    route.fulfill({ status: 409, json: { code: 'RESULT_NOT_COMMITTED' } }),
  );
  await recoveryPage(page, () => currentId);
  await page.getByRole('button', { name: 'ส่ง disposition', exact: true }).click();
  await expect(page.getByText(/ยังไม่ทราบผลบันทึก/)).toBeVisible();
  currentId = nextId;
  await page.getByRole('button', { name: 'Refresh fixture', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(
    page.getByText(`คำสั่งที่ยังไม่จบเป็นของงาน ${originalId} ไม่ใช่งานใหม่`),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'ส่ง disposition', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'ส่ง disposition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(tokens).toEqual(['Bearer token-one', 'Bearer token-two']);
});

test('popup ถูกบล็อกโดยร่างยังอยู่ พร้อมเตือนก่อน navigation/reload/signout', async ({ page }) => {
  await page.route('**/oidc/.well-known/openid-configuration', (route) =>
    route.fulfill({
      json: {
        issuer: 'http://127.0.0.1:4173/oidc',
        authorization_endpoint: 'http://127.0.0.1:4173/oidc/authorize',
        token_endpoint: 'http://127.0.0.1:4173/oidc/token',
        userinfo_endpoint: 'http://127.0.0.1:4173/oidc/userinfo',
      },
    }),
  );
  await recoveryPage(page);
  await page.getByRole('button', { name: 'Expire fixture', exact: true }).click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'หน้าต่างเข้าสู่ระบบ' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('ร่างสังเคราะห์');
  await page.evaluate(() => {
    const anchor = document.createElement('a');
    anchor.href = '/?view=supervisor&tenant=demo';
    anchor.textContent = 'Navigate fixture';
    document.body.append(anchor);
  });
  const navigationWarning = page.waitForEvent('dialog');
  const navigate = page.getByRole('link', { name: 'Navigate fixture' }).click();
  const navigationDialog = await navigationWarning;
  expect(navigationDialog.type()).toBe('confirm');
  await navigationDialog.dismiss();
  await navigate;
  expect(page.url()).toContain('authHarness=1');
  const signoutWarning = page.waitForEvent('dialog');
  const signout = page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await (await signoutWarning).dismiss();
  await signout;
  const reloadWarning = page.waitForEvent('dialog');
  const reload = page.reload({ timeout: 2000 }).catch(() => undefined);
  const reloadDialog = await reloadWarning;
  expect(reloadDialog.type()).toBe('beforeunload');
  await reloadDialog.dismiss();
  await reload;
  await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('ร่างสังเคราะห์');
});

for (const invalid of ['nonce', 'state', 'cancel'] as const) {
  test(`OIDC popup ${invalid}: ปฏิเสธ callback ผิดและ retry บัญชีเดิมได้โดยร่างไม่หาย`, async ({
    page,
    context,
  }) => {
    const issuer = 'http://127.0.0.1:4173/oidc';
    let nonce = '';
    let valid = false;
    let leaseRequests = 0;
    let invalidCallbackSeen = false;
    context.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/me/work-session'))
        leaseRequests += 1;
      if (request.url().includes('state=incorrect-state')) invalidCallbackSeen = true;
    });
    await context.route('**/oidc/.well-known/openid-configuration', (route) =>
      route.fulfill({
        json: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
        },
      }),
    );
    await context.route('**/oidc/authorize**', (route) => {
      const request = new URL(route.request().url());
      expect(request.searchParams.get('code_challenge_method')).toBe('S256');
      expect(request.searchParams.get('code_challenge')).toBeTruthy();
      nonce = request.searchParams.get('nonce') ?? '';
      expect(nonce).toBeTruthy();
      if (!valid && invalid === 'cancel')
        return route.fulfill({ contentType: 'text/html', body: '<p>Cancel fixture</p>' });
      const callback = new URL(request.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'synthetic-code');
      callback.searchParams.set(
        'state',
        !valid && invalid === 'state' ? 'incorrect-state' : request.searchParams.get('state')!,
      );
      return route.fulfill({ status: 302, headers: { location: callback.href } });
    });
    await context.route('**/oidc/token', async (route) => {
      expect(new URLSearchParams(route.request().postData()!).get('code_verifier')).toBeTruthy();
      const profile = {
        iss: issuer,
        aud: 'agent-desktop',
        sub: 'agent-one',
        tenant_id: '00000000-0000-4000-8000-000000000001',
        tenant_slug: 'demo',
        dc_user_id: 'agent-one',
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        nonce: !valid && invalid === 'nonce' ? 'incorrect-nonce' : nonce,
      };
      const jwt = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(profile)).toString('base64url')}.synthetic-signature`;
      return route.fulfill({
        json: { access_token: 'token-popup', token_type: 'Bearer', expires_in: 300, id_token: jwt },
      });
    });
    await context.route('**/oidc/userinfo', (route) =>
      route.fulfill({ json: { sub: 'agent-one' } }),
    );
    await recoveryPage(page);
    await page.getByRole('button', { name: 'Expire fixture', exact: true }).click();
    const before = leaseRequests;
    const opened = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }).click();
    const popup = await opened;
    if (invalid === 'cancel') {
      await expect(popup.getByText('Cancel fixture')).toBeVisible();
      await popup.close();
    }
    if (invalid === 'state') {
      await expect.poll(() => invalidCallbackSeen).toBe(true);
      await popup.close().catch(() => undefined);
    }
    await expect(page.getByRole('alert').filter({ hasText: 'หน้าต่างเข้าสู่ระบบ' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('ร่างสังเคราะห์');
    valid = true;
    const retried = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }).click();
    const retryPopup = await retried;
    await expect.poll(() => retryPopup.isClosed()).toBe(true);
    await expect(
      page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveValue('ร่างสังเคราะห์');
    expect(leaseRequests).toBe(before);
  });
}

test('token refresh ไม่สร้าง lease ใหม่ และ auth หายยังเห็นร่างใน Workspace เดิม', async ({
  page,
}) => {
  let leaseReads = 0;
  const tokens: string[] = [];
  await page.route('**/api/v1/me/work-session', (route) => {
    leaseReads += 1;
    return route.fulfill({ status: 200, json: { holder: null } });
  });
  await page.route('**/api/v1/me/work-session/acquire', (route) =>
    route.fulfill({ status: 409, json: { code: 'WORK_SESSION_HELD' } }),
  );
  await page.route('**/api/v1/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/snapshot', (route) => {
    tokens.push(route.request().headers().authorization ?? '');
    return route.fulfill({
      json: voiceSnapshot(),
    });
  });
  await page.goto('/?authHarness=1&tenant=demo');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'โน้ตสรุป' });
  await note.fill('ร่างสังเคราะห์ที่ต้องไม่สูญหาย');
  await expect.poll(() => leaseReads).toBeGreaterThan(0);
  const before = leaseReads;
  await page.getByRole('button', { name: 'Refresh fixture', exact: true }).click();
  await expect(note).toHaveValue('ร่างสังเคราะห์ที่ต้องไม่สูญหาย');
  await page.getByRole('button', { name: 'Expire fixture', exact: true }).click();
  await expect(note).toBeVisible();
  await expect(note).toHaveValue('ร่างสังเคราะห์ที่ต้องไม่สูญหาย');
  expect(leaseReads).toBe(before);
  expect(tokens[0]).toBe('Bearer token-one');
  await page.getByRole('button', { name: 'Other fixture', exact: true }).click();
  await expect(note).not.toBeVisible();
  await expect(page.locator('textarea')).toHaveValue('');
  await expect(page.getByRole('status').filter({ hasText: 'บัญชีเปลี่ยน' })).toBeVisible();
  expect(leaseReads).toBe(before);
});
