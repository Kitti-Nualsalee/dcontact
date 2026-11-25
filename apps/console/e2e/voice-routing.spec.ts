import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';
import { homeNavigation } from './support/home-navigation.js';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const id = '7a33ac96-d87d-4ca4-ab75-f27e40e943be',
  teamId = '7a33ac96-d87d-4ca4-ab75-f27e40e943bf';
const capabilities = {
  version: 1,
  canWrite: true,
  configuration: { ready: true, reasons: [] },
  managedRouting: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
  policyRevision: 1,
  sourceKind: 'UAT_EXPLICIT',
  limits: { voiceQueues: { used: 0, limit: 10 }, skills: { used: 0, limit: 10 } },
};
const item = (name: string, kind: string) => ({
  id,
  name,
  teamId,
  voiceConfigVersion: 1,
  legacy: false,
  ...(kind === 'queues'
    ? {
        isActive: false,
        configRevision: 1,
        policy: { offerTimeoutSec: 20, maxTotalPreanswerSec: 60, terminalAction: 'HANGUP' },
      }
    : { code: 'LANG_TH', revision: 1 }),
});
test.use({ locale: 'th-TH' });
for (const section of ['queues', 'skills'])
  test(`production auth root opens Voice ${section} without forcing an Interaction context`, async ({
    page,
  }) => {
    await page.goto(`/?view=voice-routing&section=${section}&tenant=demo&authRootHarness=1`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: th('common:auth.contextMissing.title'), exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText(
      new RegExp(`Identity Provider|${escapeRegExp(th('voiceRouting:signIn'))}|Voice`),
    );
  });

async function harness(
  page: Page,
  options: {
    readOnly?: boolean;
    notReady?: boolean;
    lostResponse?: boolean;
    timeoutResponse?: boolean;
    status?: number;
    shellV2?: boolean;
    legacyPages?: boolean;
  } = {},
) {
  let stored: ReturnType<typeof item> | undefined;
  const commands: string[] = [];
  let detailReads = 0;
  await page.route('**/api/v1/me/navigation**', (route) => {
    const nav = homeNavigation(['admin'], options.shellV2 ?? true);
    if (options.legacyPages)
      for (const area of nav.areas)
        for (const section of area.sections) for (const item of section.items) delete item.pages;
    return route.fulfill({ json: nav });
  });
  await page.route('**/api/v1/tenant-voice/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.split('/tenant-voice/')[1];
    if (options.status)
      return route.fulfill({
        status: options.status,
        json: { code: options.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' },
      });
    if (path === 'capabilities')
      return route.fulfill({
        json: {
          ...capabilities,
          canWrite: !options.readOnly,
          configuration: options.notReady
            ? { ready: false, reasons: ['RESOURCE_POLICY_NOT_READY'] }
            : capabilities.configuration,
        },
      });
    if (path === 'teams')
      return route.fulfill({ json: { items: [{ id: teamId, name: 'UAT team' }] } });
    if (path.startsWith('commands/'))
      return stored
        ? route.fulfill({ json: { state: 'SUCCEEDED', result: stored } })
        : route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    const kind = path.split('/')[0];
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      commands.push(body.commandId);
      stored = item(body.name, kind);
      if (options.lostResponse) return route.abort('failed');
      if (options.timeoutResponse) return route.fulfill({ status: 408, json: { code: 'FAILED' } });
      return route.fulfill({ status: 201, json: stored });
    }
    if (path.includes('/')) {
      detailReads++;
      return stored
        ? route.fulfill({ json: stored })
        : route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
    }
    return route.fulfill({ json: { items: stored ? [stored] : [], nextCursor: null } });
  });
  return { commands, reads: () => detailReads };
}
async function fill(page: Page, name: string, skill = false) {
  await page.getByRole('textbox', { name: th('voiceRouting:name'), exact: true }).fill(name);
  if (skill)
    await page.getByRole('textbox', { name: th('voiceRouting:code'), exact: true }).fill('LANG_TH');
  await page
    .getByRole('button', {
      name: `${th('voiceRouting:chooseTeam')} ${th('voiceRouting:team')}`,
      exact: true,
    })
    .click();
  await page.getByRole('option', { name: 'UAT team' }).click();
}
for (const kind of ['queues', 'skills'])
  test(`${kind}: create→readback→reload and no lease/SIP/WS`, async ({ page }) => {
    const data = await harness(page);
    const forbidden: string[] = [];
    page.on('request', (r) => {
      if (/work-session|sip-credentials/.test(r.url())) forbidden.push(r.url());
    });
    page.on('websocket', (s) => {
      if (s.url().includes('workspace-session')) forbidden.push(s.url());
    });
    await page.goto(`/?view=voice-routing&section=${kind}&tenant=demo`);
    await expect(page.getByText(th('voiceRouting:empty'), { exact: true })).toBeVisible();
    await fill(page, kind === 'queues' ? 'Voice test queue' : 'Language skill', kind === 'skills');
    await page.getByRole('button', { name: th('voiceRouting:create'), exact: true }).click();
    await expect(page.getByText(th('voiceRouting:saved'), { exact: true })).toBeVisible();
    expect(data.reads()).toBeGreaterThan(0);
    expect(data.commands).toHaveLength(1);
    expect(page.url()).toContain(`resource=${id}`);
    await page.reload();
    await expect(
      page.getByRole('heading', {
        name: kind === 'queues' ? 'Voice test queue' : 'Language skill',
        exact: true,
      }),
    ).toBeVisible();
    expect(forbidden).toEqual([]);
    await page.screenshot({ path: `/tmp/dcontact-b1-${kind}-th.png`, fullPage: true });
  });
for (const outcome of ['lost response', 'HTTP 408'])
  test(`${outcome} + reload → original command lookup → readback without sending a new create`, async ({
    page,
  }) => {
    const data = await harness(
      page,
      outcome === 'lost response' ? { lostResponse: true } : { timeoutResponse: true },
    );
    await page.goto('/?view=voice-routing&tenant=demo');
    await fill(page, 'Recovery queue');
    await page.getByRole('button', { name: th('voiceRouting:create'), exact: true }).click();
    await expect(page.getByText(th('voiceRouting:unknown'), { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: th('voiceRouting:create'), exact: true }),
    ).toBeDisabled();
    const remembered = await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith('dc:voice-catalog:pending:'))
        .map(([, value]) => value),
    );
    expect(remembered).toEqual(data.commands);
    await page.reload();
    await expect(page.getByText(th('voiceRouting:unknown'), { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: th('voiceRouting:create'), exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: th('voiceRouting:checkResult'), exact: true }).click();
    await expect(page.getByText(th('voiceRouting:saved'), { exact: true })).toBeVisible();
    expect(data.commands).toHaveLength(1);
    expect(data.reads()).toBeGreaterThan(0);
  });
test('a Supervisor is read-only, and a missing policy blocks create with the reason', async ({
  page,
}) => {
  await harness(page, { readOnly: true });
  await page.goto('/?view=voice-routing&tenant=demo');
  await expect(page.getByText(th('voiceRouting:readOnly'), { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('voiceRouting:create'), exact: true }),
  ).toHaveCount(0);
  await page.unroute('**/api/v1/tenant-voice/**');
  await harness(page, { notReady: true });
  await page.reload();
  await expect(
    page.getByText(th('voiceRouting:errors.RESOURCE_POLICY_NOT_READY'), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('voiceRouting:create'), exact: true }),
  ).toBeDisabled();
});
for (const status of [401, 403])
  test(`HTTP ${status} shows a permission status and does not open create`, async ({ page }) => {
    await harness(page, { status });
    await page.goto('/?view=voice-routing&tenant=demo');
    await expect(page.getByRole('alert')).toContainText(
      status === 401 ? th('voiceRouting:errors.UNAUTHORIZED') : th('voiceRouting:errors.FORBIDDEN'),
    );
    await expect(
      page.getByRole('button', { name: th('voiceRouting:create'), exact: true }),
    ).toHaveCount(0);
  });
test.describe('English', () => {
  test.use({ locale: 'en-US' });
  test('shows the English catalog and policy', async ({ page }) => {
    await harness(page);
    await page.goto('/?view=voice-routing&tenant=demo');
    await expect(
      page.getByRole('heading', { name: 'Voice configuration', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Using 0 of 10 items', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/dcontact-b1-queues-en.png', fullPage: true });
  });
});

for (const mode of ['shell', 'shell-off', 'legacy-pages'] as const)
  test(`${mode}: switching queue/skill highlights the right page and goes back without reload`, async ({
    page,
  }) => {
    await harness(page, { shellV2: mode !== 'shell-off', legacyPages: mode === 'legacy-pages' });
    await page.goto('/?view=voice-routing&section=queues&tenant=demo');
    await expect(
      page.getByRole('heading', { name: th('voiceRouting:queues'), exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { catalogNavigationProbe: string }).catalogNavigationProbe =
        'same-document';
    });
    if (mode === 'shell') {
      await expect(
        page.locator('a[aria-current="page"]', {
          hasText: th('common:navigation.pages.voiceRouting.queues'),
        }),
      ).toBeVisible();
      await page
        .getByRole('link', { name: th('common:navigation.pages.voiceRouting.skills'), exact: true })
        .click();
      await expect(
        page.locator('a[aria-current="page"]', {
          hasText: th('common:navigation.pages.voiceRouting.skills'),
        }),
      ).toBeVisible();
      await expect(page.getByRole('navigation', { name: th('voiceRouting:catalog') })).toHaveCount(
        0,
      );
    } else {
      const nav = page.getByRole('navigation', { name: th('voiceRouting:catalog') });
      await nav.getByRole('button', { name: th('voiceRouting:skills'), exact: true }).click();
      await expect(
        nav.getByRole('button', { name: th('voiceRouting:skills'), exact: true }),
      ).toHaveAttribute('aria-current', 'page');
    }
    await expect(
      page.getByRole('heading', { name: th('voiceRouting:skills'), exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: th('voiceRouting:code'), exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { catalogNavigationProbe: string }).catalogNavigationProbe,
      ),
    ).toBe('same-document');
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: th('voiceRouting:queues'), exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: th('voiceRouting:code'), exact: true }),
    ).toHaveCount(0);
  });
