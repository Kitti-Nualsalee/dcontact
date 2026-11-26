import { expect, test } from './fixtures.js';
import { th } from './catalog';

/**
 * #583: every tenant enforces the work-session lease — two tabs in the same origin: the first tab (leader) gets the lease and is the work point
 * the second tab sees a holder exists so it is view-only and does not open for duplicate work (it used to test leader election without a lease)
 */
test('an Agent has a single work point: a second tab in the same origin is view-only and cannot open for calls', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: th('workspace:status.owner') })).toHaveText(
    th('workspace:lease.chip.held'),
  );

  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('status', { name: th('workspace:status.owner') })).toHaveText(
    th('workspace:lease.chip.standby'),
  );
  await expect(
    second.getByRole('button', { name: th('workspace:availability.open') }),
  ).toBeDisabled();
  await expect(page.getByRole('status', { name: th('workspace:status.owner') })).toHaveText(
    th('workspace:lease.chip.held'),
  );
});
