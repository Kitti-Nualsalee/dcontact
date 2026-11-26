import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

// D1.14 (#453): text comes from the catalog per the browser language — this suite checks the original J5 flow in Thai
test.use({ locale: 'th-TH' });

/**
 * J5.6 (#344): Journey authoring Console end-to-end
 *
 * Stateful mock of `/api/v1/journey-authoring/**` only (real CAS/revision) — the data is entirely synthetic
 * with no PII; a request going outside the Console origin counts as wrong
 */

import {
  JOURNEY_ID,
  NEW_JOURNEY_ID,
  REVIEW_ID,
  DIGEST,
  type Json,
  authoringDocument,
  AuthoringMock,
  withShell,
} from './support/journey-authoring-mock';

async function openEditor(page: Page, mock: AuthoringMock, journeyId = JOURNEY_ID) {
  await mock.install(page);
  await page.goto(`/?view=journeys&journey=${journeyId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes[0]?.target}`)).toEqual([]);
}

test.use({ viewport: { width: 1440, height: 1000 } });

test('keyboard-only authoring: add/configure/connect/reorder/delete, then save with CAS', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);

  // canvas: roving focus with arrows, Enter selects → properties change accordingly
  const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
  await canvas.getByRole('button', { name: 'เริ่มเมื่อเกิด event' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(canvas.getByRole('button', { name: 'ส่งข้อความ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'ส่งข้อความ' })).toBeVisible();

  // outline: insert WAIT after SEND with ordinary controls
  const insertType = page.getByLabel('แทรกขั้นตอนหลัง ถัดไป').first();
  await insertType.selectOption('WAIT');
  await insertType.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(canvas.getByRole('button', { name: 'รอ' })).toBeVisible();
  await expect(page.getByLabel('ถัดไป ของ รอ ไปที่')).toHaveValue('done');

  // properties: commit on Enter
  const wait = page.getByLabel('ระยะเวลารอ (วินาที)');
  await wait.fill('600');
  await wait.press('Enter');
  const label = page.getByLabel('ชื่อที่แสดง');
  await label.fill('รอชำระ 10 นาที');
  await label.press('Enter');
  await expect(canvas.getByRole('button', { name: 'รอชำระ 10 นาที' })).toBeVisible();

  // reorder + move position with Shift+arrow (visual-only)
  await page.getByRole('button', { name: 'เลื่อนขึ้น รอชำระ 10 นาที' }).press('Enter');
  await canvas.getByRole('button', { name: 'รอชำระ 10 นาที' }).focus();
  await page.keyboard.press('Shift+ArrowRight');

  // delete then undo with a keyboard shortcut
  await page.getByRole('button', { name: 'ลบ จบ Journey' }).press('Enter');
  await expect(canvas.getByRole('button', { name: 'จบ Journey' })).toHaveCount(0);
  await canvas.getByRole('button', { name: 'รอชำระ 10 นาที' }).focus();
  await page.keyboard.press('Control+z');
  await expect(canvas.getByRole('button', { name: 'จบ Journey' })).toBeVisible();

  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'บันทึกเป็น revision 2 แล้ว' }),
  ).toBeVisible();

  const put = mock.requests.find((request) => request.method() === 'PUT')!;
  const body = put.postDataJSON() as Json;
  expect(body).toMatchObject({
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: DIGEST('1'),
  });
  expect(put.headers()['idempotency-key']).toMatch(/^draft-/);
  const nodes = (body.document as { nodes: Json[] }).nodes;
  const saved = nodes.find((node) => node.type === 'WAIT')!;
  expect(saved).toMatchObject({ label: 'รอชำระ 10 นาที', config: { waitSeconds: 600 } });
  // reorder puts WAIT before SEND in the document; layout changes only the position
  expect(nodes.map((node) => node.type)).toEqual(['SEND', 'WAIT', 'EXIT']);
  expect(Object.keys((body.document as { layout: { nodes: Json } }).layout.nodes)).toContain(
    String(saved.nodeId),
  );
});

test('diagnostics link back to the node and validate uses the saved revision; dialog traps focus and Esc returns focus', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  await page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'server พบข้อผิดพลาด 1 รายการ' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'ไปที่ ส่งข้อความ' }).press('Enter');
  await expect(page.getByRole('button', { name: 'ส่งข้อความ มีปัญหา 1 รายการ' })).toBeFocused();

  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'ส่งตรวจ' }).click();
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ยืนยันอนุมัติ' });
  await expect(dialog.getByLabel('Reason code')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'ยกเลิก' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toBeFocused();
});

test('409 opens compare/reload/keep-copy and keep-copy saves on the latest revision', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  const exitReason = page.getByLabel('Event ที่ถือว่าบรรลุเป้าหมาย');
  await exitReason.fill('invoice.settled');
  await exitReason.press('Enter');
  mock.concurrentEdit = true;
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  const conflict = page.getByRole('alert').filter({ hasText: 'ฉบับร่างถูกแก้โดยผู้อื่น' });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('revision 2');
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeDisabled();

  await conflict.getByRole('button', { name: 'ใช้การแก้ของฉันต่อบนฉบับล่าสุด' }).click();
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'บันทึกเป็น revision 3 แล้ว' }),
  ).toBeVisible();
  const puts = mock.requests.filter((request) => request.method() === 'PUT');
  expect(puts).toHaveLength(2);
  expect(puts[1]!.postDataJSON()).toMatchObject({ expectedDraftRevision: 2 });
  expect(
    (puts[1]!.postDataJSON() as { document: { settings: Json } }).document.settings,
  ).toMatchObject({
    purpose: 'MARKETING',
    goal: { eventType: 'invoice.settled' },
  });
});

test('tab session recovery: reload restores unsaved edits', async ({ page }) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  const name = page.getByLabel('ชื่อ Journey');
  await name.fill('ชื่อใหม่ก่อน reload');
  await name.press('Enter');
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'กู้คืนการแก้ไข' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ชื่อใหม่ก่อน reload' })).toBeVisible();
  expect(mock.mutations()).toHaveLength(0);
});

test('publish with an unknown result (202) must resolve with the same key and not show success before the result is known', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  const journey = mock.journeys.get(JOURNEY_ID)!;
  journey.review = {
    reviewId: REVIEW_ID,
    state: 'APPROVED',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: false,
  };
  mock.publishUnknown = true;
  await openEditor(page, mock);
  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /ยืนยัน publish version 1/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'ยืนยัน Publish' }).click();
  await expect(page.getByText('ยังไม่ทราบผล publish')).toBeVisible();
  await expect(page.getByText('Publish version 1 สำเร็จ')).toHaveCount(0);

  await page.getByRole('button', { name: 'ตรวจผล publish' }).click();
  await expect(page.getByText('Publish version 1 สำเร็จ')).toBeVisible();
  const publish = mock.requests.filter((request) =>
    new URL(request.url()).pathname.endsWith('/publish'),
  );
  const resolution = mock.requests.find((request) =>
    request.url().endsWith('/publish-resolution'),
  )!;
  expect(publish).toHaveLength(1);
  expect(resolution.postDataJSON()).toEqual({
    originalIdempotencyKey: publish[0]!.headers()['idempotency-key'],
  });
});

test('templates: instantiate with the version+digest being viewed, then upgrade must choose a resolution before apply', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await mock.install(page);
  await page.goto('/?view=journeys');
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'payment-reminder' }).click();
  const form = page.getByRole('form', { name: 'สร้าง Journey จาก payment-reminder' });
  await form.getByLabel('ชื่อ Journey').fill('เตือนชำระ Q4');
  await form.getByLabel('ทีมเจ้าของ (team ID)').fill('team-synthetic');
  await form.getByLabel('reminderContent *').fill('content-q4');
  await form.getByRole('button', { name: 'สร้าง Journey จาก template' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'เตือนชำระ Q4' })).toBeVisible();
  const instantiate = mock.requests.find((request) => request.url().endsWith('/instantiate'))!;
  expect(instantiate.postDataJSON()).toEqual({
    expectedContentDigest: DIGEST('c'),
    bindings: { reminderContent: 'content-q4' },
    targetOwnerTeamId: 'team-synthetic',
    name: 'เตือนชำระ Q4',
  });
  // parameter values are not stored in the browser storage
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain('content-q4');

  await expect(page.getByText('มี template version 2')).toBeVisible();
  await page.getByRole('button', { name: 'ตรวจการ upgrade' }).click();
  const apply = page.getByRole('button', { name: 'ปรับฉบับร่างตาม proposal' });
  await expect(apply).toBeDisabled();
  await page.getByLabel('ใช้ของ template').check();
  await apply.click();
  await expect(
    page.getByText('ปรับเป็น template version 2 ในฉบับร่างแล้ว ยังไม่ publish'),
  ).toBeVisible();
  const upgrade = mock.requests.find((request) => request.url().endsWith('/template-upgrades'))!;
  expect(upgrade.postDataJSON()).toMatchObject({
    targetVersion: 2,
    proposalDigest: DIGEST('7'),
    conflictDigest: DIGEST('8'),
    resolutions: { c1: 'TAKE_TEMPLATE' },
  });
});

test('960px fully editable; 959px read-only and sends no mutation', async ({ page }) => {
  const mock = new AuthoringMock();
  await page.setViewportSize({ width: 960, height: 900 });
  await openEditor(page, mock);
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toBeVisible();

  await page.setViewportSize({ width: 959, height: 900 });
  await expect(page.getByRole('note').filter({ hasText: 'อ่านอย่างเดียว' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกฉบับร่าง' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^ลบ / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
  await canvas.getByRole('button', { name: 'ส่งข้อความ' }).focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(canvas.getByRole('button', { name: 'ส่งข้อความ' })).toBeVisible();
  await expect(page.getByText('มีการแก้ไขที่ยังไม่บันทึก')).toHaveCount(0);
  await page.goto('/?view=journeys');
  await expect(page.getByRole('heading', { name: 'สร้าง Journey เปล่า' })).toHaveCount(0);
  expect(mock.mutations()).toHaveLength(0);
});

test('a11y: editor has no serious/critical, 200% zoom does not overflow horizontally, and reduced motion disables transitions', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await openEditor(page, mock);
  await expectNoSeriousA11yViolations(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transition = await page
    .getByRole('group', { name: 'ผังขั้นตอนของ Journey' })
    .getByRole('button', { name: 'ส่งข้อความ' })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(transition.split(',').every((value) => parseFloat(value) === 0)).toBe(true);

  // 200% zoom of a 1280px screen = viewport 640 CSS px
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByRole('note').filter({ hasText: 'อ่านอย่างเดียว' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.3 a reviewer finds the candidate awaiting review from the list, opens the exact candidate, approves it and can view the audit', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  mock.persona = 'reviewer';
  mock.journeys.get(JOURNEY_ID)!.review = {
    reviewId: REVIEW_ID,
    state: 'IN_REVIEW',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: false,
  };
  await mock.install(page);
  await page.goto('/?view=journeys');

  // the list shows the review state from the server; the "awaiting review" filter shows work the reviewer can decide
  await expect(page.getByRole('cell', { name: 'รอตรวจ' })).toBeVisible();
  await page.getByRole('button', { name: 'รอตรวจ' }).click();
  await expect(page.getByRole('button', { name: 'รอตรวจ' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'งานที่รอให้คุณตรวจ' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'ติดตามการชำระ' }).click();

  // the reviewer sees the exact candidate and the decide buttons, but no submit-for-review button (no journey.edit)
  const candidate = page.getByRole('definition').filter({ hasText: DIGEST('a').slice(0, 12) });
  await expect(candidate).toBeVisible();
  await expect(page.getByRole('button', { name: 'ส่งตรวจ' })).toHaveCount(0);
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason code').fill('LOOKS_GOOD');
  await dialog.getByLabel('Evidence reference').fill('uat-431');
  await dialog.getByRole('button', { name: 'อนุมัติ' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'สถานะการตรวจ: APPROVED' }),
  ).toBeVisible();
  const decision = mock.requests.find((request) =>
    new URL(request.url()).pathname.endsWith(`/reviews/${REVIEW_ID}/decisions`),
  );
  expect(decision?.postDataJSON()).toMatchObject({ decision: 'APPROVE', reasonCode: 'LOOKS_GOOD' });

  // the audit loads only when pressed (reading the audit is itself audited)
  expect(mock.requests.some((request) => request.url().endsWith('/audit'))).toBe(false);
  await page.getByRole('button', { name: 'แสดงประวัติ' }).click();
  const timeline = page.getByRole('list', { name: 'ประวัติการเปลี่ยนแปลง ใหม่สุดก่อน' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline).toContainText('REVIEW_APPROVED');
  await expect(timeline).toContainText('corr-synthetic-1');
  await expectNoSeriousA11yViolations(page);
});

test('U1.3 the submitter sees the reason another reviewer is required and has no decide button', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  mock.journeys.get(JOURNEY_ID)!.review = {
    reviewId: REVIEW_ID,
    state: 'IN_REVIEW',
    draftRevision: 1,
    draftDigest: DIGEST('1'),
    compileDigest: DIGEST('a'),
    submittedAt: '2026-09-22T01:00:00.000Z',
    makerIsCaller: true,
  };
  await openEditor(page, mock);
  await expect(page.getByRole('note').filter({ hasText: 'ต้องให้ reviewer คนอื่น' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0);
});

// ── D1.14 (#453): the Journeys page on the new shell/i18n/components ────────────────────────

test.describe('D1.14 English', () => {
  test.use({ locale: 'en-US' });

  test('the whole page text is English from the catalog and axe has no serious/critical on both the list and the editor', async ({
    page,
  }) => {
    const mock = new AuthoringMock();
    await mock.install(page);
    await page.goto('/?view=journeys');
    await expect(page.getByRole('heading', { name: 'Journeys you can see' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create draft' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.goto(`/?view=journeys&journey=${JOURNEY_ID}`);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Structure' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Journey step diagram' })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test('flag ui.shell.v2 on: Journeys is in AppShell without the old chrome duplicated, and axe passes in both TH/EN', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, true);
  await openEditor(page, mock);

  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByText('D-CONTACT', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ข้ามไปที่เนื้อหา' })).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("flag off: Journeys uses the page's original chrome (skip link + header) on the new components/tokens", async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, false);
  await openEditor(page, mock);
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
  await expect(page.getByText('D-CONTACT', { exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dc-brand-700').trim(),
  );
  expect(brand).toBe('#0f766e');
  await expectNoSeriousA11yViolations(page);
});

test('switching language while editing a Journey: text changes immediately, no reload, and unsaved edits remain', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await withShell(page, true);
  await openEditor(page, mock);
  const origin = await page.evaluate(() => performance.timeOrigin);

  await page.getByRole('button', { name: 'เพิ่ม', exact: true }).last().click();
  await expect(page.getByText(/มีการแก้ไขที่ยังไม่บันทึก 1 รายการ/)).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByText(/1 unsaved change/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(page.getByText(/มีการแก้ไขที่ยังไม่บันทึก 1 รายการ/)).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

// ── U1.4 (#432): UAT run on the Journey Console ─────────────────────────────────────────────

const RUN_ID = '9c4d5e6f-7a8b-4c93-9dae-2f3a4b5c6d74';
const NEXT_RUN_ID = 'ad5e6f7a-8b9c-4da4-8ebf-3a4b5c6d7e85';
const UAT_STEPS = [
  {
    stepId: 'MAKER_EDIT',
    title: 'Maker แก้ฉบับร่าง',
    expected: 'บันทึกฉบับร่างได้ revision ใหม่',
    stateLabel: 'REAL_STATE',
  },
  {
    stepId: 'SIMULATE',
    title: 'จำลองการทำงาน',
    expected: 'ผลจำลองจบที่ EXIT',
    stateLabel: 'SIMULATION_ONLY',
  },
];
const UAT_FIXTURE = {
  fixtureId: 'uat-fixture-1',
  startAt: '2026-09-01T02:00:00.000Z',
  seed: 'seed-uat-1',
  context: { segment: 'synthetic-a', amountDue: 1200 },
};

/**
 * stateful mock of `/api/v1/runtime-profile` (profile uat) and `/api/v1/uat-runs/**` — installed after
 * `AuthoringMock`, so it wins over the profile's 404 route; all data is synthetic
 */
class UatMock {
  readonly requests: Request[] = [];
  run: Json | null;
  /** the next `Start new round` is rejected with this response */
  startFailure: { status: number; body: Json } | null = null;
  unauthorized = false;
  /** U1.5 (#433): metadata of screenshots the mock accepted */
  evidence: Json[] = [];

  constructor(private readonly authoring: AuthoringMock) {
    this.run = this.makeRun(RUN_ID, 1, JOURNEY_ID);
  }

  makeRun(runId: string, sequence: number, journeyId: string): Json {
    return {
      runId,
      sequence,
      lifecycle: 'ACTIVE',
      revision: 1,
      journeyId,
      fixturePack: {
        environment: 'uat',
        packVersion: 'uat-pack-1',
        digest: DIGEST('5'),
        buildSha: 'abc1234def5678',
      },
      steps: UAT_STEPS,
      openedAt: '2026-09-22T00:00:00.000Z',
      closedAt: null,
      stepResults: [],
    };
  }

  async install(page: Page) {
    await page.route('**/api/v1/runtime-profile', (route) =>
      route.fulfill({
        status: 200,
        json: {
          profile: 'uat',
          kafka: 'DISABLED',
          lineWebhook: 'DISABLED',
          providerEgress: 'DISABLED',
          journeyRuntime: 'NOT_DEPLOYED',
          unilateralPublish: 'NOT_EXPOSED',
          blockedRequests: 0,
          journeyAuthoring: { canvasWrite: true, publishUi: true },
        },
      }),
    );
    await page.route('**/api/v1/uat-runs/**', async (route) => {
      const request = route.request();
      this.requests.push(request);
      const path = new URL(request.url()).pathname.replace('/api/v1/uat-runs', '');
      // a screenshot is a raw body — parse JSON only for requests that are JSON
      const isJson = (request.headers()['content-type'] ?? '').startsWith('application/json');
      const body = ((isJson ? request.postDataJSON() : null) ?? {}) as Json;
      const reply = (status: number, payload: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
      if (this.unauthorized) return reply(401, { message: 'Unauthorized' });
      if (request.method() === 'GET' && path === '/current') {
        return this.run ? reply(200, this.run) : reply(404, { code: 'UAT_RUN_NOT_FOUND' });
      }
      if (request.method() === 'GET' && path === '/current/simulation-fixture') {
        return this.run
          ? reply(200, { runId: this.run.runId, fixture: UAT_FIXTURE })
          : reply(404, { code: 'UAT_RUN_NOT_FOUND' });
      }
      if (request.method() === 'POST' && path === '/start') {
        if (this.startFailure) {
          const failure = this.startFailure;
          this.startFailure = null;
          return reply(failure.status, failure.body);
        }
        if (body.expectedRevision !== ((this.run?.revision as number | undefined) ?? 0)) {
          return reply(409, { code: 'REVISION_CONFLICT' });
        }
        this.authoring.journeys.set(NEW_JOURNEY_ID, {
          headVersion: 1,
          revision: 1,
          document: authoringDocument('Journey รอบที่ 2'),
          lifecycle: 'DRAFT_ONLY',
          activeVersion: null,
          review: null,
          notices: [],
        });
        this.run = this.makeRun(
          NEXT_RUN_ID,
          ((this.run?.sequence as number) ?? 0) + 1,
          NEW_JOURNEY_ID,
        );
        return reply(200, this.run);
      }
      const record = /^\/([^/]+)\/step-results$/.exec(path);
      if (request.method() === 'POST' && record && this.run?.runId === record[1]) {
        const step = UAT_STEPS.find((entry) => entry.stepId === body.stepId);
        if (!step || (body.outcome === 'FAIL') !== (body.severity !== undefined)) {
          return reply(400, { code: 'VALIDATION_FAILED', safeParams: { field: 'severity' } });
        }
        const result = {
          stepId: step.stepId,
          outcome: body.outcome,
          expected: step.expected,
          actual: body.actual,
          severity: body.severity ?? null,
          correlationId: body.correlationId ?? null,
          stateLabel: step.stateLabel,
          recordedByRef: '0a1b2c3d-0000-4000-8000-000000000001',
          recordedAt: '2026-09-22T03:00:00.000Z',
        };
        (this.run.stepResults as Json[]).push(result);
        return reply(200, result);
      }
      const evidence = /^\/([^/]+)\/evidence$/.exec(path);
      if (evidence && this.run?.runId === evidence[1]) {
        if (request.method() === 'GET') {
          return reply(200, { runId: this.run.runId, items: this.evidence });
        }
        // the real server checks the content type and then re-checks magic bytes — the mock follows the same steps in short form
        const type = request.headers()['content-type'];
        const bytes = request.postDataBuffer();
        if (type !== 'image/png' && type !== 'image/jpeg') {
          return reply(415, {
            code: 'EVIDENCE_TYPE_REJECTED',
            safeParams: { reason: 'CONTENT_TYPE' },
          });
        }
        if (!bytes || bytes[0] !== 0x89) {
          return reply(415, { code: 'EVIDENCE_TYPE_REJECTED', safeParams: { detected: 'ZIP' } });
        }
        const item = {
          evidenceId: `0e1f2a3b-4c5d-4e6f-8a7b-${String(this.evidence.length + 1).padStart(12, '0')}`,
          stepId: request.headers()['x-uat-step-id'],
          sha256: DIGEST('7'),
          sizeBytes: bytes.length,
          contentType: type,
          recordedByRef: '0a1b2c3d-0000-4000-8000-000000000001',
          recordedAt: '2026-09-22T04:00:00.000Z',
        };
        this.evidence.push(item);
        return reply(200, item);
      }
      if (request.method() === 'GET' && path === `/${this.run?.runId}/bundle`) {
        return reply(200, this.bundle());
      }
      return reply(400, { code: 'REQUEST_MALFORMED' });
    });
  }

  bundle(): Json {
    return {
      schema: 'UatEvidenceBundleV1',
      manifest: { runId: this.run?.runId, sequence: this.run?.sequence },
      stepResults: this.run?.stepResults ?? [],
      screenshots: this.evidence,
      scan: { status: 'PASSED', severity: null, findings: [] },
      verdict: 'INCOMPLETE',
      digest: DIGEST('9'),
    };
  }

  posts(suffix: string) {
    return this.requests.filter(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix),
    );
  }
}

async function openUat(page: Page, query = '') {
  const authoring = new AuthoringMock();
  const uat = new UatMock(authoring);
  await authoring.install(page);
  await uat.install(page);
  await page.goto(`/?view=journeys${query}`);
  const panel = page.getByRole('region', { name: 'รอบทดสอบ UAT' });
  await expect(panel).toBeVisible();
  return { authoring, uat, panel };
}

/** the URL has only view/tenant/journey (opaque id) — no token or value the tester typed */
function expectOpaqueUrl(page: Page) {
  const url = new URL(page.url());
  expect(
    [...url.searchParams.keys()].every((key) => ['view', 'tenant', 'journey'].includes(key)),
  ).toBe(true);
  expect(page.url()).not.toMatch(/token|bearer|eyJ|@/i);
}

test('U1.4 UAT: badge/scope + run data from the server, record PASS and FAIL with severity; axe passes', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  await expect(panel.getByText('UAT / จำลอง (simulated)')).toBeVisible();
  await expect(panel.getByRole('note').filter({ hasText: 'ข้อมูลสังเคราะห์' })).toBeVisible();
  const facts = panel.getByRole('definition');
  await expect(facts.filter({ hasText: 'รอบที่ 1' })).toBeVisible();
  await expect(facts.filter({ hasText: RUN_ID.slice(0, 8) })).toBeVisible();
  await expect(facts.filter({ hasText: 'uat-pack-1' })).toContainText(DIGEST('5').slice(0, 12));
  await expect(facts.filter({ hasText: 'abc1234def56' })).toBeVisible();
  await expect(panel.getByText('ยังไม่มีผลที่บันทึกในรอบนี้')).toBeVisible();

  // PASS: expected comes from the server's step catalog
  await expect(
    panel.getByRole('definition').filter({ hasText: 'บันทึกฉบับร่างได้ revision ใหม่' }),
  ).toBeVisible();
  const record = panel.getByRole('button', { name: 'บันทึกผล', exact: true });
  await expect(record).toBeDisabled();
  await panel.getByLabel('สิ่งที่เกิดขึ้นจริง').fill('บันทึกได้ revision 2');
  await panel.getByLabel('Correlation ID (ถ้ามี)').fill('corr-uat-1');
  await record.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'บันทึกผลของ MAKER_EDIT แล้ว' }),
  ).toBeVisible();

  // FAIL: a severity must be chosen before sending
  await panel.getByLabel('ขั้นตอนที่ทดสอบ').selectOption('SIMULATE');
  await panel.getByLabel('ไม่ผ่าน (FAIL)').check();
  await panel.getByLabel('สิ่งที่เกิดขึ้นจริง').fill('จบที่ MAX_DURATION');
  await expect(record).toBeDisabled();
  await panel.getByLabel('ความรุนแรง (ต้องระบุเมื่อไม่ผ่าน)').selectOption('S2');
  await record.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'บันทึกผลของ SIMULATE แล้ว' }),
  ).toBeVisible();

  const rows = panel.getByRole('table').getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('ผ่าน (PASS)');
  await expect(rows.nth(1)).toContainText('REAL_STATE');
  await expect(rows.nth(2)).toContainText('ไม่ผ่าน (FAIL)');
  await expect(rows.nth(2)).toContainText('S2');
  await expect(rows.nth(2)).toContainText('SIMULATION_ONLY');

  const posts = uat.posts('/step-results');
  expect(posts.map((request) => request.postDataJSON())).toEqual([
    {
      stepId: 'MAKER_EDIT',
      outcome: 'PASS',
      actual: 'บันทึกได้ revision 2',
      correlationId: 'corr-uat-1',
    },
    { stepId: 'SIMULATE', outcome: 'FAIL', actual: 'จบที่ MAX_DURATION', severity: 'S2' },
  ]);
  const keys = posts.map((request) => request.headers()['idempotency-key']);
  expect(keys.every((key) => /^uat-step-/.test(key ?? ''))).toBe(true);
  expect(new Set(keys).size).toBe(2);
  expect(new URL(posts[0]!.url()).pathname).toBe(`/api/v1/uat-runs/${RUN_ID}/step-results`);
  expectOpaqueUrl(page);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 start new round: confirm then see the new round and go to the new Journey; 409 PENDING_REVIEW points to the way forward', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  await panel.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'ยืนยันเริ่มรอบใหม่' });
  await expect(confirm).toContainText('รอบที่ 1 จะถูกปิด');
  await expect(confirm).toContainText('ABANDONED');
  await expect(confirm.getByLabel('Environment ของ fixture pack')).toHaveValue('uat');
  await expect(confirm.getByLabel('Version ของ fixture pack')).toHaveValue('uat-pack-1');
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();

  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey รอบที่ 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey รอบที่ 2' })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(NEW_JOURNEY_ID);
  const [start] = uat.posts('/start');
  expect(start!.postDataJSON()).toEqual({
    environment: 'uat',
    packVersion: 'uat-pack-1',
    expectedRevision: 1,
  });
  expect(start!.headers()['idempotency-key']).toMatch(/^uat-start-/);

  // the original run still has work awaiting review: the server rejects and states the next safe action
  uat.startFailure = {
    status: 409,
    body: { code: 'UAT_RUN_PENDING_REVIEW', safeParams: { nextSafeAction: 'DECIDE_REVIEW' } },
  };
  await panel.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  await page
    .getByRole('alertdialog', { name: 'ยืนยันเริ่มรอบใหม่' })
    .getByRole('button', { name: 'เริ่มรอบใหม่' })
    .click();
  const alert = panel.getByRole('alert').filter({ hasText: 'ยังมีงานรอตรวจ' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('ให้ reviewer ตัดสินงานที่รอตรวจ');
  await expect(alert.getByRole('button', { name: 'เปิด Journey ของรอบนี้' })).toBeVisible();
  // do not infer that the new round started — it is still round 2 per the server
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 2' })).toBeVisible();
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 3' })).toHaveCount(0);
  expectOpaqueUrl(page);
});

test("U1.4 simulation in UAT uses the server's fixture exactly and shows SIMULATION_ONLY with the virtual time", async ({
  page,
}) => {
  const { authoring } = await openUat(page, `&journey=${JOURNEY_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // there is no browser-built JSON context field in UAT
  await expect(page.getByLabel('Context สังเคราะห์สำหรับ simulation (JSON)')).toHaveCount(0);
  const fixture = page.getByRole('definition').filter({ hasText: 'uat-fixture-1' });
  await expect(fixture).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: 'seed-uat-1' })).toBeVisible();

  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await page.getByRole('button', { name: 'จำลองการทำงาน' }).click();
  const result = page.locator('.j5-simulation');
  await expect(result).toContainText('SIMULATION_ONLY');
  await expect(result).toContainText('เวลาเสมือน');
  await expect(result).toContainText('ไม่ใช่เวลาจริงใน audit');
  await expect(result.locator('time').first()).toHaveAttribute('datetime', UAT_FIXTURE.startAt);

  const simulation = authoring.requests.find((request) => request.url().endsWith('/simulations'))!;
  expect((simulation.postDataJSON() as Json).fixture).toEqual(UAT_FIXTURE);
});

test('U1.4 deep link/refresh/Back/Forward do not dead-end, focus goes to the heading, and unsaved edits are not lost', async ({
  page,
}) => {
  const mock = new AuthoringMock();
  await mock.install(page);
  await page.goto('/?view=journeys');
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  // not UAT (profile 404): no UAT UI at all
  await expect(page.getByRole('region', { name: 'รอบทดสอบ UAT' })).toHaveCount(0);
  await expect(page.getByText('UAT / จำลอง (simulated)')).toHaveCount(0);

  await page.getByRole('button', { name: 'ติดตามการชำระ' }).click();
  const editorHeading = page.getByRole('heading', { level: 1, name: 'ติดตามการชำระ' });
  await expect(editorHeading).toBeFocused();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(JOURNEY_ID);
  const name = page.getByLabel('ชื่อ Journey');
  await name.fill('ชื่อที่ยังไม่บันทึก');
  await name.press('Enter');

  await page.goBack();
  const listHeading = page.getByRole('heading', { level: 1, name: 'Journey authoring' });
  await expect(listHeading).toBeFocused();
  expect(new URL(page.url()).searchParams.has('journey')).toBe(false);

  await page.goForward();
  await expect(editorHeading).toBeFocused();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();

  // refresh on a deep link opens the same Journey and can still restore edits
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'กู้คืนการแก้ไข' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ชื่อที่ยังไม่บันทึก' })).toBeVisible();
  expect(page.url()).not.toContain(encodeURIComponent('ชื่อที่ยังไม่บันทึก'));
  expectOpaqueUrl(page);

  await page.getByRole('button', { name: '← รายการ Journey' }).click();
  await expect(listHeading).toBeFocused();
  // leaving the editor with the back button then Back: the edits remain in session recovery to restore again
  await page.goBack();
  await expect(
    page.getByRole('alert').filter({ hasText: 'พบการแก้ไขที่ยังไม่บันทึก' }),
  ).toBeVisible();
  expect(mock.mutations()).toHaveLength(0);
});

test('U1.4 session expired (401) at the UAT API shows a way to sign in again, no dead end', async ({
  page,
}) => {
  const authoring = new AuthoringMock();
  const uat = new UatMock(authoring);
  uat.unauthorized = true;
  await authoring.install(page);
  await uat.install(page);
  await page.goto('/?view=journeys');
  const panel = page.getByRole('region', { name: 'รอบทดสอบ UAT' });
  const alert = panel.getByRole('alert').filter({ hasText: 'Session หมดอายุ' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('เข้าสู่ระบบอีกครั้ง');
  await expect(alert.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'เริ่มรอบใหม่' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 959px: the UAT panel is read-only with no save-result/start-new-round buttons and sends no mutation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 959, height: 900 });
  const { uat, panel } = await openUat(page);
  await expect(panel.getByText('UAT / จำลอง (simulated)')).toBeVisible();
  await expect(panel.getByRole('definition').filter({ hasText: 'รอบที่ 1' })).toBeVisible();
  await expect(
    panel.getByRole('note').filter({ hasText: 'ดูรอบทดสอบได้อย่างเดียว' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'บันทึกผล', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'เริ่มรอบใหม่' })).toHaveCount(0);
  await expect(panel.getByLabel('สิ่งที่เกิดขึ้นจริง')).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(uat.requests.filter((request) => request.method() !== 'GET')).toHaveLength(0);
  await expectNoSeriousA11yViolations(page);
});

test('U1.4 the UAT panel is in the page content: seen the same with flag ui.shell.v2 on and off', async ({
  page,
}) => {
  for (const shellV2 of [true, false]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await withShell(page, shellV2);
    await openUat(page);
    await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(shellV2 ? 1 : 0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main').getByText('UAT / จำลอง (simulated)')).toBeVisible();
  }
});

// ── U1.5 (#433): evidence screenshots and the evidence bundle ──────────────────────────────

/** PNG signature + minimal IHDR — the mock checks only magic bytes */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test('U1.5 attach a screenshot, see the digest, a trace is rejected with a way forward, and export the bundle through a Blob', async ({
  page,
}) => {
  const { uat, panel } = await openUat(page);
  const evidence = panel.getByRole('region', { name: 'ภาพหน้าจอหลักฐาน' });
  await expect(evidence.getByText('ยังไม่มีภาพหน้าจอในรอบนี้')).toBeVisible();
  const file = evidence.getByLabel('ไฟล์ภาพหน้าจอ');
  await expect(file).toHaveAttribute('accept', 'image/png,image/jpeg');
  const upload = evidence.getByRole('button', { name: 'อัปโหลดภาพหน้าจอ' });
  await expect(upload).toBeDisabled();

  await evidence.getByLabel('ขั้นตอนของภาพหน้าจอ').selectOption('SIMULATE');
  await file.setInputFiles({ name: 'simulate.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await upload.click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'แนบภาพหน้าจอของ SIMULATE แล้ว' }),
  ).toBeVisible();
  const row = evidence.getByRole('table').getByRole('row').nth(1);
  await expect(row).toContainText('SIMULATE');
  await expect(row).toContainText(DIGEST('7').slice(0, 12));
  await expect(row).toContainText('image/png');

  // a Playwright trace (zip) is rejected by the server — show the reason and the way forward, nothing is added
  await file.setInputFiles({
    name: 'trace.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('PK\u0003\u0004trace', 'latin1'),
  });
  await upload.click();
  const alert = panel.getByRole('alert');
  await expect(alert).toContainText('รับเฉพาะภาพหน้าจอ PNG/JPEG');
  await expect(alert).toContainText('เลือกไฟล์ภาพหน้าจอ PNG หรือ JPEG');
  await expect(evidence.getByRole('table').getByRole('row')).toHaveCount(2);

  const posts = uat.posts('/evidence');
  expect(posts).toHaveLength(2);
  const [accepted, rejected] = posts;
  expect(new URL(accepted!.url()).pathname).toBe(`/api/v1/uat-runs/${RUN_ID}/evidence`);
  expect(accepted!.headers()['content-type']).toBe('image/png');
  expect(accepted!.headers()['x-uat-step-id']).toBe('SIMULATE');
  expect(accepted!.headers()['authorization']).toMatch(/^Bearer /);
  expect(accepted!.headers()['idempotency-key']).toMatch(/^uat-evidence-/);
  expect(rejected!.headers()['content-type']).toBe('application/zip');
  expect(rejected!.headers()['idempotency-key']).not.toBe(accepted!.headers()['idempotency-key']);

  // export the bundle: fetch with a bearer header then download from a Blob — no token in the URL
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    evidence.getByRole('button', { name: 'ส่งออก evidence bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('uat-run-1-evidence-bundle.json');
  expect(download.url()).toMatch(/^blob:/);
  const exported = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Json;
  expect(exported).toEqual(uat.bundle());
  const bundleRequest = uat.requests.find((request) =>
    new URL(request.url()).pathname.endsWith('/bundle'),
  );
  expect(bundleRequest!.headers()['authorization']).toMatch(/^Bearer /);
  for (const request of uat.requests) expect(request.url()).not.toMatch(/token|bearer|eyJ/i);
  const summary = evidence.getByRole('definition');
  await expect(summary.filter({ hasText: 'ยังไม่ครบ (INCOMPLETE)' })).toBeVisible();
  await expect(summary.filter({ hasText: 'ไม่พบข้อมูลต้องห้าม' })).toBeVisible();
  await expect(summary.filter({ hasText: DIGEST('9').slice(0, 12) })).toBeVisible();
  expectOpaqueUrl(page);
  await expectNoSeriousA11yViolations(page);
});
