import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #938 status picker page after login and the status selector in Workspace (docs/agent-readiness-setup.md)
 * the mock server stores the Agent's status according to the availability/after-work commands sent (the API contract of #937)
 * `AGENT_STATUS_EVIDENCE_DIR=<dir>` = save evidence screenshots for the PR
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

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

const reasons = [
  { code: 'BREAK', labelTh: 'พักสั้น', labelEn: 'Break' },
  { code: 'LUNCH', labelTh: 'พักเที่ยง', labelEn: 'Lunch' },
  { code: 'MEETING', labelTh: 'ประชุม', labelEn: 'Meeting' },
  { code: 'BACK_OFFICE', labelTh: 'งานหลังบ้าน', labelEn: 'Back office' },
];

type Agent = {
  id: string;
  displayName: string;
  extension: string;
  state: string;
  stateSince: string | null;
  reasonCode: string | null;
  changedBy: string;
  changedByName?: string;
  changeNote?: string;
  afterWork: { state: string; reasonCode?: string };
};

async function open(
  page: Page,
  {
    interaction = null,
    agent = {},
    mic = 'ok',
  }: { interaction?: unknown; agent?: Partial<Agent>; mic?: 'ok' | 'denied' } = {},
) {
  const server = {
    agent: {
      id: 'agent-1000',
      displayName: 'สมชาย ใจดี',
      extension: '1000',
      state: 'OFFLINE',
      stateSince: new Date(Date.now() - 65_000).toISOString(),
      reasonCode: null,
      changedBy: 'SYSTEM',
      afterWork: { state: 'AVAILABLE' },
      ...agent,
    } as Agent,
    commands: [] as unknown[],
    afterWork: [] as unknown[],
    sipRequests: 0,
  };
  if (mic === 'denied')
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('blocked', 'NotAllowedError');
        },
      });
    });
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        capabilities: { voiceWrapupV1: 1, agentStatusV1: 1 },
        agent: server.agent,
        interaction,
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/not-ready-reasons', (route) =>
    route.fulfill({ status: 200, json: { reasons } }),
  );
  await page.route('**/api/v1/workspace/agent/availability', async (route) => {
    const body = route.request().postDataJSON() as { state: string; reasonCode?: string };
    server.commands.push(body);
    server.agent = {
      ...server.agent,
      state: body.state,
      reasonCode: body.reasonCode ?? null,
      stateSince: new Date().toISOString(),
      changedBy: 'AGENT',
    };
    await route.fulfill({ status: 200, json: body });
  });
  await page.route('**/api/v1/workspace/agent/after-work', async (route) => {
    const body = route.request().postDataJSON() as Agent['afterWork'];
    server.afterWork.push(body);
    server.agent = { ...server.agent, afterWork: body };
    await route.fulfill({ status: 200, json: { afterWork: body } });
  });
  await page.route('**/api/v1/workspace/agent/sip-credentials', (route) => {
    server.sipRequests += 1;
    return route.fulfill({
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
    });
  });
  await page.goto('/?tenant=demo');
  return server;
}

const gate = (page: Page) => page.getByRole('region', { name: /^(สวัสดี|Hello,) สมชาย ใจดี$/ });
const enter = (page: Page) => gate(page).getByRole('button', { name: 'เข้า Workspace' });
const selector = (page: Page) => page.getByRole('button', { name: /สถานะของฉัน/ });

async function evidence(page: Page, name: string) {
  const dir = process.env.AGENT_STATUS_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test('after login, choosing Not Ready requires choosing a reason first — enter Workspace without asking for the mic and without registering the phone', async ({
  page,
}) => {
  const server = await open(page);
  await expect(gate(page)).toBeVisible();
  await expect(gate(page).getByRole('radio', { name: /^Ready/ })).toBeChecked();
  await expect(page.getByRole('region', { name: /^(งานของฉัน|My work)$/ })).toHaveCount(0);

  await gate(page)
    .getByRole('radio', { name: /^Not Ready/ })
    .check();
  await expect(enter(page)).toBeDisabled();
  await expect(gate(page)).toContainText('เลือกเหตุผลก่อนเข้า');
  await gate(page).getByRole('radio', { name: 'พักเที่ยง' }).check();

  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
  await evidence(page, 'agent-status-gate');

  await enter(page).click();
  await expect(gate(page)).toHaveCount(0);
  expect(server.commands).toEqual([{ state: 'BREAK', reasonCode: 'LUNCH' }]);
  await expect(selector(page)).toContainText('Not Ready · พักเที่ยง');
  await expect(page.getByRole('region', { name: /^(งานของฉัน|My work)$/ })).toBeVisible();
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText(
    'โทรศัพท์ยังไม่พร้อม',
  );
  await evidence(page, 'agent-status-selector');
});

test('Ready → fully prepared to take calls then enter Workspace, switch to Offline from the release-phone option', async ({
  page,
}) => {
  const server = await open(page);
  await enter(page).click();
  await expect(gate(page)).toHaveCount(0);
  expect(server.commands).toEqual([{ state: 'AVAILABLE' }]);
  await expect(selector(page)).toContainText('Ready');
  const phone = page.getByRole('status', { name: 'สถานะ dphone' });
  await expect(phone).toHaveText('โทรศัพท์พร้อม');

  // Not Ready keeps the phone — only Offline releases it (owner decision item 5)
  await selector(page).click();
  await page.getByRole('option', { name: 'Not Ready · ประชุม', exact: true }).click();
  await expect(selector(page)).toContainText('Not Ready · ประชุม');
  await expect(phone).toHaveText('โทรศัพท์พร้อม');
  await selector(page).click();
  await page.getByRole('option', { name: 'Offline', exact: true }).click();
  await expect(selector(page)).toContainText('Offline');
  await expect(phone).not.toHaveText('โทรศัพท์พร้อม');
  expect(server.commands).toEqual([
    { state: 'AVAILABLE' },
    { state: 'BREAK', reasonCode: 'MEETING' },
    { state: 'OFFLINE' },
  ]);

  // going back to Ready must prepare for calls again
  await selector(page).click();
  await page.getByRole('option', { name: 'Ready', exact: true }).click();
  await expect(selector(page)).toContainText('Ready');
  await expect(phone).toHaveText('โทรศัพท์พร้อม');
});

test('mic denied → explains the fix, and enters as Not Ready · back-office work allowed', async ({
  page,
}) => {
  const server = await open(page, { mic: 'denied' });
  await enter(page).click();
  await expect(gate(page).getByRole('alert')).toContainText('ใช้ไมโครโฟนไม่ได้');
  await expect(gate(page).getByRole('button', { name: 'ลองอีกครั้ง' })).toBeVisible();
  expect(server.commands).toEqual([]);
  await evidence(page, 'agent-status-mic-denied');
  await gate(page).getByRole('button', { name: 'เข้าแบบ Not Ready · งานหลังบ้าน' }).click();
  await expect(gate(page)).toHaveCount(0);
  expect(server.commands).toEqual([{ state: 'BREAK', reasonCode: 'BACK_OFFICE' }]);
});

test('a call in hand when the page opens → skip the status picker page, and the status can be set after the work ends', async ({
  page,
}) => {
  const server = await open(page, {
    agent: { state: 'BUSY' },
    interaction: {
      id: '3f0c6c55-9a3e-4a51-9f53-0d7d1d3b8a21',
      state: 'ACTIVE',
      direction: 'INBOUND',
      version: '7',
      caller: '081-234-5678',
      queue: { id: 'queue-service', name: 'บริการลูกค้า' },
      offerExpiresAt: null,
      answeredAt: new Date(Date.now() - 30_000).toISOString(),
      endedAt: null,
    },
  });
  await expect(page.getByRole('region', { name: /^(งานของฉัน|My work)$/ })).toBeVisible();
  await expect(gate(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'อยู่ในสาย' }).first()).toBeVisible();
  const afterWork = page.getByRole('button', { name: /หลังจบงาน/ });
  await expect(afterWork).toContainText('Ready');
  await afterWork.click();
  await page.getByRole('option', { name: 'Not Ready · พักเที่ยง', exact: true }).click();
  await expect(afterWork).toContainText('Not Ready · พักเที่ยง');
  expect(server.afterWork).toEqual([{ state: 'BREAK', reasonCode: 'LUNCH' }]);
  expect(server.commands).toEqual([]);
});

test('the status picker page remembers the last chosen status', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('dcontact.workspace.lastStatus', JSON.stringify({ state: 'OFFLINE' })),
  );
  const server = await open(page);
  // owner decision item 6
  await expect(gate(page).getByRole('radio', { name: /^Offline/ })).toBeChecked();
  await enter(page).click();
  await expect(gate(page)).toHaveCount(0);
  expect(server.commands).toEqual([{ state: 'OFFLINE' }]);
  await expect(selector(page)).toContainText('Offline');
  await expect(page.getByRole('status', { name: 'สถานะ dphone' })).toHaveText(
    'โทรศัพท์ยังไม่พร้อม',
  );
});

test('a Supervisor changes the status during use → a bar notifies and the user acknowledges', async ({
  page,
}) => {
  await page.clock.install();
  const server = await open(page);
  await gate(page)
    .getByRole('radio', { name: /^Not Ready/ })
    .check();
  await gate(page).getByRole('radio', { name: 'พักสั้น' }).check();
  await enter(page).click();
  server.agent = {
    ...server.agent,
    state: 'BREAK',
    reasonCode: null,
    changedBy: 'SUPERVISOR',
    changedByName: 'หัวหน้าทีม ทดสอบ',
    changeNote: 'ประชุมทีมด่วน',
    stateSince: new Date().toISOString(),
  };
  // when idle, Workspace reads the snapshot every 15 seconds
  await page.clock.fastForward(16_000);
  const notice = page.locator('.aw-supervisor-notice');
  await expect(notice).toContainText('หัวหน้าทีม ทดสอบ');
  await expect(notice).toContainText('ประชุมทีมด่วน');
  await evidence(page, 'agent-status-supervisor');
  await notice.getByRole('button', { name: 'รับทราบ' }).click();
  await expect(notice).toHaveCount(0);
});

test('EN → the status picker page changes language without a reload', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('region', { name: 'Hello, สมชาย ใจดี' })).toBeVisible();
  await page.getByRole('radio', { name: /^Not Ready/ }).check();
  await expect(page.getByRole('radio', { name: 'Lunch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Workspace' })).toBeDisabled();
});
