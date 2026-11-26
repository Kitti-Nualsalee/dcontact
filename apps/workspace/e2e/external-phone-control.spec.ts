import { expect, test } from './fixtures';
import { th } from './catalog';
import { thRegExp } from './locale-match';

test('Workspace external simulator: controls stay local without SIP, microphone or business writes', async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(window, '__externalMediaRequests', { value: 0, writable: true });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => {
        const state = window as unknown as { __externalMediaRequests: number };
        state.__externalMediaRequests += 1;
        throw new Error('External control must not request a microphone');
      },
    });
  });
  page.on('request', (request) => {
    if (
      request.url().includes('/sip-credentials') ||
      (request.method() !== 'GET' && request.url().includes('/workspace/agent/'))
    )
      mutations.push(request.url());
  });
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
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
        pins: { appIds: ['agent-workspace'], source: 'SYSTEM', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: true },
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        agent: { id: 'agent', displayName: 'Test Agent', extension: '1000', state: 'OFFLINE' },
        interaction: null,
      },
    }),
  );
  await page.goto('/?phoneControl=external-simulator');
  const panel = page.getByRole('article', { name: th('dphone:external.title') });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: th('workspace:media.check') })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'dphone', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: th('dphone:external.connect') }).click();
  await panel.getByRole('button', { name: th('dphone:external.incoming') }).click();
  await expect(panel.getByRole('status')).toHaveText(th('dphone:external.phase.RINGING'));
  await panel.getByRole('button', { name: th('dphone:external.accept') }).click();
  await expect(panel.getByRole('status')).toHaveText(th('dphone:external.phase.ACTIVE'));
  await panel.getByRole('button', { name: th('dphone:external.hangup') }).click();
  await expect(panel.getByRole('status')).toHaveText(th('dphone:external.phase.ENDED'));
  await panel.getByRole('button', { name: th('dphone:external.incoming') }).click();
  await expect(panel.getByRole('status')).toHaveText(th('dphone:external.phase.RINGING'));
  await page.screenshot({ path: 'test-results/external-softphone-control.png', fullPage: true });
  expect(mutations).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __externalMediaRequests: number }).__externalMediaRequests,
    ),
  ).toBe(0);
  expect(await page.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBeUndefined();
  // once there is real work from the server the simulator must pause, and the simulated state must not control that call
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        agent: { id: 'agent', displayName: 'Test Agent', extension: '1000', state: 'BUSY' },
        interaction: {
          id: 'real-work',
          state: 'ACTIVE',
          direction: 'INBOUND',
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
  await page.reload();
  await expect(panel.getByRole('button', { name: th('dphone:external.connect') })).toBeDisabled();
  await expect(panel.getByRole('status')).toHaveText(th('dphone:external.phase.DISCONNECTED'));
  await expect(panel.getByText(thRegExp('dphone:external.paused'))).toBeVisible();
  expect(mutations).toEqual([]);
});
