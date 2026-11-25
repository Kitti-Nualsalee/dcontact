import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { th } from '../e2e/catalog.js';
import { totp } from '../../../scripts/keycloak-platform-login.mjs';
import { PLATFORM_DEV_USERS } from '../../../scripts/keycloak-platform-setup.mjs';

/**
 * A1.8 (#413) UAT journey of #393 §7 that completes failure → reconcile → resume → handoff through the real UI
 *
 * fault injection: stop Keycloak before confirming the request → the worker retries until exhausted then hands off to an operator (ACTION_REQUIRED)
 * → bring Keycloak back → Reconcile (reads the real state, nothing to adopt) → Retry current step → ACTIVE + handoff
 * runs only when `A1_UAT_KEYCLOAK_OUTAGE=1` because it stops a real dev container
 */
const COMPOSE = ['compose', '-f', '../../infra/docker/docker-compose.dev.yml'];
const operator = PLATFORM_DEV_USERS.find((user) => user.role === 'platform_operator')!;
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const run = randomUUID().slice(0, 6);

test.skip(process.env.A1_UAT_KEYCLOAK_OUTAGE !== '1', 'A1_UAT_KEYCLOAK_OUTAGE=1 must be set');

async function keycloakReady() {
  for (let round = 0; round < 90; round += 1) {
    const response = await fetch('http://localhost:8081/realms/dcontact').catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Keycloak did not come back within 3 minutes');
}

async function recover(page: Page, title: string, comment: string) {
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  const panel = page.getByRole('region', { name: new RegExp(title) });
  await panel.getByLabel(th('common:recovery.comment')).fill(comment);
  await panel
    .getByRole('button', { name: th('common:recovery.confirm', { action: title }) })
    .click();
  await expect(panel.getByText(th('common:recovery.succeeded', { action: title }))).toBeVisible({
    timeout: 60_000,
  });
  return panel;
}

test('UAT: failure → reconcile → resume → handoff while Keycloak is down', async ({ page }) => {
  test.setTimeout(600_000);
  test.info().annotations.push({ type: 'fault', description: 'docker compose stop keycloak' });

  await page.goto('/');
  await page.getByRole('button', { name: th('common:auth.signIn') }).click();
  await page.locator('#username').fill(operator.username);
  await page.locator('#password').fill(operator.password);
  await page.locator('#kc-login').click();
  const window = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((window + 1) * 30_000 - Date.now() + 500);
  await page.locator('#otp').fill(totp(operator.totpSecret));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();

  // create → review
  const slug = `uat-${run}-outage`;
  await page
    .getByRole('button', { name: th('common:navigation.create') })
    .first()
    .click();
  await page.getByLabel(th('common:fields.displayName')).fill(`UAT ${slug}`);
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Primary domain').fill(`${slug}.uat.example.test`);
  await page.getByLabel('Plan').selectOption({ index: 1 });
  await page.getByLabel(th('common:fields.firstAdminDisplayName')).fill('UAT Admin');
  await page
    .getByLabel(th('common:fields.firstAdminEmail'))
    .fill(`uat-${run}-outage@uat.example.test`);
  await page.getByRole('button', { name: th('common:wizard.review') }).click();
  await page.getByLabel(new RegExp(escapeRegExp(th('common:wizard.confirm')))).check();

  // failure: the dependency is down after the request is accepted (the API still accepts because it verifies tokens with a cached JWKS)
  execFileSync('docker', [...COMPOSE, 'stop', 'keycloak'], { stdio: 'ignore' });
  try {
    await page.getByRole('button', { name: th('common:wizard.submit') }).click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { name: th('common:statuses.ACTION_REQUIRED') }),
    ).toBeVisible({
      timeout: 300_000,
    });
  } finally {
    execFileSync('docker', [...COMPOSE, 'start', 'keycloak'], { stdio: 'ignore' });
    await keycloakReady();
  }

  // reconcile after the dependency returns: read the real state, nothing to adopt — no guessing, no duplicate creation
  const reconcile = await recover(
    page,
    'Reconcile & resume',
    'Keycloak is back, check whether an Organization is left behind',
  );
  await expect(
    reconcile.getByText(th('common:recovery.requestState', { state: 'ACTION_REQUIRED' })),
  ).toBeVisible();
  await reconcile.getByRole('button', { name: th('common:common.close') }).click();

  // resume: reconcile proved the resource does not exist — retry the step
  await recover(page, 'Retry current step', 'Reconcile confirmed that no resource is left behind');
  await expect(page.getByRole('heading', { name: th('common:request.ready') })).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByText(th('common:invitation.delivery.SENT'))).toBeVisible();

  // search + Action history has both the operator's decisions and System work
  await page.getByRole('button', { name: 'Tenants' }).click();
  await page.getByLabel(th('common:list.searchLabel')).fill(slug);
  await page.getByLabel(th('common:list.searchLabel')).press('Enter');
  await expect(page.getByRole('row', { name: new RegExp(`UAT ${slug}`) })).toContainText('ACTIVE');
  await page
    .getByRole('button', { name: th('common:list.openDetails', { name: `UAT ${slug}` }) })
    .click();
  const timeline = page.getByRole('list', { name: th('common:history.order') });
  await expect(timeline.getByText('Reconcile').first()).toBeVisible();
  await expect(timeline.getByText('Retry step').first()).toBeVisible();
  await expect(timeline.getByText('System').first()).toBeVisible();
  console.log(JSON.stringify({ run, slug }));
});
