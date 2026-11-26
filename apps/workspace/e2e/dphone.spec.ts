import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { th } from './catalog';
import { escapeRegExp, thRegExp } from './locale-match';

/**
 * D1.15 (#454): the dphone widget in Agent Workspace (flag ui.shell.v2 on) on a simulated transport
 *
 * evidence checked at every step: the SIP session ID (window.__dcontactDphone) and performance.timeOrigin do not change
 * across collapse/expand/detach/pull back/language switch — real calls on the dev stack are in the acceptance of D1.16
 */
const navigation = {
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
};

const snapshot = {
  agent: { id: 'agent-1000', displayName: 'Somchai Jaidee', extension: '1000', state: 'RESERVED' },
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
};

async function openWithCall(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({ status: 200, json: snapshot }),
  );
  await page.route('**/api/v1/workspace/agent/sip-credentials', (route) =>
    route.fulfill({
      status: 200,
      json: {
        leaseId: 'e2e-lease',
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'e2e-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'fs-e2e',
        iceServers: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }),
  );
  await page.goto('/?tenant=demo');
  const dphone = page.getByRole('region', { name: 'dphone' });
  await expect(dphone).toBeVisible();
  await page.getByRole('button', { name: th('workspace:media.check') }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(
    th('dphone:phase.RINGING'),
  );
  await expect(dphone.getByText('081-234-5678')).toBeVisible();
  await dphone.getByRole('button', { name: th('dphone:accept') }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
  return dphone;
}

const evidence = (page: Page) =>
  page.evaluate(() => ({
    sip: window.__dcontactDphone?.sipSessionId(),
    timeOrigin: performance.timeOrigin,
    navigations: performance.getEntriesByType('navigation').length,
  }));

for (const ending of ['local', 'remote'] as const) {
  test(`#687: ${ending} SIP ending before the server changes to WRAPUP must show the summary without a reload`, async ({
    page,
  }) => {
    const dphone = await openWithCall(page);
    const before = await evidence(page);
    let snapshotsAfterHangup = 0;
    await page.route('**/api/v1/workspace/agent/snapshot', (route) => {
      snapshotsAfterHangup += 1;
      return route.fulfill({
        status: 200,
        json: {
          ...snapshot,
          interaction: {
            ...snapshot.interaction,
            state: snapshotsAfterHangup < 3 ? 'ACTIVE' : 'WRAPUP',
            answeredAt: '2026-09-06T10:00:10.000Z',
            endedAt: snapshotsAfterHangup < 3 ? null : '2026-09-06T10:01:10.000Z',
          },
        },
      });
    });
    if (ending === 'local') {
      await dphone.getByRole('button', { name: th('dphone:hangup') }).click();
    } else {
      await page
        .locator('audio')
        .evaluate((audio) => audio.dispatchEvent(new Event('e2e:sip-terminated')));
    }
    await expect(page.getByRole('heading', { name: th('workspace:wrapup.title') })).toBeVisible();
    expect(snapshotsAfterHangup).toBe(3);
    expect((await evidence(page)).timeOrigin).toBe(before.timeOrigin);
  });
}

test('flag on: dphone floats instead of the call control panel, and the old incoming call panel is not duplicated', async ({
  page,
}) => {
  const dphone = await openWithCall(page);
  await expect(page.getByRole('heading', { name: th('workspace:offer.title') })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: th('workspace:controls.title') })).toHaveCount(0);
  await expect(dphone.getByRole('button', { name: th('dphone:hangup') })).toBeVisible();
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
});

test('collapse/expand 3 sizes and switch language: the same SIP session, no reload, and DTMF works in the expanded size', async ({
  page,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  expect(before.sip).toMatch(/[0-9a-f-]{36}/);

  await dphone.getByRole('button', { name: th('dphone:size.bar') }).click();
  await expect(dphone.getByRole('button', { name: th('dphone:mute') })).toHaveCount(0);
  await expect(dphone.getByRole('button', { name: th('dphone:hangup') })).toBeVisible();

  await dphone.getByRole('button', { name: th('dphone:size.expanded') }).click();
  await dphone.getByRole('button', { name: th('dphone:dtmf', { value: '5' }) }).click();
  await dphone.getByRole('button', { name: th('dphone:mute') }).click();
  await expect(dphone.getByRole('button', { name: th('dphone:unmute') })).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
  await expect(dphone.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await page.getByRole('button', { name: th('ui:shell.languageNames.th') }).click();

  await dphone.getByRole('button', { name: th('dphone:size.compact') }).click();
  await expect(dphone.getByRole('button', { name: th('dphone:dtmf', { value: '5' }) })).toHaveCount(
    0,
  );
  expect(await evidence(page)).toEqual(before);
});

test('detach the /dphone window then hold the call from the detached window — the session stays in the working tab and can be pulled back', async ({
  page,
  context,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    dphone.getByRole('button', { name: th('dphone:detach') }).click(),
  ]);
  await expect(page.getByText(th('dphone:detached'))).toBeVisible();
  expect(new URL(popup.url()).pathname).toBe('/dphone');
  expect(new URL(popup.url()).searchParams.get('tenant')).toBe('demo');
  expect(new URL(popup.url()).searchParams.get('remote')).toMatch(/^[0-9a-f-]{36}$/);

  const remote = popup.getByRole('region', { name: 'dphone' });
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
  await expect(remote.getByText('081-234-5678')).toBeVisible();
  await remote.getByRole('button', { name: th('dphone:hold') }).click();
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.HELD'),
  );
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText(th('dphone:phase.HELD'));

  // switch language in Workspace → the detached window follows
  await page.getByRole('button', { name: 'English' }).click();
  await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('On hold');
  await page.getByRole('button', { name: th('ui:shell.languageNames.th') }).click();

  const axe = await new AxeBuilder({ page: popup }).analyze();
  expect(
    axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id),
  ).toEqual([]);

  const closed = popup.waitForEvent('close');
  await page.getByRole('button', { name: th('dphone:attach') }).click();
  await closed;
  await expect(
    page.getByRole('region', { name: 'dphone' }).getByRole('button', { name: th('dphone:resume') }),
  ).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test('closing the detached window by hand → the widget returns to Workspace with the call still up', async ({
  page,
  context,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    dphone.getByRole('button', { name: th('dphone:detach') }).click(),
  ]);
  await expect(popup.getByRole('region', { name: 'dphone' })).toBeVisible();
  await popup.close();
  await expect(
    page.getByRole('region', { name: 'dphone' }).getByRole('button', { name: th('dphone:hangup') }),
  ).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test('/dphone opened directly with no Workspace → states the reason clearly, creates no session', async ({
  page,
}) => {
  await page.goto('/dphone');
  await expect(page.getByRole('status')).toHaveText(thRegExp('dphone:page.noHost'), {
    timeout: 6_000,
  });
  expect(await page.evaluate(() => window.__dcontactDphone)).toBeUndefined();
});

for (const language of ['th', 'en'] as const) {
  test(`axe (${language}): Agent Workspace in the shell with dphone at every size has no serious/critical`, async ({
    page,
  }) => {
    const dphone = await openWithCall(page);
    if (language === 'en') await page.getByRole('button', { name: 'English' }).click();
    const labels = {
      th: {
        bar: th('dphone:size.bar'),
        compact: th('dphone:size.compact'),
        expanded: th('dphone:size.expanded'),
      },
      en: { bar: 'Minimize to bar', compact: 'Compact', expanded: 'Expand with keypad' },
    }[language];
    for (const size of ['bar', 'compact', 'expanded'] as const) {
      await dphone.getByRole('button', { name: labels[size] }).click();
      const result = await new AxeBuilder({ page }).analyze();
      expect(
        result.violations
          .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
          .map((v) => `${size}: ${v.id} ${v.nodes[0]?.target}`),
      ).toEqual([]);
    }
  });
}

test('a /dphone window opened by itself (bookmark) during a call does not make the call control buttons in Workspace disappear and cannot control the call', async ({
  page,
  context,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  for (const path of ['/dphone', '/dphone?remote=not-ours']) {
    const stray = await context.newPage();
    await stray.goto(path);
    await expect(stray.getByRole('status')).toHaveText(thRegExp('dphone:page.noHost'), {
      timeout: 6_000,
    });
    await expect(dphone.getByRole('button', { name: th('dphone:hangup') })).toBeVisible();
    await expect(page.getByText(th('dphone:detached'))).toHaveCount(0);
    await stray.close();
  }
  await expect(page.getByRole('status', { name: th('workspace:status.dphone') })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
  expect(await evidence(page)).toEqual(before);
});

test('#588: signing out during a call must confirm — after cancelling the existing call stays without a remount, after confirming it signs out', async ({
  page,
}) => {
  const dphone = await openWithCall(page);
  const before = await evidence(page);
  const trigger = page.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(th('ui:userMenu.open', { name: '' }).trim())}`),
  });

  await trigger.click();
  await page.getByRole('menuitem', { name: th('ui:userMenu.signOut') }).click();
  const dialog = page.getByRole('alertdialog', { name: th('common:shell.signOutConfirm.title') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: th('ui:userMenu.cancel') }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(
    th('dphone:phase.ACTIVE'),
  );
  expect(await evidence(page)).toEqual(before);
  expect(await page.evaluate(() => (window as { __signOuts?: number }).__signOuts ?? 0)).toBe(0);

  await trigger.click();
  await page.getByRole('menuitem', { name: th('ui:userMenu.signOut') }).click();
  await dialog.getByRole('button', { name: th('common:shell.signOutConfirm.confirm') }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as { __signOuts?: number }).__signOuts ?? 0)).toBe(1);
});

test('forced-colors: the selected size button of dphone uses the system Highlight background', async ({
  page,
}) => {
  const dphone = await openWithCall(page);
  await page.emulateMedia({ forcedColors: 'active' });
  const pressed = dphone.locator('.dp-icon-button[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  // other buttons have a transparent background over Canvas, so compare against the real system Highlight value instead of against other buttons
  const highlight = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'Highlight';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  expect(await pressed.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    highlight,
  );
});
