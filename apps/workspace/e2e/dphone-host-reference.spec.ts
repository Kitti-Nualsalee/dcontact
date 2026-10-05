import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { ACCESS_TOKEN, DPHONE, dphoneFrame, REFRESH_TOKEN, setup, signIn } from './embed-harness';

/**
 * E1.15 (#489): host อ้างอิง (`examples/dphone-host/index.html`) + `<dphone-launcher>` จาก release ใน repo
 * — หลักฐานก่อนเลื่อน alias: ครบ 4 ความสามารถผ่าน launcher (รับสาย, screen-pop, activity, click-to-call)
 */
const reference = readFileSync(
  fileURLToPath(new URL('../../../examples/dphone-host/index.html', import.meta.url)),
  'utf8',
);
const hostHtml = (launcherVersion: string) => () =>
  reference
    .replaceAll("'DPHONE_ORIGIN'", `'${DPHONE}'`)
    .replaceAll('/embed/v1/dphone-launcher.js', `/embed/${launcherVersion}/dphone-launcher.js`)
    .replaceAll('TENANT', 'demo');

for (const version of ['v1', 'v1.0.1']) {
  test(`host อ้างอิง + launcher ${version}: ready → login → screen-pop → รับสาย → activity (ack อัตโนมัติ) → click-to-call`, async ({
    page,
  }) => {
    const { server, frame } = await setup(page, { hostHtml: hostHtml(version), path: '/' });
    await expect(page.locator('body')).toHaveAttribute('data-dphone-ready', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-screen-pop-level', 'ids');

    await signIn(page, frame);
    await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
    const dphone = frame.getByRole('region', { name: 'dphone' });
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
    await expect(page.locator('#screenpop')).toContainText(
      '"interactionId": "interaction-embed-1"',
    );
    await expect(page.locator('#screenpop')).toContainText('"level": "ids"');

    await dphone.getByRole('button', { name: 'รับสาย' }).click();
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
    const sipBeforeReload = await dphoneFrame(page).evaluate(() =>
      window.__dcontactDphone?.sipSessionId(),
    );
    await page.evaluate(
      ({ origin }) => {
        const iframe = document.querySelector('dphone-launcher iframe') as HTMLIFrameElement;
        window.dispatchEvent(
          new MessageEvent('message', {
            origin,
            source: iframe.contentWindow,
            data: {
              v: 1,
              type: 'dphone.screenpop',
              requestId: 'active-call-reload-guard',
              level: 'ids',
              interactionId: 'interaction-embed-1',
              policyVersion: 'e1.screen-pop.disclosure/v1',
              decisionId: 'dec-reload-guard',
              callState: 'ACTIVE',
            },
          }),
        );
      },
      { origin: DPHONE },
    );
    const reloadGuard = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return { dispatched: window.dispatchEvent(event), prevented: event.defaultPrevented };
    });
    expect(reloadGuard).toEqual({ dispatched: false, prevented: true });
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
    expect(await dphoneFrame(page).evaluate(() => window.__dcontactDphone?.sipSessionId())).toBe(
      sipBeforeReload,
    );
    server.state = 'WRAPUP';
    await dphone.getByRole('button', { name: 'วางสาย' }).click();
    await frame.getByRole('button', { name: 'ลูกค้าได้รับความช่วยเหลือ' }).click();
    await frame.getByRole('button', { name: 'ส่ง disposition' }).click();
    await expect(page.locator('#activities li')).toHaveText([
      'interaction-embed-1 · CUSTOMER_ASSISTED · 120 วินาที',
    ]);
    // launcher ack ให้แล้ว → คิวใน iframe ว่าง (ไม่ส่งซ้ำ)
    await expect
      .poll(() =>
        dphoneFrame(page).evaluate(() => sessionStorage.getItem('dphone.embed.activity.demo')),
      )
      .toBeNull();

    // click-to-call: host ส่งเบอร์ได้อย่างเดียว agent ต้องกดโทรเอง
    await page.getByLabel('เบอร์โทร').fill('081-234-5678');
    await page.getByRole('button', { name: 'ส่งเบอร์ให้ dphone' }).click();
    await expect(page.locator('#call-result')).toHaveText(
      'ส่งเบอร์ให้ dphone แล้ว — รอ agent กดโทร',
    );
    expect(server.clickToCalls).toHaveLength(0);
    const prompt = frame.getByRole('region', { name: 'โทรออกจากระบบที่ฝัง' });
    await prompt.getByRole('button', { name: 'โทร', exact: true }).click();
    await expect(page.locator('#call-result')).toHaveText('ผล: blocked (QUIET_HOURS)');

    const html = await page.content();
    expect(html.includes(ACCESS_TOKEN) || html.includes(REFRESH_TOKEN)).toBe(false);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => v.id),
    ).toEqual([]);
  });
}
