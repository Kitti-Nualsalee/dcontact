import { expect, test } from './fixtures';

// #956 happy path ของการเปิดเคสจากงานที่กำลังคุย ใช้ route mock เท่านั้น ไม่ใช่หลักฐานของ API จริง
const workId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const caseId = '9b0c6a1e-2f3d-4c5b-8a7e-1d2c3b4a5f6e';

test('เปิดเคสจากงานที่ผูกลูกค้าแล้ว: ผลไม่ทราบครั้งแรกส่ง commandId เดิมซ้ำ แล้วได้ลิงก์ไป Console', async ({
  page,
}) => {
  let state = 'ASSIGNED';
  const attempts: Record<string, unknown>[] = [];
  await page.route('**/api/v1/customer-360/work/*/customer', (route) =>
    route.fulfill({
      json: {
        interactionId: workId,
        state: 'LINKED',
        linkageRevision: '1',
        contact: {
          id: '44444444-4444-4444-8444-444444444444',
          displayName: 'คุณภา จันทร์เพ็ญ',
          company: 'Siam Retail',
        },
        revisions: { profile: '0', tag: '0', lineage: '0' },
        canEdit: true,
        canLink: true,
        identity: 'ACTIVE',
      },
    }),
  );
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
        areas: [
          {
            id: 'workspace',
            labelKey: 'navigation.areas.workspace',
            sections: [
              {
                id: 'work',
                labelKey: 'navigation.sections.work',
                items: [{ appId: 'agent-workspace' }],
              },
            ],
          },
        ],
        pins: { appIds: ['agent-workspace'], source: 'TENANT', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: true },
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        capabilities: { voiceWrapupV1: 1, workCustomerV1: 1 },
        agent: { id: 'agent-one', displayName: 'สมหญิง ใจดี', extension: '1000', state: 'BUSY' },
        interaction: {
          id: workId,
          state,
          direction: 'INBOUND',
          voiceWrapupPolicy: 'VOICE_NOTE_V1',
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
  await page.route('**/sip-credentials', (route) =>
    route.fulfill({
      json: {
        leaseId: route.request().headers()['x-work-session-lease-id'],
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'synthetic-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'synthetic',
        iceServers: [],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/cases/team-agents', (route) =>
    route.fulfill({
      json: {
        items: [
          { userId: 'agent-one', displayName: 'สมหญิง ใจดี' },
          { userId: 'agent-two', displayName: 'ปกรณ์ ศรีสุข' },
        ],
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/cases', async (route) => {
    attempts.push(route.request().postDataJSON() as Record<string, unknown>);
    if (attempts.length === 1) return route.abort('connectionreset');
    return route.fulfill({ status: 201, json: { caseId, version: 1 } });
  });

  await page.goto('/?authHarness=1&tenant=demo');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง', exact: true }).click();
  await page.getByRole('button', { name: 'รับสาย', exact: true }).click();
  state = 'ACTIVE';
  await expect(page.getByText('คุณภา จันทร์เพ็ญ').first()).toBeVisible();

  await page.getByRole('button', { name: 'เปิดเคส', exact: true }).first().click();
  const subject = page.getByRole('textbox', { name: 'หัวข้อ' });
  await expect(subject).toBeFocused();
  await subject.fill('เครื่อง X200 ชำรุด ขอเปลี่ยนเครื่องใหม่');
  await page.getByRole('textbox', { name: 'โน้ตแรก' }).fill('รอฝ่ายคลังยืนยันสต็อก');
  // dphone แบบลอยบังส่วนล่างของแผงงานที่ 1280×720 ผู้ใช้ย่อเป็นแถบได้
  await page.getByRole('button', { name: 'ย่อเป็นแถบ' }).click();
  const panel = page.getByRole('tabpanel', { name: 'เคส' });
  await panel.getByRole('button', { name: /ผู้รับผิดชอบ/ }).click();
  await page.getByRole('option', { name: 'ปกรณ์ ศรีสุข' }).click();
  await panel.getByRole('button', { name: 'เปิดเคส', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('ยังไม่ทราบผลการเปิดเคส');
  await expect(page.getByRole('textbox', { name: 'หัวข้อ' })).toHaveAttribute('readonly', '');

  await panel.getByRole('button', { name: 'ส่งคำสั่งเดิมอีกครั้ง' }).click();
  await expect(panel.getByRole('heading', { name: 'เปิดเคสแล้ว' })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({
    interactionId: workId,
    subject: 'เครื่อง X200 ชำรุด ขอเปลี่ยนเครื่องใหม่',
    note: 'รอฝ่ายคลังยืนยันสต็อก',
    assigneeUserId: 'agent-two',
  });
  const link = panel.getByRole('link', { name: 'เปิดเคสใน Console (แท็บใหม่)' });
  await expect(link).toHaveAttribute('href', new RegExp(`view=team-cases&case=${caseId}`));
  expect(decodeURIComponent(page.url())).not.toContain('X200');
});
