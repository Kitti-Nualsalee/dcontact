import { expect, test, type Page } from '@playwright/test';
test.use({ locale: 'th-TH' });

/** #986 team history and summary — mock API, verifies UI only and does not replace permission evidence from the DB (that is in integration) */
const teamA = '7a33ac96-d87d-4ca4-ab75-f27e40e94a01';
const teamB = '7a33ac96-d87d-4ca4-ab75-f27e40e94a02';
const agentA = '7a33ac96-d87d-4ca4-ab75-f27e40e94b01';
const agentA2 = '7a33ac96-d87d-4ca4-ab75-f27e40e94b02';
const callA = '7a33ac96-d87d-4ca4-ab75-f27e40e94c01';
const callA2 = '7a33ac96-d87d-4ca4-ab75-f27e40e94c02';
const callB = '7a33ac96-d87d-4ca4-ab75-f27e40e94c03';
const period = {
  key: '7d',
  from: '2026-11-15T17:00:00.000Z',
  to: '2026-11-22T17:00:00.000Z',
  timeZone: 'Asia/Bangkok',
};
const item = (
  interactionId: string,
  agent: { id: string; displayName: string },
  team: { id: string; name: string },
  disposition: string,
) => ({
  interactionId,
  agent,
  team,
  startedAt: '2026-11-20T07:00:00.000Z',
  endedAt: '2026-11-20T07:01:10.000Z',
  talkSeconds: 70,
  disposition,
  recordedAt: '2026-11-20T07:02:00.000Z',
  recordedAtSource: 'SERVER_COMMIT',
  legacy: false,
});
const A = { id: teamA, name: 'Customer Care' };
const B = { id: teamB, name: 'Sales' };
const agentOne = { id: agentA, displayName: 'สมชาย' };
const agentTwo = { id: agentA2, displayName: 'สมหญิง' };
const rows = [
  item(callA, agentOne, A, 'CUSTOMER_ASSISTED'),
  item(callA2, agentTwo, A, 'FOLLOW_UP_REQUIRED'),
  item(callB, { id: agentA, displayName: 'สมชาย' }, B, 'CUSTOMER_ASSISTED'),
];

async function harness(page: Page, role: 'supervisor' | 'admin') {
  const requests: string[] = [];
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/team-history/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/team-history/')[1];
    requests.push(`${path}?${url.searchParams.toString()}`);
    const teamId = url.searchParams.get('teamId') ?? (role === 'supervisor' ? teamA : null);
    const scoped = rows.filter((row) => !teamId || row.team.id === teamId);
    if (path === 'teams')
      return route.fulfill({
        json:
          role === 'admin'
            ? {
                allTeams: true,
                items: [
                  { ...A, isActive: true },
                  { ...B, isActive: false },
                ],
              }
            : { allTeams: false, items: [{ ...A, isActive: true }] },
      });
    if (path === 'summary') {
      const byAgent = [agentOne, agentTwo]
        .map((agent) => ({
          agent,
          completed: scoped.filter((row) => row.agent.id === agent.id).length,
          talk: { averageSeconds: 70, measuredCount: 1 },
        }))
        .filter((row) => row.completed);
      return route.fulfill({
        json: {
          teamId,
          period,
          completed: scoped.length,
          talk: { averageSeconds: 70, measuredCount: scoped.length },
          byDisposition: ['CUSTOMER_ASSISTED', 'FOLLOW_UP_REQUIRED']
            .map((disposition) => ({
              disposition,
              count: scoped.filter((row) => row.disposition === disposition).length,
            }))
            .filter((group) => group.count),
          byAgent,
        },
      });
    }
    if (path === 'items') {
      const agentId = url.searchParams.get('agentId');
      const disposition = url.searchParams.get('disposition');
      return route.fulfill({
        json: {
          teamId,
          items: scoped.filter(
            (row) =>
              (!agentId || row.agent.id === agentId) &&
              (!disposition || row.disposition === disposition),
          ),
          nextCursor: null,
        },
      });
    }
    if (path === `items/${callA2}`)
      return route.fulfill({
        json: { ...rows[1], talkSeconds: 125, note: 'ลูกค้าขอให้โทรกลับพรุ่งนี้\nก่อน 10 โมง' },
      });
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
  return requests;
}

test('a Supervisor sees their own team summary, presses an Agent number, and sees the source list and notes', async ({
  page,
}) => {
  const requests = await harness(page, 'supervisor');
  await page.goto('/?view=team-history&tenant=demo');
  await expect(page.getByRole('heading', { name: 'ประวัติงานของทีม', level: 1 })).toBeVisible();
  await expect(page.getByText('Customer Care', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'ทีม' })).toHaveCount(0);
  const summary = page.getByRole('region', { name: 'สรุปงานของทีม' });
  await expect(summary.getByRole('button', { name: 'แสดงงานที่จบทั้งหมด 2 งาน' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'รายการงานของทีม' }).getByRole('row')).toHaveCount(3);
  await summary.getByRole('button', { name: /^สมหญิง: 1 งาน/ }).click();
  await expect(summary.getByRole('button', { name: /^สมหญิง: 1 งาน/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { name: /สมหญิง · ทุกผลบันทึก · 1 งาน/ })).toBeVisible();
  await expect
    .poll(() => requests.some((request) => request.includes(`agentId=${agentA2}`)))
    .toBe(true);
  await expect(page).toHaveURL(new RegExp(`agent=${agentA2}`));
  await page.getByRole('button', { name: `เปิดงาน ${callA2} ของ สมหญิง` }).click();
  await expect(page.getByRole('heading', { name: 'ผลที่บันทึก' })).toBeVisible();
  await expect(page.getByText(/ลูกค้าขอให้โทรกลับพรุ่งนี้/)).toBeVisible();
  await expect(page.getByText('เวลาสนทนา: 2:05')).toBeVisible();
  await page.getByRole('button', { name: 'กลับรายการ' }).click();
  await expect(page.getByRole('heading', { name: /สมหญิง · ทุกผลบันทึก · 1 งาน/ })).toBeVisible();
  // both Agent and disposition selected: the summary has no count for this pair, so the list heading shows no count
  await summary.getByRole('button', { name: /^ต้องติดตามต่อ/ }).click();
  await expect(
    page.getByRole('heading', { name: 'รายการงาน · 7 วัน · สมหญิง · ต้องติดตามต่อ', exact: true }),
  ).toBeVisible();
  expect(requests.every((request) => !request.includes(`teamId=${teamB}`))).toBe(true);
});

test('an Admin views all teams then picks one at a time, and a disabled team can still be selected to view history', async ({
  page,
}) => {
  const requests = await harness(page, 'admin');
  await page.goto('/?view=team-history&tenant=demo');
  const summary = page.getByRole('region', { name: 'สรุปงานของทีม' });
  await expect(summary.getByRole('button', { name: 'แสดงงานที่จบทั้งหมด 3 งาน' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'ทีม' })).toBeVisible();
  await page.getByRole('button', { name: /ทีม/ }).first().click();
  await page.getByRole('option', { name: 'Sales (ปิดใช้งาน)' }).click();
  await expect(summary.getByRole('button', { name: 'แสดงงานที่จบทั้งหมด 1 งาน' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`team=${teamB}`));
  await expect(page.getByRole('columnheader', { name: 'ทีม' })).toHaveCount(0);
  expect(requests.some((request) => request.startsWith('summary') && request.includes(teamB))).toBe(
    true,
  );
});

test('the API rejects permission, then shows a message and a try-again button', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation**', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/team-history/**', (route) =>
    route.fulfill({ status: 403, json: { code: 'TEAM_HISTORY_ACCESS_DENIED' } }),
  );
  await page.goto('/?view=team-history&tenant=demo');
  await expect(page.getByRole('alert')).toContainText('ไม่มีสิทธิ์ดูประวัติของทีม');
  await expect(page.getByRole('button', { name: 'ลองอีกครั้ง' })).toBeVisible();
});

test('a failed team-list load shows a message instead of a page for the wrong role, and can retry', async ({
  page,
}) => {
  await harness(page, 'admin');
  let fail = true;
  await page.route('**/api/v1/team-history/teams', (route) =>
    fail
      ? route.fulfill({ status: 500, json: { code: 'INTERNAL' } })
      : route.fulfill({ json: { allTeams: true, items: [{ ...A, isActive: true }] } }),
  );
  await page.goto('/?view=team-history&tenant=demo');
  await expect(page.getByRole('alert')).toContainText('โหลดประวัติของทีมไม่สำเร็จ');
  await expect(page.getByText(/ซึ่งทีมของคุณรับ/)).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.getByText(/ของทุกทีม/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'สรุปงานของทีม' })).toBeVisible();
});
