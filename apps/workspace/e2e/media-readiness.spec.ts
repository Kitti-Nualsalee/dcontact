import { expect, test } from './fixtures';
import { th } from './catalog';

test('an Agent can open for calls only after the browser confirms media readiness', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Agent Workspace' })).toBeVisible();
  await expect(
    page.getByText(th('workspace:availability.notReady'), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('workspace:availability.open') }),
  ).toBeDisabled();

  await page.getByRole('button', { name: th('workspace:media.check') }).click();

  await expect(page.getByRole('status', { name: th('workspace:media.indicator') })).toHaveText(
    th('workspace:readiness.READY'),
  );
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.READY'),
  );
  await expect(page.getByRole('button', { name: th('workspace:availability.open') })).toBeEnabled();

  await page.getByRole('button', { name: th('workspace:availability.open') }).click();

  await expect(page.getByText(th('workspace:availability.ready'), { exact: true })).toBeVisible();
});

test('an Agent is withdrawn from AVAILABLE when the media track ends while waiting for a call', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: th('workspace:media.check') }).click();
  await page.getByRole('button', { name: th('workspace:availability.open') }).click();
  await expect(page.getByText(th('workspace:availability.ready'), { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const track = (window as Window & { __dContactTestMediaTrack: EventTarget })
      .__dContactTestMediaTrack;
    track.dispatchEvent(new Event('ended'));
  });

  await expect(page.getByRole('alert')).toHaveText(th('workspace:micEnded'));
  await expect(
    page.getByRole('button', { name: th('workspace:availability.open') }),
  ).toBeDisabled();
  await expect(
    page.getByText(th('workspace:availability.notReady'), { exact: true }),
  ).toBeVisible();
});
