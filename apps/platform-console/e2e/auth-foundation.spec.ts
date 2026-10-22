import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './platform-test.js';

const origin = 'http://127.0.0.1:5182';
const issuer = `${origin}/oidc`;

/** ทดสอบ production root จริงโดยจำลอง OIDC protocol; ไม่อ้างว่าเป็น Keycloak/MFA acceptance */
async function mockIdentity(
  page: Page,
  options: { sessionError?: string; holdSession?: boolean } = {},
) {
  let authenticated = false;
  let nonce: string | null = null;
  const authorizations: URL[] = [];
  let releaseSession = () => {};
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  if (!options.holdSession) releaseSession();
  await page.route(`${issuer}/.well-known/openid-configuration`, (route) =>
    route.fulfill({
      json: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        end_session_endpoint: `${issuer}/logout`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
    }),
  );
  await page.route(`${issuer}/authorize**`, async (route) => {
    const url = new URL(route.request().url());
    authorizations.push(url);
    nonce = url.searchParams.get('nonce');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    if (url.searchParams.get('prompt') === 'none' && !authenticated) {
      callback.searchParams.set('error', 'login_required');
    } else {
      authenticated = true;
      callback.searchParams.set('code', 'synthetic-code');
    }
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.route(`${issuer}/token`, async (route) => {
    const body = new URLSearchParams(route.request().postData()!);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBeTruthy();
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: issuer,
      aud: 'platform-console',
      sub: 'synthetic-platform-operator',
      exp: now + 3600,
      iat: now,
      auth_time: now,
      ...(nonce ? { nonce } : {}),
    })}.synthetic-signature`;
    await route.fulfill({
      json: {
        access_token: 'synthetic-platform-access',
        id_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid',
      },
    });
  });
  await page.route(`${issuer}/logout**`, async (route) => {
    authenticated = false;
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 302,
      headers: {
        location: url.searchParams.get('post_logout_redirect_uri')!,
      },
    });
  });
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') {
      await sessionGate;
      if (options.sessionError) {
        await route.fulfill({
          status: 403,
          json: {
            status: 403,
            code: options.sessionError,
            title: 'RAW_SERVER_SECRET',
            correlationId: null,
            retryable: false,
          },
        });
      } else {
        await route.fulfill({
          json: {
            subject: 'synthetic-platform-operator',
            roles: ['platform_operator'],
            capabilities: ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE'],
            mutations: 'ALLOWED',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });
      }
    } else if (path === '/api/v1/tenants') {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else {
      throw new Error(`API นอกขอบเขต mock: ${path}`);
    }
  });
  return { authorizations, releaseSession };
}

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
}

test.describe('OIDC กับ production root', () => {
  test.use({ baseURL: origin });

  test('login TH/EN, OIDC redirect, refresh และ logout คง preference และ scope เดิม', async ({
    page,
  }, testInfo) => {
    const identity = await mockIdentity(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    await accessible(page);
    const toggle = page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Switch to Thai' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: testInfo.outputPath('platform-login-en.png'), fullPage: true });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    expect(await page.evaluate(() => sessionStorage.getItem('dcontact.platform.locale'))).toBe(
      'en',
    );
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveURL(`${origin}/`);
    expect(identity.authorizations.map((url) => url.searchParams.get('prompt'))).toEqual([
      'none',
      'login',
      'none',
    ]);
    for (const url of identity.authorizations) {
      expect(url.searchParams.get('client_id')).toBe('platform-console');
      expect(url.searchParams.get('scope')).toBe('openid');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    }
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).not.toContain('synthetic-platform-access');
    expect(storage).not.toContain('synthetic-platform-operator');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'UNKNOWN']) {
    test(`session loading/error ${code} ครบ TH/EN และไม่แสดง raw server title`, async ({
      page,
    }) => {
      const identity = await mockIdentity(page, { sessionError: code, holdSession: true });
      await page.goto('/');
      await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'กำลังตรวจสอบ session' })).toBeVisible();
      await page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' }).click();
      await expect(page.getByRole('heading', { name: 'Checking session' })).toBeVisible();
      identity.releaseSession();
      await expect(
        page.getByRole('heading', { name: 'Cannot open Platform Console' }),
      ).toBeVisible();
      await expect(page.getByRole('alert')).not.toContainText('RAW_SERVER_SECRET');
      await accessible(page);
      if (code === 'UNAUTHENTICATED')
        await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
      await page.getByRole('button', { name: 'Switch to Thai' }).click();
      await expect(
        page.getByRole('heading', { name: 'เปิด Platform Console ไม่ได้' }),
      ).toBeVisible();
      await accessible(page);
    });
  }
});

test.describe('configuration ก่อนตั้ง issuer', () => {
  test.use({ baseURL: 'http://127.0.0.1:5183' });
  test('configuration screen ใช้ TH/EN พร้อม keyboard และ axe', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ยังไม่ได้ตั้งค่า' })).toBeVisible();
    await accessible(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'เปลี่ยนเป็นภาษาอังกฤษ' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Setup required' })).toBeVisible();
    await accessible(page);
  });
});
