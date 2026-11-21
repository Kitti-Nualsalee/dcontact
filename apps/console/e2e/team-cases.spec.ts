import { expect, test, type Page } from '@playwright/test';
test.use({ locale: 'th-TH' });

const caseId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const me = 'first'; // dc_user_id ของ harness identity
const other = 'agent-2';
const people = { [me]: 'สมหญิง ใจดี', [other]: 'ปกรณ์ ศรีสุข' };

type Status = 'OPEN' | 'RESOLVED' | 'CLOSED';
interface Fixture {
  status: Status;
  version: number;
  assignee: string;
  notes: string[];
  commands: { path: string; commandId: string }[];
  failNext?: 'network' | 'conflict';
  seen: Set<string>;
}

function activities(fixture: Fixture) {
  const blank = {
    interactionId: null,
    interactionMine: false,
    interactionChannel: null,
    interactionDirection: null,
    body: null,
    fromStatus: null,
    toStatus: null,
    assigneeUserId: null,
  };
  return [
    {
      ...blank,
      id: 'a1',
      kind: 'CREATED',
      occurredAt: '2026-11-18T10:02:00.000Z',
      actorUserId: me,
      assigneeUserId: me,
    },
    {
      ...blank,
      id: 'a2',
      kind: 'LINKED',
      occurredAt: '2026-11-18T10:02:00.000Z',
      actorUserId: me,
      interactionId: '7f3c0000-0000-4000-8000-00000000a91e',
      interactionMine: true,
      interactionChannel: 'VOICE',
      interactionDirection: 'INBOUND',
    },
    ...fixture.notes.map((body, index) => ({
      ...blank,
      id: `n${index}`,
      kind: 'NOTE',
      occurredAt: `2026-11-19T09:0${index}:00.000Z`,
      actorUserId: me,
      body,
    })),
  ];
}

async function mockCases(page: Page, fixture: Fixture) {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/workspace/agent/cases**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/workspace/agent/cases', '');
    if (request.method() === 'GET' && path === '') {
      const mine = url.searchParams.get('mine') === '1';
      const include =
        (!mine || fixture.assignee === me) &&
        (url.searchParams.get('status') !== 'NOT_CLOSED' || fixture.status !== 'CLOSED');
      return route.fulfill({
        json: {
          items: include
            ? [
                {
                  id: caseId,
                  subject: 'เครื่อง X200 ชำรุด ขอเปลี่ยนเครื่องใหม่',
                  contactId: 'c1',
                  contactDisplayName: 'คุณนภา จันทร์เพ็ญ',
                  status: fixture.status,
                  assigneeUserId: fixture.assignee,
                  version: fixture.version,
                  linkedWorkCount: 1,
                  createdAt: '2026-11-18T10:02:00.000Z',
                  updatedAt: '2026-11-19T02:15:00.000Z',
                },
              ]
            : [],
          nextCursor: null,
          people,
          teamName: 'Retail Support',
        },
      });
    }
    if (request.method() === 'GET' && path === '/team-agents')
      return route.fulfill({
        json: {
          items: [
            { userId: me, displayName: people[me] },
            { userId: other, displayName: people[other] },
          ],
        },
      });
    if (request.method() === 'GET' && path === `/${caseId}`)
      return route.fulfill({
        json: {
          case: {
            id: caseId,
            subject: 'เครื่อง X200 ชำรุด ขอเปลี่ยนเครื่องใหม่',
            contactId: 'c1',
            contactDisplayName: 'คุณนภา จันทร์เพ็ญ',
            status: fixture.status,
            assigneeUserId: fixture.assignee,
            version: fixture.version,
            linkedWorkCount: 1,
            createdAt: '2026-11-18T10:02:00.000Z',
            updatedAt: '2026-11-19T02:15:00.000Z',
            teamId: 't1',
            assigneeInTeam: true,
            reopenCount: 0,
            createdByUserId: me,
            sourceInteractionId: null,
            resolvedAt: null,
            closedAt: fixture.status === 'CLOSED' ? '2026-11-20T03:00:00.000Z' : null,
            activities: activities(fixture),
          },
          people,
          teamName: 'Retail Support',
          customer: { displayName: 'คุณนภา จันทร์เพ็ญ', company: 'Siam Retail Co.' },
        },
      });
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        commandId: string;
        expectedVersion: number;
        note?: string;
        status?: Status;
        assigneeUserId?: string;
      };
      fixture.commands.push({ path, commandId: body.commandId });
      if (fixture.failNext === 'network') {
        fixture.failNext = undefined;
        // ผลไม่ทราบ: server บันทึกแล้วแต่ response ไม่ถึงผู้ใช้
        fixture.seen.add(body.commandId);
        apply(fixture, path, body);
        return route.abort('failed');
      }
      if (fixture.failNext === 'conflict') {
        fixture.failNext = undefined;
        return route.fulfill({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      }
      if (!fixture.seen.has(body.commandId)) {
        fixture.seen.add(body.commandId);
        apply(fixture, path, body);
      }
      return route.fulfill({ json: { caseId, version: fixture.version } });
    }
    return route.fulfill({ status: 404 });
  });
}

function apply(
  fixture: Fixture,
  path: string,
  body: { note?: string; status?: Status; assigneeUserId?: string },
) {
  fixture.version += 1;
  if (path.endsWith('/notes') && body.note) fixture.notes.push(body.note);
  if (path.endsWith('/status') && body.status) fixture.status = body.status;
  if (path.endsWith('/assignment') && body.assigneeUserId) fixture.assignee = body.assigneeUserId;
}

const newFixture = (): Fixture => ({
  status: 'OPEN',
  version: 1,
  assignee: me,
  notes: ['ลูกค้าแจ้งว่าเครื่องแตกที่ฝาหลัง'],
  commands: [],
  seen: new Set(),
});

test('Agent ดูรายการ เปิดรายละเอียด เพิ่มโน้ต แก้แล้ว และปิดเคสด้วย alertdialog', async ({
  page,
}) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto('/?view=team-cases&tenant=demo');

  // รายการ: ค่าเริ่มต้นยังไม่ปิด + ของฉัน
  await expect(page.getByRole('heading', { name: 'เคสของทีม', level: 1 })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'รายการเคสของทีม' })).toContainText('คุณ');
  await expect(page.getByText('แสดง 1–1')).toBeVisible();
  await page
    .getByRole('button', { name: 'เปิดเคส เครื่อง X200 ชำรุด ขอเปลี่ยนเครื่องใหม่' })
    .click();

  // รายละเอียด: URL, ไทม์ไลน์ และลิงก์ประวัติงาน (งานของผู้ดูเอง)
  await expect(page.getByRole('heading', { name: /เครื่อง X200/, level: 1 })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('case')).toBe(caseId);
  await expect(page.getByText('เปิดเคส และให้ตัวเองเป็นผู้รับผิดชอบ')).toBeVisible();
  await expect(page.getByRole('link', { name: 'เปิดในประวัติงาน' })).toHaveAttribute(
    'href',
    /view=agent-history&.*interaction=/,
  );

  // เพิ่มโน้ต
  const note = page.getByRole('textbox', { name: 'เพิ่มโน้ต' });
  await note.fill('<b>ฝ่ายคลัง</b> ยืนยันสต็อกแล้ว');
  await page.getByRole('button', { name: 'บันทึกโน้ต' }).click();
  await expect(page.getByText('<b>ฝ่ายคลัง</b> ยืนยันสต็อกแล้ว', { exact: true })).toBeVisible();
  await expect(page.locator('.cs-note b')).toHaveCount(0);
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('');

  // แก้แล้ว: ไม่ต้องยืนยัน, ปุ่มชุดใหม่และ focus
  await page.getByRole('button', { name: 'ทำเครื่องหมายว่าแก้แล้ว' }).click();
  await expect(page.getByRole('button', { name: 'เปิดเคสอีกครั้ง' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'การทำงานกับเคส' }).getByRole('button').first(),
  ).toBeFocused();

  // ปิดเคส: alertdialog focus เริ่มที่ยกเลิก
  await page.getByRole('button', { name: 'ปิดเคส', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('เครื่อง X200');
  await expect(dialog.getByRole('button', { name: 'ยกเลิก' })).toBeFocused();
  await dialog.getByRole('button', { name: 'ปิดเคส', exact: true }).click();
  await expect(page.locator('.cs-bar-brand')).toContainText('เคสนี้ปิดแล้วเมื่อ');
  await expect(page.locator('.cs-bar-brand')).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'เพิ่มโน้ต' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'มอบหมาย' })).toHaveCount(0);

  // ทุกคำสั่งมี commandId ไม่ซ้ำกัน
  expect(fixture.commands.map((c) => c.path.split('/').pop())).toEqual([
    'notes',
    'status',
    'status',
  ]);
  expect(new Set(fixture.commands.map((c) => c.commandId)).size).toBe(3);

  // Back กลับรายการ
  await page.goBack();
  await expect(page.getByRole('grid', { name: 'รายการเคสของทีม' })).toHaveCount(0);
  await expect(page.getByText('ไม่มีเคสที่ตรงกับตัวกรอง')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'เคสของทีม', level: 1 })).toBeVisible();
});

test('มอบหมายผ่าน Dialog และ filter ทั้งทีมอยู่ใน URL', async ({ page }) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto('/?view=team-cases&tenant=demo&assignee=team&status=ALL');
  await expect(page.getByRole('grid', { name: 'รายการเคสของทีม' })).toBeVisible();
  await page.getByRole('link', { name: /เครื่อง X200/ }).click();
  await page.getByRole('button', { name: 'มอบหมาย' }).click();
  const dialog = page.getByRole('dialog', { name: 'มอบหมายเคส' });
  await dialog.getByRole('button', { name: /ผู้รับผิดชอบ/ }).click();
  await page.getByRole('option', { name: 'ปกรณ์ ศรีสุข' }).click();
  await dialog.getByRole('button', { name: 'มอบหมาย', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('ปกรณ์ ศรีสุข').first()).toBeVisible();
  expect(fixture.assignee).toBe(other);
  expect(new URL(page.url()).searchParams.get('assignee')).toBe('team');
});

test('ไม่ทราบผล: กดส่งคำสั่งเดิมใช้ commandId เดิม และไม่สร้างโน้ตซ้ำ', async ({ page }) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto(`/?view=team-cases&tenant=demo&case=${caseId}`);
  const note = page.getByRole('textbox', { name: 'เพิ่มโน้ต' });
  await note.fill('โทรกลับลูกค้าแล้ว');
  fixture.failNext = 'network';
  await page.getByRole('button', { name: 'บันทึกโน้ต' }).click();
  const retry = page.getByRole('button', { name: 'ยังไม่ทราบผล ส่งคำสั่งเดิมอีกครั้ง' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText('โทรกลับลูกค้าแล้ว', { exact: true })).toBeVisible();
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.commands[1].commandId).toBe(fixture.commands[0].commandId);
  expect(fixture.notes.filter((n) => n === 'โทรกลับลูกค้าแล้ว')).toHaveLength(1);
});

test('conflict: แสดงแถบ เก็บร่างโน้ต และโหลดเคสล่าสุด', async ({ page }) => {
  const fixture = newFixture();
  await mockCases(page, fixture);
  await page.goto(`/?view=team-cases&tenant=demo&case=${caseId}`);
  const note = page.getByRole('textbox', { name: 'เพิ่มโน้ต' });
  await note.fill('ร่างที่ต้องไม่หาย');
  fixture.failNext = 'conflict';
  await page.getByRole('button', { name: 'บันทึกโน้ต' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'เคสนี้ถูกแก้ไขหลังจากคุณเปิดหน้า' });
  await expect(alert).toBeFocused();
  await expect(page.getByRole('button', { name: 'บันทึกโน้ต' })).toBeDisabled();
  await expect(note).toHaveValue('ร่างที่ต้องไม่หาย');
  fixture.version += 1;
  await page.getByRole('button', { name: 'โหลดเคสล่าสุด' }).click();
  await expect(alert).toHaveCount(0);
  await expect(note).toHaveValue('ร่างที่ต้องไม่หาย');
  await page.getByRole('button', { name: 'บันทึกโน้ต' }).click();
  expect(fixture.commands[1].commandId).not.toBe(fixture.commands[0].commandId);
  expect(fixture.notes).toContain('ร่างที่ต้องไม่หาย');
});
