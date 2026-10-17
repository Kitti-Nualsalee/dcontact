import { expect, test } from '@playwright/test';

for (const outcome of ['success', 'unknown'] as const) {
  test(`V1 ${outcome}: แสดงผลที่ commit แล้วแม้ snapshot หลังบันทึกอ่านไม่ได้`, async ({
    page,
  }) => {
    let saved = false;
    let submitted: Record<string, unknown> | undefined;
    const attempts: Record<string, unknown>[] = [];
    const interactionId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
    await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
      route.fulfill({
        status: saved ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify({
          capabilities: { voiceWrapupV1: 1 },
          agent: { id: 'agent', displayName: 'Agent', extension: '1000', state: 'ACW' },
          interaction: {
            id: interactionId,
            state: 'WRAPUP',
            direction: 'INBOUND',
            voiceWrapupPolicy: 'VOICE_NOTE_V1',
            version: '20',
            caller: null,
            queue: null,
            offerExpiresAt: null,
            answeredAt: null,
            endedAt: null,
          },
        }),
      }),
    );
    await page.route('**/wrapup-v1', async (route) => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      attempts.push(submitted);
      saved = true;
      if (outcome === 'unknown' && attempts.length === 1) {
        await route.abort('connectionreset');
        return;
      }
      if (outcome === 'unknown' && attempts.length === 2) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAUTHORIZED' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          interactionId,
          policyVersion: 1,
          state: 'COMPLETED',
          disposition: 'CUSTOMER_ASSISTED',
          note: 'ทดสอบ 😀\nplain text',
          recordedAt: '2026-10-17T07:00:00.000Z',
          legacy: false,
        }),
      });
    });
    await page.route('**/wrapup-result', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'RESULT_NOT_COMMITTED' }),
      }),
    );
    await page.route('**/wrapup-commands/*', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'COMMAND_NOT_FOUND' }),
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
    await expect(page.getByRole('button', { name: 'ส่ง disposition' })).toBeDisabled();
    await page.getByRole('textbox', { name: 'โน้ตสรุป' }).fill('😀'.repeat(2001));
    await expect(page.getByRole('button', { name: 'ส่ง disposition' })).toBeDisabled();
    await page.getByRole('textbox', { name: 'โน้ตสรุป' }).fill('  ทดสอบ 😀\r\nplain text  ');
    await page.getByRole('button', { name: 'ส่ง disposition' }).click();
    if (outcome === 'unknown') {
      await expect(page.getByText(/ยังไม่ทราบผลบันทึก/)).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toBeDisabled();
      await page.getByRole('button', { name: 'ตรวจผลที่บันทึก' }).click();
      await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toBeDisabled();
      await page.getByRole('button', { name: 'ส่ง disposition' }).click();
      await expect(page.getByText(/ยังไม่ทราบผลบันทึก/)).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toBeDisabled();
      await page.getByRole('button', { name: 'ส่ง disposition' }).click();
    }
    await expect(page.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
    const history = page.getByRole('link', { name: 'เปิดผลในประวัติงาน (แท็บใหม่)' });
    await expect(history).toHaveAttribute('target', '_blank');
    const historyUrl = new URL((await history.getAttribute('href'))!);
    expect(historyUrl.searchParams.get('interaction')).toBe(interactionId);
    expect(historyUrl.searchParams.get('view')).toBe('agent-history');
    expect([...historyUrl.searchParams.keys()].sort()).toEqual(['interaction', 'tenant', 'view']);
    if (outcome === 'success') {
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await page
        .context()
        .route(`${historyUrl.origin}/**`, (route) =>
          route.fulfill({ contentType: 'text/html', body: '<p>History destination fixture</p>' }),
        );
      const opened = page.waitForEvent('popup');
      await history.click();
      const resultPage = await opened;
      await expect(resultPage.getByText('History destination fixture')).toBeVisible();
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      await resultPage.close();
    }
    await expect(page.getByText('ทดสอบ 😀\nplain text', { exact: true })).toBeVisible();
    expect(submitted).toMatchObject({
      disposition: 'CUSTOMER_ASSISTED',
      note: 'ทดสอบ 😀\nplain text',
    });
    expect(submitted?.commandId).toEqual(expect.any(String));
    if (outcome === 'unknown') {
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[2]).toEqual(attempts[0]);
    }
    await expect(page.getByRole('textbox', { name: 'โน้ตสรุป' })).toHaveCount(0);
  });
}

test('Agent ส่ง disposition จาก WRAPUP และรอ authoritative snapshot', async ({ page }) => {
  let completed = false;
  let requestBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: completed ? 'AVAILABLE' : 'ACW',
        },
        interaction: completed
          ? null
          : {
              id: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
              state: 'WRAPUP',
              version: '19',
              caller: '081-234-5678',
              queue: { id: 'queue-service', name: 'บริการลูกค้า' },
              offerExpiresAt: null,
              answeredAt: '2026-09-06T10:00:00.000Z',
              endedAt: '2026-09-06T10:03:00.000Z',
            },
      }),
    }),
  );
  await page.route('**/wrapup', async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    completed = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        interactionId: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
        state: 'COMPLETED',
        disposition: 'CUSTOMER_ASSISTED',
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'สรุปผลหลังสาย' })).toBeVisible();
  await page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).focus();
  await expect(page.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'ส่ง disposition' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'สรุปผลหลังสาย' })).toHaveCount(0);
  expect(requestBody).toMatchObject({ disposition: 'CUSTOMER_ASSISTED' });
  expect(requestBody?.commandId).toEqual(expect.any(String));
});
