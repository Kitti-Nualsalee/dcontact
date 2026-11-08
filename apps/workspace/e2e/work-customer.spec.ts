import { expect, test, type Page } from '@playwright/test';
const workId = '11111111-1111-4111-8111-111111111111';
const contactId = '44444444-4444-4444-8444-444444444444';
const linked = () => ({
  interactionId: workId,
  state: 'LINKED',
  linkageRevision: '1',
  contact: { id: contactId, displayName: 'ลูกค้าทดสอบงาน', company: 'บริษัททดสอบ' },
  revisions: { profile: '0', tag: '0', lineage: '0' },
  canEdit: true,
  canLink: true,
  identity: 'ACTIVE',
});
async function fixture(
  page: Page,
  options: { unknown?: boolean; unlinked?: boolean; pending?: boolean } = {},
) {
  let view: Record<string, unknown> = options.unlinked
    ? { interactionId: workId, state: 'UNLINKED', linkageRevision: '0', canLink: true }
    : linked();
  let command: Record<string, unknown> | undefined;
  let mutations = 0;
  await page.route('**/api/v1/customer-360/work/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.includes('22222222'))
      return route.fulfill({
        json: {
          interactionId: '22222222-2222-4222-8222-222222222222',
          state: 'UNLINKED',
          linkageRevision: '0',
          canLink: true,
        },
      });
    if (path.endsWith('/reauthenticate')) return route.fulfill({ json: { state: 'ACTIVE' } });
    if (path.includes('/candidates/search'))
      return route.fulfill({
        json: {
          items: [
            {
              candidateRef: 'opaque-reference',
              displayName: 'ลูกค้าจากผลค้นหา',
              company: 'บริษัทเลือก',
              matchingChannel: '•••11',
            },
          ],
          nextCursor: null,
          verified: false,
        },
      });
    if (path.includes('/commands/') && options.pending && method === 'GET')
      return route.fulfill({ json: { state: 'PENDING', commandId: command?.commandId } });
    if (path.includes('/commands/')) return route.fulfill({ json: { state: 'TERMINAL', command } });
    if (method === 'PATCH' || path.endsWith('/customer-link')) {
      mutations++;
      const body = route.request().postDataJSON();
      if (options.pending) {
        command = {
          commandId: body.commandId,
          outcome: 'REJECTED',
          code: 'COMMAND_NOT_APPLIED',
          committedRevisions: {},
        };
        return route.abort('failed');
      }
      view = path.endsWith('/customer-link')
        ? {
            ...linked(),
            contact: { id: contactId, displayName: 'ลูกค้าจากผลค้นหา', company: 'บริษัทเลือก' },
          }
        : {
            ...view,
            contact: { id: contactId, displayName: body.displayName, company: body.company },
            revisions: { profile: '1', tag: '0', lineage: '0' },
          };
      command = {
        commandId: body.commandId,
        outcome: 'APPLIED',
        code: null,
        committedRevisions: path.endsWith('/customer-link') ? { linkage: '1' } : { profile: '1' },
      };
      if (options.unknown) return route.abort('failed');
      return route.fulfill({ json: { state: 'TERMINAL', command } });
    }
    return route.fulfill({ json: view });
  });
  await page.goto('/?view=customer-trial');
  return { mutations: () => mutations };
}
async function privateDraft(page: Page, value: string) {
  expect(decodeURIComponent(page.url())).not.toContain(value);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    value,
  );
}
test('เลือก candidate เองโดยไม่ auto-link แม้มีหนึ่งรายการและอ่านกลับก่อน success', async ({
  page,
}) => {
  const f = await fixture(page, { unlinked: true });
  await expect(page.getByText('งานนี้ยังไม่เชื่อมกับลูกค้า')).toBeVisible();
  await page.getByLabel('เบอร์โทรศัพท์สากลหรืออีเมลเต็มค่า').fill('+6621234511');
  await page.getByRole('button', { name: 'ค้นหาลูกค้าสำหรับงานนี้' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'รายการที่พบยังไม่ใช่การยืนยันตัวบุคคล' }),
  ).toBeVisible();
  expect(f.mutations()).toBe(0);
  await page.getByRole('button', { name: 'เลือกเชื่อมลูกค้า' }).click();
  await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click();
  await expect(page.getByText('บันทึกและอ่านข้อมูลปัจจุบันกลับแล้ว')).toBeVisible();
  expect(f.mutations()).toBe(1);
  await privateDraft(page, '+6621234511');
});
test('ร่างอยู่ memory และพักเมื่อsessionหาย กู้เฉพาะงานเดิมโดยไม่สร้าง Voice controls', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: 'แก้ชื่อและบริษัท' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างส่วนตัว');
  await privateDraft(page, 'ร่างส่วนตัว');
  await page.getByRole('button', { name: 'Pause fixture' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
  await expect(page.getByText('ลูกค้าทดสอบงาน', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume fixture' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างส่วนตัว');
  await page.getByRole('button', { name: 'Switch work fixture' }).click();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveCount(0);
  await expect(page.getByText('งานนี้ยังไม่เชื่อมกับลูกค้า')).toBeVisible();
});
test('responseหายหลังบันทึก ใช้commandเดิมตรวจผล ไม่สร้าง effectซ้ำ', async ({ page }) => {
  const f = await fixture(page, { unknown: true });
  await page.getByRole('button', { name: 'แก้ชื่อและบริษัท' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่าง unknown');
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม' })).toBeVisible();
  await privateDraft(page, 'ร่าง unknown');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม' }).click();
  await expect(page.getByText('บันทึกและอ่านข้อมูลปัจจุบันกลับแล้ว')).toBeVisible();
  expect(f.mutations()).toBe(1);
});
test('ถอดหรือเปลี่ยนลูกค้าต้องยืนยันพร้อมเหตุผลและจอ768ไม่ล้น', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole('button', { name: 'ถอดการเชื่อมลูกค้า', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ยืนยัน', exact: true })).toBeDisabled();
  await page.getByLabel('เหตุผล (ไม่ใส่ข้อมูลส่วนบุคคล)').fill('เลือกผิดรายการ');
  await expect(page.getByRole('button', { name: 'ยืนยัน', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('admissionค้างแต่ไม่มีeffect ต้องreconcile PENDINGให้NOT_APPLIEDก่อนเริ่มใหม่', async ({
  page,
}) => {
  await fixture(page, { pending: true });
  await page.getByRole('button', { name: 'แก้ชื่อและบริษัท' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill('ร่างที่ยังไม่บันทึก');
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await page.getByRole('button', { name: 'ตรวจผลคำสั่งเดิม' }).click();
  await expect(page.getByText('คำสั่งเดิมไม่มีผลบันทึก ตรวจร่างก่อนส่งใหม่')).toBeVisible();
  await expect(page.getByLabel('ชื่อลูกค้า')).toHaveValue('ร่างที่ยังไม่บันทึก');
  await expect(page.getByRole('button', { name: 'บันทึกลูกค้า' })).toBeEnabled();
});
