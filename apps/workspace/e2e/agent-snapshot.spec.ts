import { expect, test } from './fixtures';
import { th } from './catalog';

test('Workspace shows an incoming offer from the authoritative Agent snapshot', async ({
  page,
}) => {
  await page.route('**/api/v1/workspace/agent/snapshot', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer e2e-access-token');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent: {
          id: 'agent-1000',
          displayName: 'Somchai Jaidee',
          extension: '1000',
          state: 'RESERVED',
        },
        interaction: {
          id: 'interaction-offer-1',
          state: 'ASSIGNED',
          version: '17',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'Customer Service' },
          offerExpiresAt: '2026-09-06T10:00:20.000Z',
          answeredAt: null,
          endedAt: null,
        },
      }),
    });
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: th('workspace:offer.title') })).toBeVisible();
  await expect(page.getByText('081-234-5678')).toBeVisible();
  await expect(page.getByText('Customer Service')).toBeVisible();
  await expect(page.getByText('Somchai Jaidee')).toBeVisible();
  await expect(page.getByText('Interaction v17')).toBeVisible();

  await page.getByRole('button', { name: th('workspace:media.check') }).click();
  await expect(page.getByRole('button', { name: th('dphone:accept'), exact: true })).toBeEnabled();
  await page.getByRole('button', { name: th('dphone:accept'), exact: true }).click();
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
  await expect(page.getByRole('button', { name: th('dphone:accept'), exact: true })).toBeDisabled();
  await page.getByRole('button', { name: th('dphone:mute') }).click();
  await expect(page.getByRole('button', { name: th('dphone:unmute') })).toBeVisible();
  await page.getByRole('button', { name: th('dphone:dtmf', { value: '5' }) }).click();
  await page.getByRole('button', { name: th('dphone:hold') }).click();
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.HELD'),
  );
  await page.getByRole('button', { name: th('dphone:resume') }).click();
  await page.getByRole('button', { name: th('dphone:hangup') }).click();
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.READY'),
  );
});
