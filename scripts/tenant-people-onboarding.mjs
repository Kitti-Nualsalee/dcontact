import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(new URL('../apps/console/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const callbackServer = createServer((request, response) => {
  if (request.url?.startsWith('/b3-callback')) {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Synthetic callback complete');
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  callbackServer.once('error', reject);
  callbackServer.listen(60606, '127.0.0.1', resolve);
});
let input = '';
for await (const chunk of process.stdin) input += chunk;
const configuration = JSON.parse(input);
const issuer = new URL(configuration.issuer);
const invitation = new URL(configuration.link);
assert.equal(invitation.origin, issuer.origin);
assert.ok(invitation.pathname.startsWith(`${issuer.pathname}/login-actions/action-token`));
assert.equal(issuer.hostname, '127.0.0.1');

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const browser = await chromium.launch({ headless: true });
let stage = 'INVITATION';
try {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await page.goto(invitation.href);
  let secret = '';
  let enrolledCounter = 0;
  let passwordCompleted = false;
  let totpCompleted = false;
  for (let action = 0; action < 10; action++) {
    await page
      .locator('#password-new, #totp, input[name=lastName], #kc-info-message, #kc-error-message')
      .first()
      .waitFor();
    if (await page.locator('#kc-error-message').count()) throw new Error('ACTION_REJECTED');
    if (await page.locator('#password-new').count()) {
      stage = 'PASSWORD';
      assert.equal(passwordCompleted, false);
      await page.locator('#password-new').fill(configuration.password);
      await page.locator('#password-confirm').fill(configuration.password);
      stage = 'PASSWORD_SUBMIT';
      await page
        .locator('form')
        .filter({ has: page.locator('#password-new') })
        .locator('[name=login]')
        .click();
      passwordCompleted = true;
    } else if (await page.locator('#totp').count()) {
      stage = 'TOTP';
      assert.equal(totpCompleted, false);
      secret = await page.locator('input[name=totpSecret]').inputValue();
      if (30_000 - (Date.now() % 30_000) < 2500) await page.waitForTimeout(3000);
      await page.locator('#totp').fill(totp(secret));
      enrolledCounter = Math.floor(Date.now() / 30_000);
      if (await page.locator('#userLabel').count())
        await page.locator('#userLabel').fill('Synthetic boundary device');
      stage = 'TOTP_SUBMIT';
      await page.locator('#saveTOTPBtn').click();
      await page.waitForFunction(() => !document.querySelector('#totp'));
      totpCompleted = true;
    } else if (await page.locator('input[name=lastName]').count()) {
      stage = 'PROFILE';
      await page.locator('input[name=lastName]').fill('Boundary');
      await page
        .locator('form')
        .filter({ has: page.locator('input[name=lastName]') })
        .locator('[type=submit]')
        .click();
    } else if (await page.locator('#kc-info-message a').count()) {
      if (passwordCompleted && totpCompleted) break;
      await page.locator('#kc-info-message a').click();
    } else break;
  }
  assert.equal(passwordCompleted, true);
  assert.equal(totpCompleted, true);
  await context.close();

  stage = 'LOGIN';
  const loginContext = await browser.newContext({ locale: 'en-US' });
  const loginPage = await loginContext.newPage();
  loginPage.setDefaultTimeout(12_000);
  const redirectUri = 'http://127.0.0.1:60606/b3-callback';
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorization = new URL(`${configuration.issuer}/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: 'b3-onboarding-console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  }).toString();
  stage = 'LOGIN_PAGE';
  await loginPage.goto(authorization.href);
  stage = 'LOGIN_USERNAME';
  await loginPage.locator('#username').fill(configuration.email);
  await loginPage.locator('#kc-login').click();
  stage = 'LOGIN_PASSWORD';
  await loginPage.locator('#password').fill(configuration.password);
  stage = 'LOGIN_SUBMIT';
  await loginPage.locator('#kc-login').click({ noWaitAfter: true });
  await loginPage.waitForTimeout(500);
  if (!(await loginPage.locator('#otp').count())) {
    const present = await Promise.all(
      ['#username', '#password', '#otp', '#kc-error-message', '#kc-info-message'].map(
        async (selector) => (await loginPage.locator(selector).count()) > 0,
      ),
    );
    stage = `LOGIN_FORM_${present.map((value) => (value ? '1' : '0')).join('')}`;
    throw new Error('EXPECTED_OTP_STEP_NOT_PRESENT');
  }
  await loginPage.locator('#otp').waitFor();
  if (Math.floor(Date.now() / 30_000) <= enrolledCounter)
    await loginPage.waitForTimeout((enrolledCounter + 1) * 30_000 - Date.now() + 500);
  if (30_000 - (Date.now() % 30_000) < 2500) await loginPage.waitForTimeout(3000);
  await loginPage.locator('#otp').fill(totp(secret));
  secret = '';
  await loginPage.locator('#kc-login').click();
  await loginPage.waitForURL(`${redirectUri}**`);
  const callback = new URL(loginPage.url());
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  const response = await fetch(`${configuration.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'b3-onboarding-console',
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, configuration.userId);
  stage = 'ACTIVATED_LINK_GUARD';
  assert.equal((await loginContext.request.get(invitation.href)).status(), 400);
  await loginContext.close();
  process.stdout.write(
    JSON.stringify({ completed: true, login: true, userId: configuration.userId }),
  );
} catch (failure) {
  const kind =
    failure instanceof Error && /^[A-Za-z]+$/.test(failure.name) ? failure.name : 'Failure';
  const detail =
    failure instanceof Error
      ? failure.message
          .replaceAll(configuration.email, '[email]')
          .replaceAll(configuration.password, '[secret]')
          .replace(/[^A-Za-z0-9_():#./ -]/g, '')
          .slice(0, 300)
      : '';
  process.stderr.write(`B3_ONBOARDING_FAILED_${stage}_${kind}_${detail}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => callbackServer.close(resolve));
}
