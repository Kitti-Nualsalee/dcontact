import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import {
  ACCESS_TOKEN,
  DPHONE,
  dphoneFrame,
  HOST,
  ISSUER,
  messages,
  REFRESH_TOKEN,
  setup,
  signIn,
} from './embed-harness';

for (const receiptMode of ['committed', 'racing'] as const) {
  test(`V1 recovery ${receiptMode}: ส่ง activity ครั้งเดียวและไม่ส่ง note ออกไป CRM`, async ({
    page,
  }) => {
    const { server, frame } = await setup(page);
    const interactionId = '688c850d-5056-426f-9cb8-14af85521382';
    const note = 'โน้ตส่วนตัว <b>ไม่ส่งไป CRM</b>';
    let commandReads = 0;
    const result = {
      interactionId,
      state: 'COMPLETED',
      policyVersion: 1,
      disposition: 'CUSTOMER_ASSISTED',
      note,
      recordedAt: '2026-10-17T07:00:00.000Z',
      legacy: false,
    };
    await page.context().route(`${DPHONE}/api/v1/workspace/agent/snapshot`, (route) =>
      route.fulfill({
        json: {
          capabilities: { voiceWrapupV1: 1 },
          agent: { id: 'agent-embed', displayName: 'Agent', extension: '1000', state: 'ACW' },
          interaction:
            server.state === 'NONE'
              ? null
              : {
                  id: interactionId,
                  state: server.state,
                  voiceWrapupPolicy: 'VOICE_NOTE_V1',
                  direction: 'INBOUND',
                  version: '3',
                  caller: null,
                  queue: null,
                  offerExpiresAt: '2099-01-01T00:00:20.000Z',
                  answeredAt: null,
                  endedAt: null,
                },
        },
      }),
    );
    await page.context().route('**/wrapup-v1', async (route) => {
      server.state = 'NONE';
      await route.abort('connectionreset');
    });
    await page.context().route('**/wrapup-result', (route) => route.fulfill({ json: result }));
    await page.context().route('**/wrapup-commands/*', (route) => {
      commandReads += 1;
      if (receiptMode === 'racing' && commandReads === 1)
        return route.fulfill({ status: 404, json: { code: 'COMMAND_NOT_FOUND' } });
      return route.fulfill({
        json: {
          status: 'COMMITTED',
          result: {
            interactionId,
            state: 'COMPLETED',
            policyVersion: 1,
            disposition: result.disposition,
            recordedAt: result.recordedAt,
          },
        },
      });
    });
    await signIn(page, frame);
    await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
    const dphone = frame.getByRole('region', { name: 'dphone' });
    await dphone.getByRole('button', { name: 'รับสาย' }).click();
    server.state = 'WRAPUP';
    await dphone.getByRole('button', { name: 'วางสาย' }).click();
    await frame.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
    await frame.getByRole('textbox', { name: 'โน้ตสรุป' }).fill(note);
    await frame.getByRole('button', { name: 'ส่ง disposition' }).click();
    await frame.getByRole('button', { name: 'ตรวจผลที่บันทึก' }).click();
    await expect(frame.getByRole('heading', { name: 'บันทึกผลแล้ว' })).toBeVisible();
    await expect(frame.getByText(note, { exact: true })).toBeVisible();
    await expect(frame.getByText('งานนี้ปิดด้วยคำสั่งอื่นแล้ว', { exact: false })).toHaveCount(0);
    await expect
      .poll(async () =>
        (await messages(page)).filter((message) => message.type === 'dphone.activity'),
      )
      .toHaveLength(1);
    expect(JSON.stringify(await messages(page))).not.toContain(note);
    expect(commandReads).toBe(receiptMode === 'racing' ? 2 : 1);
  });
}

/**
 * E1.14 (#488): dphone ที่ถูกฝังในหน้า host ต่าง origin — harness อยู่ใน `embed-harness.ts`
 */

test('origin ไม่อยู่ใน allowlist → dphone ไม่เริ่มทำงานและไม่ส่งข้อความหา host', async ({
  page,
}) => {
  const { frame } = await setup(page, { hostOrigin: 'https://evil.example.test' });
  await expect
    .poll(() => dphoneFrame(page)?.evaluate(() => document.documentElement.dataset.embedState))
    .toBe('blocked');
  await expect(frame.getByRole('button', { name: 'เข้าสู่ระบบ' })).toHaveCount(0);
  expect(await messages(page)).toEqual([]);
});

test('ฝังบน host: ready → popup login → lease embedded → สายเข้า screen-pop → รับสาย → wrap-up → activity + ack; token ไม่ออกนอก iframe', async ({
  page,
}) => {
  const { server, frame } = await setup(page);
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.ready',
      capabilities: { screenPop: true, clickToCall: true, activity: true },
      screenPopLevel: 'ids',
    });

  await signIn(page, frame);
  await expect
    .poll(() => server.leaseBodies)
    .toContainEqual({ surface: 'embedded', hostOrigin: HOST });

  // dphone ของ D1.15 ใน iframe — ตรวจอุปกรณ์เสียงแล้วสายที่ assign มาดังขึ้น
  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
  await expect
    .poll(async () => (await messages(page)).filter((m) => m.type === 'dphone.screenpop'))
    .toHaveLength(1);
  expect(server.screenPops[0]!.headers['x-work-session-lease-id']).toBe(server.lease);

  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const sipBefore = await dphoneFrame(page).evaluate(() => window.__dcontactDphone?.sipSessionId());

  // จบสาย → WRAPUP → บันทึก → activity ถึง host แล้ว host ack
  server.state = 'WRAPUP';
  await dphone.getByRole('button', { name: 'วางสาย' }).click();
  await frame.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
  await frame.getByRole('button', { name: 'ส่ง disposition' }).click();
  await expect
    .poll(async () => (await messages(page)).filter((m) => m.type === 'dphone.activity'))
    .toHaveLength(1);
  const [activity] = (await messages(page)).filter((m) => m.type === 'dphone.activity');
  expect(activity).toMatchObject({
    v: 1,
    interactionId: 'interaction-embed-1',
    disposition: 'CUSTOMER_ASSISTED',
  });
  expect(sipBefore).toMatch(/[0-9a-f-]{36}/);
  // ack แล้วคิวว่าง (sessionStorage ของ iframe ไม่มีรายการค้าง)
  await expect
    .poll(() =>
      dphoneFrame(page).evaluate(() => sessionStorage.getItem('dphone.embed.activity.demo')),
    )
    .toBeNull();

  // token ไม่ปรากฏใน host: postMessage, DOM, URL และ storage ของ host
  const hostSurface = await page.evaluate(() =>
    JSON.stringify({
      messages: (window as unknown as { __messages: unknown[] }).__messages,
      html: document.documentElement.outerHTML,
      url: location.href,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(hostSurface.includes(ACCESS_TOKEN)).toBe(false);
  expect(hostSurface.includes(REFRESH_TOKEN)).toBe(false);
  expect(server.authorization).toEqual(new Set([`Bearer ${ACCESS_TOKEN}`]));
});

test('click-to-call: host กรอกเบอร์ได้อย่างเดียว; agent กดโทร → ผลของ Governance ถึง host; ข้อความผิด origin/version ถูกจัดการ', async ({
  page,
}) => {
  const { server, frame } = await setup(page);
  await signIn(page, frame);
  await expect.poll(() => server.lease).toBeTruthy();
  await expect
    .poll(() => messages(page))
    .toContainEqual(expect.objectContaining({ type: 'dphone.screenpop' }));

  // host ขอโทรพร้อม field ที่พยายามสั่งโทรเอง → ได้แค่ prefilled ไม่มีการเรียก server
  await page.evaluate(() =>
    (window as unknown as { __send(m: unknown): void }).__send({
      v: 1,
      type: 'dphone.call',
      requestId: 'host-req-1',
      number: '081-234-5678',
      autoDial: true,
    }),
  );
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.call.result',
      requestId: 'host-req-1',
      status: 'prefilled',
      blocked: false,
    });
  expect(server.clickToCalls).toHaveLength(0);
  const prompt = frame.getByRole('region', { name: 'โทรออกจากระบบที่ฝัง' });
  await expect(prompt.getByText('081-234-5678')).toBeVisible();

  await prompt.getByRole('button', { name: 'โทร', exact: true }).click();
  await expect
    .poll(() => messages(page))
    .toContainEqual(
      expect.objectContaining({
        requestId: 'host-req-1',
        status: 'blocked',
        reasonCode: 'QUIET_HOURS',
      }),
    );
  expect(server.clickToCalls[0]!.headers['x-work-session-lease-id']).toBe(server.lease);
  await expect(prompt.getByText('โทรออกไม่ได้ตามกติกาการติดต่อลูกค้า')).toBeVisible();

  // v ที่ไม่รองรับ → unsupported_version
  await page.evaluate(() =>
    (window as unknown as { __send(m: unknown): void }).__send({
      v: 2,
      type: 'dphone.call',
      requestId: 'host-req-2',
      number: '0812345678',
    }),
  );
  await expect
    .poll(() => messages(page))
    .toContainEqual({
      v: 1,
      type: 'dphone.error',
      code: 'unsupported_version',
      supportedVersions: [1],
      requestId: 'host-req-2',
    });
});

test('refresh token ใช้ไม่ได้ระหว่างสาย (revoke/reuse) → ขึ้นแถบให้ login ใหม่ แต่สายและ SIP session เดิมไม่หลุด; axe ไม่มี serious/critical', async ({
  page,
}) => {
  const { frame } = await setup(page);
  await signIn(page, frame);
  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const embed = dphoneFrame(page);
  const sipBefore = await embed.evaluate(() => window.__dcontactDphone?.sipSessionId());

  // Keycloak ปฏิเสธ refresh token (admin revoke / reuse / session cap) แล้วสั่ง refresh ทันที
  await page.context().unroute(`${ISSUER}/protocol/openid-connect/token`);
  await page.context().route(`${ISSUER}/protocol/openid-connect/token`, (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'invalid_grant' },
      headers: { 'access-control-allow-origin': DPHONE },
    }),
  );
  await embed.evaluate(() => window.__dphoneEmbed?.auth?.refresh());
  await expect(frame.getByText('การเข้าสู่ระบบหมดอายุ สายที่คุยอยู่ยังไม่หลุด')).toBeVisible();
  await expect(frame.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  expect(await embed.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(sipBefore);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => v.id),
  ).toEqual([]);
});

test('ลบ origin ระหว่างสาย → หยุดช่องทาง host ทันที แต่สายและ SIP session เดิมไม่หลุด', async ({
  page,
}) => {
  const { server, frame } = await setup(page);
  await signIn(page, frame);
  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  const embed = dphoneFrame(page);
  const sipBefore = await embed.evaluate(() => window.__dcontactDphone?.sipSessionId());
  const messageCountBefore = (await messages(page)).length;

  server.sendWorkspaceEvent?.({ type: 'embed.origin.revoked', origin: HOST });
  await expect.poll(() => embed.evaluate(() => window.__dphoneEmbed?.lock.revoked)).toBe(true);
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  expect(await embed.evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(sipBefore);

  await page.evaluate(() =>
    (window as unknown as { __send(message: unknown): void }).__send({
      v: 1,
      type: 'dphone.call',
      requestId: 'revoked-origin-call',
      number: '0812345678',
    }),
  );
  await page.waitForTimeout(100);
  expect(await messages(page)).toHaveLength(messageCountBefore);
  expect(server.clickToCalls).toHaveLength(0);
});
