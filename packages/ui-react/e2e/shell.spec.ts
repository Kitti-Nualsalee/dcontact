import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * D1.13 (#452) acceptance: axe 0 serious/critical, keyboard ของ rail/launcher และไม่มี PII ใน URL ข้ามแอป
 * หน้า `?view=shell` ใช้ Navigation API จำลอง (maxPins = 3) ผ่าน `useShellNavigation`
 */
async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
}

const rail = (page: Page) => page.getByRole('navigation', { name: /เมนูหลัก|Main navigation/ });

for (const lang of ['th', 'en'] as const) {
  test(`axe: shell 0 serious/critical (${lang}) ทั้งปกติและตอนเปิด launcher`, async ({ page }) => {
    await page.goto(`/?view=shell&lang=${lang}`);
    await expect(rail(page)).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.getByRole('button', { name: lang === 'th' ? 'แอปทั้งหมด' : 'All apps' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('rail: หมุดตามลำดับ, หน้าปัจจุบันมี aria-current, แอปอีกฝั่งเปิดแท็บใหม่ด้วย path + tenant เท่านั้น', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const links = rail(page).getByRole('link');
  await expect(links).toHaveCount(3); // กล่องงาน, Journeys, ตั้งค่า
  const inbox = rail(page).getByRole('link', { name: /กล่องงาน/ });
  await expect(inbox).toHaveAttribute('target', '_blank');
  await expect(inbox).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(inbox).toHaveAttribute('href', 'https://workspace.example/?tenant=demo');
  await expect(inbox).toHaveAccessibleName(/เปิดในแท็บใหม่/);
  const journeys = rail(page).getByRole('link', { name: 'Journeys' });
  await expect(journeys).toHaveAttribute('aria-current', 'page');
  await expect(journeys).toHaveAttribute('href', '/?view=journeys&tenant=demo');
  await expect(journeys).not.toHaveAttribute('target', /.*/);
});

test('keyboard: skip link พาไปที่เนื้อหา', async ({ page }) => {
  await page.goto('/?view=shell');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'ข้ามไปที่เนื้อหา' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dc-main')).toBeFocused();
});

test('keyboard: เปิด launcher ด้วย Enter, focus ที่ช่องค้นหา, ค้นหาได้, Esc ปิดแล้ว focus กลับที่ปุ่ม', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const trigger = page.getByRole('button', { name: 'แอปทั้งหมด' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'แอป D-Contact' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('searchbox')).toBeFocused();

  await page.keyboard.type('gov');
  await expect(dialog.getByRole('link')).toHaveCount(2); // Governance + สร้าง Journey
  await expect(dialog.getByRole('link', { name: 'Governance' })).toBeVisible();
  await page.keyboard.type('zzz');
  await expect(dialog.getByRole('status').first()).toHaveText('ไม่พบแอปที่ตรงกับคำค้น');

  await page.keyboard.press('Escape'); // ล้างคำค้นหา
  await page.keyboard.press('Escape'); // ปิด launcher
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('keyboard: ปักหมุดด้วย Space → rail อัปเดต, PUT ส่ง expectedRevision และถึงเพดานแล้วปักเพิ่มไม่ได้', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  await page.getByRole('button', { name: 'แอปทั้งหมด' }).click();
  const pinGovernance = page.getByRole('button', { name: 'ปักหมุด Governance' });
  await pinGovernance.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'เลิกปักหมุด Governance' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toBeVisible();

  const put = await page.evaluate(() =>
    (
      window as unknown as { __navRequests: { method: string; body: unknown }[] }
    ).__navRequests.filter((r) => r.method === 'PUT'),
  );
  expect(put).toEqual([
    {
      url: 'https://api.example/api/v1/me/navigation/pins',
      method: 'PUT',
      body: { appIds: ['agent-workspace', 'journeys', 'contact-governance'], expectedRevision: 0 },
    },
  ]);

  // เพดาน 3 (mock) — แอปที่ยังไม่ปักถูกปิดใช้ และมีข้อความบอกเหตุผล
  await expect(page.getByRole('button', { name: 'ปักหมุด ทีมสด' })).toBeDisabled();
  await expect(page.getByText('ปักหมุดได้สูงสุด 3 แอป')).toBeVisible();

  // เลิกปักด้วยคีย์บอร์ด → revision ถัดไป
  await page.getByRole('button', { name: 'เลิกปักหมุด Governance' }).focus();
  await page.keyboard.press('Space');
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toHaveCount(0);
  // PUT ถูกส่งทีละคำขอ — รอคำขอเลิกปักที่ต่อคิวหลังคำขอแรก แล้วต้องใช้ revision ถัดไป
  await expect
    .poll(() =>
      page.evaluate(() => {
        const all = (
          window as unknown as {
            __navRequests: { method: string; body: { expectedRevision: number } }[];
          }
        ).__navRequests;
        return all.filter((r) => r.method === 'PUT').at(-1)!.body.expectedRevision;
      }),
    )
    .toBe(1);
});

test('สลับภาษาในแถบบนเปลี่ยนป้ายของ rail/launcher ทันทีโดยไม่ reload', async ({ page }) => {
  await page.goto('/?view=shell');
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rail(page).getByRole('link', { name: /Inbox/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All apps' })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

test('กดปัก/เลิกปักหมุดติดกันเร็ว ๆ — คำขอถูกส่งทีละคำขอด้วย revision ล่าสุด ไม่ชนกันเองและไม่มีหมุดหาย', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  await page.getByRole('button', { name: 'แอปทั้งหมด' }).click();
  // สองคลิกติดกันระหว่างที่ PUT แรกยังไม่ตอบ (mock หน่วง 150ms)
  await page.getByRole('button', { name: 'ปักหมุด Governance', exact: true }).click();
  await page.getByRole('button', { name: 'เลิกปักหมุด Journeys', exact: true }).click();
  // launcher เป็น popover แบบ modal — ปิดก่อนตรวจ rail (ส่วนอื่นของหน้าถูกซ่อนจาก a11y tree ระหว่างเปิด)
  await page.keyboard.press('Escape');
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Journeys' })).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __navRequests: { method: string }[] }).__navRequests.filter(
            (r) => r.method === 'PUT',
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
  // รอให้คิวว่าง แล้วตรวจว่า server ได้ชุดสุดท้ายโดยไม่มี 409 ระหว่างทาง
  await page.waitForTimeout(300);
  const puts = await page.evaluate(() =>
    (
      window as unknown as {
        __navRequests: { method: string; body: { appIds: string[]; expectedRevision: number } }[];
      }
    ).__navRequests
      .filter((r) => r.method === 'PUT')
      .map((r) => r.body),
  );
  expect(puts.map((body) => body.expectedRevision)).toEqual(puts.map((_, index) => index));
  expect(puts.at(-1)!.appIds).toEqual(['agent-workspace', 'contact-governance']);
  // ไม่มี 409 → ไม่มีการโหลด navigation ใหม่หลัง PUT แรก
  const methods = await page.evaluate(() =>
    (window as unknown as { __navRequests: { method: string }[] }).__navRequests.map(
      (r) => r.method,
    ),
  );
  expect(methods.slice(methods.indexOf('PUT'))).not.toContain('GET');
});
